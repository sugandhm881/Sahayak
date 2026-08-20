// Server-side session store backed by Supabase (table: http_sessions).
// Replaces the old client-side cookie-session: sessions are now revocable —
// deactivating a user, resetting a password, or renaming kills live sessions.
// Requires migrations/002_sessions_counters_indexes.sql to have been run.

const session = require('express-session');
const supabase = require('../config/supabase');

const TABLE = 'http_sessions';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class SupabaseSessionStore extends session.Store {
  async get(sid, cb) {
    try {
      const { data, error } = await supabase.from(TABLE)
        .select('sess, expire').eq('sid', sid).maybeSingle();
      if (error) throw error;
      if (!data) return cb(null, null);
      if (data.expire && new Date(data.expire).getTime() <= Date.now()) {
        supabase.from(TABLE).delete().eq('sid', sid).then(() => {}, () => {});
        return cb(null, null);
      }
      cb(null, data.sess);
    } catch (e) {
      console.error('[session] load failed (did you run migrations/002_sessions_counters_indexes.sql?):', e.message);
      cb(e);
    }
  }

  async set(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || DEFAULT_TTL_MS;
      const row = {
        sid,
        sess,
        expire: new Date(Date.now() + maxAge).toISOString(),
        user_id: (sess.user && sess.user.id) || null,
      };
      const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'sid' });
      if (error) throw error;
      // Opportunistic cleanup of expired rows (~1% of writes)
      if (Math.random() < 0.01) {
        supabase.from(TABLE).delete().lt('expire', new Date().toISOString()).then(() => {}, () => {});
      }
      if (cb) cb(null);
    } catch (e) {
      console.error('[session] save failed (did you run migrations/002_sessions_counters_indexes.sql?):', e.message);
      if (cb) cb(e);
    }
  }

  async destroy(sid, cb) {
    try {
      await supabase.from(TABLE).delete().eq('sid', sid);
      if (cb) cb(null);
    } catch (e) { if (cb) cb(e); }
  }

  // Absolute 7-day expiry (no per-request DB write): touch is a no-op.
  touch(sid, sess, cb) { if (cb) cb(null); }
}

// Kill all live sessions for a user (optionally keeping the caller's own).
// Fire-and-forget safe: logs, never throws.
async function destroySessionsForUser(username, { exceptSid } = {}) {
  try {
    let q = supabase.from(TABLE).delete().eq('user_id', username);
    if (exceptSid) q = q.neq('sid', exceptSid);
    await q;
  } catch (e) {
    console.warn('[session] destroySessionsForUser failed:', e.message);
  }
}

module.exports = { SupabaseSessionStore, destroySessionsForUser };
