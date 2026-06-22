const express = require('express');
const router = express.Router();

const { loginRequired } = require('../middleware/auth');
const { loadInvoices, loadInvoicesForUser } = require('../repositories/documents.repo');
const { allPaymentsRaw } = require('../repositories/payments.repo');
const { getSellerProfile } = require('../repositories/configs.repo');
const { generateReportExcel } = require('../services/excel/report');
const { generateGstr1Excel } = require('../services/excel/gstr1');
const { generateLedgerPdf } = require('../services/pdf/ledgerPdf');
const { formatDDMonYYYY, parseInvoiceDate, formatLedgerDate, fyString } = require('../utils/dates');

// FY helpers ---------------------------------------------------------------
function fyDateRange(fyStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(fyStr || '');
  if (!m) return null;
  const sy = parseInt(m[1]);
  return { from: `${sy}-04-01`, to: `${sy + 1}-03-31` };
}

function isoToFy(isoDate) {
  if (!isoDate) return null;
  const parts = isoDate.split('-');
  if (parts.length < 2) return null;
  const y = parseInt(parts[0]), mo = parseInt(parts[1]);
  if (!y || !mo) return null;
  return mo >= 4 ? `${y}-${String(y + 1).slice(-2)}` : `${y - 1}-${String(y).slice(-2)}`;
}

function sortedFys(fySet) {
  return [...fySet].sort((a, b) => b.localeCompare(a)); // newest first
}
// --------------------------------------------------------------------------

