// Multi-format bank statement parser.
// Handles: XLSX, XLS-as-HTML (HDFC/SBI style), CSV (comma/tab/semicolon/pipe),
//          TSV/TXT, PDF (text-based), and plain-text fixed-width.

// ─── Column candidate lists ───────────────────────────────────────────────────

const DATE_CANDIDATES = [
  'date', 'txn date', 'tran date', 'transaction date', 'value date', 'value dt',
  'posting date', 'book date', 'entry date', 'effective date',
];
const DESC_CANDIDATES = [
  'description', 'narration', 'particulars', 'details', 'remarks',
  'transaction remarks', 'transaction details', 'transaction description',
  'transaction narration',
];
const REF_CANDIDATES = [
  'ref', 'ref no', 'ref no/chq no', 'reference', 'chq no', 'cheque', 'chq/ref',
  'chq./ref.no.', 'cheque number', 'cheque/ref no', 'instrument no',
  'chq ref number', 'chq ref no', 'inst id',
];
const DR_CANDIDATES = [
  'debit', 'withdrawal', 'withdrawal amt', 'withdrawal amount',
  'withdrawal amount (inr)', 'withdrawal (dr)', 'debit amount',
  'dr', 'paid out', 'dr amount', 'withdrawals',
];
const CR_CANDIDATES = [
  'credit', 'deposit', 'deposit amt', 'deposit amount',
  'deposit amount (inr)', 'deposit (cr)', 'credit amount',
  'cr', 'paid in', 'cr amount', 'deposits',
];
const AMT_CANDIDATES = ['amount', 'amt', 'transaction amount', 'trans amount'];
const TYPE_CANDIDATES = ['type', 'dr/cr', 'dr / cr', 'txn type', 'transaction type', 'cr/dr'];
const BAL_CANDIDATES = [
  'balance', 'running balance', 'closing balance', 'balance (inr)',
  'available balance', 'book balance',
];

