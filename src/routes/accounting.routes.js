// v2 accounting — reports + expenses + period locks + audit log.
// All endpoints read/write NEW tables only; existing routes remain untouched.

const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { loginRequired, masterOnly } = require('../middleware/auth');
const { getTenantId } = require('../middleware/tenant');
const { formatLedgerDate, fyString, parseInvoiceDate } = require('../utils/dates');
const journal = require('../services/accounting/journal');
const audit = require('../services/accounting/audit');
const { loadInvoices } = require('../repositories/documents.repo');
const { allPaymentsRaw } = require('../repositories/payments.repo');
const { listExpenses, upsertExpense, deleteExpense, allExpensesRaw } = require('../repositories/expenses.repo');
const { STANDARD_ACCOUNTS } = require('../services/accounting/accounts');
const { parseStatement } = require('../services/accounting/bank');

async function fetchJournal(tenant, filters = {}) {
  let q = supabase.from('journal_entries').select('*').eq('tenant_id', tenant);
  if (filters.party) q = q.eq('party_name', filters.party);
  if (filters.account) q = q.eq('account_code', filters.account);
  if (filters.accounts) q = q.in('account_code', filters.accounts);
  if (filters.ref_type) q = q.eq('ref_type', filters.ref_type);
  if (filters.from) q = q.gte('entry_date', filters.from);
  if (filters.to) q = q.lte('entry_date', filters.to);
  const { data } = await q.order('entry_date', { ascending: true }).order('created_at', { ascending: true });
  return data || [];
}

// ---------------- UI page ----------------
router.get('/accounts', loginRequired, (req, res) => res.render('accounts.html'));

