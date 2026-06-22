const ExcelJS = require('exceljs');
const { loadInvoicesForUser } = require('../../repositories/documents.repo');
const { getSellerProfile } = require('../../repositories/configs.repo');

const INDIGO   = 'FF4338CA';
const INDIGO_L = 'FFEDE9FE';
const ROW_ALT  = 'FFF5F3FF';
const RED_TEXT = 'FFDC2626';
const WHITE    = 'FFFFFFFF';
const MONEY    = '#,##0.00';

const MON_NUM = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
                  Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };

// Parse "DD-Mon-YYYY" → JS Date (for sorting)
function parseDate(s) {
  if (!s) return null;
  const [d, m, y] = (s || '').split('-');
  const mo = MON_NUM[m];
  if (!mo) return null;
  return new Date(`${y}-${mo}-${d}`);
}

function docTypeLabel(inv) {
  const cat   = inv.doc_category || 'sale';
  const dtype = inv.doc_type     || 'invoice';
  if (cat === 'purchase') {
    if (inv.is_debit_note || dtype === 'dn') return 'Debit Note';
    if (dtype === 'po')  return 'PO';
    if (dtype === 'grn') return 'GRN';
    return 'Purchase Bill';
  }
  if (inv.is_credit_note || dtype === 'cn') return 'Credit Note';
  if (inv.is_non_gst) return 'Bill of Supply';
  return 'Tax Invoice';
}

function styleHeader(ws, cols) {
  const hr = ws.getRow(1);
  hr.height = 30;
  hr.font      = { bold: true, color: { argb: WHITE }, size: 10 };
  hr.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: INDIGO } };
  hr.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  for (let c = 1; c <= cols; c++) {
    ws.getCell(1, c).border = { bottom: { style: 'medium', color: { argb: INDIGO } } };
  }
}

function totalRow(ws, firstData, lastData, moneyCols, labelCol, labelText) {
  const rowData = new Array(ws.columnCount).fill('');
  if (labelCol) rowData[labelCol - 1] = labelText || 'TOTAL';
  const row = ws.addRow(rowData);
  moneyCols.forEach(c => {
    row.getCell(c).value  = { formula: `SUM(${ws.getColumn(c).letter}${firstData}:${ws.getColumn(c).letter}${lastData})` };
    row.getCell(c).numFmt = MONEY;
  });
  row.font = { bold: true, size: 10 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INDIGO_L } };
  return row;
}

