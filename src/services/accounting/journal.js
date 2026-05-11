// Journal posting service — writes double-entry rows to `journal_entries`.
//
// Posting rules (per-line GST):
//   Sale invoice  :  Dr SUBLEDGER(party) grand
//                    Cr SALES sub, Cr CGST_OUTPUT/SGST_OUTPUT/IGST_OUTPUT
//   Sale CN       :  reverse of above
//   Purchase bill :  Dr PURCHASES sub, Dr CGST_INPUT/SGST_INPUT/IGST_INPUT
//                    Cr SUBLEDGER(vendor) grand
//   Purchase DN   :  reverse of above
//   Receipt       :  Dr BANK|CASH  / Cr SUBLEDGER(party)
//   Payment       :  Dr SUBLEDGER(party) / Cr BANK|CASH
//   Expense       :  Dr EXP_xxx / Cr BANK|CASH
// PO / GRN are non-financial (not posted).

const supabase = require('../../config/supabase');
const { getTenantId } = require('../../middleware/tenant');
const { seedAccounts, accountForMode } = require('./accounts');
const { parseInvoiceDate, fyString } = require('../../utils/dates');

const seededTenants = new Set();

async function ensureAccounts(tenant) {
  if (seededTenants.has(tenant)) return;
  try { await seedAccounts(supabase, tenant); seededTenants.add(tenant); } catch {}
}

