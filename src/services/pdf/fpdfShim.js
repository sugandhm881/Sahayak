// FPDF-compatible shim over PDFKit.
// All coordinate/size inputs are in millimetres (matching fpdf.py behaviour),
// internally converted to PDF points.
const PDFDocument = require('pdfkit');
const { registerFonts, CALIBRI_FONT_PATH } = require('./fonts');

const MM_TO_PT = 72 / 25.4;
const mm = (v) => v * MM_TO_PT;

class FpdfShim {
  constructor() {
    this.doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    registerFonts(this.doc);
    this.chunks = [];
    this.doc.on('data', (c) => this.chunks.push(c));
    this.doc.on('end', () => { this._endResolve && this._endResolve(Buffer.concat(this.chunks)); });
    this.doc.on('error', (err) => { this._endReject && this._endReject(err); });

    // Page metrics in mm (A4)
    this.w = 210;
    this.h = 297;
    this.lMargin = 15;
    this.rMargin = 15;
    this.tMargin = 10;
    this.bMargin = 15;

    this.x = this.lMargin;
    this.y = this.tMargin;

    this.fontFamily = 'Calibri';
    this.fontStyle = '';
    this.fontSize = 12;
    this.textColor = [0, 0, 0];
    this.fillColor = [255, 255, 255];
    this.drawColor = [0, 0, 0];
  }

  add_page() {
    this.doc.addPage({ size: 'A4', margin: 0 });
    this.x = this.lMargin;
    this.y = this.tMargin;
  }

  add_font(/* family, style, path, uni */) { /* fonts pre-registered */ }

  set_font(family, style = '', size = null) {
    this.fontFamily = family || this.fontFamily;
    this.fontStyle = style;
    if (size) this.fontSize = size;
    this._applyFont();
  }

  _applyFont() {
    const base = this.fontFamily || 'Calibri';
    let name = base;
    if (this.fontStyle.includes('B')) name = `${base}-B`;
    else if (this.fontStyle.includes('I')) name = `${base}-I`;
    try { this.doc.font(name); } catch { this.doc.font('Helvetica'); }
    this.doc.fontSize(this.fontSize);
  }

  set_text_color(r, g, b) { this.textColor = [r, g, b]; this.doc.fillColor(this._rgb(r, g, b)); }
  set_fill_color(r, g, b) { this.fillColor = [r, g, b]; }
  set_draw_color(r, g, b) { this.drawColor = [r, g, b]; this.doc.strokeColor(this._rgb(r, g, b)); }

  _rgb(r, g, b) { return [r, g, b]; }

  set_xy(x, y) { this.x = x; this.y = y; }
  set_x(x) { this.x = x; }
  set_y(y) { this.y = y; this.x = this.lMargin; }
  get_x() { return this.x; }
  get_y() { return this.y; }

  ln(h) {
    this.y += (h === undefined ? this.fontSize * 0.3528 : h); // fallback
    this.x = this.lMargin;
  }

  line(x1, y1, x2, y2) {
    this.doc.save();
    this.doc.moveTo(mm(x1), mm(y1)).lineTo(mm(x2), mm(y2)).lineWidth(0.5).stroke(this._rgb(...this.drawColor));
    this.doc.restore();
  }

  rect(x, y, w, h, style = 'D') {
    this.doc.save();
    this.doc.rect(mm(x), mm(y), mm(w), mm(h));
    if (style === 'F') this.doc.fill(this._rgb(...this.fillColor));
    else if (style === 'FD' || style === 'DF') {
      this.doc.fillAndStroke(this._rgb(...this.fillColor), this._rgb(...this.drawColor));
    } else { this.doc.lineWidth(0.3).stroke(this._rgb(...this.drawColor)); }
    this.doc.restore();
  }

  image(filePath, x, y, w, h) {
    try {
      const opts = {};
      if (w) opts.width = mm(w);
      if (h) opts.height = mm(h);
      this.doc.image(filePath, mm(x), mm(y), opts);
    } catch (e) { /* ignore missing image */ }
  }

  // Compute vertical offset so text sits roughly vertically centered in a cell of height h.
  _textYOffset(h) {
    const lineHeightPt = this.doc.currentLineHeight();
    return (mm(h) - lineHeightPt) / 2;
  }

