// Atomic FY-sequential document numbering via the next_doc_seq() Postgres
// function (migrations/002). Replaces the O(n) "load every document and count"
// path on each save. countFn (the legacy scan) is used only to seed a missing
// counter row, and as a full fallback while the migration hasn't been run.

const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');

let rpcAvailable = true; // sticky per process after a hard failure

async function nextDocSeq(req, series, fy, countFn) {
  const tenant = await getTenantId(req);
  if (rpcAvailable) {
    try {
      // Seed only when the counter row doesn't exist yet (first use per FY):
      // race-safe because next_doc_seq upserts with ON CONFLICT.
      let seed = 0;
      const { data: row, error: selErr } = await supabase.from('doc_counters')
        .select('last_seq').eq('tenant_id', tenant).eq('series', series).eq('fy', fy)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!row) seed = await countFn();

      const { data, error } = await supabase.rpc('next_doc_seq', {
        p_tenant: tenant, p_series: series, p_fy: fy, p_seed: seed,
      });
      if (error) throw error;
      if (typeof data === 'number') return data;
      throw new Error('next_doc_seq returned no value');
    } catch (e) {
      rpcAvailable = false;
      console.warn('[counters] next_doc_seq unavailable — falling back to legacy scan.',
        'Run migrations/002_sessions_counters_indexes.sql. Cause:', e.message);
    }
  }
  return (await countFn()) + 1;
}

module.exports = { nextDocSeq };
