const { test } = require('node:test');
const assert = require('node:assert');
const { requireAnyPermission, hasPermission } = require('../src/middleware/auth');

// Simulate a request through the guard; return 'ALLOW' if next() was called,
// else the HTTP status the middleware set.
function run(user, perms) {
  const req = { session: user ? { user } : {}, method: 'POST', accepts: () => false };
  let status = 200, nexted = false;
  const res = {
    status(c) { status = c; return this; },
    json() { return this; },
    send() { return this; },
    redirect() { status = 302; return this; },
  };
  requireAnyPermission(...perms)(req, res, () => { nexted = true; });
  return nexted ? 'ALLOW' : status;
}

test('master bypasses any permission', () => {
  assert.strictEqual(run({ is_master: true }, ['accounts']), 'ALLOW');
});

test('user holding any listed permission is allowed', () => {
  assert.strictEqual(run({ permissions: ['sale'] }, ['accounts', 'sale', 'purchase']), 'ALLOW');
});

test('user without any listed permission is forbidden (403)', () => {
  assert.strictEqual(run({ permissions: ['shipping'] }, ['accounts', 'sale', 'purchase']), 403);
});

test('user with empty permissions is forbidden (403)', () => {
  assert.strictEqual(run({ permissions: [] }, ['sale']), 403);
});

test('unauthenticated request is 401', () => {
  assert.strictEqual(run(null, ['sale']), 401);
});

test('hasPermission: master always true; others by membership', () => {
  assert.strictEqual(hasPermission({ is_master: true }, 'anything'), true);
  assert.strictEqual(hasPermission({ permissions: ['sale'] }, 'sale'), true);
  assert.strictEqual(hasPermission({ permissions: ['sale'] }, 'accounts'), false);
  assert.strictEqual(hasPermission(null, 'sale'), false);
});