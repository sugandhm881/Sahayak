const os = require('os');
const path = require('path');
const fs = require('fs');
const { FpdfShim } = require('./fpdfShim');
const { convertToWords } = require('../../utils/words');
const { generateUpiQrBuffer } = require('../qr');
const env = require('../../config/env');

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

// GST state codes (per GSTIN spec). Used to print "Place of Supply: <state> (<code>)".
const GST_STATE_CODES = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03', 'chandigarh': '04',
  'uttarakhand': '05', 'haryana': '06', 'delhi': '07', 'rajasthan': '08', 'uttar pradesh': '09',
  'bihar': '10', 'sikkim': '11', 'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14',
  'mizoram': '15', 'tripura': '16', 'meghalaya': '17', 'assam': '18', 'west bengal': '19',
  'jharkhand': '20', 'odisha': '21', 'chhattisgarh': '22', 'madhya pradesh': '23', 'gujarat': '24',
  'daman and diu': '25', 'dadra and nagar haveli': '26', 'maharashtra': '27', 'andhra pradesh': '28',
  'karnataka': '29', 'goa': '30', 'lakshadweep': '31', 'kerala': '32', 'tamil nadu': '33',
  'puducherry': '34', 'andaman and nicobar islands': '35', 'telangana': '36', 'ladakh': '38',
};
function placeOfSupplyLine(invoiceData) {
  const state = (invoiceData.client_state || '').trim();
  const gstin = (invoiceData.client_gstin || '').trim();
  let code = '';
  if (gstin && gstin.length >= 2 && /^\d{2}/.test(gstin)) code = gstin.slice(0, 2);
  if (!code && state) code = GST_STATE_CODES[state.toLowerCase()] || '';
  if (state && code) return `${state} (${code})`;
  return state || '';
}

// Derive supplier State + Code from profile (preferring the GSTIN encoding, since
// chars 1-2 of GSTIN are the state code per spec).
function supplierStateLine(profile) {
  const state = (profile.state || '').trim();
  const gstin = (profile.gstin || '').trim();
  let code = '';
  if (gstin && gstin.length >= 2 && /^\d{2}/.test(gstin)) code = gstin.slice(0, 2);
  if (!code && state) code = GST_STATE_CODES[state.toLowerCase()] || '';
  if (state && code) return `${state} (${code})`;
  return state || '';
}

// PAN is embedded in GSTIN at chars 3-12 (positions 2..11 zero-indexed).
function panFromGstin(gstin) {
  if (!gstin || gstin.length < 12) return '';
  const candidate = gstin.slice(2, 12);
  // PAN format: 5 letters + 4 digits + 1 letter
  if (/^[A-Z]{5}\d{4}[A-Z]$/.test(candidate)) return candidate;
  return '';
}

// Decide inter-state vs intra-state by comparing supplier and recipient GSTIN
// state codes. Falls back to state-name comparison if either GSTIN is absent.
function supplyType(profile, invoiceData) {
  const sGstin = (profile.gstin || '').trim();
  const cGstin = (invoiceData.client_gstin || '').trim();
  const sCode = sGstin.slice(0, 2);
  const cCode = cGstin.slice(0, 2);
  if (/^\d{2}$/.test(sCode) && /^\d{2}$/.test(cCode)) {
    return sCode === cCode ? 'Intra-State' : 'Inter-State';
  }
  const sState = (profile.state || '').trim().toLowerCase();
  const cState = (invoiceData.client_state || '').trim().toLowerCase();
  if (sState && cState) return sState === cState ? 'Intra-State' : 'Inter-State';
  return '';
}

