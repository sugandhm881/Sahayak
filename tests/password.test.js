const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { hashPassword, verifyPassword } = require('../src/utils/password');

test('bcrypt hash/verify roundtrip', async () => {
  const h = await hashPassword('S3cret!pass');
  assert.ok(/^\$2[aby]\$/.test(h), 'produces a bcrypt hash');
  assert.strictEqual(await verifyPassword(h, 'S3cret!pass'), true);
  assert.strictEqual(await verifyPassword(h, 'wrong-pass'), false);
});

test('Werkzeug pbkdf2 hashes verify (Python-generated passwords stay valid)', async () => {
  const salt = 'abc123salt';
  const iterations = 600000;
  const derived = crypto.pbkdf2Sync('mypassword', salt, iterations, 32, 'sha256').toString('hex');
  const stored = `pbkdf2:sha256:${iterations}$${salt}$${derived}`;
  assert.strictEqual(await verifyPassword(stored, 'mypassword'), true);
  assert.strictEqual(await verifyPassword(stored, 'wrong'), false);
});

test('empty/garbage stored hash never verifies', async () => {
  assert.strictEqual(await verifyPassword('', 'x'), false);
  assert.strictEqual(await verifyPassword(null, 'x'), false);
});