// Document conversion service: PO -> GRN -> Bill workflow.
//
// Valid conversions (purchase side):
//   po   -> grn    (carry forward remaining qty)
//   grn  -> bill   (carry forward received qty, adds tax/totals)
//   po   -> bill   (skip GRN, direct bill)

const { loadInvoices } = require('../repositories/documents.repo');
const { listChildren } = require('../repositories/docLinks.repo');

const VALID_NEXT = {
  po:  ['grn', 'bill'],
  grn: ['bill'],
};

function validNext(docType) {
  return VALID_NEXT[docType] || [];
}

// Sum qty already carried from a parent into its children.
function qtyCarriedByLine(children, lineCount) {
  const out = new Array(lineCount).fill(0);
  for (const c of children) {
    const lm = c.line_map || {};
    for (const [idx, qty] of Object.entries(lm)) {
      const i = parseInt(idx, 10);
      if (Number.isInteger(i) && i >= 0 && i < lineCount) {
        out[i] += parseFloat(qty) || 0;
      }
    }
  }
  return out;
}

// Build pending-qty view of a parent doc.
async function getPending(req, billNo) {
  const invoices = await loadInvoices(req);
  const parent = invoices.find((i) => i.bill_no === billNo);
  if (!parent) return null;
  const children = await listChildren(req, billNo);
  const originalQtys = (parent.qtys || []).map((q) => parseFloat(q) || 0);
  const carried = qtyCarriedByLine(children, originalQtys.length);
  const lines = originalQtys.map((oq, i) => ({
    index: i,
    particular: (parent.particulars || [])[i] || '',
    hsn: (parent.hsns || [])[i] || '',
    rate: parseFloat((parent.rates || [])[i] || 0) || 0,
    taxrate: parseFloat((parent.taxrates || [])[i] || 0) || 0,
    qty_ordered: oq,
    qty_carried: Math.round(carried[i] * 1000) / 1000,
    qty_pending: Math.round((oq - carried[i]) * 1000) / 1000,
  }));
  const anyPending = lines.some((l) => l.qty_pending > 0.0001);
  return {
    parent_bill_no: parent.bill_no,
    parent_type: parent.doc_type || 'invoice',
    client_name: parent.client_name,
    invoice_date: parent.invoice_date,
    children: children.map((c) => ({ bill_no: c.child_bill_no, type: c.child_type, at: c.created_at })),
    lines,
    status: anyPending ? (lines.some((l) => l.qty_carried > 0.0001) ? 'Partial' : 'Open') : 'Closed',
  };
}

// Build prefill body for creating a child doc from a parent (for client-side form).
async function prefillFromParent(req, billNo, toType) {
  const pending = await getPending(req, billNo);
  if (!pending) return { error: 'Parent not found' };
  if (!validNext(pending.parent_type).includes(toType)) {
    return { error: `Cannot convert ${pending.parent_type} -> ${toType}` };
  }
  const invoices = await loadInvoices(req);
  const parent = invoices.find((i) => i.bill_no === billNo);
  if (!parent) return { error: 'Parent not found' };

  const useLines = pending.lines.filter((l) => l.qty_pending > 0.0001);
  if (!useLines.length) return { error: 'Nothing pending to convert' };

  const body = {
    doc_category: 'purchase',
    doc_type: toType,
    is_non_gst: !!parent.is_non_gst,
    client_name: parent.client_name,
    client_address1: parent.client_address1, client_address2: parent.client_address2,
    client_pincode: parent.client_pincode, client_district: parent.client_district,
    client_state: parent.client_state, client_gstin: parent.client_gstin,
    client_email: parent.client_email, client_mobile: parent.client_mobile,
    invoice_type: parent.invoice_type || 'goods',
    po_number: toType === 'bill' || toType === 'grn' ? (parent.bill_no || '') : (parent.po_number || ''),
    particulars: useLines.map((l) => l.particular),
    qtys: useLines.map((l) => l.qty_pending),
    rates: useLines.map((l) => l.rate),
    taxrates: useLines.map((l) => l.taxrate),
    hsns: useLines.map((l) => l.hsn),
    amounts: useLines.map((l) => Math.round(l.rate * l.qty_pending * (1 + l.taxrate / 100) * 100) / 100),
    _parent_bill_no: parent.bill_no,
    _parent_type: pending.parent_type,
    _parent_line_indexes: useLines.map((l) => l.index),
    _parent_line_qtys: useLines.map((l) => l.qty_pending),
  };
  return { ok: true, prefill: body };
}

module.exports = { getPending, prefillFromParent, validNext };