async function generateReportExcel(req, userId, opts = {}) {
  let isService = false;
  try { const prof = await getSellerProfile(req); isService = (prof.invoice_type || 'goods') === 'service'; } catch {}

  const all      = await loadInvoicesForUser(req, userId);
  const category = opts.category || 'sale';
  const invoices = all.filter(i => (i.doc_category || 'sale') === category);
  if (!invoices.length) return null;

  // Sort by date asc, then bill_no
  invoices.sort((a, b) => {
    const da = parseDate(a.invoice_date), db = parseDate(b.invoice_date);
    if (da && db && da - db !== 0) return da - db;
    return (a.bill_no || '').localeCompare(b.bill_no || '', undefined, { numeric: true });
  });

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Sahayak ERP';
  wb.created  = new Date();

  // ──────────────────────────────────────────────────────────────────────
  // Sheet 1 — Line-Item Register
  // ──────────────────────────────────────────────────────────────────────
  const ws = wb.addWorksheet(category === 'purchase' ? 'Purchase Register' : 'Sales Register');
  ws.views       = [{ state: 'frozen', ySplit: 1 }];

  ws.columns = [
    { header: 'S.No.',             width: 6  },
    { header: 'Invoice Date',      width: 14 },
    { header: 'Bill No',           width: 18 },
    { header: 'Party Name',        width: 30 },
    { header: 'GSTIN',             width: 18 },
    { header: 'State / POS',       width: 16 },
    { header: 'Doc Type',          width: 14 },
    { header: 'Item / Service',    width: 32 },
    { header: 'HSN / SAC',         width: 11 },
    { header: 'Qty',               width: 8  },
    { header: 'Rate (₹)',          width: 13 },
    { header: 'Disc %',            width: 8  },
    { header: 'Taxable (₹)',       width: 15 },
    { header: 'GST %',             width: 7  },
    { header: 'CGST (₹)',          width: 13 },
    { header: 'SGST (₹)',          width: 13 },
    { header: 'IGST (₹)',          width: 13 },
    { header: 'Total GST (₹)',     width: 14 },
    { header: 'Line Total (₹)',    width: 15 },
    { header: 'Pay Status',        width: 12 },
  ];
  styleHeader(ws, 20);
  ws.autoFilter = { from: 'A1', to: 'T1' };
  if (isService) ws.getColumn(11).hidden = true; // Rate (₹) not applicable for service accounts

  const g = (arr, i) => (arr && i < arr.length ? arr[i] : '');
  let sno = 0;

  for (const inv of invoices) {
    const parts = inv.particulars || [];
    const is_igst = !!(inv.is_interstate || (parseFloat(inv.igst) > 0));
    const typeLabel = docTypeLabel(inv);
    const isCN = inv.is_credit_note || (inv.doc_type === 'cn');

    for (let i = 0; i < parts.length; i++) {
      sno++;
      const taxable  = parseFloat(g(inv.amounts,           i)) || 0;
      const taxAmt   = parseFloat(g(inv.line_tax_amounts,  i)) || 0;
      const lineTotal= parseFloat(g(inv.line_total_amounts,i)) || 0;
      const cgst = is_igst ? 0 : +(taxAmt / 2).toFixed(2);
      const sgst = is_igst ? 0 : +(taxAmt / 2).toFixed(2);
      const igst = is_igst ? taxAmt : 0;

      const row = ws.addRow([
        sno,
        inv.invoice_date,
        inv.bill_no,
        inv.client_name      || '',
        inv.client_gstin     || '',
        inv.client_state     || '',
        typeLabel,
        parts[i],
        g(inv.hsns,      i),
        parseFloat(g(inv.qtys,      i)) || 0,
        parseFloat(g(inv.rates,     i)) || 0,
        parseFloat(g(inv.discounts, i)) || 0,
        taxable,
        parseFloat(g(inv.taxrates,  i)) || 0,
        cgst,
        sgst,
        igst,
        taxAmt,
        lineTotal,
        inv.status || '',
      ]);

      // Number formats
      row.getCell(10).numFmt = '#,##0.##';   // Qty
      row.getCell(11).numFmt = MONEY;         // Rate
      row.getCell(12).numFmt = '0.##';        // Disc %
      row.getCell(13).numFmt = MONEY;         // Taxable
      row.getCell(14).numFmt = '0';           // GST %
      row.getCell(15).numFmt = MONEY;         // CGST
      row.getCell(16).numFmt = MONEY;         // SGST
      row.getCell(17).numFmt = MONEY;         // IGST
      row.getCell(18).numFmt = MONEY;         // Total GST
      row.getCell(19).numFmt = MONEY;         // Line Total

      row.font = { size: 10, ...(isCN ? { color: { argb: RED_TEXT } } : {}) };
      if (sno % 2 === 0 && !isCN) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT } };
      }
    }
  }

  if (sno > 0) {
    totalRow(ws, 2, sno + 1, [13, 15, 16, 17, 18, 19], 12, 'TOTAL');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Sheet 2 — Invoice Summary (one row per invoice)
  // ──────────────────────────────────────────────────────────────────────
  const ws2 = wb.addWorksheet('Invoice Summary');
  ws2.views = [{ state: 'frozen', ySplit: 1 }];
  ws2.columns = [
    { header: 'S.No.',          width: 6  },
    { header: 'Invoice Date',   width: 14 },
    { header: 'Bill No',        width: 18 },
    { header: 'Party Name',     width: 30 },
    { header: 'GSTIN',          width: 18 },
    { header: 'State',          width: 16 },
    { header: 'Doc Type',       width: 14 },
    { header: 'Taxable (₹)',    width: 15 },
    { header: 'CGST (₹)',       width: 13 },
    { header: 'SGST (₹)',       width: 13 },
    { header: 'IGST (₹)',       width: 13 },
    { header: 'Total GST (₹)', width: 14 },
    { header: 'Grand Total (₹)',width: 16 },
    { header: 'Pay Status',     width: 12 },
  ];
  styleHeader(ws2, 14);
  ws2.autoFilter = { from: 'A1', to: 'N1' };

  let ssno = 0;
  for (const inv of invoices) {
    const is_igst = !!(inv.is_interstate || (parseFloat(inv.igst) > 0));
    const isCN    = inv.is_credit_note || (inv.doc_type === 'cn');
    const sumTaxable = (inv.amounts          || []).reduce((s, v) => s + (parseFloat(v) || 0), 0);
    const sumTax     = (inv.line_tax_amounts  || []).reduce((s, v) => s + (parseFloat(v) || 0), 0);
    const grand      = parseFloat(inv.grand_total) || 0;
    const cgst = is_igst ? 0 : +(sumTax / 2).toFixed(2);
    const sgst = is_igst ? 0 : +(sumTax / 2).toFixed(2);
    const igst = is_igst ? sumTax : 0;

    ssno++;
    const row = ws2.addRow([
      ssno,
      inv.invoice_date,
      inv.bill_no,
      inv.client_name   || '',
      inv.client_gstin  || '',
      inv.client_state  || '',
      docTypeLabel(inv),
      sumTaxable,
      cgst, sgst, igst,
      sumTax,
      grand,
      inv.status || '',
    ]);

    [8,9,10,11,12,13].forEach(c => { row.getCell(c).numFmt = MONEY; });
    row.font = { size: 10, ...(isCN ? { color: { argb: RED_TEXT } } : {}) };
    if (ssno % 2 === 0 && !isCN) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT } };
    }
  }
  if (ssno > 0) {
    totalRow(ws2, 2, ssno + 1, [8,9,10,11,12,13], 7, 'TOTAL');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Sheet 3 — Monthly Summary
  // ──────────────────────────────────────────────────────────────────────
  const ws3 = wb.addWorksheet('Monthly Summary');
  ws3.views = [{ state: 'frozen', ySplit: 1 }];
  ws3.columns = [
    { header: 'Month',           width: 14 },
    { header: '# Invoices',      width: 12 },
    { header: 'Taxable (₹)',    width: 18 },
    { header: 'Total GST (₹)', width: 18 },
    { header: 'Grand Total (₹)',width: 18 },
  ];
  styleHeader(ws3, 5);

  const byMonth = {};
  for (const inv of invoices) {
    const parts2 = (inv.invoice_date || '').split('-');
    if (parts2.length !== 3) continue;
    const key   = `${parts2[2]}-${MON_NUM[parts2[1]] || '00'}`;
    const label = `${parts2[1]} ${parts2[2]}`;
    if (!byMonth[key]) byMonth[key] = { label, count: 0, taxable: 0, gst: 0, grand: 0 };
    byMonth[key].count++;
    (inv.amounts         || []).forEach(v => { byMonth[key].taxable += parseFloat(v) || 0; });
    (inv.line_tax_amounts|| []).forEach(v => { byMonth[key].gst     += parseFloat(v) || 0; });
    byMonth[key].grand += parseFloat(inv.grand_total) || 0;
  }

  let mno = 0;
  for (const key of Object.keys(byMonth).sort()) {
    mno++;
    const m   = byMonth[key];
    const row = ws3.addRow([m.label, m.count, m.taxable, m.gst, m.grand]);
    [3,4,5].forEach(c => { row.getCell(c).numFmt = MONEY; });
    row.font = { size: 10 };
    if (mno % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT } };
  }
  if (mno > 0) {
    const tr = ws3.addRow([
      'TOTAL',
      { formula: `SUM(B2:B${mno + 1})` },
      { formula: `SUM(C2:C${mno + 1})` },
      { formula: `SUM(D2:D${mno + 1})` },
      { formula: `SUM(E2:E${mno + 1})` },
    ]);
    [3,4,5].forEach(c => { tr.getCell(c).numFmt = MONEY; });
    tr.font = { bold: true, size: 10 };
    tr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INDIGO_L } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { generateReportExcel };