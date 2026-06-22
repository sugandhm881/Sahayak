const ExcelJS = require('exceljs');
const { STATE_CODES } = require('../../config/constants');
const { loadInvoices }  = require('../../repositories/documents.repo');

const INDIGO   = 'FF4338CA';
const INDIGO_L = 'FFEDE9FE';
const ROW_ALT  = 'FFF5F3FF';
const WHITE    = 'FFFFFFFF';
const MONEY    = '#,##0.00';

// B2CL threshold — invoices above this (inter-state, no GSTIN) go to B2CL
const B2CL_THRESHOLD = 250000;

const MON_NUM = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
                  Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };

function styleHeader(ws, numCols) {
  const hr = ws.getRow(1);
  hr.height = 28;
  hr.font      = { bold: true, color: { argb: WHITE }, size: 10 };
  hr.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: INDIGO } };
  hr.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  for (let c = 1; c <= numCols; c++) {
    ws.getCell(1, c).border = { bottom: { style: 'medium', color: { argb: INDIGO } } };
  }
}

function altRow(row, n) {
  row.font = { size: 10 };
  if (n % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT } };
}

async function generateGstr1Excel(req, monthYear) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sahayak ERP';
  wb.created = new Date();

  // ── B2B — Taxable invoices to registered buyers ──────────────────────
  const b2b = wb.addWorksheet('B2B');
  b2b.views = [{ state: 'frozen', ySplit: 1 }];
  b2b.columns = [
    { header: 'GSTIN of Recipient',  width: 20 },
    { header: 'Invoice Number',       width: 18 },
    { header: 'Invoice Date',         width: 14 },
    { header: 'Invoice Value (₹)',    width: 18 },
    { header: 'Place of Supply',      width: 22 },
    { header: 'Reverse Charge',       width: 16 },
    { header: 'Invoice Type',         width: 14 },
    { header: 'E-Commerce GSTIN',     width: 20 },
    { header: 'Rate (%)',             width: 10 },
    { header: 'Taxable Value (₹)',   width: 18 },
    { header: 'Cess Amount (₹)',     width: 16 },
  ];
  styleHeader(b2b, 11);
  b2b.autoFilter = { from: 'A1', to: 'K1' };

  // ── B2CL — B2C large invoices (no GSTIN, value > ₹2.5L, inter-state) ─
  const b2cl = wb.addWorksheet('B2CL');
  b2cl.views = [{ state: 'frozen', ySplit: 1 }];
  b2cl.columns = [
    { header: 'Invoice Number',       width: 18 },
    { header: 'Invoice Date',         width: 14 },
    { header: 'Invoice Value (₹)',    width: 18 },
    { header: 'Place of Supply',      width: 22 },
    { header: 'Rate (%)',             width: 10 },
    { header: 'Taxable Value (₹)',   width: 18 },
    { header: 'Cess Amount (₹)',     width: 16 },
    { header: 'E-Commerce GSTIN',     width: 20 },
  ];
  styleHeader(b2cl, 8);
  b2cl.autoFilter = { from: 'A1', to: 'H1' };

  // ── B2CS — B2C small (no GSTIN, intra-state OR value ≤ ₹2.5L) ────────
  const b2cs = wb.addWorksheet('B2CS');
  b2cs.views = [{ state: 'frozen', ySplit: 1 }];
  b2cs.columns = [
    { header: 'Type',                 width: 8  },
    { header: 'Place of Supply',      width: 22 },
    { header: 'Rate (%)',             width: 10 },
    { header: 'Taxable Value (₹)',   width: 18 },
    { header: 'Cess Amount (₹)',     width: 16 },
    { header: 'E-Commerce GSTIN',     width: 20 },
  ];
  styleHeader(b2cs, 6);

  // ── CDNR — Credit / Debit Notes for Registered buyers ────────────────
  const cdnr = wb.addWorksheet('CDNR');
  cdnr.views = [{ state: 'frozen', ySplit: 1 }];
  cdnr.columns = [
    { header: 'GSTIN of Recipient',   width: 20 },
    { header: 'Note Number',          width: 18 },
    { header: 'Note Date',            width: 14 },
    { header: 'Note Type',            width: 12 },
    { header: 'Note Value (₹)',       width: 18 },
    { header: 'Place of Supply',      width: 22 },
    { header: 'Reverse Charge',       width: 16 },
    { header: 'Invoice Type',         width: 14 },
    { header: 'Rate (%)',             width: 10 },
    { header: 'Taxable Value (₹)',   width: 18 },
    { header: 'Cess Amount (₹)',     width: 16 },
  ];
  styleHeader(cdnr, 11);
  cdnr.autoFilter = { from: 'A1', to: 'K1' };

  // ── CDNUR — Credit / Debit Notes for Unregistered buyers ─────────────
  const cdnur = wb.addWorksheet('CDNUR');
  cdnur.views = [{ state: 'frozen', ySplit: 1 }];
  cdnur.columns = [
    { header: 'UR Type',              width: 12 },
    { header: 'Note Number',          width: 18 },
    { header: 'Note Date',            width: 14 },
    { header: 'Note Type',            width: 12 },
    { header: 'Note Value (₹)',       width: 18 },
    { header: 'Place of Supply',      width: 22 },
    { header: 'Rate (%)',             width: 10 },
    { header: 'Taxable Value (₹)',   width: 18 },
    { header: 'Cess Amount (₹)',     width: 16 },
  ];
  styleHeader(cdnur, 9);

  // ── EXEMP — Nil/Exempt/Non-GST supplies ──────────────────────────────
  const exemp = wb.addWorksheet('EXEMP');
  exemp.views = [{ state: 'frozen', ySplit: 1 }];
  exemp.columns = [
    { header: 'Description',          width: 30 },
    { header: 'Nil Rated (₹)',        width: 18 },
    { header: 'Exempt (₹)',           width: 18 },
    { header: 'Non-GST (₹)',          width: 18 },
  ];
  styleHeader(exemp, 4);

  // ─────────────────────────────────────────────────────────────────────
  const invoices = (await loadInvoices(req)).filter(d => (d.doc_category || 'sale') === 'sale');

  let b2bN = 0, b2clN = 0, b2csGroups = {}, cdnrN = 0, cdnurN = 0;
  let exempNil = 0, exempExempt = 0, exempNonGst = 0;

  for (const inv of invoices) {
    const inv_date = inv.invoice_date || '';

    // Month filter
    if (monthYear) {
      const p = inv_date.split('-');
      if (p.length !== 3 || `${p[1]} ${p[2]}` !== monthYear) continue;
    }

    const gstin       = (inv.client_gstin || '').trim();
    const hasGstin    = gstin.length >= 15;
    const state_code  = STATE_CODES[inv.client_state || ''] || '';
    const pos         = state_code ? `${state_code}-${inv.client_state || ''}` : (inv.client_state || '');
    const grand       = parseFloat(inv.grand_total) || 0;
    const is_cn       = !!(inv.is_credit_note || inv.doc_type === 'cn');
    const is_dn       = !!(inv.is_debit_note  || inv.doc_type === 'dn');
    const is_note     = is_cn || is_dn;
    const is_non_gst  = !!inv.is_non_gst;
    const is_nil      = !!inv.is_nil_rated;
    const is_interstate = !!inv.is_interstate;

    // Group taxable amounts by GST rate
    const rates    = inv.rates    || [];
    const taxrates = inv.taxrates || [];
    const amounts  = inv.amounts  || [];
    const tax_groups = {};
    for (let i = 0; i < amounts.length; i++) {
      const rate    = parseFloat(taxrates[i] || 0);
      const taxable = parseFloat(amounts[i]  || 0);
      tax_groups[rate] = (tax_groups[rate] || 0) + taxable;
    }

    // ── Nil / Exempt / Non-GST ─────────────────────────────────────────
    if (is_non_gst) {
      exempNonGst += grand;
      continue;
    }
    if (is_nil) {
      exempNil += grand;
      continue;
    }

    // ── Credit / Debit Notes ──────────────────────────────────────────
    if (is_note) {
      const note_type = is_cn ? 'C' : 'D';
      if (hasGstin) {
        for (const [rate, taxable] of Object.entries(tax_groups)) {
          cdnrN++;
          const row = cdnr.addRow([
            gstin, inv.bill_no, inv_date, note_type,
            grand, pos, 'N', 'Regular',
            parseFloat(rate), taxable, 0,
          ]);
          [5,10].forEach(c => { row.getCell(c).numFmt = MONEY; });
          altRow(row, cdnrN);
        }
      } else {
        for (const [rate, taxable] of Object.entries(tax_groups)) {
          cdnurN++;
          const urType = is_interstate ? 'B2CL' : 'B2CS';
          const row = cdnur.addRow([
            urType, inv.bill_no, inv_date, note_type,
            grand, pos, parseFloat(rate), taxable, 0,
          ]);
          [5,8].forEach(c => { row.getCell(c).numFmt = MONEY; });
          altRow(row, cdnurN);
        }
      }
      continue;
    }

    // ── Regular invoices ──────────────────────────────────────────────
    if (hasGstin) {
      // B2B
      for (const [rate, taxable] of Object.entries(tax_groups)) {
        b2bN++;
        const row = b2b.addRow([
          gstin, inv.bill_no, inv_date, grand,
          pos, 'N', 'Regular', '',
          parseFloat(rate), taxable, 0,
        ]);
        [4,10].forEach(c => { row.getCell(c).numFmt = MONEY; });
        altRow(row, b2bN);
      }
    } else {
      // B2CL vs B2CS — inter-state AND value > ₹2.5L → B2CL
      const goB2CL = is_interstate && grand > B2CL_THRESHOLD;
      if (goB2CL) {
        for (const [rate, taxable] of Object.entries(tax_groups)) {
          b2clN++;
          const row = b2cl.addRow([
            inv.bill_no, inv_date, grand,
            pos, parseFloat(rate), taxable, 0, '',
          ]);
          [3,6].forEach(c => { row.getCell(c).numFmt = MONEY; });
          altRow(row, b2clN);
        }
      } else {
        // Aggregate B2CS by (place_of_supply, rate)
        for (const [rate, taxable] of Object.entries(tax_groups)) {
          const key = `${pos}||${rate}`;
          if (!b2csGroups[key]) b2csGroups[key] = { pos, rate: parseFloat(rate), taxable: 0 };
          b2csGroups[key].taxable += taxable;
        }
      }
    }
  }

  // Write aggregated B2CS rows
  let b2csN = 0;
  for (const g of Object.values(b2csGroups)) {
    b2csN++;
    const row = b2cs.addRow(['OE', g.pos, g.rate, g.taxable, 0, '']);
    row.getCell(4).numFmt = MONEY;
    altRow(row, b2csN);
  }

  // Write EXEMP summary (one-row summary table)
  if (exempNil + exempExempt + exempNonGst > 0) {
    const row = exemp.addRow(['Summary', exempNil, exempExempt, exempNonGst]);
    [2,3,4].forEach(c => { row.getCell(c).numFmt = MONEY; });
    row.font = { size: 10 };
  }

  // Empty-sheet placeholder
  const allEmpty = b2bN + b2clN + b2csN + cdnrN + cdnurN === 0;
  if (allEmpty) {
    b2b.addRow(['No taxable sales found for the selected period.']);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { generateGstr1Excel };