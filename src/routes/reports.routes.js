const express = require('express');
const router = express.Router();

const { loginRequired } = require('../middleware/auth');
const { loadInvoices, loadInvoicesForUser } = require('../repositories/documents.repo');
const { allPaymentsRaw } = require('../repositories/payments.repo');
const { getSellerProfile } = require('../repositories/configs.repo');
const { generateReportExcel } = require('../services/excel/report');
const { generateGstr1Excel } = require('../services/excel/gstr1');
const { generateLedgerPdf } = require('../services/pdf/ledgerPdf');
const { formatDDMonYYYY, parseInvoiceDate, formatLedgerDate } = require('../utils/dates');

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

async function buildLedgerEntries(req, party_name) {
  const invoices = await loadInvoices(req);
  const party_invoices = invoices.filter((i) =>
    (i.client_name || '').trim().toLowerCase() === party_name.trim().toLowerCase()
  );
  let payments = [];
  try {
    const all = await allPaymentsRaw(req);
    payments = all.filter((p) => (p.party_name || '').toLowerCase() === party_name.toLowerCase());
  } catch {}

  const entries = [];
  for (const inv of party_invoices) {
    const cat = inv.doc_category || 'sale';
    const dtype = inv.doc_type || 'invoice';
    const is_cn = !!inv.is_credit_note;
    const amt = parseFloat(inv.grand_total || 0);
    let dr, cr;
    if (cat === 'sale') {
      if (is_cn) { dr = 0; cr = amt; } else { dr = amt; cr = 0; }
    } else {
      dr = 0; cr = amt;
    }
    let narr = is_cn ? 'Credit Note' : 'Sales Invoice';
    if (inv.po_number) narr += ` (PO: ${inv.po_number})`;
    entries.push({
      date: formatLedgerDate(inv.invoice_date || ''),
      doc_no: inv.bill_no || '',
      doc_type: dtype.toUpperCase(),
      narration: narr,
      debit: dr, credit: cr,
      timestamp: inv.timestamp || '',
    });
  }
  for (const pay of payments) {
    const ptype = pay.payment_type || 'receipt';
    const amt = parseFloat(pay.amount || 0);
    const pid = pay.payment_id || '';
    const short_doc = ptype === 'receipt' ? `RCPT-${pid.slice(-6)}` : `PAY-${pid.slice(-6)}`;
    let narr = `${ptype === 'receipt' ? 'Receipt' : 'Payment'} via ${pay.mode || 'Cash'}`;
    if (pay.ref_invoice) narr += ` against ${pay.ref_invoice}`;
    // Double-entry rule: money received from party => Cr party; money paid to party => Dr party.
    entries.push({
      date: formatLedgerDate(pay.payment_date || ''),
      doc_no: short_doc,
      doc_type: ptype === 'receipt' ? 'RECEIPT' : 'PAYMENT',
      narration: narr,
      debit: ptype === 'payment' ? amt : 0,
      credit: ptype === 'receipt' ? amt : 0,
      timestamp: pay.timestamp || '',
    });
  }
  entries.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  return entries;
}

async function buildLedgerFromJournal(req, party_name) {
  const supabase = require('../config/supabase');
  const { getTenantId } = require('../middleware/tenant');
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('journal_entries').select('*')
    .eq('tenant_id', tenant).ilike('party_name', party_name)
    .order('entry_date', { ascending: true }).order('created_at', { ascending: true });
  if (!data || data.length === 0) return null;
  return data.map((r) => ({
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
    let entries = null;
    try { entries = await buildLedgerFromJournal(req, party_name); } catch {}
    if (!entries) entries = await buildLedgerEntries(req, party_name);
    let running = 0;
    for (const e of entries) {
      running += e.debit - e.credit;
      e.balance = Math.round(running * 100) / 100;
    }
    res.json({ party_name, entries, closing_balance: Math.round(running * 100) / 100 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/download-ledger/:party_name(*)', loginRequired, async (req, res) => {
  try {
    const party_name = decodeURIComponent(req.params.party_name);
    const entries = await buildLedgerEntries(req, party_name);
    const profile = await getSellerProfile(req);
    const pdfBuf = await generateLedgerPdf(party_name, entries, profile);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Ledger_${party_name.replace(/ /g, '_')}.pdf"`);
    res.send(pdfBuf);
  } catch (e) {
    res.status(500).send(`Error generating PDF: ${e.message}`);
  }
});

async function computeOutstanding(req) {
  const all = (await loadInvoices(req)).filter((i) =>
    (i.doc_category || 'sale') === 'sale' &&
    (i.doc_type || 'invoice') === 'invoice' &&
    !i.is_credit_note &&
    !['Paid', 'Cancelled'].includes(i.status || 'Confirmed')
  );
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
  try { res.json(await computeOutstanding(req)); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.computeOutstanding = computeOutstanding;
