const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');
const journal = require('../services/accounting/journal');
const audit = require('../services/accounting/audit');

async function listExpenses(req) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('expenses').select('data').eq('tenant_id', tenant).order('created_at', { ascending: false });
  return (data || []).map((r) => r.data);
}

async function upsertExpense(req, expense_id, entry) {
  const tenant = await getTenantId(req);
  await supabase.from('expenses').upsert(
    { tenant_id: tenant, expense_id, data: entry },
    { onConflict: 'tenant_id,expense_id' }
  );
  journal.postExpense(req, entry).catch(() => {});
  audit.log(req, 'upsert', 'expense', expense_id, { amount: entry.amount, account: entry.account_code });
}

async function deleteExpense(req, expense_id) {
  const tenant = await getTenantId(req);
  await supabase.from('expenses').delete().eq('tenant_id', tenant).eq('expense_id', expense_id);
  journal.deleteExpenseJournal(req, expense_id).catch(() => {});
  audit.log(req, 'delete', 'expense', expense_id);
}

async function allExpensesRaw(req) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('expenses').select('data').eq('tenant_id', tenant);
  return (data || []).map((r) => r.data);
}

module.exports = { listExpenses, upsertExpense, deleteExpense, allExpensesRaw };
