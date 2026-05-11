const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');

function safeItemId(name) {
  return String(name || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

async function getProduct(req, safe_id) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('inventory_products').select('data').eq('tenant_id', tenant).eq('safe_id', safe_id);
  return data && data[0] ? data[0].data : null;
}

async function upsertProduct(req, safe_id, data) {
  const tenant = await getTenantId(req);
  await supabase.from('inventory_products').upsert(
    { tenant_id: tenant, safe_id, data },
    { onConflict: 'tenant_id,safe_id' }
  );
}

async function addLedgerEntry(req, data) {
  const tenant = await getTenantId(req);
  await supabase.from('inventory_ledger').insert({ tenant_id: tenant, data });
}

async function listProducts(req) {
  const tenant = await getTenantId(req);
  const { data } = await supabase.from('inventory_products').select('data').eq('tenant_id', tenant);
  return (data || []).map((r) => r.data);
}

async function listLedger(req, { itemName = null, limit = 200 } = {}) {
  const tenant = await getTenantId(req);
  let q = supabase.from('inventory_ledger').select('data').eq('tenant_id', tenant);
  const { data } = await q;
  let rows = (data || []).map((r) => r.data);
  if (itemName) rows = rows.filter((r) => (r.item_name || '') === itemName);
  rows.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  return rows.slice(0, limit);
}

module.exports = { safeItemId, getProduct, upsertProduct, addLedgerEntry, listProducts, listLedger };
