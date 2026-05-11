const UNITS = ['', 'One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
  'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigit(n) {
  if (n < 20) return UNITS[n];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return TENS[t] + (u ? ' ' + UNITS[u] : '');
}
function threeDigit(n) {
  let s = '';
  if (n >= 100) {
    s += UNITS[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '');
  }
  if (n % 100) s += twoDigit(n % 100);
  return s;
}

function convertToWords(number) {
  const abs = Math.abs(Number(number) || 0);
  let n = Math.floor(abs);
  const paise = Math.round((abs - n) * 100);
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = n;
  const parts = [];
  if (crore) parts.push(threeDigit(crore) + ' Crore');
  if (lakh) parts.push(threeDigit(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigit(thousand) + ' Thousand');
  if (hundred) parts.push(threeDigit(hundred));
  let words = parts.length ? parts.join(' ') : 'Zero';
  if (paise) words += ` and ${twoDigit(paise)} Paise`;
  return words + ' Only';
}

module.exports = { convertToWords };
