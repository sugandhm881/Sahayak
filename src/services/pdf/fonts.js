const path = require('path');

const CALIBRI_FONT_PATH = path.join(__dirname, '..', '..', '..', 'CALIBRI.TTF');

function registerFonts(doc) {
  try {
    doc.registerFont('Calibri', CALIBRI_FONT_PATH);
    // PDFKit: bold/italic emulated via same font (original FPDF also reuses same file).
    doc.registerFont('Calibri-B', CALIBRI_FONT_PATH);
    doc.registerFont('Calibri-I', CALIBRI_FONT_PATH);
  } catch (e) {
    // fall back to built-in Helvetica
  }
}

module.exports = { CALIBRI_FONT_PATH, registerFonts };
