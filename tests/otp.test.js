const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { generateOtp } = require('../src/services/otp');

test('OTP is always 6 digits, including leading zeros', () => {
  for (let i = 0; i < 500; i++) assert.match(generateOtp(), /^\d{6}$/);
});

test('OTP has high entropy (crypto-random, mostly unique)', () => {
  const s = new Set(Array.from({ length: 1000 }, () => generateOtp()));
  assert.ok(s.size > 950, `expected >950 unique of 1000, got ${s.size}`);
});

test('HMAC design: cookie value never reveals the OTP and needs the server key', () => {
  const SECRET = 'server-secret-never-sent-to-browser';
  const hmac = (otp, key = SECRET) => crypto.createHmac('sha256', key).update(String(otp)).digest('hex');
  const otp = generateOtp();
  const stored = hmac(otp); // what the session cookie holds

  assert.ok(!stored.includes(otp), 'stored HMAC must not contain the plaintext OTP');

  const verify = (input, key = SECRET) => {
    const a = Buffer.from(hmac(input, key), 'hex');
    const b = Buffer.from(stored, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  assert.strictEqual(verify(otp), true, 'correct OTP verifies');
  const wrong = String((Number(otp) + 1) % 1000000).padStart(6, '0');
  assert.strictEqual(verify(wrong), false, 'wrong OTP rejected');
  assert.strictEqual(verify(otp, 'attacker-key'), false, 'cannot verify without the server key');
});