// Purchase Order PDF — dedicated layout (buyer header, vendor/PO detail box,
// billing/shipping columns, items table). Uses the same FPDF shim as the invoice.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { FpdfShim } = require('./fpdfShim');

function writeTempPng(buf) {
  const p = path.join(os.tmpdir(), `po_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(p, buf);
  return p;
}
function safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }
function decodeBase64Image(b64) {
  if (!b64) return null;
  const payload = b64.includes(',') ? b64.split(',')[1] : b64;
  try { return Buffer.from(payload, 'base64'); } catch { return null; }
}

const INK = [17, 24, 39];
const MUTED = [90, 96, 110];
const BORDER = [120, 128, 145];
const HEADFILL = [242, 244, 248];

const LM = 10;          // left margin
const RM = 200;         // right edge (210 - 10)
const MID = 105;        // column divider
const WIDTH = RM - LM;  // 190mm content width

const money = (n) => (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);

function stateLine(profile) {
  const parts = [];
  if (profile.address_1) parts.push(profile.address_1);
  if (profile.address_2) parts.push(profile.address_2);
  return parts;
}

// PAN sits inside a GSTIN at positions 3-12.
function panFromGstin(g) {
  if (!g || g.length < 12) return '';
  const c = g.slice(2, 12);
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(c) ? c : '';
}

async function generatePoPdf(po, profile, opts = {}) {
  const pdf = new FpdfShim();
  pdf.add_page();

  const setColor = (c) => pdf.set_text_color(c[0], c[1], c[2]);
  const setDraw = (c) => pdf.set_draw_color(c[0], c[1], c[2]);
  const setFill = (c) => pdf.set_fill_color(c[0], c[1], c[2]);

  // txt(x, y, str, opts) — single line placed in a 5mm cell (vertically centred).
  const txt = (x, y, str, { size = 9, bold = false, color = INK, align = 'L', w = 100, h = 5 } = {}) => {
    pdf.set_font('Calibri', bold ? 'B' : '', size);
    setColor(color);
    pdf.set_xy(x, y);
    pdf.cell(w, h, str == null ? '' : String(str), 0, 0, align);
  };
  // label : value row
  const kv = (x, y, label, value, { labelW = 30, valW = 60, bold = false } = {}) => {
    txt(x, y, label, { size: 9, color: MUTED, w: labelW });
    txt(x + labelW, y, value == null ? '' : String(value), { size: 9, bold, color: INK, w: valW });
  };

  // ── 1. HEADER ──────────────────────────────────────────────────────────────
  // Logo on the left; company block centered in the space to its right; the PO
  // title/number block on the far right — nothing overlaps the logo.
  const tempFiles = [];
  const logoBuf = decodeBase64Image(profile.logo_base64);
  const hasLogo = !!logoBuf;
  if (hasLogo) { const lp = writeTempPng(logoBuf); tempFiles.push(lp); try { pdf.image(lp, LM, 9, 22, 22); } catch {} }

  const cbX = LM + (hasLogo ? 26 : 0);   // company block start (clear of the logo)
  const cbW = 148 - cbX;                 // ends before the right-hand PO block
  txt(cbX, 10, (profile.company_name || 'Company').toUpperCase(), { size: 14, bold: true, align: 'C', w: cbW });
  let hy = 17;
  if (profile.gstin) { txt(cbX, hy, `GSTIN: ${profile.gstin}`, { size: 9, align: 'C', w: cbW, color: MUTED }); hy += 4.5; }
  for (const line of stateLine(profile)) { txt(cbX, hy, line, { size: 9, align: 'C', w: cbW, color: MUTED }); hy += 4.5; }
  txt(cbX, hy, 'India', { size: 9, align: 'C', w: cbW, color: MUTED }); hy += 4.5;
  if (profile.phone) txt(cbX, hy, `Phone: ${profile.phone}`, { size: 9, align: 'C', w: cbW, color: MUTED });

  txt(150, 10, 'PURCHASE ORDER', { size: 12, bold: true, align: 'R', w: RM - 150 });
  txt(150, 18, po.bill_no || '', { size: 12, bold: true, align: 'R', w: RM - 150, color: MUTED });

  // ── 2. VENDOR / PO DETAILS BOX ──────────────────────────────────────────────
  const boxTop = 44;
  const boxH = 44;
  setDraw(BORDER);
  pdf.rect(LM, boxTop, WIDTH, boxH);
  pdf.line(MID, boxTop, MID, boxTop + boxH);

  // Left column — vendor
  let ly = boxTop + 3;
  const LX = LM + 3, LLW = 30, LVX = LM + 3 + LLW;
  kv(LX, ly, 'Vendor Code', po.vendor_code || '', { labelW: LLW, valW: 55, bold: true }); ly += 5;
  kv(LX, ly, 'Vendor Name', po.client_name || '', { labelW: LLW, valW: 55, bold: true }); ly += 5;
  const vAddr = [po.client_address1, po.client_address2,
    [po.client_district, po.client_state].filter(Boolean).join(', ') + (po.client_pincode ? ' - ' + po.client_pincode : '')]
    .map((s) => (s || '').trim()).filter(Boolean);
  for (const a of vAddr) { txt(LVX, ly, a, { size: 9, w: 55 }); ly += 5; }
  txt(LVX, ly, 'India', { size: 9, w: 55 }); ly += 5;
  kv(LX, ly, 'Contact Person', po.vendor_contact_person || '', { labelW: LLW, valW: 55 }); ly += 5;
  kv(LX, ly, 'Contact Number', po.client_mobile || '', { labelW: LLW, valW: 55 });

  // Right column — PO meta
  let ry = boxTop + 3;
  const RX = MID + 3, RLW = 42, RVX = MID + 3 + RLW;
  const rvW = RM - RVX - 2;
  const rrow = (label, value) => { kv(RX, ry, label, value, { labelW: RLW, valW: rvW }); ry += 5; };
  rrow('PO Ref No', po.po_ref_no || '');
  rrow('PO Date', po.invoice_date || '');
  rrow('Payment Term', po.payment_term || '');
  rrow('Expected Delivery Date', po.expected_delivery_date || '');
  rrow('Vendor Invoice Number', po.vendor_invoice_number || '');
  rrow('Vendor Tax ID', po.client_gstin || '');
  rrow('Purchase Date', po.purchase_date || '');
  rrow('Payment Mode', po.payment_mode || '');

  // ── 3. BILLING / SHIPPING ───────────────────────────────────────────────────
  const bhTop = boxTop + boxH;
  setFill(HEADFILL);
  pdf.rect(LM, bhTop, WIDTH, 8, 'FD');
  pdf.line(MID, bhTop, MID, bhTop + 8);
  txt(LM, bhTop + 1.5, 'Billing Address', { size: 11, bold: true, align: 'C', w: MID - LM });
  txt(MID, bhTop + 1.5, 'Shipping Address', { size: 11, bold: true, align: 'C', w: RM - MID });

  const bcTop = bhTop + 8;
  const bcH = 30;
  pdf.rect(LM, bcTop, WIDTH, bcH);
  pdf.line(MID, bcTop, MID, bcTop + bcH);
  const buyerBlock = [
    (profile.company_name || '').toUpperCase(),
    profile.address_1, profile.address_2,
    profile.state || '', 'India', profile.phone || '',
  ].map((s) => (s || '').trim()).filter(Boolean);
  const renderAddrBlock = (x, w) => {
    let y = bcTop + 3;
    buyerBlock.forEach((line, i) => {
      txt(x, y, line, { size: 9, bold: i === 0, color: i === 0 ? INK : MUTED, w });
      y += 4.5;
    });
  };
  renderAddrBlock(LM + 3, MID - LM - 6);
  renderAddrBlock(MID + 3, RM - MID - 6);

  // ── 4. ITEMS TABLE ──────────────────────────────────────────────────────────
  // columns: S.No | Description | HSN | Qty | Rate | Amount
  const cols = [
    { key: 'sno', title: 'S.No', x: LM, w: 12, align: 'C' },
    { key: 'desc', title: 'Item Description', x: LM + 12, w: 86, align: 'L' },
    { key: 'hsn', title: 'HSN', x: LM + 98, w: 22, align: 'C' },
    { key: 'qty', title: 'Qty', x: LM + 120, w: 18, align: 'C' },
    { key: 'rate', title: 'Rate', x: LM + 138, w: 26, align: 'R' },
    { key: 'amount', title: 'Amount', x: LM + 164, w: WIDTH - 164, align: 'R' },
  ];
  let ty = bcTop + bcH + 4;

  const drawHeadRow = (y) => {
    setFill(HEADFILL);
    pdf.rect(LM, y, WIDTH, 8, 'FD');
    cols.forEach((c) => {
      if (c.x > LM) pdf.line(c.x, y, c.x, y + 8);
      txt(c.x, y + 1.5, c.title, { size: 9, bold: true, color: INK, w: c.w, align: c.align });
    });
  };
  drawHeadRow(ty);
  ty += 8;

  const parts = po.particulars || [];
  const skus = po.skus || [];
  const qtys = po.qtys || [];
  const rates = po.rates || [];
  const hsns = po.hsns || [];
  const amounts = po.line_total_amounts || po.amounts || [];
  const pageBottom = pdf.h - 30;

  let total = 0, totalQty = 0;
  for (let i = 0; i < parts.length; i++) {
    const name = String(parts[i] || '').split('\n')[0];
    const sku = skus[i] || '';
    pdf.set_font('Calibri', '', 9);
    const descH = pdf.multi_cell_height(cols[1].w - 3, 4.5, name);
    const rowH = Math.max(descH + 2 + (sku ? 3.6 : 0), 7);

    if (ty + rowH > pageBottom) { pdf.add_page(); ty = 15; drawHeadRow(ty); ty += 8; }

    setDraw(BORDER);
    pdf.rect(LM, ty, WIDTH, rowH);
    cols.forEach((c) => { if (c.x > LM) pdf.line(c.x, ty, c.x, ty + rowH); });

    const q = Math.abs(parseFloat(qtys[i]) || 0);
    const r = Math.abs(parseFloat(rates[i]) || 0);
    const amt = Math.abs(parseFloat(amounts[i]) || (q * r));
    total += amt; totalQty += q;

    const midY = ty + (rowH - 5) / 2;
    setColor(INK);
    txt(cols[0].x, midY, String(i + 1), { size: 9, w: cols[0].w, align: 'C' });
    // description (may wrap)
    pdf.set_font('Calibri', '', 9);
    setColor(INK);
    pdf.set_xy(cols[1].x + 1.5, ty + 1);
    pdf.multi_cell(cols[1].w - 3, 4.5, name, 0, 'L');
    if (sku) {
      pdf.set_font('Calibri', '', 7.5);
      setColor(MUTED);
      pdf.set_xy(cols[1].x + 1.5, ty + 1 + descH);
      pdf.cell(cols[1].w - 3, 3.2, `SKU: ${sku}`, 0, 0, 'L');
      setColor(INK);
    }
    txt(cols[2].x, midY, hsns[i] || '', { size: 9, w: cols[2].w, align: 'C' });
    txt(cols[3].x, midY, q ? String(q) : '', { size: 9, w: cols[3].w, align: 'C' });
    txt(cols[4].x, midY, money(r), { size: 9, w: cols[4].w - 1.5, align: 'R' });
    txt(cols[5].x, midY, money(amt), { size: 9, w: cols[5].w - 1.5, align: 'R' });

    ty += rowH;
  }

  // Total row
  const grand = parseFloat(po.grand_total) || total;
  setFill(HEADFILL);
  pdf.rect(LM, ty, WIDTH, 9, 'FD');
  cols.forEach((c) => { if (c.x > LM) pdf.line(c.x, ty, c.x, ty + 9); });
  txt(cols[1].x, ty + 2, 'TOTAL', { size: 10, bold: true, w: cols[1].w, align: 'L' });
  txt(cols[3].x, ty + 2, totalQty ? String(totalQty) : '', { size: 9.5, bold: true, w: cols[3].w, align: 'C' });
  txt(cols[5].x, ty + 2, `Rs. ${money(grand)}`, { size: 10, bold: true, w: cols[5].w - 1.5, align: 'R' });
  ty += 9;

  // ── 5. FOOTER ───────────────────────────────────────────────────────────────
  ty += 6;
  const pan = panFromGstin(profile.gstin || '');
  if (pan) { txt(LM, ty, `PAN: ${pan}`, { size: 9, color: MUTED, w: 90 }); }
  txt(RM - 70, ty, `For ${profile.company_name || ''}`, { size: 9, bold: true, align: 'R', w: 70 });
  txt(RM - 70, ty + 16, 'Authorised Signatory', { size: 9, color: MUTED, align: 'R', w: 70 });
  setDraw(BORDER);
  pdf.line(RM - 55, ty + 15, RM, ty + 15);

  const buf = await pdf.output();
  tempFiles.forEach(safeUnlink);
  return buf;
}

module.exports = { generatePoPdf };