require('dotenv').config();

// ── Fail-fast secret validation ──────────────────────────────────────────────
// Refuse to boot with a missing or known-insecure secret. A signed-but-not-
// encrypted session cookie plus a public fallback key = trivial admin forgery,
// so these must be real values in every environment.
function requireSecret(name, { insecureDefaults = [], minLength = 0 } = {}) {
  const val = process.env[name];
  if (val === undefined || val === null || val === '') {
    throw new Error(`[Sahayak boot] Missing required environment variable ${name}. ` +
      `Refusing to start with an insecure default — set ${name} in your environment/.env.`);
  }
  if (insecureDefaults.includes(val)) {
    throw new Error(`[Sahayak boot] ${name} is set to a known-insecure default. ` +
      `Choose a strong, unique value before starting.`);
  }
  if (minLength && val.length < minLength) {
    // Warn (don't block) so an existing, working deploy isn't bricked, but make the weakness loud.
    console.warn(`[Sahayak boot] WARNING: ${name} is only ${val.length} chars; use at least ${minLength} for a strong secret.`);
  }
  return val;
}

module.exports = {
  SECRET_KEY:  requireSecret('SECRET_KEY',  { insecureDefaults: ['fallback-secret-for-staging', 'secret', 'changeme'], minLength: 24 }),
  CRON_SECRET: requireSecret('CRON_SECRET', { insecureDefaults: ['', 'cron'], minLength: 16 }),
  MASTER_USERNAME: requireSecret('LOGIN_USER', { insecureDefaults: [] }),
  MASTER_PASSWORD: requireSecret('LOGIN_PASS', { insecureDefaults: ['password', 'admin', '123456'], minLength: 10 }),
  SUPABASE_URL: requireSecret('SUPABASE_URL'),
  SUPABASE_KEY: requireSecret('SUPABASE_KEY'),
  EMAIL_HOST: process.env.EMAIL_HOST || 'smtp.gmail.com',
  EMAIL_PORT: parseInt(process.env.EMAIL_PORT || '587', 10),
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  UPI_ID: 'sugandh.mishra1@ybl',
  UPI_NAME: 'SM Tech',
  REPORT_HOUR_UTC: 16,
  NODE_ENV: process.env.NODE_ENV || 'development',
  RAPIDSHYP_API_URL: process.env.RAPIDSHYP_API_URL || 'https://api.rapidshyp.com/rapidshyp/apis/v1/',
  // Easyecom — paths confirmed from official API docs
  EASYECOM_API_URL:  process.env.EASYECOM_API_URL  || 'https://api.easyecom.io',
  EASYECOM_JWT_PATH: process.env.EASYECOM_JWT_PATH || '/api/getJWT',
  // GET  /getInventoryDetailsV3?includeLocations=1&limit=50 — Bearer only
  // POST /inventory {sku, quantity}                         — x-api-key + Bearer
};
