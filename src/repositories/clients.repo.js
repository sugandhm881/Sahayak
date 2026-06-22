const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');

async function loadClients(req) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('clients').select('numeric_id, name, data').eq('tenant_id', tenant);
  const result = {};
  (data || []).forEach((r) => {
    const d = r.data || {};
    d.client_id = r.numeric_id;
    result[r.name] = d;
  });
  return result;
}

async function saveSingleClient(req, name, incomingData) {
  const tenant = await getTenantId(req);
  // Fetch existing row and deep-merge so shipto, bank details, type, and any other
  // fields set via the vendor form are never silently overwritten by invoice saves.
  const { data: rows } = await supabase.from('clients').select('data').eq('tenant_id', tenant).eq('name', name);
  const existing = (rows && rows[0] && rows[0].data) || {};
  // Only update shipto_* fields from incoming data if they are non-empty,
  // so an invoice with empty Ship To doesn't erase a vendor's saved shipping address.
  const merged = { ...existing };
  for (const [k, v] of Object.entries(incomingData)) {
    if (k.startsWith('shipto_')) {
      if (v !== '' && v != null) merged[k] = v;
    } else {
      merged[k] = v;
    }
  }
  const { error } = await supabase.from('clients').upsert({ tenant_id: tenant, name, data: merged }, { onConflict: 'tenant_id,name' });
  if (error) throw new Error(`saveSingleClient failed for "${name}": ${error.message}`);
}

module.exports = { loadClients, saveSingleClient };
