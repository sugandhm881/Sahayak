// Minimal CSV parser + column auto-detect for bank statement imports.

function parseCsv(text) {
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
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v || '').trim() !== ''));
}

function findCol(headers, candidates) {
  const norm = headers.map((h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const cand of candidates) {
    const target = cand.toLowerCase().replace(/[^a-z0-9]/g, '');
    const idx = norm.indexOf(target);
    if (idx >= 0) return idx;
  }
  for (const cand of candidates) {
    const target = cand.toLowerCase().replace(/[^a-z0-9]/g, '');
    const idx = norm.findIndex((h) => h.includes(target));
    if (idx >= 0) return idx;
  }
  return -1;
}

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).replace(/[,\s₹]/g, '').replace(/^\(|\)$/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function toIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function parseStatement(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  const cDate = findCol(headers, ['date', 'txn date', 'transaction date', 'value date']);
  const cDesc = findCol(headers, ['description', 'narration', 'particulars', 'details']);
  const cRef = findCol(headers, ['ref', 'ref no', 'reference', 'chq no', 'cheque']);
  const cDr = findCol(headers, ['debit', 'withdrawal', 'dr', 'paid out']);
  const cCr = findCol(headers, ['credit', 'deposit', 'cr', 'paid in']);
  const cAmt = findCol(headers, ['amount', 'amt']);
  const cType = findCol(headers, ['type', 'dr/cr']);
  const cBal = findCol(headers, ['balance', 'running balance', 'closing balance']);

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    let debit = 0, credit = 0;
    if (cDr >= 0 || cCr >= 0) {
      debit = cDr >= 0 ? toNumber(row[cDr]) : 0;
      credit = cCr >= 0 ? toNumber(row[cCr]) : 0;
    } else if (cAmt >= 0) {
      const amt = toNumber(row[cAmt]);
      const t = cType >= 0 ? String(row[cType] || '').toLowerCase() : '';
      if (t.startsWith('d') || amt < 0) debit = Math.abs(amt);
      else credit = Math.abs(amt);
    }
    if (!debit && !credit) continue;
    const date = cDate >= 0 ? toIsoDate(row[cDate]) : null;
    const desc = cDesc >= 0 ? String(row[cDesc] || '').trim() : '';
    const ref = cRef >= 0 ? String(row[cRef] || '').trim() : '';
    const bal = cBal >= 0 ? toNumber(row[cBal]) : null;
    const raw = {};
    headers.forEach((h, i) => { if (h) raw[h] = row[i]; });
    const txn_id = `${date || 'nd'}|${ref || ''}|${desc.slice(0, 40)}|${debit}|${credit}|${r}`;
    out.push({ txn_id, txn_date: date, description: desc, ref_no: ref, debit, credit, balance: bal, raw });
  }
  return out;
}

module.exports = { parseStatement };
