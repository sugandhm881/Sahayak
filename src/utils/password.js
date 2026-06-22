const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Werkzeug-compatible hash format: method$salt$hash
//   method examples: "pbkdf2:sha256:600000"
//   hash: hex
// This lets existing Python-generated user passwords verify in Node.
function verifyWerkzeug(stored, plain) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [method, salt, hashHex] = parts;
  const m = /^pbkdf2:([a-z0-9]+)(?::(\d+))?$/i.exec(method);
  if (!m) return false;
  const algo = m[1].toLowerCase();
  const iterations = parseInt(m[2] || '260000', 10);
  const keyLen = Buffer.from(hashHex, 'hex').length;
  try {
    const derived = crypto.pbkdf2Sync(plain, salt, iterations, keyLen, algo);
    return crypto.timingSafeEqual(derived, Buffer.from(hashHex, 'hex'));
  } catch (e) { return false; }
}

async function verifyPassword(stored, plain) {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2:')) return verifyWerkzeug(stored, plain);
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    try { return await bcrypt.compare(plain, stored); } catch { return false; }
  }
  // plain fallback (should not happen)
  return stored === plain;
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

module.exports = { verifyPassword, hashPassword };
