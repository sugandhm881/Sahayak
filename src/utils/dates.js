const { MONTH_MAP } = require('../config/constants');

function todayDate() { return new Date(); }

function formatDDMonYYYY(d = new Date()) {
  const day = String(d.getDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${day}-${mon}-${d.getFullYear()}`;
}

function parseInvoiceDate(str) {
  if (!str) return null;
  const parts = String(str).split('-');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  let mm;
  if (/^\d+$/.test(parts[1])) mm = parseInt(parts[1], 10);
  else mm = MONTH_MAP[parts[1]] || null;
  let year = parseInt(parts[2], 10);
  if (!day || !mm || !year) return null;
  // JavaScript treats year < 100 as 1900+year in Date constructor.
  // All legitimate dates in this ERP are in the 21st century.
  if (year < 100) year += 2000;
  const d = new Date(year, mm - 1, day);
  d.setFullYear(year); // explicit setFullYear prevents the 1900+yy shortcut
  return d;
}

function formatLedgerDate(str) {
  if (!str) return '';
  // Try yyyy-mm-dd
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) return formatDDMonYYYY(new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  // Try dd-mm-yyyy
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(str);
  if (m) return formatDDMonYYYY(new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1])));
  return str;
}

function fyString(d = new Date()) {
  const y = d.getFullYear();
  if (d.getMonth() + 1 >= 4) return `${y}-${String(y + 1).slice(-2)}`;
  return `${y - 1}-${String(y).slice(-2)}`;
}

function nowIso() { return new Date().toISOString(); }

module.exports = { todayDate, formatDDMonYYYY, parseInvoiceDate, formatLedgerDate, fyString, nowIso };