// ---------------- Ledger / Reports ----------------
router.get('/v2/ledger/:party_name(*)', loginRequired, async (req, res) => {
  try {
    const party = decodeURIComponent(req.params.party_name);
    const tenant = await getTenantId(req);
    const rows = await fetchJournal(tenant, { party });
    let running = 0;
    const entries = rows.map((r) => {
      const dr = parseFloat(r.debit) || 0;
      const cr = parseFloat(r.credit) || 0;
      running += dr - cr;
      return {
        date: formatLedgerDate(r.entry_date),
        doc_no: r.ref_id,
        doc_type: r.ref_type.toUpperCase(),
        narration: r.narration || '',
        debit: dr, credit: cr,
        balance: Math.round(running * 100) / 100,
      };
    });
    res.json({ party_name: party, entries, closing_balance: Math.round(running * 100) / 100 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/trial-balance', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const rows = await fetchJournal(tenant, { from: req.query.from, to: req.query.to });
    const map = {};
    for (const r of rows) {
      const k = r.account_code;
      if (!map[k]) map[k] = { account: k, debit: 0, credit: 0 };
      map[k].debit += parseFloat(r.debit) || 0;
      map[k].credit += parseFloat(r.credit) || 0;
    }
    const out = Object.values(map).map((x) => ({
      account: x.account,
      debit: Math.round(x.debit * 100) / 100,
      credit: Math.round(x.credit * 100) / 100,
      balance: Math.round((x.debit - x.credit) * 100) / 100,
    }));
    res.json({ from: req.query.from || null, to: req.query.to || null, rows: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/profit-loss', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const [rows, { data: accounts }] = await Promise.all([
      fetchJournal(tenant, { from: req.query.from, to: req.query.to }),
      supabase.from('accounts').select('code,name,type').eq('tenant_id', tenant),
    ]);
    const typeOf = {};
    (accounts || []).forEach((a) => { typeOf[a.code] = a.type; });
    const income = {}; const expense = {};
    for (const r of rows) {
      const t = typeOf[r.account_code];
      const dr = parseFloat(r.debit) || 0;
      const cr = parseFloat(r.credit) || 0;
      if (t === 'income') income[r.account_code] = (income[r.account_code] || 0) + (cr - dr);
      else if (t === 'expense' && r.account_code !== 'ROUND_OFF')
        expense[r.account_code] = (expense[r.account_code] || 0) + (dr - cr);
    }
    const totalIncome = Object.values(income).reduce((s, v) => s + v, 0);
    const totalExpense = Object.values(expense).reduce((s, v) => s + v, 0);
    res.json({
      from: req.query.from || null, to: req.query.to || null,
      income, expense,
      total_income: Math.round(totalIncome * 100) / 100,
      total_expense: Math.round(totalExpense * 100) / 100,
      net_profit: Math.round((totalIncome - totalExpense) * 100) / 100,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/balance-sheet', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const to = req.query.to || null;
    const [rows, { data: accounts }] = await Promise.all([
      fetchJournal(tenant, { to }),
      supabase.from('accounts').select('code,name,type,is_control').eq('tenant_id', tenant),
    ]);
    const typeOf = {};
    (accounts || []).forEach((a) => { typeOf[a.code] = a; });
    const buckets = { asset: {}, liability: {}, equity: {} };
    const subByParty = {};
    for (const r of rows) {
      const acc = typeOf[r.account_code];
      if (!acc) continue;
      const dr = parseFloat(r.debit) || 0;
      const cr = parseFloat(r.credit) || 0;
      if (acc.is_control && r.account_code === 'SUBLEDGER') {
        const k = r.party_name || '(unnamed)';
        subByParty[k] = (subByParty[k] || 0) + (dr - cr);
        continue;
      }
      if (acc.type === 'asset') buckets.asset[r.account_code] = (buckets.asset[r.account_code] || 0) + (dr - cr);
      else if (acc.type === 'liability') buckets.liability[r.account_code] = (buckets.liability[r.account_code] || 0) + (cr - dr);
      else if (acc.type === 'equity') buckets.equity[r.account_code] = (buckets.equity[r.account_code] || 0) + (cr - dr);
    }
    let debtors = 0, creditors = 0;
    for (const v of Object.values(subByParty)) { if (v > 0) debtors += v; else creditors += -v; }
    if (debtors) buckets.asset.DEBTORS = Math.round(debtors * 100) / 100;
    if (creditors) buckets.liability.CREDITORS = Math.round(creditors * 100) / 100;
    res.json({ as_of: to, ...buckets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Receivables / Payables directly from party sub-ledger balances
router.get('/v2/receivables', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const rows = await fetchJournal(tenant, { account: 'SUBLEDGER', to: req.query.to });
    const byParty = {};
    for (const r of rows) {
      const k = r.party_name || '(unnamed)';
      byParty[k] = (byParty[k] || 0) + (parseFloat(r.debit) || 0) - (parseFloat(r.credit) || 0);
    }
    const list = Object.entries(byParty).filter(([, v]) => v > 0.005)
      .map(([party, bal]) => ({ party, balance: Math.round(bal * 100) / 100 }))
      .sort((a, b) => b.balance - a.balance);
    const total = list.reduce((s, x) => s + x.balance, 0);
    res.json({ rows: list, total: Math.round(total * 100) / 100 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/payables', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const rows = await fetchJournal(tenant, { account: 'SUBLEDGER', to: req.query.to });
    const byParty = {};
    for (const r of rows) {
      const k = r.party_name || '(unnamed)';
      byParty[k] = (byParty[k] || 0) + (parseFloat(r.debit) || 0) - (parseFloat(r.credit) || 0);
    }
    const list = Object.entries(byParty).filter(([, v]) => v < -0.005)
      .map(([party, bal]) => ({ party, balance: Math.round(-bal * 100) / 100 }))
      .sort((a, b) => b.balance - a.balance);
    const total = list.reduce((s, x) => s + x.balance, 0);
    res.json({ rows: list, total: Math.round(total * 100) / 100 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- GSTR-1 & GSTR-3B summary from journal ----------------
router.get('/v2/gstr-1', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const accs = ['SALES', 'CGST_OUTPUT', 'SGST_OUTPUT', 'IGST_OUTPUT', 'GST_OUTPUT'];
    const rows = await fetchJournal(tenant, { accounts: accs, from: req.query.from, to: req.query.to });
    const sums = { sales: 0, cgst: 0, sgst: 0, igst: 0, gst_legacy: 0 };
    for (const r of rows) {
      const net = (parseFloat(r.credit) || 0) - (parseFloat(r.debit) || 0);
      if (r.account_code === 'SALES') sums.sales += net;
      else if (r.account_code === 'CGST_OUTPUT') sums.cgst += net;
      else if (r.account_code === 'SGST_OUTPUT') sums.sgst += net;
      else if (r.account_code === 'IGST_OUTPUT') sums.igst += net;
      else if (r.account_code === 'GST_OUTPUT') sums.gst_legacy += net;
    }
    Object.keys(sums).forEach((k) => (sums[k] = Math.round(sums[k] * 100) / 100));
    res.json({ from: req.query.from || null, to: req.query.to || null, ...sums });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/gstr-3b', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const accs = ['CGST_OUTPUT', 'SGST_OUTPUT', 'IGST_OUTPUT', 'CGST_INPUT', 'SGST_INPUT', 'IGST_INPUT'];
    const rows = await fetchJournal(tenant, { accounts: accs, from: req.query.from, to: req.query.to });
    const out = { cgst_output: 0, sgst_output: 0, igst_output: 0, cgst_input: 0, sgst_input: 0, igst_input: 0 };
    for (const r of rows) {
      const dr = parseFloat(r.debit) || 0, cr = parseFloat(r.credit) || 0;
      const code = r.account_code.toLowerCase();
      if (code.includes('output')) out[code] += cr - dr;
      else if (code.includes('input')) out[code] += dr - cr;
    }
    Object.keys(out).forEach((k) => (out[k] = Math.round(out[k] * 100) / 100));
    const total_output = out.cgst_output + out.sgst_output + out.igst_output;
    const total_input = out.cgst_input + out.sgst_input + out.igst_input;
    res.json({
      from: req.query.from || null, to: req.query.to || null,
      ...out,
      total_output: Math.round(total_output * 100) / 100,
      total_input: Math.round(total_input * 100) / 100,
      net_payable: Math.round((total_output - total_input) * 100) / 100,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Expenses ----------------
router.get('/v2/expenses', loginRequired, async (req, res) => {
  try { res.json({ rows: await listExpenses(req) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/v2/expenses', loginRequired, async (req, res) => {
  try {
    const body = req.body || {};
    const id = body.expense_id || `EXP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const entry = {
      expense_id: id,
      expense_date: body.expense_date || new Date().toISOString().slice(0, 10),
      account_code: body.account_code || 'EXP_GENERAL',
      category: body.category || '',
      vendor: body.vendor || '',
      note: body.note || '',
      amount: parseFloat(body.amount) || 0,
      mode: body.mode || 'Bank',
      created_by: (req.session.user && req.session.user.id) || null,
      created_at: new Date().toISOString(),
    };
    if (!entry.amount) return res.status(400).json({ error: 'Amount required' });
    await upsertExpense(req, id, entry);
    res.json({ status: 'ok', expense: entry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/v2/expenses/:id', loginRequired, async (req, res) => {
  try { await deleteExpense(req, req.params.id); res.json({ status: 'ok' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/expense-accounts', loginRequired, (req, res) => {
  res.json({ rows: STANDARD_ACCOUNTS.filter((a) => a.type === 'expense' && a.code.startsWith('EXP_')) });
});

// ---------------- Period locks (master-only) ----------------
router.get('/v2/period-locks', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const { data } = await supabase.from('period_locks').select('*').eq('tenant_id', tenant).order('fy', { ascending: false });
    res.json({ rows: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/v2/period-locks', loginRequired, masterOnly, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const fy = req.body && req.body.fy;
    if (!fy) return res.status(400).json({ error: 'fy required (e.g. "2025-26")' });
    const actor = (req.session.user && req.session.user.id) || null;
    await supabase.from('period_locks').upsert(
      { tenant_id: tenant, fy, locked_by: actor, locked_at: new Date().toISOString() },
      { onConflict: 'tenant_id,fy' }
    );
    audit.log(req, 'lock', 'period', fy);
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/v2/period-locks/:fy', loginRequired, masterOnly, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    await supabase.from('period_locks').delete().eq('tenant_id', tenant).eq('fy', req.params.fy);
    audit.log(req, 'unlock', 'period', req.params.fy);
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/current-fy', loginRequired, (req, res) => res.json({ fy: fyString() }));

// ---------------- Audit log ----------------
router.get('/v2/audit-log', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    const { data } = await supabase.from('audit_log').select('*')
      .eq('tenant_id', tenant).order('at', { ascending: false }).limit(limit);
    res.json({ rows: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Bank reconciliation ----------------
router.post('/v2/bank/import', loginRequired, express.text({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const text = typeof req.body === 'string' ? req.body : (req.body && req.body.csv) || '';
    if (!text.trim()) return res.status(400).json({ error: 'Empty CSV body' });
    const rows = parseStatement(text);
    if (!rows.length) return res.status(400).json({ error: 'No recognizable rows. Expected columns: Date, Description/Narration, Debit/Credit or Amount.' });
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      const { data: existing } = await supabase.from('bank_transactions')
        .select('id').eq('tenant_id', tenant).eq('txn_id', r.txn_id).limit(1);
      if (existing && existing.length) { skipped++; continue; }
      await supabase.from('bank_transactions').insert({
        tenant_id: tenant, txn_id: r.txn_id, txn_date: r.txn_date,
        description: r.description, ref_no: r.ref_no,
        debit: r.debit, credit: r.credit, balance: r.balance, raw: r.raw,
      });
      inserted++;
    }
    audit.log(req, 'import', 'bank_statement', String(Date.now()), { inserted, skipped, total: rows.length });
    res.json({ status: 'ok', inserted, skipped, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/bank/transactions', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    let q = supabase.from('bank_transactions').select('*').eq('tenant_id', tenant);
    if (req.query.status === 'unmatched') q = q.is('matched_payment_id', null);
    else if (req.query.status === 'matched') q = q.not('matched_payment_id', 'is', null);
    if (req.query.from) q = q.gte('txn_date', req.query.from);
    if (req.query.to) q = q.lte('txn_date', req.query.to);
    const { data } = await q.order('txn_date', { ascending: false }).limit(500);
    res.json({ rows: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/v2/bank/candidates/:txn_id', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const { data: rows } = await supabase.from('bank_transactions').select('*')
      .eq('tenant_id', tenant).eq('txn_id', req.params.txn_id).limit(1);
    const txn = rows && rows[0];
    if (!txn) return res.status(404).json({ error: 'Bank txn not found' });
    const amt = Math.round(((parseFloat(txn.debit) || 0) + (parseFloat(txn.credit) || 0)) * 100) / 100;
    const ptype = (parseFloat(txn.credit) || 0) > 0 ? 'receipt' : 'payment';
    const [payments, { data: otherMatches }] = await Promise.all([
      allPaymentsRaw(req),
      supabase.from('bank_transactions').select('matched_payment_id,txn_id')
        .eq('tenant_id', tenant).not('matched_payment_id', 'is', null),
    ]);
    const alreadyMatched = new Set(
      (otherMatches || [])
        .filter((r) => r.txn_id !== req.params.txn_id && r.matched_payment_id)
        .map((r) => r.matched_payment_id)
    );
    const matches = payments.filter((p) => {
      if ((p.payment_type || 'receipt') !== ptype) return false;
      if (alreadyMatched.has(p.payment_id)) return false;
      return Math.abs((parseFloat(p.amount) || 0) - amt) < 0.01;
    }).slice(0, 50);
    res.json({ txn, candidates: matches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/v2/bank/match', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const { txn_id, payment_id } = req.body || {};
    if (!txn_id || !payment_id) return res.status(400).json({ error: 'txn_id and payment_id required' });
    const actor = (req.session.user && req.session.user.id) || null;
    await supabase.from('bank_transactions').update({
      matched_payment_id: payment_id, matched_at: new Date().toISOString(), matched_by: actor,
    }).eq('tenant_id', tenant).eq('txn_id', txn_id);
    audit.log(req, 'match', 'bank_txn', txn_id, { payment_id });
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/v2/bank/unmatch/:txn_id', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    await supabase.from('bank_transactions').update({
      matched_payment_id: null, matched_at: null, matched_by: null,
    }).eq('tenant_id', tenant).eq('txn_id', req.params.txn_id);
    audit.log(req, 'unmatch', 'bank_txn', req.params.txn_id);
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete one or more bank transactions. Body: { txn_ids: [string] } (or single :txn_id param)
router.delete('/v2/bank/transactions/:txn_id', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    await supabase.from('bank_transactions').delete()
      .eq('tenant_id', tenant).eq('txn_id', req.params.txn_id);
    audit.log(req, 'delete', 'bank_txn', req.params.txn_id);
    res.json({ status: 'ok', deleted: 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/v2/bank/transactions/bulk-delete', loginRequired, async (req, res) => {
  try {
    const tenant = await getTenantId(req);
    const ids = Array.isArray(req.body && req.body.txn_ids) ? req.body.txn_ids : [];
    if (!ids.length) return res.status(400).json({ error: 'No txn_ids provided.' });
    await supabase.from('bank_transactions').delete()
      .eq('tenant_id', tenant).in('txn_id', ids);
    for (const id of ids) audit.log(req, 'delete', 'bank_txn', id);
    res.json({ status: 'ok', deleted: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Backfill (idempotent) ----------------
router.post('/v2/backfill-journal', loginRequired, masterOnly, async (req, res) => {
  try {
    const invoices = await loadInvoices(req);
    const payments = await allPaymentsRaw(req);
    const expenses = await allExpensesRaw(req);
    let posted = 0;
    for (const inv of invoices) { await journal.postInvoice(req, inv); posted++; }
    for (const p of payments)   { await journal.postPayment(req, p);  posted++; }
    for (const x of expenses)   { await journal.postExpense(req, x);  posted++; }
    res.json({ status: 'ok', invoices: invoices.length, payments: payments.length, expenses: expenses.length, posted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
