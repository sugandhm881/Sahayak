const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const env = require('../config/env');
const { loginLimiter } = require('../middleware/rateLimit');
const { loginRequired } = require('../middleware/auth');
const { generateOtp } = require('../services/otp');
const { sendEmailRaw } = require('../services/email');
const { verifyPassword } = require('../utils/password');
const { resolveMasterId } = require('../middleware/tenant');
const { getMasterConfigProfile } = require('../repositories/configs.repo');
const { getUser, addActivationRequest } = require('../repositories/users.repo');
const { generateUpiQrBase64 } = require('../services/qr');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login.html', { error: null });
});

router.post('/login', loginLimiter, async (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const username = req.body.username || '';
  const password = req.body.password || '';

  let valid = false;
  let is_master = false;

  // Resolve (possibly renamed) master id
  let master_id = env.MASTER_USERNAME;
  try {
    const mc = await getMasterConfigProfile();
    if (mc && mc.master_username) {
      master_id = mc.master_username;
      req.session.master_id = master_id;
    }
  } catch {}

  if (username === master_id && password === env.MASTER_PASSWORD) {
    valid = true;
    is_master = true;
  } else {
    try {
      const u = await getUser(username);
      if (u && await verifyPassword(u.password || '', password)) valid = true;
    } catch {}
  }

  if (!valid) {
    return res.render('login.html', { error: 'Invalid Credentials' });
  }

  const otp = generateOtp();
  req.session.temp_user_id = username;
  req.session.temp_is_master = is_master;
  req.session.otp = otp;

  // Find target email
  let target_email = null;
  try {
    const tenant = is_master ? 'master' : username;
    const { data } = await supabase.from('configs').select('profile').eq('tenant_id', tenant);
    if (data && data[0] && data[0].profile) target_email = data[0].profile.email || null;
  } catch {}
  if (!target_email) {
    try {
      const { data } = await supabase.from('configs').select('profile').eq('tenant_id', 'master');
      if (data && data[0] && data[0].profile) target_email = data[0].profile.email || null;
    } catch {}
  }
  target_email = target_email || env.EMAIL_USER;
  await sendEmailRaw(target_email, 'Security OTP - ERP App', `Login Attempt for user: ${username}\nOTP: ${otp}`);
  res.render('verify_otp.html', { error: null });
});

router.post('/verify-otp', async (req, res) => {
  const otp_input = String(req.body.otp || '').trim();
  const stored = String(req.session.otp || '').trim();
  if (otp_input && stored && otp_input === stored && req.session.temp_user_id) {
    const user_id = req.session.temp_user_id;
    const is_master = req.session.temp_is_master;
    let payment_active = true;
    let permissions = ['sale', 'purchase'];
    if (!is_master) {
      try {
        const u = await getUser(user_id);
        if (u) {
          payment_active = !!u.is_active;
          permissions = u.permissions || ['sale', 'purchase'];
        } else {
          payment_active = false;
        }
      } catch { payment_active = false; }
    }
    req.session.user = { id: user_id, is_master, payment_active, permissions };
    delete req.session.otp;
    delete req.session.temp_user_id;
    delete req.session.temp_is_master;
    return res.redirect('/dashboard');
  }
  res.render('verify_otp.html', { error: 'Invalid OTP' });
});

router.get('/logout', loginRequired, (req, res) => {
  if (req.session) {
    delete req.session.user;
    delete req.session.temp_user_id;
    delete req.session.temp_is_master;
    delete req.session.otp;
    delete req.session.view_mode;
    delete req.session.master_id;
    delete req.session.flashes;
  }
  req.session = null;
  res.redirect('/login');
});

router.get('/activation', loginRequired, async (req, res) => {
  const qr_code = await generateUpiQrBase64(env.UPI_ID, env.UPI_NAME, 0);
  res.render('activation.html', { qr_code });
});

router.post('/activation', loginRequired, async (req, res) => {
  const { amount, utr } = req.body;
  const user = req.session.user;
  const req_data = { user_id: user.id, amount, utr, status: 'Pending' };
  try {
    await addActivationRequest(`${user.id}_${utr}`, req_data);
  } catch {}
  req.flash('success', 'Request Sent! Admin will verify.');
  res.redirect('/activation');
});

router.get('/set-view-mode/:user_id', loginRequired, async (req, res) => {
  if (!req.session.user.is_master) return res.status(403).send('Unauthorized');
  req.session.view_mode = req.params.user_id;
  req.flash('info', `Now viewing data as: ${req.params.user_id}`);
  res.redirect('/home');
});

router.get('/api/get-branding/:username', async (req, res) => {
  const master_id = await resolveMasterId(req);
  const username = req.params.username;
  try {
    const tenant = username === master_id ? 'master' : username;
    const { data } = await supabase.from('configs').select('profile').eq('tenant_id', tenant);
    if (data && data[0] && data[0].profile) {
      return res.json({
        found: true,
        company_name: data[0].profile.company_name || 'SM Tech',
        logo_base64: data[0].profile.logo_base64 || null,
      });
    }
  } catch {}
  res.json({ found: false });
});

module.exports = router;
