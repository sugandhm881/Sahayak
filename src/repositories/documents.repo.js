const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');
const journal = require('../services/accounting/journal');
const audit = require('../services/accounting/audit');
const { parseInvoiceDate } = require('../utils/dates');

// ── Indexed real columns (migration 002) ─────────────────────────────────────
// Hot fields are mirrored out of the JSONB blob into real columns so lists,
// filters, and future aggregates can run in the database. If migration 002
// hasn't been applied yet, the first failing write flips this flag and all
// writes fall back to JSONB-only (loudly).
let extraColsSupported = true;

function isMissingColumnErr(e) {
  return !!e && (e.code === 'PGRST204' || /column|schema cache/i.test(e.message || ''));
}

function extractIndexCols(data) {
  let iso = null;
  const d = parseInvoiceDate(data.invoice_date || '');
  if (d && !isNaN(d.getTime())) {
    iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return {
    doc_date: iso,
    grand_total: Number.isFinite(parseFloat(data.grand_total)) ? parseFloat(data.grand_total) : null,
    client_name: data.client_name || null,
    status: data.status || null,
    doc_type: data.doc_type || 'invoice',
  };
}

// Run a documents write with the indexed columns; on "column does not exist",
// retry without them and disable them for this process.
async function writeDocRow(buildQuery, baseRow, cols) {
  if (extraColsSupported) {
    const { error } = await buildQuery({ ...baseRow, ...cols });
    if (!error) return null;
    if (isMissingColumnErr(error)) {
      extraColsSupported = false;
      console.warn('[documents] indexed columns missing — run migrations/002_sessions_counters_indexes.sql. Falling back to JSONB-only writes.');
    } else {
      return error;
    }
  }
  const { error: e2 } = await buildQuery(baseRow);
  return e2 || null;
}

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

// Filtered + paginated load — used by /v2/invoices-list only. Existing callers unaffected.
async function loadInvoicesFiltered(req, { category, from, to, page = 1, limit = 50 } = {}) {
  const tenant = await getTenantId(req);
  const buildQuery = (useCols) => {
    let q = supabase.from('documents').select('data, bill_no, collection_name', { count: 'exact' })
      .eq('tenant_id', tenant)
      .order('bill_no', { ascending: false });
    if (category === 'sale')     q = q.in('collection_name', ['sales_invoices','sales_credit_notes','sales_debit_notes']);
    if (category === 'purchase') q = q.in('collection_name', ['purchase_bills','purchase_orders','purchase_grns','purchase_misc']);
    // Date filtering on the indexed doc_date column (migration 002) — correct
    // (dates, not strings) and applied BEFORE pagination.
    if (useCols && from) q = q.gte('doc_date', from);
    if (useCols && to)   q = q.lte('doc_date', to);
    const offset = (Math.max(1, page) - 1) * limit;
    return q.range(offset, offset + limit - 1);
  };

  let { data, count, error } = await buildQuery(extraColsSupported);
  if (error && isMissingColumnErr(error)) {
    extraColsSupported = false;
    console.warn('[documents] doc_date column missing — run migrations/002. Falling back to in-JS date filter.');
    ({ data, count, error } = await buildQuery(false));
  }
  if (error) throw error;
  let rows = (data || []).map((r) => r.data);
  if (!extraColsSupported) {
    // Legacy fallback: filter within the fetched page only
    if (from) rows = rows.filter((r) => (r.invoice_date || '') >= from);
    if (to)   rows = rows.filter((r) => (r.invoice_date || '') <= to);
  }
  return { rows, total: count || 0, page, limit };
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
  const upsertErr = await writeDocRow(
    (row) => supabase.from('documents').upsert(row, { onConflict: 'tenant_id,bill_no' }),
    { tenant_id: tenant, bill_no: billNo, collection_name: coll, data: invoiceData },
    extractIndexCols(invoiceData)
  );
  if (upsertErr) throw upsertErr;
  journal.postInvoice(req, invoiceData).catch((e) =>
    console.error('[journal] postInvoice FAILED for', invoiceData.bill_no, '-', e && e.message, '(ledger will drift — run /v2/backfill-journal)'));
  audit.log(req, 'upsert', 'invoice', invoiceData.bill_no, {
    category: invoiceData.doc_category || 'sale',
    grand_total: invoiceData.grand_total,
    client: invoiceData.client_name,
  });
}

// Strict insert for NEW documents: never overwrites an existing bill number.
// The (tenant_id, bill_no) primary key makes this the atomic guard against two
// concurrent saves racing to the same number — the loser gets DUPLICATE_BILL_NO
// and the caller can retry with the next number.
async function insertNewInvoice(req, invoiceData) {
  const tenant = await getTenantId(req);
  if (await isLocked(req, invoiceData)) {
    const err = new Error('Financial period is locked for this invoice date.');
    err.status = 423;
    throw err;
  }
  const coll = getCollectionName(invoiceData);
  const billNo = String(invoiceData.bill_no).replace(/\//g, '_');
  const insertErr = await writeDocRow(
    (row) => supabase.from('documents').insert(row),
    { tenant_id: tenant, bill_no: billNo, collection_name: coll, data: invoiceData },
    extractIndexCols(invoiceData)
  );
  if (insertErr) {
    if (insertErr.code === '23505') {
      const err = new Error(`Bill number '${invoiceData.bill_no}' already exists.`);
      err.code = 'DUPLICATE_BILL_NO';
      err.status = 409;
      throw err;
    }
    throw insertErr;
  }
  journal.postInvoice(req, invoiceData).catch((e) =>
    console.error('[journal] postInvoice FAILED for', invoiceData.bill_no, '-', e && e.message, '(ledger will drift — run /v2/backfill-journal)'));
  audit.log(req, 'insert', 'invoice', invoiceData.bill_no, {
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
  journal.deleteInvoiceJournal(req, billNo).catch((e) =>
    console.error('[journal] deleteInvoiceJournal FAILED for', billNo, '-', e && e.message));
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
  const updateErr = await writeDocRow(
    (row) => supabase.from('documents').update(row).eq('tenant_id', tenant).eq('bill_no', doc_id),
    { data: newData },
    extractIndexCols(newData)
  );
  if (updateErr) throw updateErr;
  journal.postInvoice(req, newData).catch((e) =>
    console.error('[journal] postInvoice FAILED for', newData.bill_no, '-', e && e.message, '(ledger will drift — run /v2/backfill-journal)'));
  audit.log(req, 'update', 'invoice', billNo, {
    grand_total: newData.grand_total,
    status: newData.status,
  });
}

// Merge a small patch into a document's data without triggering the period-lock check.
// Use only for non-financial metadata (e.g. rapidshyp_shipment_id).
async function patchDocumentMeta(req, billNo, patch) {
  const tenant = await getTenantId(req);
  const doc_id = String(billNo).replace(/\//g, '_');
  const { data: rows, error: selErr } = await supabase.from('documents').select('data').eq('tenant_id', tenant).eq('bill_no', doc_id).single();
  if (selErr || !rows) throw new Error('Invoice not found');
  const merged = { ...rows.data, ...patch };
  const error = await writeDocRow(
    (row) => supabase.from('documents').update(row).eq('tenant_id', tenant).eq('bill_no', doc_id),
    { data: merged },
    extractIndexCols(merged)
  );
  if (error) throw error;
}

module.exports = {
  getCollectionName,
  loadInvoices,
  loadInvoicesForUser,
  loadInvoicesFiltered,
  saveSingleInvoice,
  insertNewInvoice,
  getDocumentRow,
  deleteDocument,
  updateDocumentData,
  patchDocumentMeta,
};
