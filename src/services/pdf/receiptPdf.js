const os = require('os');
const path = require('path');
const fs = require('fs');
const { FpdfShim } = require('./fpdfShim');
const { convertToWords } = require('../../utils/words');

function writeTempPng(buf) {
  const p = path.join(os.tmpdir(), `img_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(p, buf);
  return p;
}
function safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }
function decodeBase64Image(b64) {
  if (!b64) return null;
  const payload = b64.includes(',') ? b64.split(',')[1] : b64;
  try { return Buffer.from(payload, 'base64'); } catch { return null; }
}

async function generateReceiptPdf(payment_data, profile) {
  const pdf = new FpdfShim();
  pdf.add_page();

  const margin = 15;
  const page_width = pdf.w - 30;

  const is_receipt = payment_data.payment_type === 'receipt';
  const color = is_receipt ? [34, 197, 94] : [239, 68, 68];

  pdf.set_fill_color(...color);
  pdf.rect(0, 0, pdf.w, 28, 'F');

  const tempFiles = [];
  const logoBuf = decodeBase64Image(profile.logo_base64);
  if (logoBuf) {
    const p = writeTempPng(logoBuf);
    tempFiles.push(p);
    pdf.image(p, 15, 6, null, 16);
  }

  pdf.set_y(9);
  pdf.set_font('Calibri', 'B', 22);
  pdf.set_text_color(255, 255, 255);
  const title = is_receipt ? 'RECEIPT VOUCHER' : 'PAYMENT VOUCHER';
  pdf.cell(page_width, 10, title, 0, 1, 'R');

  pdf.set_y(38);
  pdf.set_text_color(0, 0, 0);
  // Auto-shrink company name so long names don't overflow.
  const company_name_r = profile.company_name || 'SM Tech';
  const max_company_width_r = page_width - 70;
  let company_size_r = 16;
  pdf.set_font('Calibri', 'B', company_size_r);
  while (pdf.get_string_width(company_name_r) > max_company_width_r && company_size_r > 9) {
    company_size_r -= 1;
    pdf.set_font('Calibri', 'B', company_size_r);
  }
  pdf.cell(page_width, 8, company_name_r, 0, 1, 'C');
  pdf.set_font('Calibri', '', 10);

  const addr = [];
  if (profile.address_1) addr.push(profile.address_1);
  if (profile.address_2) addr.push(profile.address_2);
  if (addr.length) pdf.cell(page_width, 5, addr.join(', '), 0, 1, 'C');

  const contact = [];
  if (profile.phone) contact.push(`Phone: ${profile.phone}`);
  if (profile.email) contact.push(`Email: ${profile.email}`);
  if (contact.length) pdf.cell(page_width, 5, contact.join(' | '), 0, 1, 'C');

  pdf.ln(12);

  pdf.set_font('Calibri', 'B', 12);
  pdf.set_fill_color(245, 245, 245);
  pdf.cell(page_width, 10, '  TRANSACTION DETAILS', 1, 1, 'L', true);

  const row = (label, value, valueStyle = '', valueSize = 11) => {
    pdf.set_font('Calibri', 'B', 11);
    pdf.cell(40, 10, `  ${label}`, 'L');
    pdf.set_font('Calibri', valueStyle, valueSize);
    pdf.cell(page_width - 40, 10, String(value || ''), 'R', 1);
  };

  const pid = payment_data.payment_id || '';
  row('Voucher No:', pid.slice(-6));
  row('Date:', payment_data.payment_date);
  row('Party Name:', payment_data.party_name, 'B', 12);
  row('Payment Mode:', payment_data.mode || 'Cash');
  row('Ref Invoice:', payment_data.ref_invoice || 'N/A');
  const amt = parseFloat(payment_data.amount || 0);
  row('Amount:', `Rs. ${amt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 'B', 14);
  pdf.cell(page_width, 0, '', 'T', 1);

  pdf.ln(5);
  pdf.set_font('Calibri', 'I', 11);
  pdf.multi_cell(page_width, 6, `Amount in words: Rupees ${convertToWords(amt)}.`);

  if (payment_data.notes) {
    pdf.ln(5);
    pdf.set_font('Calibri', 'B', 11);
    pdf.cell(15, 6, 'Notes: ');
    pdf.set_font('Calibri', '', 11);
    pdf.multi_cell(0, 6, payment_data.notes);
  }

  pdf.ln(25);
  pdf.set_font('Calibri', 'I', 10);
  pdf.set_text_color(150, 150, 150);
  pdf.cell(0, 10, 'This is a computer-generated voucher and does not require a physical signature.', 0, 0, 'C');

  const out = await pdf.output();
  tempFiles.forEach(safeUnlink);
  return out;
}

module.exports = { generateReceiptPdf };
