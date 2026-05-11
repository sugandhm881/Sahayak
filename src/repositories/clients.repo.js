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

async function saveSingleClient(req, name, data) {
  const tenant = await getTenantId(req);
  await supabase.from('clients').upsert({ tenant_id: tenant, name, data }, { onConflict: 'tenant_id,name' });
}

module.exports = { loadClients, saveSingleClient };
