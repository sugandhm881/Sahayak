const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');
const journal = require('../services/accounting/journal');
const audit = require('../services/accounting/audit');

async function listPayments(req) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('payments').select('data').eq('tenant_id', tenant).order('created_at', { ascending: false });
  return (data || []).map((r) => r.data);
}

async function upsertPayment(req, payment_id, entry) {
  const tenant = await getTenantId(req);
  await supabase.from('payments').upsert(
    { tenant_id: tenant, payment_id, data: entry },
    { onConflict: 'tenant_id,payment_id' }
  );
  journal.postPayment(req, entry).catch(() => {});
  audit.log(req, 'upsert', entry.payment_type === 'payment' ? 'payment' : 'receipt', payment_id, {
    amount: entry.amount, party: entry.party_name, ref_invoice: entry.ref_invoice,
  });
}

async function getPayment(req, payment_id) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('payments').select('data').eq('tenant_id', tenant).eq('payment_id', payment_id);
  return data && data[0] ? data[0].data : null;
}

async function deletePayment(req, payment_id) {
  const tenant = await getTenantId(req);
  await supabase.from('payments').delete().eq('tenant_id', tenant).eq('payment_id', payment_id);
  journal.deletePaymentJournal(req, payment_id).catch(() => {});
  audit.log(req, 'delete', 'payment_or_receipt', payment_id);
}

async function allPaymentsRaw(req) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('payments').select('data').eq('tenant_id', tenant);
  return (data || []).map((r) => r.data);
}

module.exports = { listPayments, upsertPayment, getPayment, deletePayment, allPaymentsRaw };
