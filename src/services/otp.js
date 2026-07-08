const crypto = require('crypto');

// Cryptographically-secure 6-digit OTP (Math.random is predictable and must not
// be used for security tokens).
function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
module.exports = { generateOtp };