router.get('/download-report', loginRequired, async (req, res) => {
  try {
    const userId = req.session.view_mode || req.session.user.id;
    const buf = await generateReportExcel(req, userId);
    if (!buf) return res.status(404).send('Error: No invoices found');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Sales_Report_${formatDDMonYYYY()}.xlsx"`);
    res.send(buf);
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

router.get('/download-purchase-report', loginRequired, async (req, res) => {
  try {
    const userId = req.session.view_mode || req.session.user.id;
    const buf = await generateReportExcel(req, userId, { category: 'purchase' });
    if (!buf) return res.status(404).send('Error: No purchase records found');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Purchase_Report_${formatDDMonYYYY()}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(500).send(`Error: ${e.message}`); }
});

router.get('/download-gstr1', loginRequired, async (req, res) => {
  try {
    const monthYear = req.query.month_year || '';
    const buf = await generateGstr1Excel(req, monthYear);
    const filename = monthYear
      ? `GSTR1_${monthYear.replace(/ /g, '_')}.xlsx`
      : `GSTR1_Report_${formatDDMonYYYY()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

// Convert any stored date string to ISO YYYY-MM-DD
function toIso(dateStr) {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const d = parseInvoiceDate(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Build the complete FY list for a party by unioning journal_entries + raw docs.
// journal_entries is queried first (same source the ledger uses), raw docs as supplement.
async function getAvailableFysForParty(req, party_name) {
  const supabase = require('../config/supabase');
  const { getTenantId } = require('../middleware/tenant');
  const fySet = new Set();

  // Primary: scan journal_entries (same tenant/data as buildLedgerFromJournal)
  try {
    const tenant = await getTenantId(req);
    const { data } = await supabase
      .from('journal_entries')
      .select('entry_date')
      .eq('tenant_id', tenant)
      .ilike('party_name', party_name);
    (data || []).forEach((r) => { const f = isoToFy(r.entry_date); if (f) fySet.add(f); });
  } catch {}

  // Supplement: raw invoices + payments (catches journal-not-yet-built cases)
  const pnLower = party_name.trim().toLowerCase();
  try {
    const invoices = await loadInvoices(req);
    invoices
      .filter((i) => (i.client_name || '').trim().toLowerCase() === pnLower)
      .forEach((i) => { const f = isoToFy(toIso(i.invoice_date || '')); if (f) fySet.add(f); });
  } catch {}
  try {
    const payments = await allPaymentsRaw(req);
    payments
      .filter((p) => (p.party_name || '').toLowerCase() === pnLower)
      .forEach((p) => { const f = isoToFy(toIso(p.payment_date || '')); if (f) fySet.add(f); });
  } catch {}

  return sortedFys(fySet);
}

// Fallback ledger builder â€” raw invoices + payments filtered to a FY
async function buildLedgerEntries(req, party_name, fy) {
  const pnLower = party_name.trim().toLowerCase();
  const invoices = await loadInvoices(req);
  const party_invoices = invoices.filter((i) => (i.client_name || '').trim().toLowerCase() === pnLower);
  let payments = [];
  try {
    const all = await allPaymentsRaw(req);
    payments = all.filter((p) => (p.party_name || '').toLowerCase() === pnLower);
  } catch {}

  const range = fyDateRange(fy);
  const allEntries = [];

  for (const inv of party_invoices) {
    const iso = toIso(inv.invoice_date || '');
    const cat = inv.doc_category || 'sale';
    const dtype = inv.doc_type || 'invoice';
    const is_cn = !!inv.is_credit_note;
    const amt = parseFloat(inv.grand_total || 0);
    let dr = 0, cr = 0;
    if (cat === 'sale') { if (is_cn) cr = amt; else dr = amt; } else cr = amt;
    let narr = is_cn ? 'Credit Note' : 'Sales Invoice';
    if (inv.po_number) narr += ` (PO: ${inv.po_number})`;
    allEntries.push({ iso, date: formatLedgerDate(inv.invoice_date || ''), doc_no: inv.bill_no || '', doc_type: dtype.toUpperCase(), narration: narr, debit: dr, credit: cr, timestamp: inv.timestamp || '' });
  }
  for (const pay of payments) {
    const iso = toIso(pay.payment_date || '');
    const ptype = pay.payment_type || 'receipt';
    const amt = parseFloat(pay.amount || 0);
    const pid = pay.payment_id || '';
    let narr = `${ptype === 'receipt' ? 'Receipt' : 'Payment'} via ${pay.mode || 'Cash'}`;
    if (pay.ref_invoice) narr += ` against ${pay.ref_invoice}`;
    allEntries.push({ iso, date: formatLedgerDate(pay.payment_date || ''), doc_no: ptype === 'receipt' ? `RCPT-${pid.slice(-6)}` : `PAY-${pid.slice(-6)}`, doc_type: ptype === 'receipt' ? 'RECEIPT' : 'PAYMENT', narration: narr, debit: ptype === 'payment' ? amt : 0, credit: ptype === 'receipt' ? amt : 0, timestamp: pay.timestamp || '' });
  }

  allEntries.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  return allEntries
    .filter((e) => !range || (e.iso >= range.from && e.iso <= range.to))
    .map(({ iso, ...rest }) => rest);
}

// Primary ledger builder â€” journal_entries filtered to a FY
async function buildLedgerFromJournal(req, party_name, fy) {
  const supabase = require('../config/supabase');
  const { getTenantId } = require('../middleware/tenant');
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('journal_entries').select('*')
    .eq('tenant_id', tenant).ilike('party_name', party_name)
    .order('entry_date', { ascending: true }).order('created_at', { ascending: true });
  if (!data || data.length === 0) return null;

  const range = fyDateRange(fy);
  const filtered = range
    ? data.filter((r) => r.entry_date >= range.from && r.entry_date <= range.to)
    : data;

  return filtered.map((r) => ({
    date: formatLedgerDate(r.entry_date),
    doc_no: r.ref_id,
    doc_type: (r.ref_type || '').toUpperCase(),
    narration: r.narration || '',
    debit: parseFloat(r.debit) || 0,
    credit: parseFloat(r.credit) || 0,
    timestamp: r.created_at || '',
  }));
}

router.get('/ledger/:party_name(*)', loginRequired, async (req, res) => {
  try {
    const party_name = decodeURIComponent(req.params.party_name);
    const fy = req.query.fy || fyString();

    const curFy = fyString();
    const allFys = await getAvailableFysForParty(req, party_name);
    const fyList = allFys.includes(curFy) ? allFys : [curFy, ...allFys];

    // Ledger entries: prefer journal, fall back to raw
    let entries = null;
    try { entries = await buildLedgerFromJournal(req, party_name, fy); } catch {}
    if (!entries) entries = await buildLedgerEntries(req, party_name, fy);

    let running = 0;
    for (const e of entries) {
      running += e.debit - e.credit;
      e.balance = Math.round(running * 100) / 100;
    }
    res.json({ party_name, entries, closing_balance: Math.round(running * 100) / 100, available_fys: fyList, fy, _debug: allFys._debug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/download-ledger/:party_name(*)', loginRequired, async (req, res) => {
  try {
    const party_name = decodeURIComponent(req.params.party_name);
    const fy = req.query.fy || fyString();
    let result = null;
    try { result = await buildLedgerFromJournal(req, party_name, fy); } catch {}
    if (!result) result = await buildLedgerEntries(req, party_name, fy);
    const profile = await getSellerProfile(req);
    const pdfBuf = await generateLedgerPdf(party_name, result, profile);
    const safeName = party_name.replace(/ /g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Ledger_${safeName}_${fy}.pdf"`);
    res.send(pdfBuf);
  } catch (e) {
    res.status(500).send(`Error generating PDF: ${e.message}`);
  }
});

async function computeOutstanding(req, fy = null) {
  let fyFrom = null, fyTo = null;
  if (fy) { const r = fyDateRange(fy); if (r) { fyFrom = r.from; fyTo = r.to; } }
  const all = (await loadInvoices(req)).filter((i) => {
    if ((i.doc_category || 'sale') !== 'sale') return false;
    if ((i.doc_type || 'invoice') !== 'invoice') return false;
    if (i.is_credit_note) return false;
    if (['Paid', 'Cancelled'].includes(i.status || 'Confirmed')) return false;
    if (fyFrom) { const iso = toIso(i.invoice_date || ''); if (!iso || iso < fyFrom || iso > fyTo) return false; }
    return true;
  });
  let payments = [];
  try { payments = (await allPaymentsRaw(req)).filter((p) => p.payment_type === 'receipt'); } catch {}
  const today = new Date();
  const result = [];
  for (const inv of all) {
    const bill_no = inv.bill_no || '';
    const grand_total = parseFloat(inv.grand_total || 0);
    const paid = payments.filter((p) => p.ref_invoice === bill_no).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    const balance = Math.round((grand_total - paid) * 100) / 100;
    if (balance <= 0) continue;
    let days_overdue = 0;
    const d = parseInvoiceDate(inv.invoice_date || '');
    if (d) days_overdue = Math.floor((today - d) / (24 * 60 * 60 * 1000));
    const age_bucket = days_overdue <= 30 ? '0-30 days'
      : days_overdue <= 60 ? '31-60 days'
      : days_overdue <= 90 ? '61-90 days'
      : '90+ days';
    result.push({
      bill_no,
      invoice_date: inv.invoice_date || '',
      client_name: inv.client_name || '',
      client_mobile: inv.client_mobile || '',
      grand_total,
      paid: Math.round(paid * 100) / 100,
      balance,
      days_overdue,
      age_bucket,
      status: inv.status || 'Confirmed',
    });
  }
  result.sort((a, b) => b.days_overdue - a.days_overdue);
  return result;
}

router.get('/outstanding', loginRequired, async (req, res) => {
  const fy = req.query.fy || null;
  try { res.json(await computeOutstanding(req, fy)); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.computeOutstanding = computeOutstanding;

