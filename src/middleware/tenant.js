const supabase = require('../config/supabase');
const env = require('../config/env');

async function resolveMasterId(req) {
  const sessionMaster = req.session && req.session.master_id;
  if (sessionMaster) return sessionMaster;
  try {
    const { data } = await supabase.from('configs').select('profile').eq('tenant_id', 'master_config');
    if (data && data[0] && data[0].profile && data[0].profile.master_username) {
      const mid = data[0].profile.master_username;
      if (req.session) req.session.master_id = mid;
      return mid;
    }
  } catch (e) {}
  return env.MASTER_USERNAME;
}

async function getTenantId(req, targetUser) {
  const masterId = await resolveMasterId(req);
  const user = req.session && req.session.user;
  if (targetUser) return targetUser === masterId ? 'master' : targetUser;
  if (user && !user.is_master) return user.id;
  const view = req.session && req.session.view_mode;
  if (user && user.is_master && view && view !== masterId) return view;
  return 'master';
}

async function getAllUsers(req) {
  const masterId = await resolveMasterId(req);
  const users = [masterId];
  try {
    const { data } = await supabase.from('app_users').select('username');
    (data || []).forEach((u) => users.push(u.username));
  } catch (e) {}
  return users.sort();
}

module.exports = { getTenantId, getAllUsers, resolveMasterId };
