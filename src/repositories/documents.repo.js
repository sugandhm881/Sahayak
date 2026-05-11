const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');
const journal = require('../services/accounting/journal');
const audit = require('../services/accounting/audit');

async function isLocked(req, invoiceData) {
  try {
    const { isPeriodLocked } = journal;
    if (!isPeriodLocked) return false;
    const tenant = await getTenantId(req);
    const { parseInvoiceDate, fyString } = require('../utils/dates');
    const d = parseInvoiceDate(invoiceData.invoice_date) || new Date();
    return await isPeriodLocked(tenant, d.toISOString().slice(0, 10));
  } catch { return false; }
}

function getCollectionName(data) {
  const cat = data.doc_category || 'sale';
  const dtype = data.doc_type || 'invoice';
  const isCn = !!data.is_credit_note;
  const isDn = !!data.is_debit_note;
  if (cat === 'purchase') {
    if (isDn) return 'purchase_debit_notes';
    if (dtype === 'po') return 'purchase_orders';
    if (dtype === 'grn') return 'purchase_grns';
    if (dtype === 'bill') return 'purchase_bills';
    return 'purchase_misc';
  }
  if (isCn) return 'sales_credit_notes';
  if (isDn) return 'sales_debit_notes';
  return 'sales_invoices';
}

async function loadInvoices(req) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('documents').select('data').eq('tenant_id', tenant);
  return (data || []).map((r) => r.data);
}

async function loadInvoicesForUser(req, targetUserId) {
  const tenant = await getTenantId(req, targetUserId);
  const { data } = await supabase.from('documents').select('data').eq('tenant_id', tenant);
  return (data || []).map((r) => r.data);
}

async function saveSingleInvoice(req, invoiceData) {
  const tenant = await getTenantId(req);
  if (await isLocked(req, invoiceData)) {
    const err = new Error('Financial period is locked for this invoice date.');
    err.status = 423;
    throw err;
  }
  const coll = getCollectionName(invoiceData);
  const billNo = String(invoiceData.bill_no).replace(/\//g, '_');
  await supabase.from('documents').upsert(
    { tenant_id: tenant, bill_no: billNo, collection_name: coll, data: invoiceData },
    { onConflict: 'tenant_id,bill_no' }
  );
  journal.postInvoice(req, invoiceData).catch(() => {});
  audit.log(req, 'upsert', 'invoice', invoiceData.bill_no, {
    category: invoiceData.doc_category || 'sale',
    grand_total: invoiceData.grand_total,
    client: invoiceData.client_name,
  });
}

async function getDocumentRow(req, billNo) {
  const tenant = await getTenantId(req);
  const doc_id = String(billNo).replace(/\//g, '_');
  const { data } = await supabase.from('documents').select('data').eq('tenant_id', tenant).eq('bill_no', doc_id);
  return { tenant, doc_id, row: data && data[0] ? data[0] : null };
}

async function deleteDocument(req, billNo) {
  const tenant = await getTenantId(req);
  const doc_id = String(billNo).replace(/\//g, '_');
  const { data, error } = await supabase.from('documents').delete().eq('tenant_id', tenant).eq('bill_no', doc_id).select();
  if (error) throw error;
  journal.deleteInvoiceJournal(req, billNo).catch(() => {});
  audit.log(req, 'delete', 'invoice', billNo);
  return data && data.length > 0;
}

async function updateDocumentData(req, billNo, newData) {
  const tenant = await getTenantId(req);
  if (await isLocked(req, newData)) {
    const err = new Error('Financial period is locked for this invoice date.');
    err.status = 423;
    throw err;
  }
  const doc_id = String(billNo).replace(/\//g, '_');
  await supabase.from('documents').update({ data: newData }).eq('tenant_id', tenant).eq('bill_no', doc_id);
  journal.postInvoice(req, newData).catch(() => {});
  audit.log(req, 'update', 'invoice', billNo, {
    grand_total: newData.grand_total,
    status: newData.status,
  });
}

module.exports = {
  getCollectionName,
  loadInvoices,
  loadInvoicesForUser,
  saveSingleInvoice,
  getDocumentRow,
  deleteDocument,
  updateDocumentData,
};
