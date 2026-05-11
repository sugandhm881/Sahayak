const ExcelJS = require('exceljs');
const { loadInvoicesForUser } = require('../../repositories/documents.repo');

async function generateReportExcel(req, userId) {
  const invoices = await loadInvoicesForUser(req, userId);
  if (!invoices.length) return null;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sales Register');
  ws.addRow(['Invoice Date', 'Bill No', 'Party Name', 'GSTIN', 'Item Name', 'HSN', 'Qty', 'Rate', 'Disc %', 'GST %', 'Taxable', 'Tax Amt', 'Total', 'Type', 'Category']);

  for (const inv of invoices) {
    const particulars = inv.particulars || [];
    for (let i = 0; i < particulars.length; i++) {
      const d_cat = inv.doc_category || 'sale';
      const d_type = inv.doc_type || 'invoice';
      let t_str;
      if (d_cat === 'purchase') {
        if (inv.is_debit_note || d_type === 'dn') t_str = 'Debit Note';
        else if (d_type === 'po') t_str = 'PO';
        else if (d_type === 'grn') t_str = 'GRN';
        else t_str = 'Purchase Bill';
      } else {
        if (inv.is_credit_note || d_type === 'cn') t_str = 'Credit Note';
        else if (inv.is_non_gst) t_str = 'Bill of Supply';
        else t_str = 'Tax Invoice';
      }
      const g = (arr, i) => (arr && i < arr.length ? arr[i] : '');
      ws.addRow([
        inv.invoice_date, inv.bill_no, inv.client_name, inv.client_gstin,
        particulars[i], g(inv.hsns, i),
        parseFloat(g(inv.qtys, i)) || 0, parseFloat(g(inv.rates, i)) || 0,
        parseFloat(g(inv.discounts, i)) || 0, parseFloat(g(inv.taxrates, i)) || 0,
        parseFloat(g(inv.amounts, i)) || 0, parseFloat(g(inv.line_tax_amounts, i)) || 0,
        parseFloat(g(inv.line_total_amounts, i)) || 0,
        t_str, d_cat.toUpperCase(),
      ]);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { generateReportExcel };