async function generateInvoicePdf(invoiceData, profile, opts = {}) {
  const { is_credit_note = false, is_debit_note = false } = opts;
  const pdf = new FpdfShim();
  pdf.add_page();

  const margin = 15;
  const page_width = pdf.w - 30;          // 180mm
  const right_edge = pdf.w - margin;       // 195mm

  const invoice_type = invoiceData.invoice_type || profile.invoice_type || 'goods';
  const is_service = invoice_type === 'service';
  const is_non_gst = !!invoiceData.is_non_gst;
  const doc_category = invoiceData.doc_category || 'sale';
  const doc_type = invoiceData.doc_type || 'invoice';

  // ── Document title + accent color resolution ────────────────────────────
  let doc_title = 'TAX INVOICE';
  let accent = [234, 88, 12]; // sale orange-600
  if (doc_category === 'purchase') {
    accent = [30, 64, 175]; // blue-800
    if (is_debit_note) doc_title = 'DEBIT NOTE';
    else if (doc_type === 'po') doc_title = 'PURCHASE ORDER';
    else if (doc_type === 'grn') { doc_title = 'GOODS RECEIPT NOTE'; accent = [5, 150, 105]; }
    else if (doc_type === 'bill') doc_title = 'PURCHASE BILL';
    else doc_title = 'PURCHASE DOC';
  } else if (is_credit_note) { doc_title = 'CREDIT NOTE'; accent = [220, 38, 38]; }
  else if (is_debit_note) { doc_title = 'DEBIT NOTE'; accent = [0, 51, 102]; }
  else if (is_non_gst) { doc_title = 'BILL OF SUPPLY'; accent = [5, 150, 105]; }

  // Palette — warmer tones (cream off-white panels, slightly warm grays).
  const COLOR = {
    accent,
    ink: [33, 30, 28],          // warm near-black
    ink2: [82, 73, 67],          // warm dark gray
    muted: [140, 130, 122],      // warm muted
    panel: [252, 249, 244],      // soft cream
    panel2: [247, 243, 236],     // slightly darker cream for accents
    border: [225, 218, 209],     // warm hairline
    zebra: [250, 247, 242],      // very subtle warm tint
    white: [255, 255, 255],
  };
  const setColor = (kind, c) => {
    if (kind === 'text') pdf.set_text_color(c[0], c[1], c[2]);
    else if (kind === 'fill') pdf.set_fill_color(c[0], c[1], c[2]);
    else if (kind === 'draw') pdf.set_draw_color(c[0], c[1], c[2]);
  };
  let tempFiles = [];

  // ── 1. TOP ACCENT STRIPE (full-width, 2mm — subtle) ─────────────────────
  setColor('fill', accent);
  pdf.rect(0, 0, pdf.w, 2, 'F');

  // ── 2. HEADER BAND ───────────────────────────────────────────────────────
  // Layout: logo + company name + GSTIN/contact on left; doc title + meta on right.
  // Y is tracked dynamically so a wrapping company name doesn't collide with text below.
  const logoBuf = decodeBase64Image(profile.logo_base64);
  const has_logo = !!logoBuf;
  if (has_logo) {
    const p = writeTempPng(logoBuf);
    tempFiles.push(p);
    pdf.image(p, margin, 10, 22, 22);
  }
  const company_x = has_logo ? margin + 26 : margin;
  // Make room for the right-side meta block (which starts around x=130)
  const max_company_w = 130 - company_x - 4;
  const company_name = profile.company_name || 'SM Tech';

  // Auto-shrink with a small safety buffer to avoid PDFKit edge-case wraps.
  let company_size = 16;
  pdf.set_font('Calibri', 'B', company_size);
  while (pdf.get_string_width(company_name) > max_company_w - 2 && company_size > 8) {
    company_size -= 1;
    pdf.set_font('Calibri', 'B', company_size);
  }
  setColor('text', COLOR.ink);
  pdf.set_xy(company_x, 12);
  // Use multi_cell so very long names wrap cleanly (and we track the resulting Y).
  pdf.multi_cell(max_company_w, company_size * 0.45, company_name, 0, 'L');
  let header_y = pdf.get_y() + 1;

  // GSTIN + PAN + State + Contact + Address — compliance-grade identity block.
  // Trailing commas/whitespace are stripped per part to avoid ",, " artefacts.
  setColor('text', COLOR.muted);
  pdf.set_font('Calibri', '', 8);
  const my_gstin = profile.gstin || '';
  const my_pan = panFromGstin(my_gstin);
  const my_state_line = supplierStateLine(profile);

  // Line 1: GSTIN  06ABOCS1954R1ZG  ·  PAN  ABOCS1954R
  const id_bits = [];
  if (my_gstin) id_bits.push(`GSTIN  ${my_gstin}`);
  if (my_pan) id_bits.push(`PAN  ${my_pan}`);
  if (id_bits.length) {
    pdf.set_xy(company_x, header_y);
    pdf.cell(max_company_w, 4, id_bits.join('  ·  '), 0, 0, 'L');
    header_y += 4;
  }
  // Line 2: State and code
  if (my_state_line) {
    pdf.set_xy(company_x, header_y);
    pdf.cell(max_company_w, 4, `State  ${my_state_line}`, 0, 0, 'L');
    header_y += 4;
  }
  // Line 3: Phone · Email
  const contact_bits = [];
  if (profile.phone) contact_bits.push(String(profile.phone).trim());
  if (profile.email) contact_bits.push(String(profile.email).trim());
  if (contact_bits.length) {
    pdf.set_xy(company_x, header_y);
    pdf.cell(max_company_w, 4, contact_bits.join('  ·  '), 0, 0, 'L');
    header_y += 4;
  }
  // Line 4: Address (multi-line if long). Sanitize parts so we don't get ",,".
  const cleanPart = (s) => String(s || '').trim().replace(/^[,\s]+|[,\s]+$/g, '').trim();
  const addr_bits = [cleanPart(profile.address_1), cleanPart(profile.address_2)].filter(Boolean).join(', ');
  if (addr_bits) {
    pdf.set_xy(company_x, header_y);
    pdf.multi_cell(max_company_w, 4, addr_bits, 0, 'L');
    header_y = pdf.get_y();
  }

  // Right-side meta block: doc title + invoice no + date.
  // Drawn at fixed Y because the left block's wrap can push header_y around, but
  // the right block has its own Y baseline.
  const meta_x = 132;
  const meta_w = right_edge - meta_x; // ~63mm
  setColor('text', accent);
  pdf.set_font('Calibri', 'B', 18);
  pdf.set_xy(meta_x, 11);
  pdf.cell(meta_w, 9, doc_title, 0, 1, 'R');

  pdf.set_font('Calibri', '', 7);
  setColor('text', COLOR.muted);
  pdf.set_xy(meta_x, 22);
  pdf.cell(meta_w, 3.5, 'INVOICE NO', 0, 1, 'R');
  pdf.set_xy(meta_x, 25.5);
  pdf.set_font('Calibri', 'B', 10);
  setColor('text', COLOR.ink);
  pdf.cell(meta_w, 4.5, invoiceData.bill_no || '', 0, 1, 'R');

  pdf.set_xy(meta_x, 31);
  pdf.set_font('Calibri', '', 7);
  setColor('text', COLOR.muted);
  pdf.cell(meta_w, 3.5, 'DATE', 0, 1, 'R');
  pdf.set_xy(meta_x, 34.5);
  pdf.set_font('Calibri', 'B', 10);
  setColor('text', COLOR.ink);
  pdf.cell(meta_w, 4.5, invoiceData.invoice_date || '', 0, 1, 'R');

  // Move below the taller of the two header blocks.
  const right_block_bottom = 41;
  pdf.set_y(Math.max(header_y, right_block_bottom) + 4);

  // Reference invoice for credit/debit notes
  if (is_credit_note || is_debit_note) {
    let ref_bill = invoiceData.original_invoice_no || '';
    if (!ref_bill) ref_bill = String(invoiceData.bill_no || '').replace('CN-', '').replace('DN-', '').replace('TE-CN', 'TE').replace('TE-DN', 'TE');
    setColor('text', accent);
    pdf.set_font('Calibri', 'B', 9);
    pdf.cell(page_width, 5, `Ref Invoice: ${ref_bill}`, 0, 1, 'R');
    setColor('text', COLOR.ink);
  }

  pdf.ln(2);

  // ── 3. BILL TO / SHIP TO PANELS ──────────────────────────────────────────
  const formatAddress = (prefix) => {
    const pincode = invoiceData[`${prefix}_pincode`] || '';
    const district = invoiceData[`${prefix}_district`] || '';
    const lines = [
      invoiceData[`${prefix}_address1`] || '',
      invoiceData[`${prefix}_address2`] || '',
      pincode ? `${district} - ${pincode}` : district,
      `${invoiceData[`${prefix}_state`] || ''}`,
      invoiceData[`${prefix}_gstin`] ? `GSTIN  ${invoiceData[`${prefix}_gstin`]}` : '',
      invoiceData[`${prefix}_mobile`] ? `Mobile  ${invoiceData[`${prefix}_mobile`]}` : '',
      invoiceData[`${prefix}_email`] ? `Email  ${invoiceData[`${prefix}_email`]}` : '',
    ];
    return lines.filter((l) => l && l.trim() && !['-', ''].includes(l.trim())).join('\n');
  };

  const label_bill_to = (doc_category === 'purchase' && is_debit_note) ? 'TO (VENDOR)'
    : (doc_category === 'purchase' ? 'VENDOR' : 'BILL TO');
  const label_ship_to = (doc_category === 'purchase' && is_debit_note) ? 'REFERENCE'
    : (doc_category === 'purchase' ? 'SHIP TO (WAREHOUSE)' : 'SHIP TO');

  // For goods invoices: Bill To (left) + Ship To (right), each ~half width.
  // For service invoices: Bill To takes the full width (no Ship To panel),
  // since services aren't shipped to a separate address.
  const panel_y = pdf.get_y();
  const bill_w = is_service ? page_width : (page_width - 4) / 2;
  const ship_w = is_service ? 0 : (page_width - 4) / 2;
  const panel_l_x = margin;
  const panel_r_x = margin + bill_w + 4;

  const bill_addr = formatAddress('client');
  const ship_addr = is_service ? '' : formatAddress('shipto');

  // Pre-compute panel heights from the actual address content so nothing escapes
  // the panel box. Both panels share the same height for visual alignment.
  // Layout inside panel:
  //   y+3 → label row (4mm)
  //   y+8 → name row (5mm)
  //   y+14 → address body (variable, 4mm per line)
  //   + 3mm bottom padding
  const computePanelHeight = (addr_text, w) => {
    pdf.set_font('Calibri', '', 9);
    const body_h = addr_text ? pdf.multi_cell_height(w - 8, 4, addr_text) : 0;
    return 14 + body_h + 3; // header offsets + body + bottom padding
  };
  const bill_h = computePanelHeight(bill_addr, bill_w);
  const ship_h = ship_w ? computePanelHeight(ship_addr, ship_w) : 0;
  const panel_h = Math.max(bill_h, ship_h, 38); // floor at 38mm so empty panels still look balanced

  const drawPanel = (x, y, w, h, label, name, addr_text) => {
    setColor('fill', COLOR.panel);
    setColor('draw', COLOR.border);
    pdf.rect(x, y, w, h, 'FD');
    // accent strip on left edge (1mm wide) for visual hook
    setColor('fill', accent);
    pdf.rect(x, y, 1, h, 'F');
    // header label
    pdf.set_xy(x + 4, y + 3);
    setColor('text', COLOR.muted);
    pdf.set_font('Calibri', 'B', 7);
    pdf.cell(w - 8, 4, label, 0, 1, 'L');
    // name (bold)
    pdf.set_xy(x + 4, y + 8);
    setColor('text', COLOR.ink);
    pdf.set_font('Calibri', 'B', 11);
    pdf.cell(w - 8, 5, name || '—', 0, 1, 'L');
    // address body
    pdf.set_xy(x + 4, y + 14);
    setColor('text', COLOR.ink2);
    pdf.set_font('Calibri', '', 9);
    if (addr_text) pdf.multi_cell(w - 8, 4, addr_text, 0, 'L');
  };

  drawPanel(panel_l_x, panel_y, bill_w, panel_h, label_bill_to, invoiceData.client_name || '', bill_addr);
  if (!is_service) {
    drawPanel(panel_r_x, panel_y, ship_w, panel_h, label_ship_to, invoiceData.shipto_name || invoiceData.client_name || '', ship_addr);
  }

  pdf.set_y(panel_y + panel_h + 4);

  // ── 4. GST DISCLOSURE STRIP — compliance-critical row ────────────────────
  // Shows: Place of Supply, Supply Type (Inter-State/Intra-State), Reverse Charge,
  // Copy designation. All in one structured 4-column band.
  if (!is_non_gst) {
    const pos = placeOfSupplyLine(invoiceData);
    const stype = supplyType(profile, invoiceData);
    const rcm = invoiceData.reverse_charge ? 'Yes' : 'No';
    const copy_label = opts.copy_label || 'ORIGINAL FOR RECIPIENT';
    const strip_y = pdf.get_y();
    const strip_h = 8;
    setColor('fill', COLOR.panel);
    setColor('draw', COLOR.border);
    pdf.rect(margin, strip_y, page_width, strip_h, 'FD');

    // 4 columns: POS | Supply Type | Reverse Charge | Copy designation
    const col_w = page_width / 4;
    const draw_cell = (i, label, value, opts3 = {}) => {
      const cx = margin + (i * col_w);
      pdf.set_xy(cx + 3, strip_y + 1.5);
      setColor('text', COLOR.muted);
      pdf.set_font('Calibri', '', 6.5);
      pdf.cell(col_w - 4, 2.5, label.toUpperCase(), 0, 1, 'L');
      pdf.set_xy(cx + 3, strip_y + 4);
      setColor('text', opts3.accent ? accent : COLOR.ink);
      pdf.set_font('Calibri', 'B', 8);
      pdf.cell(col_w - 4, 3.5, value || '—', 0, 1, 'L');
    };
    draw_cell(0, 'Place of Supply', pos);
    draw_cell(1, 'Supply Type', stype);
    draw_cell(2, 'Reverse Charge', rcm);
    draw_cell(3, 'Copy', copy_label, { accent: true });
    setColor('text', COLOR.ink);
    pdf.set_y(strip_y + strip_h + 1);
  }

  // PO Number row if applicable (purchase)
  if (!is_service && invoiceData.po_number) {
    pdf.set_font('Calibri', '', 8);
    setColor('text', COLOR.muted);
    pdf.set_x(margin);
    pdf.cell(page_width, 4, `PO Number  ${invoiceData.po_number}`, 0, 1, 'L');
    setColor('text', COLOR.ink);
  }

  pdf.ln(3);

  // ── 5. ITEMS TABLE ───────────────────────────────────────────────────────
  const rate_col_label = is_service ? 'Rate (Excl.)' : 'Rate (Incl.)';
  let p_w = 46, h_w = 15, q_w = 12, r_w = 18, d_w = 12, tp_w = 12, ta_w = 22, tm_w = 18, t_w = 25;
  if (is_service) { p_w += q_w; q_w = 0; }

  const drawItemsHeader = () => {
    // No fill on header — just charcoal underline. Uppercase letterspaced labels.
    setColor('text', COLOR.muted);
    pdf.set_font('Calibri', 'B', 7);
    const hy = pdf.get_y();
    pdf.set_x(margin);
    pdf.cell(p_w, 7, 'PARTICULARS', 0, 0, 'L');
    pdf.cell(h_w, 7, 'HSN', 0, 0, 'C');
    if (!is_service) pdf.cell(q_w, 7, 'QTY', 0, 0, 'C');
    pdf.cell(r_w, 7, rate_col_label.toUpperCase(), 0, 0, 'R');
    pdf.cell(d_w, 7, 'DISC%', 0, 0, 'R');
    pdf.cell(tp_w, 7, 'TAX %', 0, 0, 'R');
    pdf.cell(ta_w, 7, 'TAXABLE', 0, 0, 'R');
    pdf.cell(tm_w, 7, 'TAX AMT', 0, 0, 'R');
    pdf.cell(t_w, 7, 'TOTAL', 0, 1, 'R');
    // Border line under header (charcoal, slightly thicker visual via two lines)
    setColor('draw', COLOR.ink);
    pdf.line(margin, hy + 7, right_edge, hy + 7);
    setColor('draw', COLOR.border);
    setColor('text', COLOR.ink);
  };
  drawItemsHeader();

  pdf.set_font('Calibri', '', 9);
  const particulars = invoiceData.particulars || [];
  const hsns = invoiceData.hsns || [];
  const qtys = invoiceData.qtys || [];
  const rates = invoiceData.rates || [];
  const discounts = invoiceData.discounts || [];
  const taxrates = invoiceData.taxrates || [];
  const amounts = invoiceData.amounts || [];
  const line_tax_amounts = invoiceData.line_tax_amounts || [];
  const line_total_amounts = invoiceData.line_total_amounts || [];

  let total_qty_calc = 0;
  for (let i = 0; i < particulars.length; i++) {
    const part_str = String(particulars[i] || '');

    // Pre-compute row height to decide on page-break.
    let part_h;
    if (part_str.includes('\n')) {
      const [main, ...rest] = part_str.split('\n');
      const sub = rest.join('\n');
      pdf.set_font('Calibri', 'B', 9);
      const hMain = pdf.multi_cell_height(p_w, 5, main);
      pdf.set_font('Calibri', '', 8);
      const hSub = pdf.multi_cell_height(p_w, 4, sub);
      part_h = hMain + hSub;
    } else {
      pdf.set_font('Calibri', '', 9);
      part_h = pdf.multi_cell_height(p_w, 6, part_str);
    }
    const expected_row_h = Math.max(part_h, 8);
    const page_bottom = pdf.h - pdf.bMargin;
    if (pdf.get_y() + expected_row_h > page_bottom) {
      pdf.add_page();
    }

    const start_y = pdf.get_y();
    const start_x = margin;
    pdf.set_x(start_x);

    // Zebra fill on alternate rows (subtle)
    if (i % 2 === 1) {
      setColor('fill', COLOR.zebra);
      pdf.rect(margin, start_y, page_width, expected_row_h, 'F');
    }

    setColor('text', COLOR.ink);
    if (part_str.includes('\n')) {
      const [main, ...rest] = part_str.split('\n');
      const sub = rest.join('\n');
      pdf.set_font('Calibri', 'B', 9);
      pdf.set_xy(start_x + 1, start_y + 1);
      pdf.multi_cell(p_w - 2, 5, main, 0, 'L');
      pdf.set_xy(start_x + 1, pdf.get_y());
      pdf.set_font('Calibri', '', 8);
      setColor('text', COLOR.muted);
      pdf.multi_cell(p_w - 2, 4, sub, 0, 'L');
      setColor('text', COLOR.ink);
    } else {
      pdf.set_font('Calibri', '', 9);
      pdf.set_xy(start_x + 1, start_y + 1);
      pdf.multi_cell(p_w - 2, 6, part_str, 0, 'L');
    }

    const y_after = pdf.get_y();
    const row_h = Math.max(y_after - start_y, expected_row_h);

    pdf.set_font('Calibri', '', 9);
    pdf.set_xy(start_x + p_w, start_y);

    const q_val = parseFloat(qtys[i]) || 0;
    total_qty_calc += Math.abs(q_val);
    const q_abs = Math.abs(q_val);
    const q_str = String(q_abs);
    let tx_str = '0%';
    try {
      const tx_p = parseFloat(taxrates[i] || 0);
      tx_str = Number.isInteger(tx_p) ? `${tx_p.toFixed(0)}%` : `${tx_p}%`;
    } catch {}
    let ds_str = '-';
    try {
      const ds_p = parseFloat(discounts[i] || 0);
      ds_str = ds_p > 0 ? `${ds_p.toFixed(1)}%` : '-';
    } catch {}

    // Vertically center the numeric cells against the row height
    const cellY = start_y + (row_h - 6) / 2;
    pdf.set_xy(start_x + p_w, cellY);
    setColor('text', COLOR.ink2);
    pdf.cell(h_w, 6, is_non_gst ? '' : String(hsns[i] || ''), 0, 0, 'C');
    if (!is_service) pdf.cell(q_w, 6, q_str, 0, 0, 'C');
    pdf.cell(r_w, 6, `${Math.abs(parseFloat(rates[i]) || 0).toFixed(2)}`, 0, 0, 'R');
    pdf.cell(d_w, 6, ds_str, 0, 0, 'R');
    pdf.cell(tp_w, 6, tx_str, 0, 0, 'R');
    pdf.cell(ta_w, 6, `${Math.abs(parseFloat(amounts[i]) || 0).toFixed(2)}`, 0, 0, 'R');
    pdf.cell(tm_w, 6, `${Math.abs(parseFloat(line_tax_amounts[i]) || 0).toFixed(2)}`, 0, 0, 'R');
    setColor('text', COLOR.ink);
    pdf.set_font('Calibri', 'B', 9);
    pdf.cell(t_w, 6, `${Math.abs(parseFloat(line_total_amounts[i]) || 0).toFixed(2)}`, 0, 0, 'R');
    pdf.set_font('Calibri', '', 9);

    // Subtle row separator (gray hairline)
    setColor('draw', COLOR.border);
    pdf.line(margin, start_y + row_h, right_edge, start_y + row_h);
    pdf.set_y(start_y + row_h);
  }

  // ── 6. TRAILING BLOCK (totals + bank/upi + signature) ────────────────────
  // Reserve enough for: 6-7 totals rows + grand total + amount in words +
  // bank/UPI panels + signature. ~110mm is comfortable.
  const trailing_reserve = 110;
  if (pdf.get_y() + trailing_reserve > pdf.h - pdf.bMargin) {
    pdf.add_page();
  }

  pdf.ln(4);

  // Total Quantity small line (left side)
  if (!is_service && total_qty_calc > 0) {
    pdf.set_font('Calibri', '', 8);
    setColor('text', COLOR.muted);
    pdf.set_x(margin);
    pdf.cell(80, 5, `Total Quantity  ${total_qty_calc}`, 0, 0, 'L');
    setColor('text', COLOR.ink);
  }

  // ── COMPLIANCE-GRADE TOTALS SUMMARY ──────────────────────────────────────
  // Layout matches how CAs/auditors expect to see it: Taxable Amount, then a
  // tax breakdown section (CGST/SGST/IGST/Cess), then Total Tax, then Round Off,
  // then a prominent Grand Total with thick top + bottom rules.
  const totals_w = 95;
  const totals_x = right_edge - totals_w;
  const totals_label_w = 58;
  const totals_value_w = totals_w - totals_label_w;
  let totals_y = pdf.get_y();

  const subT = parseFloat(invoiceData.sub_total || 0);
  const igstT = parseFloat(invoiceData.igst || 0);
  const cgstT = parseFloat(invoiceData.cgst || 0);
  const sgstT = parseFloat(invoiceData.sgst || 0);
  const cessT = parseFloat(invoiceData.cess || 0);
  const grandT = parseFloat(invoiceData.grand_total || 0);
  const total_tax = Math.round((igstT + cgstT + sgstT + cessT) * 100) / 100;
  const round_off = Math.round((grandT - (subT + total_tax)) * 100) / 100;

  const drawRow = (label, val, style = {}) => {
    pdf.set_xy(totals_x, totals_y);
    const lblColor = style.muted ? COLOR.muted : COLOR.ink2;
    const valColor = style.muted ? COLOR.muted : COLOR.ink;
    setColor('text', lblColor);
    pdf.set_font('Calibri', style.bold ? 'B' : '', style.size || 9);
    pdf.cell(totals_label_w, 6, label, 0, 0, 'L');
    setColor('text', valColor);
    pdf.set_font('Calibri', style.bold ? 'B' : '', style.size || 9);
    const sign = (val < 0) ? '-' : '';
    pdf.cell(totals_value_w, 6, `${sign}${Math.abs(val || 0).toFixed(2)}`, 0, 0, 'R');
    totals_y += 6;
  };
  const drawHairline = (color = COLOR.border) => {
    setColor('draw', color);
    pdf.line(totals_x, totals_y, totals_x + totals_w, totals_y);
  };
  const drawThickRule = (color = COLOR.ink) => {
    setColor('draw', color);
    // Double hairlines for a "double underline" classic accounting effect
    pdf.line(totals_x, totals_y, totals_x + totals_w, totals_y);
    pdf.line(totals_x, totals_y + 0.8, totals_x + totals_w, totals_y + 0.8);
    totals_y += 1;
  };

  // 1. Discount (if any)
  if ((invoiceData.total_discount || 0) > 0) {
    drawRow('Total Discount', invoiceData.total_discount);
    drawHairline();
  }
  // 2. Taxable Amount (the GST-correct label)
  drawRow('Taxable Amount', subT);
  drawHairline();

  // 3. Tax breakdown — show component lines if non-GST is false. Skip zero-only
  //    rows but always show the breakdown section header for compliance clarity.
  if (!is_non_gst && (cgstT > 0 || sgstT > 0 || igstT > 0 || cessT > 0)) {
    if (cgstT > 0) drawRow('Add: CGST', cgstT);
    if (sgstT > 0) drawRow('Add: SGST', sgstT);
    if (igstT > 0) drawRow('Add: IGST', igstT);
    if (cessT > 0) drawRow('Add: Cess', cessT);
    drawHairline();
    // 4. Total Tax aggregate
    drawRow('Total Tax', total_tax, { bold: true, size: 9 });
    drawHairline();
  }

  // 5. Round Off (auto)
  if (Math.abs(round_off) >= 0.01) {
    drawRow('Round Off', round_off, { muted: true, size: 8 });
    drawHairline();
  }

  // 6. GRAND TOTAL — flat layout with thick double-rule above and below,
  //    bold accent-colored amount. Modern + professional + compliance-friendly.
  totals_y += 2;
  drawThickRule(COLOR.ink);
  totals_y += 1;

  pdf.set_xy(totals_x, totals_y);
  setColor('text', COLOR.ink);
  pdf.set_font('Calibri', 'B', 11);
  pdf.cell(totals_label_w, 8, 'GRAND TOTAL', 0, 0, 'L');
  setColor('text', accent);
  pdf.set_font('Calibri', 'B', 14);
  pdf.cell(totals_value_w, 8, `Rs. ${Math.abs(grandT).toFixed(2)}`, 0, 0, 'R');
  setColor('text', COLOR.ink);
  totals_y += 8;

  drawThickRule(COLOR.ink);
  totals_y += 3;

  pdf.set_y(totals_y);

  // ── 7. AMOUNT IN WORDS ───────────────────────────────────────────────────
  pdf.ln(2);
  pdf.set_x(margin);
  pdf.set_font('Calibri', 'I', 9);
  setColor('text', COLOR.muted);
  pdf.cell(15, 5, 'In Words', 0, 0, 'L');
  pdf.set_font('Calibri', 'B', 9);
  setColor('text', COLOR.ink2);
  pdf.cell(page_width - 15, 5, `Rupees ${convertToWords(grandT)}`, 0, 1, 'L');
  setColor('text', COLOR.ink);
  pdf.ln(3);

  // ── 8. BANK / UPI BAND ──────────────────────────────────────────────────
  const bank_y = pdf.get_y();
  const bank_h = 28;
  const bank_w = 110;
  // Left: bank panel
  setColor('fill', COLOR.panel);
  setColor('draw', COLOR.border);
  pdf.rect(margin, bank_y, bank_w, bank_h, 'FD');
  setColor('text', COLOR.muted);
  pdf.set_font('Calibri', 'B', 7);
  pdf.set_xy(margin + 3, bank_y + 2);
  pdf.cell(bank_w - 6, 4, 'BANK DETAILS', 0, 1, 'L');
  // 2-column mini layout
  const bankLine = (label, value, x, y) => {
    pdf.set_xy(x, y);
    setColor('text', COLOR.muted);
    pdf.set_font('Calibri', '', 7);
    pdf.cell(45, 3.5, label.toUpperCase(), 0, 1, 'L');
    pdf.set_xy(x, y + 3.5);
    setColor('text', COLOR.ink);
    pdf.set_font('Calibri', 'B', 9);
    pdf.cell(45, 4, value || '—', 0, 1, 'L');
  };
  bankLine('Bank', profile.bank_name || '', margin + 3, bank_y + 7);
  bankLine('Account Holder', profile.account_holder || '', margin + 56, bank_y + 7);
  bankLine('Account No', profile.account_no || '', margin + 3, bank_y + 16);
  bankLine('IFSC', profile.ifsc || '', margin + 56, bank_y + 16);

  // Right: UPI QR (if applicable)
  const upi_id_prof = (profile.upi_id || '').trim();
  let qr_amount = grandT;
  if (invoiceData.tds_applicable) {
    const tds_deduction = Math.round(Math.abs(subT) * 0.01 * 100) / 100;
    qr_amount = Math.round((Math.abs(grandT) - tds_deduction) * 100) / 100;
  }
  const qr_x = margin + bank_w + 4;
  const qr_w = page_width - bank_w - 4;
  if (upi_id_prof && grandT > 0 && !is_credit_note && !is_debit_note) {
    try {
      const qrBuf = await generateUpiQrBuffer(upi_id_prof, profile.company_name || env.UPI_NAME, qr_amount);
      if (qrBuf) {
        const qrPath = writeTempPng(qrBuf);
        tempFiles.push(qrPath);
        setColor('fill', COLOR.panel);
        setColor('draw', COLOR.border);
        pdf.rect(qr_x, bank_y, qr_w, bank_h, 'FD');
        setColor('text', COLOR.muted);
        pdf.set_font('Calibri', 'B', 7);
        pdf.set_xy(qr_x + 3, bank_y + 2);
        pdf.cell(qr_w - 6, 4, 'PAY VIA UPI', 0, 1, 'L');
        pdf.image(qrPath, qr_x + 3, bank_y + 7, 18, 18);
        setColor('text', COLOR.ink);
        pdf.set_font('Calibri', '', 7);
        pdf.set_xy(qr_x + 24, bank_y + 8);
        pdf.cell(qr_w - 27, 3, upi_id_prof, 0, 1, 'L');
        pdf.set_xy(qr_x + 24, bank_y + 12);
        pdf.set_font('Calibri', 'B', 10);
        pdf.cell(qr_w - 27, 5, `Rs. ${qr_amount.toFixed(2)}`, 0, 1, 'L');
        if (invoiceData.tds_applicable) {
          pdf.set_xy(qr_x + 24, bank_y + 17);
          setColor('text', COLOR.muted);
          pdf.set_font('Calibri', 'I', 7);
          pdf.cell(qr_w - 27, 3, 'After TDS @1%', 0, 1, 'L');
        }
        setColor('text', COLOR.ink);
      }
    } catch {}
  }

  pdf.set_y(bank_y + bank_h + 6);

  // ── 9. FOOTER: "For <Company>" + signature + Authorised Signatory label ─
  // Lay everything out at explicit Y positions, and use multi_cell for the
  // company line so a long name wraps deterministically. We then place the
  // signature image strictly BELOW the wrapped block.
  const sig_box_w = 60;
  const sig_box_h = 18; // fixed signature-image box height
  const sig_x = right_edge - sig_box_w;
  const for_y = pdf.get_y();
  const for_text = `For ${profile.company_name || 'Sahayak ERP'}`;

  pdf.set_font('Calibri', 'B', 9);
  setColor('text', COLOR.ink);
  pdf.set_xy(sig_x, for_y);
  // multi_cell wraps cleanly and advances Y past the bottom of the wrapped text
  pdf.multi_cell(sig_box_w, 4.5, for_text, 0, 'R');
  const for_bottom = pdf.get_y();

  // Signature image sits BELOW the wrapped "For ..." block
  const sig_top = for_bottom + 1;
  const sigBuf = decodeBase64Image(profile.signature_base64);
  if (sigBuf) {
    const sigPath = writeTempPng(sigBuf);
    tempFiles.push(sigPath);
    try { pdf.image(sigPath, sig_x + 8, sig_top, sig_box_w - 16, sig_box_h - 2); } catch {}
  }
  // Hairline separator under the signature image
  setColor('draw', COLOR.border);
  pdf.line(sig_x + 4, sig_top + sig_box_h, sig_x + sig_box_w - 4, sig_top + sig_box_h);

  pdf.set_xy(sig_x, sig_top + sig_box_h + 1);
  pdf.set_font('Calibri', '', 7);
  setColor('text', COLOR.muted);
  pdf.cell(sig_box_w, 4, 'Authorised Signatory', 0, 1, 'R');
  setColor('text', COLOR.ink);

  const out = await pdf.output();
  tempFiles.forEach(safeUnlink);
  return out;
}

module.exports = { generateInvoicePdf };