// ─── Core helpers ─────────────────────────────────────────────────────────────

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function findCol(headers, candidates) {
  const normed = headers.map(norm);
  // Exact match first
  for (const c of candidates) {
    const t = norm(c);
    const i = normed.indexOf(t);
    if (i >= 0) return i;
  }
  // Substring match second (e.g. 'withdrawal' inside 'withdrawalamt')
  for (const c of candidates) {
    const t = norm(c);
    const i = normed.findIndex((h) => h.includes(t) || t.includes(h));
    if (i >= 0 && normed[i].length > 0) return i;
  }
  return -1;
}

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  // Handle Indian number format 2,07,811.58 and leading minus / parentheses
  const s = String(v).replace(/[,\s₹]/g, '').replace(/^\((.+)\)$/, '-$1');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function toIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  // Already ISO
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // DD/MM/YYYY  DD-MM-YYYY  DD.MM.YYYY  DD/MM/YY  DD-MM-YY
  m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  // DD-Mon-YYYY  04-Apr-2025  04 Apr 25
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[\s\-](\d{2,4})/);
  if (m) {
    const MO = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                 jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
    const mo = MO[m[2].toLowerCase()];
    if (mo) {
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${y}-${mo}-${m[1].padStart(2, '0')}`;
    }
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function isJunkRow(cells) {
  // Skip separator / header-repeat rows: all non-empty cells are made of *, -, =, _, #, ~
  const filled = cells.filter((c) => String(c || '').trim().length > 0);
  return filled.length > 0 && filled.every((c) => /^[*\-=_#~\s]+$/.test(String(c)));
}

function isBlankRow(cells) {
  return cells.every((c) => String(c || '').trim().length === 0);
}

// ─── Header row finder ────────────────────────────────────────────────────────

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const lower = rows[i].map((h) => String(h || '').toLowerCase());
    // Must have a date-ish column AND at least one amount-ish column
    const hasDate = lower.some((h) => DATE_CANDIDATES.some((c) => h.includes(c.replace(/\s/g, ''))));
    const hasAmt  = lower.some((h) =>
      [...DR_CANDIDATES, ...CR_CANDIDATES, ...AMT_CANDIDATES]
        .some((c) => h.includes(norm(c)))
    );
    if (hasDate && hasAmt) return i;
    // Also accept: has 'date' literal AND 'balance' — e.g. "Date  Description  Balance"
    const hasDateLit = lower.some((h) => h === 'date' || h.endsWith('date'));
    const hasBal     = lower.some((h) => BAL_CANDIDATES.some((c) => h.includes(c.replace(/\s/g, ''))));
    if (hasDateLit && hasBal) return i;
  }
  return -1;
}

// ─── Row alignment fix for unquoted commas in narration ──────────────────────
// When a CSV narration like "NEFT, MUM" is unquoted, parseCsv splits it into
// extra cells. We detect extra cells and merge them back into the description.

function fixRowAlignment(row, headerLen, cDesc, cDr, cCr, cBal) {
  if (row.length <= headerLen) return row;
  const extra = row.length - headerLen;
  // The "safe right side" are the last 1-3 numeric columns (debit/credit/balance)
  const rightCols = Math.max(cDr, cCr, cBal >= 0 ? cBal : 0) - (headerLen - 1) + headerLen;
  const mergeFrom = cDesc >= 0 ? cDesc : 1;
  const mergeTo   = mergeFrom + extra; // inclusive of merged cells

  const merged = row.slice(mergeFrom, mergeTo + 1).join(', ');
  return [
    ...row.slice(0, mergeFrom),
    merged,
    ...row.slice(mergeTo + 1),
  ];
}

// ─── Core row-array → transactions ───────────────────────────────────────────

function parseRowArrays(rows) {
  if (!rows || rows.length < 2) return [];

  const headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) return [];

  const headers = rows[headerIdx].map((h) => String(h || '').trim());
  const cDate = findCol(headers, DATE_CANDIDATES);
  const cDesc = findCol(headers, DESC_CANDIDATES);
  const cRef  = findCol(headers, REF_CANDIDATES);
  const cDr   = findCol(headers, DR_CANDIDATES);
  const cCr   = findCol(headers, CR_CANDIDATES);
  const cAmt  = findCol(headers, AMT_CANDIDATES);
  const cType = findCol(headers, TYPE_CANDIDATES);
  const cBal  = findCol(headers, BAL_CANDIDATES);

  // Secondary date col for banks that have both "Txn Date" and "Value Date"
  // Prefer the first date-type column, which findCol already returns.

  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    let row = rows[r];
    if (!row || isBlankRow(row) || isJunkRow(row)) continue;

    // Fix extra columns caused by unquoted commas in description
    if (row.length > headers.length && cDesc >= 0) {
      row = fixRowAlignment(row, headers.length, cDesc, cDr, cCr, cBal);
    }

    let debit = 0, credit = 0;
    if (cDr >= 0 || cCr >= 0) {
      debit  = cDr >= 0 ? toNumber(row[cDr]) : 0;
      credit = cCr >= 0 ? toNumber(row[cCr]) : 0;
    } else if (cAmt >= 0) {
      const amt = toNumber(row[cAmt]);
      const t   = cType >= 0 ? String(row[cType] || '').toLowerCase() : '';
      if (t.startsWith('d') || t.includes('dr') || amt < 0) debit = Math.abs(amt);
      else credit = Math.abs(amt);
    }

    if (!debit && !credit) continue;

    const date = cDate >= 0 ? toIsoDate(row[cDate]) : null;
    const desc = cDesc >= 0 ? String(row[cDesc] || '').trim() : '';
    const ref  = cRef  >= 0 ? String(row[cRef]  || '').trim() : '';
    const bal  = cBal  >= 0 ? toNumber(row[cBal]) : null;

    // Build raw snapshot (keyed by original header)
    const raw = {};
    headers.forEach((h, i) => { if (h) raw[h] = row[i]; });

    const txn_id = `${date || 'nd'}|${ref || ''}|${desc.slice(0, 40)}|${debit}|${credit}|${r}`;
    out.push({ txn_id, txn_date: date, description: desc, ref_no: ref, debit, credit, balance: bal, raw });
  }
  return out;
}

// ─── CSV / TSV / TXT ──────────────────────────────────────────────────────────

function detectDelimiter(text) {
  // Score delimiters by count in the first ~3000 chars, but prefer
  // tab when it appears on the header row (avoids miscount from values).
  const sample = text.slice(0, 3000);
  const firstLine = (text.split('\n')[0] || '');
  if (firstLine.includes('\t')) return '\t'; // strong signal
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  for (const c of sample) if (c in counts) counts[c]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseCsv(text, delimiter) {
  const sep = delimiter || detectDelimiter(text);
  const rows = [];
  let i = 0, field = '', row = [], inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === sep) { row.push(field.trim()); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(field.trim());
      if (row.some((v) => v !== '')) rows.push(row);
      row = []; field = ''; i++;
      continue;
    }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field.trim()); if (row.some((v) => v !== '')) rows.push(row); }
  return rows;
}

function parseStatement(text) {
  // Try tab first (avoids comma-in-narration issues)
  if (text.includes('\t')) {
    const result = parseRowArrays(parseCsv(text, '\t'));
    if (result.length > 0) return result;
  }
  // Auto-detect
  const autoDelim = detectDelimiter(text);
  const result = parseRowArrays(parseCsv(text, autoDelim));
  if (result.length > 0) return result;
  // Fallback: try comma and semicolon
  for (const d of [',', ';']) {
    if (d !== autoDelim) {
      const r = parseRowArrays(parseCsv(text, d));
      if (r.length > 0) return r;
    }
  }
  return [];
}

// ─── HTML-table (XLS-as-HTML, used by HDFC and some SBI exports) ──────────────

function parseHtmlTable(html) {
  const rows = [];
  // Strip scripts/styles
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const tagRe = /<[^>]+>/g;

  let trM;
  while ((trM = trRe.exec(clean)) !== null) {
    const cells = [];
    const localTd = new RegExp(tdRe.source, 'gi');
    let tdM;
    while ((tdM = localTd.exec(trM[1])) !== null) {
      const text = tdM[1]
        .replace(tagRe, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .trim();
      cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function isHtml(bufOrStr) {
  const s = typeof bufOrStr === 'string' ? bufOrStr : bufOrStr.toString('utf8', 0, 512);
  return /^\s*(<\?xml|<!doctype|<html)/i.test(s);
}

// ─── Excel (.xlsx) ────────────────────────────────────────────────────────────

async function parseExcel(buffer) {
  // Guard: if the buffer is actually HTML (HDFC XLS-as-HTML), fall through to HTML parser
  if (isHtml(buffer)) return parseRowArrays(parseHtmlTable(buffer.toString('utf8')));

  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    let ws = null;
    wb.eachSheet((sheet) => { if (!ws && sheet.rowCount > 1) ws = sheet; });
    if (!ws) return [];

    const rows = [];
    ws.eachRow((row) => {
      const cells = row.values.slice(1).map((v) => {
        if (v === null || v === undefined) return '';
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'object' && v.result !== undefined) return String(v.result);
        if (typeof v === 'object' && v.richText) return v.richText.map((r) => r.text).join('');
        return String(v);
      });
      rows.push(cells);
    });

    const result = parseRowArrays(rows);
    if (result.length > 0) return result;

    // If exceljs returned no rows, try reading as CSV (some .xlsx are actually CSVs)
    return parseStatement(buffer.toString('utf8'));
  } catch {
    // Parsing as Excel failed — try HTML table, then CSV fallback
    if (isHtml(buffer)) return parseRowArrays(parseHtmlTable(buffer.toString('utf8')));
    return parseStatement(buffer.toString('utf8'));
  }
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

async function parsePdf(buffer) {
  let pdfParse;
  try { pdfParse = require('pdf-parse'); } catch { return []; }

  let text = '';
  try { text = (await pdfParse(buffer)).text || ''; } catch { return []; }

  const lines = text.split('\n').map((l) => l.replace(/\t/g, '  ').trimEnd()).filter((l) => l.trim());

  // Strategy 1: split each line by 2+ spaces → virtual columns
  const headerLineIdx = lines.findIndex((l) => {
    const lo = l.toLowerCase();
    return lo.includes('date') &&
           (lo.includes('debit') || lo.includes('withdrawal') ||
            lo.includes('credit') || lo.includes('deposit') || lo.includes('amount'));
  });

  if (headerLineIdx >= 0) {
    const rows = lines.slice(headerLineIdx).map((l) =>
      l.split(/\s{2,}/).map((v) => v.trim())
    );
    const result = parseRowArrays(rows);
    if (result.length > 0) return result;
  }

  // Strategy 2: line-by-line date regex
  return parsePdfLineByLine(lines);
}

function parsePdfLineByLine(lines) {
  const DATE_RE = /^(\d{1,2}[\/\-\. ][A-Za-z]{3}[\/\-\. ]\d{2,4}|\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/;
  const out = [];
  let rowIdx = 0;

  for (const line of lines) {
    const dm = line.match(DATE_RE);
    if (!dm) continue;
    const date = toIsoDate(dm[0]);
    const rest = line.slice(dm[0].length).trim();

    const numbers = [...rest.matchAll(/(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+\.\d{1,2})/g)]
      .map((m) => parseFloat(m[0].replace(/,/g, '')))
      .filter((n) => n > 0);
    if (!numbers.length) continue;

    const firstNumIdx = rest.search(/\d+[,.\d]/);
    const desc = firstNumIdx > 0 ? rest.slice(0, firstNumIdx).trim() : rest.trim();
    const drCr = (line.match(/\b(Dr|CR|DR|Cr)\b/) || [])[0] || '';

    let debit = 0, credit = 0, balance = null;
    if (numbers.length >= 3) {
      balance = numbers[numbers.length - 1];
      const amt = numbers[numbers.length - 2];
      if (/^(cr|credit)/i.test(drCr)) credit = amt; else debit = amt;
    } else if (numbers.length === 2) {
      balance = numbers[1];
      if (/^(cr|credit)/i.test(drCr)) credit = numbers[0]; else debit = numbers[0];
    } else {
      if (/^(cr|credit)/i.test(drCr)) credit = numbers[0]; else debit = numbers[0];
    }

    if (!debit && !credit) continue;
    rowIdx++;
    const txn_id = `${date || 'nd'}||${desc.slice(0, 40)}|${debit}|${credit}|${rowIdx}`;
    out.push({ txn_id, txn_date: date, description: desc, ref_no: '', debit, credit, balance, raw: { line } });
  }
  return out;
}

// ─── Unified entry point ──────────────────────────────────────────────────────

async function parseFile(buffer, mimeType, filename) {
  const name = (filename || '').toLowerCase().trim();
  const mime = (mimeType || '').toLowerCase().trim();

  // PDF
  if (mime.includes('pdf') || name.endsWith('.pdf')) {
    return parsePdf(buffer);
  }

  // Excel (.xlsx) — true XLSX only, exceljs can't read old binary .xls
  if ((mime.includes('spreadsheet') || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      || name.endsWith('.xlsx')) {
    return parseExcel(buffer);
  }

  // XLS (old format or HDFC HTML-as-XLS) — check for HTML first, then try xlsx, then csv
  if (mime.includes('vnd.ms-excel') || mime.includes('ms-excel') || name.endsWith('.xls')) {
    if (isHtml(buffer)) return parseRowArrays(parseHtmlTable(buffer.toString('utf8')));
    // Try parsing as xlsx (some .xls are actually xlsx)
    try {
      const r = await parseExcel(buffer);
      if (r.length > 0) return r;
    } catch {}
    // Fall through to text/CSV
    return parseStatement(buffer.toString('utf8'));
  }

  // Everything else: CSV, TSV, TXT, octet-stream (also catches misidentified Excel)
  const text = buffer.toString('utf8');
  if (isHtml(text)) return parseRowArrays(parseHtmlTable(text));
  const result = parseStatement(text);
  if (result.length > 0) return result;

  // Last resort: try Excel in case MIME/extension was wrong
  try {
    const r = await parseExcel(buffer);
    if (r.length > 0) return r;
  } catch {}

  return [];
}

module.exports = { parseStatement, parseExcel, parsePdf, parseFile };
