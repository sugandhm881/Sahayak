const ExcelJS = require('exceljs');
const { STATE_CODES } = require('../../config/constants');
const { loadInvoices } = require('../../repositories/documents.repo');

async function generateGstr1Excel(req, monthYear) {
  const wb = new ExcelJS.Workbook();
  const b2b = wb.addWorksheet('B2B');
  b2b.addRow(['GSTIN/UIN of Recipient', 'Invoice Number', 'Invoice Date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount']);
  const b2cl = wb.addWorksheet('B2CL');
  b2cl.addRow(['Invoice Number', 'Invoice Date', 'Invoice Value', 'Place Of Supply', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN']);
  const b2cs = wb.addWorksheet('B2CS');
  b2cs.addRow(['Type', 'Place Of Supply', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN']);

  const invoices = (await loadInvoices(req)).filter((d) => (d.doc_category || 'sale') === 'sale');

  for (const inv of invoices) {
    const inv_date = inv.invoice_date || '';
    if (monthYear) {
      const parts = inv_date.split('-');
      if (parts.length === 3) {
        if (`${parts[1]} ${parts[2]}` !== monthYear) continue;
      } else continue;
    }

    const gstin = (inv.client_gstin || '').trim();
    const state_code = STATE_CODES[inv.client_state || ''] || '';
    const pos = state_code ? `${state_code}-${inv.client_state || ''}` : (inv.client_state || '');

    const tax_groups = {};
    const rates = inv.rates || [];
    const taxrates = inv.taxrates || [];
    const amounts = inv.amounts || [];
    for (let i = 0; i < rates.length; i++) {
      const rate = parseFloat(taxrates[i] || 0);
      const taxable = parseFloat(amounts[i] || 0);
      tax_groups[rate] = (tax_groups[rate] || 0) + taxable;
    }

    if (gstin && gstin.length > 5) {
      for (const [rate, taxable] of Object.entries(tax_groups)) {
        b2b.addRow([gstin, inv.bill_no, inv_date, inv.grand_total, pos, 'N', 'Regular', '', parseFloat(rate), taxable, 0]);
      }
    } else {
      for (const [rate, taxable] of Object.entries(tax_groups)) {
        b2cs.addRow(['OE', pos, parseFloat(rate), taxable, 0, '']);
      }
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { generateGstr1Excel };
