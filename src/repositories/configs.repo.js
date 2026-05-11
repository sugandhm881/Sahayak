const supabase = require('../config/supabase');
const { getTenantId } = require('../middleware/tenant');

const DEFAULT_PROFILE = { company_name: 'Sahayak ERP', invoice_prefix: 'SHK' };

async function getSellerProfile(req, targetUserId) {
  const tenant = await getTenantId(req, targetUserId);
  try {
    const { data } = await supabase.from('configs').select('profile').eq('tenant_id', tenant);
    if (data && data[0] && data[0].profile) return data[0].profile;
  } catch (e) {
    console.error('Profile error:', e.message);
  }
  return { ...DEFAULT_PROFILE };
}

async function saveSellerProfile(req, profile, targetUserId) {
  const tenant = await getTenantId(req, targetUserId);
  const { data } = await supabase.from('configs').select('tenant_id').eq('tenant_id', tenant);
  if (data && data.length > 0) {
    await supabase.from('configs').update({ profile }).eq('tenant_id', tenant);
  } else {
    await supabase.from('configs').insert({ tenant_id: tenant, profile, counters: {} });
  }
}

async function getMasterConfigProfile() {
  try {
    const { data } = await supabase.from('configs').select('profile').eq('tenant_id', 'master_config');
    if (data && data[0] && data[0].profile) return data[0].profile;
  } catch (e) {}
  return {};
}

module.exports = { getSellerProfile, saveSellerProfile, getMasterConfigProfile };
