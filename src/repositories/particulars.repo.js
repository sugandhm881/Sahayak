const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');

async function loadParticulars(req) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('particulars').select('name, data').eq('tenant_id', tenant);
  const out = {};
  (data || []).forEach((r) => { out[r.name] = r.data; });
  return out;
}

async function saveSingleParticular(req, name, incomingData) {
  const tenant = await getTenantId(req);
  // Always fetch the current row and deep-merge so no existing field is ever silently lost.
  const { data: rows } = await supabase.from('particulars').select('data').eq('tenant_id', tenant).eq('name', name);
  const existing = (rows && rows[0] && rows[0].data) || {};
  const merged = { ...existing, ...incomingData };
  const { error } = await supabase.from('particulars').upsert({ tenant_id: tenant, name, data: merged }, { onConflict: 'tenant_id,name' });
  if (error) throw new Error(`saveSingleParticular failed for "${name}": ${error.message}`);
}

// Resolve a particular by its Product ID (stored inside the jsonb `data.product_id`).
// Returns { name, data } if found, else null.
async function getByProductId(req, productId) {
  if (!productId) return null;
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('particulars').select('name, data').eq('tenant_id', tenant);
  const pid = String(productId).trim().toLowerCase();
  for (const row of (data || [])) {
    const rowPid = String((row.data && row.data.product_id) || '').trim().toLowerCase();
    if (rowPid && rowPid === pid) return { name: row.name, data: row.data };
  }
  return null;
}

async function deleteParticular(req, name) {
  const tenant = await getTenantId(req);
  await supabase.from('particulars').delete().eq('tenant_id', tenant).eq('name', name);
}

// Append a single change-log row.
async function logChange(req, particularName, productId, field, oldValue, newValue, notes = '') {
  const tenant = await getTenantId(req);
  const actor = (req.session && req.session.user && req.session.user.id) || '';
  await supabase.from('product_changelog').insert({
    tenant_id: tenant,
    particular_name: particularName,
    product_id: productId || null,
    field,
    old_value: oldValue == null ? null : String(oldValue),
    new_value: newValue == null ? null : String(newValue),
    actor,
    notes: notes || null,
  });
}

// Read the changelog. If `particularName` is given, filter to that particular.
async function listChangelog(req, particularName = null, limit = 200) {
  const tenant = await getTenantId(req);
  let q = supabase.from('product_changelog')
    .select('*')
    .eq('tenant_id', tenant)
    .order('changed_at', { ascending: false })
    .limit(limit);
  if (particularName) q = q.eq('particular_name', particularName);
  const { data } = await q;
  return data || [];
}

module.exports = {
  loadParticulars,
  saveSingleParticular,
  getByProductId,
  deleteParticular,
  logChange,
  listChangelog,
};
