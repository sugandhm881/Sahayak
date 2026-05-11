const express = require('express');
const multer = require('multer');
const router = express.Router();
const supabase = require('../config/supabase');
const env = require('../config/env');
const { loginRequired, masterOnly } = require('../middleware/auth');
const { resolveMasterId } = require('../middleware/tenant');
const { getSellerProfile, saveSellerProfile } = require('../repositories/configs.repo');
const { getUser, createUser, updateUser, deleteUser, listActivationRequests, getActivationRequest, updateActivationRequest } = require('../repositories/users.repo');
const { hashPassword } = require('../utils/password');
const { compressImage } = require('../utils/imageCompress');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/profile', loginRequired, async (req, res) => {
  const master_id = await resolveMasterId(req);
  const user = req.session.user;
  let target_user = req.query.edit_user;
  if (!user.is_master) target_user = user.id;
  else if (!target_user) target_user = master_id;

  const profile_data = await getSellerProfile(req, target_user);
  let target_is_active = true;
  let target_perms = ['sale', 'purchase'];
  if (target_user !== master_id) {
    try {
      const u = await getUser(target_user);
      if (u) {
        target_is_active = !!u.is_active;
        target_perms = u.permissions || ['sale', 'purchase'];
      }
    } catch {}
  }
  const pending_requests = user.is_master ? await listActivationRequests() : [];
  res.render('user_profile.html', {
    profile: res.locals._wrap(profile_data),
    target_user,
    target_is_active,
    target_perms,
    pending_requests,
  });
});

router.post('/profile', loginRequired, upload.fields([{ name: 'logo' }, { name: 'signature' }]), async (req, res) => {
  const user = req.session.user;
  const master_id = await resolveMasterId(req);
  const body = req.body;

  if (body.verify_request && user.is_master) {
    const req_id = body.request_id;
    const u_id = body.user_to_activate;
    await updateUser(u_id, { is_active: true });
    const dt = await getActivationRequest(req_id);
    if (dt) {
      dt.status = 'Approved';
      await updateActivationRequest(req_id, dt);
    }
    req.flash('success', 'Payment Verified!');
    return res.redirect('/profile');
  }

  if (body.update_perms && user.is_master) {
    const target = body.target_user_id;
    const perms = [];
    if (body.perm_sale) perms.push('sale');
    if (body.perm_purchase) perms.push('purchase');
    await updateUser(target, { permissions: perms });
    req.flash('success', 'Permissions updated!');
    return res.redirect(`/profile?edit_user=${encodeURIComponent(target)}`);
  }

  if (body.toggle_active && user.is_master) {
    const target = body.target_user_id;
    const new_status = body.toggle_active === 'true';
    await updateUser(target, { is_active: new_status });
    req.flash('success', `User ${new_status ? 'Activated' : 'Deactivated'}`);
    return res.redirect(`/profile?edit_user=${encodeURIComponent(target)}`);
  }

  if (body.new_username && user.is_master) {
    const new_u = body.new_username;
    const new_p = body.new_password;
    const perms = [];
    if (body.new_perm_sale) perms.push('sale');
    if (body.new_perm_purchase) perms.push('purchase');
    if (new_u && new_p) {
      await createUser({ username: new_u, password: await hashPassword(new_p), is_active: false, permissions: perms });
      req.flash('success', 'User created!');
    }
    return res.redirect('/profile');
  }

  if (body.action_rename_user && user.is_master) {
    const old_u = body.target_user_id;
    const new_u = (body.new_sub_username || '').trim();
    if (!new_u || old_u === master_id || new_u === master_id) {
      req.flash('error', 'Invalid rename.');
      return res.redirect(`/profile?edit_user=${encodeURIComponent(old_u)}`);
    }
    const chk = await getUser(new_u);
    if (chk) {
      req.flash('error', 'Username taken!');
      return res.redirect(`/profile?edit_user=${encodeURIComponent(old_u)}`);
    }
    const tables = ['clients', 'particulars', 'documents', 'inventory_products', 'inventory_ledger', 'payments', 'configs', 'expenses', 'accounts', 'journal_entries', 'period_locks', 'audit_log', 'bank_transactions'];
    for (const t of tables) {
      try { await supabase.from(t).update({ tenant_id: new_u }).eq('tenant_id', old_u); } catch {}
    }
    await supabase.from('app_users').update({ username: new_u }).eq('username', old_u);
    req.flash('success', 'User renamed successfully.');
    return res.redirect(`/profile?edit_user=${encodeURIComponent(new_u)}`);
  }

  const target_user = body.target_user_id;
  if (!user.is_master) {
    req.flash('error', 'Not authorized to update settings.');
    return res.redirect('/profile');
  }

  const data = {
    company_name: body.company_name,
    invoice_prefix: body.invoice_prefix || 'TE',
    address_1: body.address_1,
    address_2: body.address_2,
    phone: body.phone,
    email: body.email,
    gstin: body.gstin,
    bank_name: body.bank_name,
    account_holder: body.account_holder,
    account_no: body.account_no,
    ifsc: body.ifsc,
    state: body.state || '',
    upi_id: (body.upi_id || '').trim(),
  };

  if (user.is_master) data.invoice_type = body.invoice_type || 'goods';

  const logoFile = req.files && req.files.logo && req.files.logo[0];
  if (logoFile && logoFile.buffer) {
    const c = await compressImage(logoFile.buffer, 400);
    if (c) data.logo_base64 = c;
  } else {
    const ext = await getSellerProfile(req, target_user);
    if (ext && ext.logo_base64) data.logo_base64 = ext.logo_base64;
  }

  const sigFile = req.files && req.files.signature && req.files.signature[0];
  if (sigFile && sigFile.buffer) {
    const c = await compressImage(sigFile.buffer, 300);
    if (c) data.signature_base64 = c;
  } else {
    const ext = await getSellerProfile(req, target_user);
    if (ext && ext.signature_base64) data.signature_base64 = ext.signature_base64;
  }

  await saveSellerProfile(req, data, target_user);
  req.flash('success', 'Profile Updated!');
  res.redirect(`/profile?edit_user=${encodeURIComponent(target_user)}`);
});

router.post('/reset-password', loginRequired, masterOnly, async (req, res) => {
  const { target_user_id, reset_password } = req.body;
  if (target_user_id && reset_password) {
    try {
      await updateUser(target_user_id, { password: await hashPassword(reset_password) });
      req.flash('success', 'Password updated successfully!');
    } catch (e) {
      req.flash('error', `Database error: ${e.message}`);
    }
  }
  res.redirect(`/profile?edit_user=${encodeURIComponent(target_user_id)}`);
});

module.exports = router;
