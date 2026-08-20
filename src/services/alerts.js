// Critical-error alerting over the existing SMTP transport — no external
// monitoring account needed. Throttled per error-kind so a failure storm sends
// one email an hour, not thousands. Fire-and-forget: never throws to callers.

const env = require('../config/env');
const { sendEmailRaw } = require('./email');

const THROTTLE_MS = 60 * 60 * 1000; // max 1 email per kind per hour
const lastSent = new Map();

async function alertError(kind, detail) {
  try {
    const now = Date.now();
    if (now - (lastSent.get(kind) || 0) < THROTTLE_MS) return;
    lastSent.set(kind, now);
    const to = env.ALERT_EMAIL || env.EMAIL_USER;
    if (!to) return;
    const body = `Time (UTC): ${new Date().toISOString()}\nKind: ${kind}\n\n${String(detail || '').slice(0, 5000)}\n\n` +
      `(Throttled: at most one email per error kind per hour. Check server logs for the full picture.)`;
    await sendEmailRaw(to, `[Sahayak ALERT] ${kind}`, body);
  } catch (e) {
    console.error('[alerts] failed to send alert email:', e.message);
  }
}

module.exports = { alertError };