  // cell(w, h, txt, border=0, ln=0, align='L', fill=false)
  // border: 0 no border, 1 full box, or a string containing any of 'LTRB'
  // ln: 0 -> advance x; 1 -> move to next line (x = lMargin); 2 -> below current cell
  cell(w, h, txt = '', border = 0, ln = 0, align = 'L', fill = false) {
    if (!w || w <= 0) w = this.w - this.rMargin - this.x;
    const px = mm(this.x);
    const py = mm(this.y);
    const pw = mm(w);
    const ph = mm(h);

    if (fill) {
      this.doc.save();
      this.doc.rect(px, py, pw, ph).fill(this._rgb(...this.fillColor));
      this.doc.restore();
    }

    this._drawBorders(border, px, py, pw, ph);

    // text
    if (txt !== null && txt !== undefined && txt !== '') {
      const yOffset = this._textYOffset(h);
      this.doc.save();
      this.doc.fillColor(this._rgb(...this.textColor));
      this.doc.text(String(txt), px + mm(1.5), py + yOffset, {
        width: pw - mm(3),
        align: align === 'L' ? 'left' : align === 'R' ? 'right' : 'center',
        lineBreak: false,
      });
      this.doc.restore();
    }

    if (ln === 0) this.x = this.x + w;
    else if (ln === 1) { this.x = this.lMargin; this.y = this.y + h; }
    else if (ln === 2) { this.y = this.y + h; }
  }

  _drawBorders(border, px, py, pw, ph) {
    if (!border || border === 0) return;
    this.doc.save();
    this.doc.lineWidth(0.3).strokeColor(this._rgb(...this.drawColor));
    if (border === 1) {
      this.doc.rect(px, py, pw, ph).stroke();
    } else if (typeof border === 'string') {
      if (border.includes('L')) this.doc.moveTo(px, py).lineTo(px, py + ph).stroke();
      if (border.includes('T')) this.doc.moveTo(px, py).lineTo(px + pw, py).stroke();
      if (border.includes('R')) this.doc.moveTo(px + pw, py).lineTo(px + pw, py + ph).stroke();
      if (border.includes('B')) this.doc.moveTo(px, py + ph).lineTo(px + pw, py + ph).stroke();
    }
    this.doc.restore();
  }

  // multi_cell(w, h, txt, border=0, align='L', fill=false)
  // h is the per-line height (mm). Text wraps at width w. advances y by total block height.
  multi_cell(w, h, txt = '', border = 0, align = 'L', fill = false) {
    if (!w || w <= 0) w = this.w - this.rMargin - this.x;
    const lines = this._wrapText(String(txt || ''), w);
    const totalH = lines.length * h;
    const px = mm(this.x);
    const py = mm(this.y);
    const pw = mm(w);
    const ph = mm(totalH);

    if (fill) {
      this.doc.save();
      this.doc.rect(px, py, pw, ph).fill(this._rgb(...this.fillColor));
      this.doc.restore();
    }

    this._drawBorders(border, px, py, pw, ph);

    this.doc.save();
    this.doc.fillColor(this._rgb(...this.textColor));
    let cy = py;
    for (const line of lines) {
      const yOffset = this._textYOffset(h);
      this.doc.text(line, px + mm(1.5), cy + yOffset, {
        width: pw - mm(3),
        align: align === 'L' ? 'left' : align === 'R' ? 'right' : 'center',
        lineBreak: false,
      });
      cy += mm(h);
    }
    this.doc.restore();

    this.x = this.lMargin;
    this.y = this.y + totalH;
  }

  // Estimate how many mm a multi_cell(w, h, txt) call will consume. Useful for
  // pre-computing row heights so callers can decide whether to page-break first.
  multi_cell_height(w, h, txt = '') {
    if (!w || w <= 0) w = this.w - this.rMargin - this.x;
    const lines = this._wrapText(String(txt || ''), w);
    return lines.length * h;
  }

  _wrapText(text, widthMm) {
    // split on explicit newlines then word-wrap each line
    const widthPt = mm(widthMm) - mm(3);
    const result = [];
    const paragraphs = text.split('\n');
    for (const para of paragraphs) {
      if (!para) { result.push(''); continue; }
      const words = para.split(/\s+/);
      let line = '';
      for (const word of words) {
        const candidate = line ? line + ' ' + word : word;
        if (this.doc.widthOfString(candidate) <= widthPt) {
          line = candidate;
        } else {
          if (line) result.push(line);
          line = word;
        }
      }
      if (line) result.push(line);
    }
    return result.length ? result : [''];
  }

  get_string_width(s) {
    // return mm
    return this.doc.widthOfString(String(s || '')) / MM_TO_PT;
  }

  output() {
    return new Promise((resolve, reject) => {
      this._endResolve = resolve;
      this._endReject = reject;
      this.doc.end();
    });
  }
}

module.exports = { FpdfShim, CALIBRI_FONT_PATH };
