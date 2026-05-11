// Audit log helper. Fire-and-forget; never throws into the caller.

const supabase = require('../../config/supabase');
const { getTenantId } = require('../../middleware/tenant');

async function log(req, action, ref_type, ref_id, details) {
  try {
    const tenant = await getTenantId(req);
    const actor = (req.session && req.session.user && req.session.user.id) || null;
    await supabase.from('audit_log').insert({
      tenant_id: tenant,
      actor,
      action,
      ref_type,
      ref_id: String(ref_id || ''),
      details: details || null,
    });
  } catch (e) {
    // Audit is best-effort.
  }
}

module.exports = { log };
