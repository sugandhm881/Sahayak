const { test } = require('node:test');
const assert = require('node:assert');
const { fyString, parseInvoiceDate, formatLedgerDate, formatDDMonYYYY } = require('../src/utils/dates');

test('fyString: Indian financial year flips on 1 April', () => {
  assert.strictEqual(fyString(new Date(2026, 3, 1)),  '2026-27'); // 01 Apr 2026
  assert.strictEqual(fyString(new Date(2026, 2, 31)), '2025-26'); // 31 Mar 2026
  assert.strictEqual(fyString(new Date(2026, 0, 15)), '2025-26'); // 15 Jan 2026
  assert.strictEqual(fyString(new Date(2025, 11, 31)),'2025-26'); // 31 Dec 2025
});

test('parseInvoiceDate handles DD-Mon-YYYY and rejects garbage', () => {
  const d = parseInvoiceDate('02-Jun-2026');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 5);
  assert.strictEqual(d.getDate(), 2);
  assert.strictEqual(parseInvoiceDate('not-a-date'), null);
  assert.strictEqual(parseInvoiceDate(''), null);
});

test('formatLedgerDate normalizes ISO and DD-MM-YYYY to DD-Mon-YYYY', () => {
  assert.strictEqual(formatLedgerDate('2026-06-02'), '02-Jun-2026');
  assert.strictEqual(formatLedgerDate('02-06-2026'), '02-Jun-2026');
});

test('formatDDMonYYYY formats a Date correctly', () => {
  assert.strictEqual(formatDDMonYYYY(new Date(2026, 5, 2)), '02-Jun-2026');
});