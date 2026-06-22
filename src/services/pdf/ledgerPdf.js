const os = require('os');
const path = require('path');
const fs = require('fs');
const { FpdfShim } = require('./fpdfShim');
const { formatDDMonYYYY } = require('../../utils/dates');

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

async function generateLedgerPdf(party_name, entries, profile) {
  const pdf = new FpdfShim();
  pdf.add_page();

  const tempFiles = [];
  const logoBuf = decodeBase64Image(profile.logo_base64);
  if (logoBuf) {
    const p = writeTempPng(logoBuf);
    tempFiles.push(p);
    pdf.image(p, 10, 8, 25);
  }

  pdf.set_font('Calibri', 'B', 16);
  pdf.cell(0, 8, `Party Ledger: ${party_name}`, 0, 1, 'C');
  pdf.set_font('Calibri', '', 10);
  pdf.cell(0, 5, `Company: ${profile.company_name || 'SM Tech'}`, 0, 1, 'C');
  pdf.cell(0, 5, `Generated On: ${formatDDMonYYYY()}`, 0, 1, 'C');
  pdf.ln(10);

  const printHeader = () => {
    pdf.set_font('Calibri', 'B', 9);
    pdf.set_fill_color(220, 220, 220);
    pdf.cell(20, 8, 'Date', 1, 0, 'C', true);
    pdf.cell(45, 8, 'Doc No', 1, 0, 'C', true);
    pdf.cell(55, 8, 'Narration', 1, 0, 'C', true);
    pdf.cell(22, 8, 'Debit (Dr)', 1, 0, 'R', true);
    pdf.cell(22, 8, 'Credit (Cr)', 1, 0, 'R', true);
    pdf.cell(26, 8, 'Balance', 1, 1, 'R', true);
    pdf.set_font('Calibri', '', 8);
  };

  printHeader();

  let running = 0;
  for (const e of entries) {
    running += e.debit - e.credit;
    const bal_str = `${Math.abs(running).toFixed(2)} ${running > 0 ? 'Dr' : (running < 0 ? 'Cr' : '')}`;

    const text = e.narration || '';
    const words = text.split(/\s+/);
    let lines = 1;
    let current_line = '';
    for (const w of words) {
      if (pdf.get_string_width(current_line + w + ' ') > 53) {
        lines += 1;
        current_line = w + ' ';
      } else {
        current_line += w + ' ';
      }
    }
    const row_h = Math.max(lines * 5, 8);

    if (pdf.get_y() + row_h > 280) {
      pdf.add_page();
      printHeader();
    }

    const start_y = pdf.get_y();
    const start_x = pdf.get_x();

    pdf.cell(20, row_h, e.date, 1, 0, 'C');

    const doc_str = e.doc_no || '';
    if (pdf.get_string_width(doc_str) > 43) pdf.set_font('Calibri', '', 7);
    pdf.cell(45, row_h, doc_str, 1, 0, 'C');
    pdf.set_font('Calibri', '', 8);

    pdf.set_x(start_x + 65 + 55);

    pdf.cell(22, row_h, e.debit > 0 ? e.debit.toFixed(2) : '-', 1, 0, 'R');
    pdf.cell(22, row_h, e.credit > 0 ? e.credit.toFixed(2) : '-', 1, 0, 'R');
    pdf.cell(26, row_h, bal_str, 1, 0, 'R');

    const y_offset = (row_h - (lines * 5)) / 2;
    pdf.set_xy(start_x + 65, start_y + y_offset);
    pdf.multi_cell(55, 5, text, 0, 'L');
    pdf.rect(start_x + 65, start_y, 55, row_h);

    pdf.set_y(start_y + row_h);
  }

  pdf.ln(5);
  pdf.set_font('Calibri', 'B', 10);
  const final_bal = `${Math.abs(running).toFixed(2)} ${running > 0 ? 'Dr' : (running < 0 ? 'Cr' : '')}`;
  pdf.cell(0, 8, `Closing Balance: Rs. ${final_bal}`, 0, 1, 'R');

  const out = await pdf.output();
  tempFiles.forEach(safeUnlink);
  return out;
}

module.exports = { generateLedgerPdf };