function toIsoDate(str) {
  if (!str) return new Date().toISOString().slice(0, 10);
  const d = parseInvoiceDate(str);
  if (!d || isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function num(v) { return Math.round((parseFloat(v) || 0) * 100) / 100; }

async function isPeriodLocked(tenant, isoDate) {
  try {
    const d = new Date(isoDate);
    const fy = fyString(d);
    const { data } = await supabase.from('period_locks').select('fy').eq('tenant_id', tenant).eq('fy', fy);
    return !!(data && data.length);
  } catch { return false; }
}

async function deleteJournalFor(tenant, ref_type, ref_id) {
  await supabase.from('journal_entries').delete()
    .eq('tenant_id', tenant).eq('ref_type', ref_type).eq('ref_id', ref_id);
}

async function writeLines(tenant, lines) {
  if (!lines.length) return;
  const dr = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.abs(dr - cr) > 0.05) {
    const diff = Math.round((cr - dr) * 100) / 100;
    lines.push({
      ...lines[0],
      line_no: lines.length + 1,
      account_code: 'ROUND_OFF',
      party_name: null,
      debit: diff > 0 ? diff : 0,
      credit: diff < 0 ? -diff : 0,
      narration: 'Rounding',
    });
  }
  const rows = lines.map((l, i) => ({
    tenant_id: tenant,
    entry_date: l.entry_date,
    ref_type: l.ref_type,
    ref_id: l.ref_id,
    line_no: l.line_no || i + 1,
    account_code: l.account_code,
    party_name: l.party_name || null,
    debit: num(l.debit || 0),
    credit: num(l.credit || 0),
    narration: l.narration || null,
  }));
  await supabase.from('journal_entries').insert(rows);
}

// ---------- Invoices / credit & debit notes / purchase bills ----------
async function postInvoice(req, invoice) {
  try {
    const tenant = await getTenantId(req);
    await ensureAccounts(tenant);

    const doc_type = invoice.doc_type || 'invoice';
    if (['po', 'grn'].includes(doc_type)) return;

    const cat = invoice.doc_category || 'sale';
    const is_cn = !!invoice.is_credit_note;
    const is_dn = !!invoice.is_debit_note;
    const ref_id = String(invoice.bill_no || '');
    if (!ref_id) return;
    const ref_type = is_cn ? 'credit_note' : is_dn ? 'debit_note' : (cat === 'purchase' ? 'purchase_bill' : 'invoice');
    const date = toIsoDate(invoice.invoice_date);

    await deleteJournalFor(tenant, ref_type, ref_id);

    const sub   = num(invoice.sub_total);
    const cgst  = num(invoice.cgst);
    const sgst  = num(invoice.sgst);
    const igst  = num(invoice.igst);
    const grand = num(invoice.grand_total);
    const party = invoice.client_name || null;
    const narr  = `${ref_type.replace('_', ' ')} ${ref_id}`;

    const base = { tenant_id: tenant, entry_date: date, ref_type, ref_id, narration: narr };
    const reverse = is_cn; // credit-note reverses sale; debit-note behaves like extra charge (same direction)
    const flip = reverse ? -1 : 1;
    const lines = [];

    const push = (acc, amount, side /* 'dr'|'cr' */, party_name = null) => {
      const v = Math.abs(amount) * flip;
      const dr = (side === 'dr' ? (v > 0 ? v : 0) : (v < 0 ? -v : 0));
      const cr = (side === 'cr' ? (v > 0 ? v : 0) : (v < 0 ? -v : 0));
      if (dr || cr) lines.push({ ...base, account_code: acc, party_name, debit: dr, credit: cr });
    };

    if (cat === 'sale') {
      if (grand) push('SUBLEDGER', grand, 'dr', party);
      if (sub)   push('SALES',      sub,   'cr');
      if (cgst)  push('CGST_OUTPUT', cgst, 'cr');
      if (sgst)  push('SGST_OUTPUT', sgst, 'cr');
      if (igst)  push('IGST_OUTPUT', igst, 'cr');
    } else {
      if (sub)   push('PURCHASES',  sub,   'dr');
      if (cgst)  push('CGST_INPUT', cgst,  'dr');
      if (sgst)  push('SGST_INPUT', sgst,  'dr');
      if (igst)  push('IGST_INPUT', igst,  'dr');
      if (grand) push('SUBLEDGER',  grand, 'cr', party);
    }

    await writeLines(tenant, lines);
  } catch (e) {
    console.warn('[journal] postInvoice failed:', e.message);
  }
}

async function deleteInvoiceJournal(req, billNo) {
  try {
    const tenant = await getTenantId(req);
    const id = String(billNo || '');
    if (!id) return;
    for (const rt of ['invoice', 'credit_note', 'debit_note', 'purchase_bill']) {
      await deleteJournalFor(tenant, rt, id);
    }
  } catch (e) { console.warn('[journal] deleteInvoiceJournal failed:', e.message); }
}

// ---------- Payments ----------
async function postPayment(req, payment) {
  try {
    const tenant = await getTenantId(req);
    await ensureAccounts(tenant);

    const pid = String(payment.payment_id || '');
    if (!pid) return;
    const ptype = payment.payment_type === 'payment' ? 'payment' : 'receipt';
    await deleteJournalFor(tenant, ptype, pid);

    const date = toIsoDate(payment.payment_date);
    const amt = num(payment.amount);
    if (!amt) return;
    const cashAcc = accountForMode(payment.mode);
    const party = payment.party_name || null;
    const narr = `${ptype === 'receipt' ? 'Receipt' : 'Payment'}${payment.ref_invoice ? ' against ' + payment.ref_invoice : ''}`;

    const base = { tenant_id: tenant, entry_date: date, ref_type: ptype, ref_id: pid, narration: narr };
    const lines = [];
    if (ptype === 'receipt') {
      lines.push({ ...base, account_code: cashAcc,    debit: amt, credit: 0 });
      lines.push({ ...base, account_code: 'SUBLEDGER', party_name: party, debit: 0, credit: amt });
    } else {
      lines.push({ ...base, account_code: 'SUBLEDGER', party_name: party, debit: amt, credit: 0 });
      lines.push({ ...base, account_code: cashAcc,    debit: 0, credit: amt });
    }
    await writeLines(tenant, lines);
  } catch (e) { console.warn('[journal] postPayment failed:', e.message); }
}

async function deletePaymentJournal(req, paymentId) {
  try {
    const tenant = await getTenantId(req);
    const id = String(paymentId || '');
    if (!id) return;
    for (const rt of ['receipt', 'payment']) await deleteJournalFor(tenant, rt, id);
  } catch (e) { console.warn('[journal] deletePaymentJournal failed:', e.message); }
}

// ---------- Expenses ----------
async function postExpense(req, expense) {
  try {
    const tenant = await getTenantId(req);
    await ensureAccounts(tenant);
    const id = String(expense.expense_id || '');
    if (!id) return;
    await deleteJournalFor(tenant, 'expense', id);

    const date = toIsoDate(expense.expense_date);
    const amt = num(expense.amount);
    if (!amt) return;
    const cashAcc = accountForMode(expense.mode);
    const acc = expense.account_code || 'EXP_GENERAL';
    const narr = `${expense.category || 'Expense'}${expense.vendor ? ' - ' + expense.vendor : ''}${expense.note ? ' (' + expense.note + ')' : ''}`;

    const base = { tenant_id: tenant, entry_date: date, ref_type: 'expense', ref_id: id, narration: narr };
    const lines = [
      { ...base, account_code: acc,     debit: amt, credit: 0 },
      { ...base, account_code: cashAcc, debit: 0, credit: amt },
    ];
    await writeLines(tenant, lines);
  } catch (e) { console.warn('[journal] postExpense failed:', e.message); }
}

async function deleteExpenseJournal(req, expenseId) {
  try {
    const tenant = await getTenantId(req);
    await deleteJournalFor(tenant, 'expense', String(expenseId || ''));
  } catch (e) { console.warn('[journal] deleteExpenseJournal failed:', e.message); }
}

module.exports = {
  postInvoice, deleteInvoiceJournal,
  postPayment, deletePaymentJournal,
  postExpense, deleteExpenseJournal,
  isPeriodLocked,
  ensureAccounts,
};
