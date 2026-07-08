// Goods Receipt Note PDF — landscape warehouse layout (company header, GRN title,
// vendor/PO detail box, wide receiving-columns table). Distinct from the invoice.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { FpdfShim } = require('./fpdfShim');

const INK = [17, 24, 39];
const MUTED = [90, 96, 110];
const BORDER = [120, 128, 145];
const HEADFILL = [242, 244, 248];

const LM = 8;            // left margin
const RM = 289;          // right edge (297 - 8) for landscape A4
const MID = 150;         // vendor/PO column divider
const WIDTH = RM - LM;   // 281mm

const money = (n) => (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);

function writeTempPng(buf) {
  const p = path.join(os.tmpdir(), `grn_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(p, buf);
  return p;
}
function safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }
function decodeBase64Image(b64) {
  if (!b64) return null;
  const payload = b64.includes(',') ? b64.split(',')[1] : b64;
  try { return Buffer.from(payload, 'base64'); } catch { return null; }
}

async function generateGrnPdf(grn, profile, opts = {}) {
  const pdf = new FpdfShim({ landscape: true });
  pdf.add_page();

  const setColor = (c) => pdf.set_text_color(c[0], c[1], c[2]);
  const setDraw = (c) => pdf.set_draw_color(c[0], c[1], c[2]);
  const setFill = (c) => pdf.set_fill_color(c[0], c[1], c[2]);

  const txt = (x, y, str, { size = 8.5, bold = false, color = INK, align = 'L', w = 100, h = 5 } = {}) => {
    pdf.set_font('Calibri', bold ? 'B' : '', size);
    setColor(color);
    pdf.set_xy(x, y);
    pdf.cell(w, h, str == null ? '' : String(str), 0, 0, align);
  };
  const kv = (x, y, label, value, { labelW = 34, valW = 60, bold = false } = {}) => {
    txt(x, y, label, { size: 8.5, color: MUTED, w: labelW });
    txt(x + labelW, y, value == null ? '' : String(value), { size: 8.5, bold, color: INK, w: valW });
  };

  const tempFiles = [];

  // ── 1. HEADER BOX (logo + company) ──────────────────────────────────────────
  const headTop = 8, headH = 26;
  setDraw(BORDER);
  pdf.rect(LM, headTop, WIDTH, headH);
  const logoBuf = decodeBase64Image(profile.logo_base64);
  if (logoBuf) { const lp = writeTempPng(logoBuf); tempFiles.push(lp); try { pdf.image(lp, LM + 3, headTop + 3, 18, 18); } catch {} }
  txt(LM, headTop + 4, (profile.company_name || 'Company'), { size: 14, bold: true, align: 'C', w: WIDTH });
  let hy = headTop + 11;
  [profile.address_1, profile.address_2, `${profile.state || ''}${profile.gstin ? '  ·  GSTIN ' + profile.gstin : ''}`]
    .map((s) => (s || '').trim()).filter(Boolean)
    .forEach((line) => { txt(LM, hy, line, { size: 8.5, align: 'C', w: WIDTH, color: MUTED }); hy += 4.5; });

  // ── 2. GRN TITLE BAND ───────────────────────────────────────────────────────
  const titleTop = headTop + headH;
  setFill(HEADFILL);
  pdf.rect(LM, titleTop, WIDTH, 9, 'FD');
  txt(LM, titleTop + 1.5, 'GRN', { size: 15, bold: true, align: 'C', w: WIDTH });

  // ── 3. VENDOR / PO DETAILS BOX ──────────────────────────────────────────────
  const boxTop = titleTop + 9;
  const boxH = 30;
  pdf.rect(LM, boxTop, WIDTH, boxH);
  pdf.line(MID, boxTop, MID, boxTop + boxH);

  // Left — vendor
  let ly = boxTop + 3;
  const vendAddr = [grn.client_address1, grn.client_address2,
    [grn.client_district, grn.client_state].filter(Boolean).join(', ')].map((s) => (s || '').trim()).filter(Boolean).join(', ');
  kv(LM + 3, ly, 'Vendor Name', grn.client_name || '', { labelW: 34, valW: 110, bold: true }); ly += 5.5;
  kv(LM + 3, ly, 'Vendor Address', vendAddr || 'India', { labelW: 34, valW: 110 }); ly += 5.5;
  kv(LM + 3, ly, 'Vendor TIN No', grn.client_gstin || '', { labelW: 34, valW: 110 });

  // Right — PO / GRN meta
  let ry = boxTop + 3;
  const RX = MID + 3, RLW = 40, rvW = RM - (RX + RLW) - 2;
  const rrow = (label, value) => { kv(RX, ry, label, value, { labelW: RLW, valW: rvW }); ry += 4.6; };
  rrow('PO No', grn.po_number || grn.original_invoice_no || '');
  rrow('PO Ref No', grn.po_ref_no || '');
  rrow('GRN No', grn.bill_no || '');
  rrow('Vendor Invoice No', grn.vendor_invoice_number || '');
  rrow('PO Date', grn.po_date || '');
  rrow('GRN Date', grn.invoice_date || '');

  // ── 4. ITEMS TABLE ──────────────────────────────────────────────────────────
  const cols = [
    { title: 'S.No', w: 12, align: 'C' },
    { title: 'SKU Code', w: 20, align: 'L' },
    { title: 'Product Name', w: 46, align: 'L' },
    { title: 'SKU Desc', w: 20, align: 'L' },
    { title: 'Vendor SKU', w: 20, align: 'L' },
    { title: 'Colour', w: 16, align: 'C' },
    { title: 'Size', w: 14, align: 'C' },
    { title: 'GRN MRP', w: 18, align: 'R' },
    { title: 'Exp Qty', w: 15, align: 'C' },
    { title: 'Recv Qty', w: 16, align: 'C' },
    { title: 'Cost Price', w: 18, align: 'R' },
    { title: 'Batch Code', w: 18, align: 'C' },
    { title: 'Add. Cost', w: 18, align: 'R' },
    { title: 'Total', w: RM - (LM + 12 + 20 + 46 + 20 + 20 + 16 + 14 + 18 + 15 + 16 + 18 + 18 + 18), align: 'R' },
  ];
  // Precompute x positions
  let cx = LM;
  cols.forEach((c) => { c.x = cx; cx += c.w; });

  let ty = boxTop + boxH + 3;
  const drawHead = (y) => {
    setFill(HEADFILL);
    pdf.rect(LM, y, WIDTH, 10, 'FD');
    cols.forEach((c) => {
      if (c.x > LM) pdf.line(c.x, y, c.x, y + 10);
      pdf.set_font('Calibri', 'B', 8);
      setColor(INK);
      pdf.set_xy(c.x, y + 1);
      pdf.multi_cell(c.w, 4, c.title, 0, c.align);
    });
  };
  drawHead(ty);
  ty += 10;

  const parts = grn.particulars || [];
  const skus = grn.skus || [];
  const qtys = grn.qtys || [];
  const rates = grn.rates || [];
  const totals = grn.line_total_amounts || grn.amounts || [];
  const pageBottom = pdf.h - 18;

  let grandQty = 0, grandTotal = 0;
  for (let i = 0; i < parts.length; i++) {
    const name = String(parts[i] || '').split('\n')[0];
    pdf.set_font('Calibri', '', 8);
    const nameH = pdf.multi_cell_height(cols[2].w - 2, 4, name);
    const rowH = Math.max(nameH + 2, 9);
    if (ty + rowH > pageBottom) { pdf.add_page(); ty = 12; drawHead(ty); ty += 10; }

    setDraw(BORDER);
    pdf.rect(LM, ty, WIDTH, rowH);
    cols.forEach((c) => { if (c.x > LM) pdf.line(c.x, ty, c.x, ty + rowH); });

    const q = Math.abs(parseFloat(qtys[i]) || 0);
    const r = Math.abs(parseFloat(rates[i]) || 0);
    const tot = Math.abs(parseFloat(totals[i]) || (q * r));
    grandQty += q; grandTotal += tot;

    const midY = ty + (rowH - 4.5) / 2;
    const cell = (idx, str, opts = {}) => txt(cols[idx].x, midY, str, { size: 8, align: cols[idx].align, w: cols[idx].w, ...opts });
    cell(0, String(i + 1));
    cell(1, skus[i] || '');
    // product name (wraps)
    pdf.set_font('Calibri', '', 8); setColor(INK);
    pdf.set_xy(cols[2].x + 1, ty + 1.2);
    pdf.multi_cell(cols[2].w - 2, 4, name, 0, 'L');
    cell(3, '');
    cell(4, '');
    cell(5, 'NA');
    cell(6, 'NA');
    cell(7, '');
    cell(8, q ? String(q) : '');
    cell(9, q ? String(q) : '');
    cell(10, money(r));
    cell(11, grn.batch_code || '');
    cell(12, '');
    cell(13, money(tot));
    ty += rowH;
  }

  // ── 5. TOTALS ROW ───────────────────────────────────────────────────────────
  const gt = parseFloat(grn.grand_total) || grandTotal;
  setFill(HEADFILL);
  pdf.rect(LM, ty, WIDTH, 9, 'FD');
  txt(LM + 2, ty + 2, `Grand Total :  Rs. ${money(gt)}`, { size: 10, bold: true, w: 120 });
  txt(RM - 120, ty + 2, `Total Quantity :  ${grandQty}`, { size: 10, bold: true, align: 'R', w: 118 });

  const buf = await pdf.output();
  tempFiles.forEach(safeUnlink);
  return buf;
}

module.exports = { generateGrnPdf };