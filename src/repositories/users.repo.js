const supabase = require('../config/supabase');

async function getUser(username) {
  const { data } = await supabase.from('app_users').select('*').eq('username', username);
  return data && data[0] ? data[0] : null;
}

async function createUser({ username, password, is_active = false, permissions = [] }) {
  await supabase.from('app_users').insert({ username, password, is_active, permissions });
}

async function updateUser(username, patch) {
  await supabase.from('app_users').update(patch).eq('username', username);
}

async function deleteUser(username) {
  await supabase.from('app_users').delete().eq('username', username);
}

async function listActivationRequests() {
  try {
    const { data } = await supabase.from('activation_requests').select('data').order('created_at', { ascending: false });
    return (data || []).map((r) => r.data);
  } catch (e) { return []; }
}

async function addActivationRequest(request_id, data) {
  await supabase.from('activation_requests').insert({ request_id, data });
}

async function updateActivationRequest(request_id, data) {
  await supabase.from('activation_requests').update({ data }).eq('request_id', request_id);
}

async function getActivationRequest(request_id) {
  const { data } = await supabase.from('activation_requests').select('data').eq('request_id', request_id);
  return data && data[0] ? data[0].data : null;
}

module.exports = {
  getUser, createUser, updateUser, deleteUser,
  listActivationRequests, addActivationRequest, updateActivationRequest, getActivationRequest,
};
