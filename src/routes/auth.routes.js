const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../config/supabase');
const env = require('../config/env');
const { loginLimiter } = require('../middleware/rateLimit');

const OTP_TTL_MS = 10 * 60 * 1000;   // OTP valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5;          // verify attempts before the code is invalidated

// Keep the OTP itself out of the (client-readable) session cookie: store only an
// HMAC keyed by the server SECRET_KEY, which the browser never sees. An attacker
// who reads their own cookie cannot derive or offline-brute-force the code.
function otpHmac(otp) {
  return crypto.createHmac('sha256', env.SECRET_KEY).update(String(otp)).digest('hex');
}
// Constant-time string comparison via fixed-length digests (avoids leaking length
// and avoids the timing side-channel of `===`).
function safeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const { loginRequired } = require('../middleware/auth');
const { generateOtp } = require('../services/otp');
const { sendEmailRaw } = require('../services/email');
const { verifyPassword, hashPassword } = require('../utils/password');
const { resolveMasterId } = require('../middleware/tenant');
const { getMasterConfigProfile, saveSellerProfile } = require('../repositories/configs.repo');
const { getUser, createUser, addActivationRequest } = require('../repositories/users.repo');

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

  if (username === master_id && safeEqualStr(password, env.MASTER_PASSWORD)) {
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
  req.session.otp_hmac = otpHmac(otp);
  req.session.otp_expires = Date.now() + OTP_TTL_MS;
  req.session.otp_attempts = 0;
  delete req.session.otp; // never store the plaintext code in the cookie

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

router.post('/verify-otp', loginLimiter, async (req, res) => {
  const otp_input = String(req.body.otp || '').trim();
  const stored = req.session.otp_hmac;
  const expired = !req.session.otp_expires || Date.now() > req.session.otp_expires;
  req.session.otp_attempts = (req.session.otp_attempts || 0) + 1;
  const tooMany = req.session.otp_attempts > OTP_MAX_ATTEMPTS;

  let match = false;
  if (otp_input && stored && !expired && !tooMany && req.session.temp_user_id) {
    try {
      const a = Buffer.from(otpHmac(otp_input), 'hex');
      const b = Buffer.from(stored, 'hex');
      match = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { match = false; }
  }

  if (match) {
    const user_id = req.session.temp_user_id;
    const is_master = req.session.temp_is_master;
    let payment_active = true;
    let permissions = [];
    if (!is_master) {
      try {
        const u = await getUser(user_id);
        if (u) {
          payment_active = !!u.is_active;
          permissions = u.permissions || [];
        } else {
          payment_active = false;
        }
      } catch { payment_active = false; }
    }
    req.session.user = { id: user_id, is_master, payment_active, permissions };
    delete req.session.otp_hmac;
    delete req.session.otp_expires;
    delete req.session.otp_attempts;
    delete req.session.temp_user_id;
    delete req.session.temp_is_master;
    return res.redirect('/dashboard');
  }

  // On expiry or too many attempts, invalidate the code so it can't be retried.
  if (expired || tooMany) {
    delete req.session.otp_hmac;
    delete req.session.otp_expires;
  }
  const msg = expired ? 'OTP expired — please log in again.'
    : tooMany ? 'Too many attempts — please log in again.'
    : 'Invalid OTP';
  res.render('verify_otp.html', { error: msg });
});

// ── Self-serve signup (email-verified, no billing) ───────────────────────────
router.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('signup.html', { error: null, form: {} });
});

router.post('/signup', loginLimiter, async (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const username = (req.body.username || '').trim();
  const email = (req.body.email || '').trim();
  const company = (req.body.company_name || '').trim();
  const password = req.body.password || '';
  const confirm = req.body.confirm_password || '';
  const form = { username, email, company_name: company };
  const fail = (m) => res.render('signup.html', { error: m, form });

  if (!username || !email || !company || !password) return fail('All fields are required.');
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return fail('Username must be 3–32 characters: letters, numbers, dot, underscore or hyphen.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Please enter a valid email address.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (password !== confirm) return fail('Passwords do not match.');

  // Never allow taking the master/admin username.
  let master_id = env.MASTER_USERNAME;
  try { const mc = await getMasterConfigProfile(); if (mc && mc.master_username) master_id = mc.master_username; } catch {}
  if (username.toLowerCase() === String(master_id).toLowerCase()) return fail('That username is not available.');

  try { if (await getUser(username)) return fail('That username is already taken.'); } catch {}

  // Stash the pending signup + an email-verification OTP (HMAC only, never the
  // plaintext code — same protection as login).
  const otp = generateOtp();
  req.session.signup = {
    username, email, company,
    password_hash: await hashPassword(password),
    otp_hmac: otpHmac(otp),
    otp_expires: Date.now() + OTP_TTL_MS,
    otp_attempts: 0,
  };
  try {
    await sendEmailRaw(email, 'Verify your Sahayak account',
      `Welcome to Sahayak!\n\nYour verification code is: ${otp}\n\nThis code expires in 10 minutes.`);
  } catch (e) {
    delete req.session.signup;
    return fail('Could not send the verification email. Please check the address and try again.');
  }
  res.render('verify_signup.html', { error: null, email });
});

router.post('/verify-signup', loginLimiter, async (req, res) => {
  const s = req.session.signup;
  if (!s) return res.redirect('/signup');
  const input = String(req.body.otp || '').trim();
  const expired = !s.otp_expires || Date.now() > s.otp_expires;
  s.otp_attempts = (s.otp_attempts || 0) + 1;
  const tooMany = s.otp_attempts > OTP_MAX_ATTEMPTS;

  let match = false;
  if (input && s.otp_hmac && !expired && !tooMany) {
    try {
      const a = Buffer.from(otpHmac(input), 'hex');
      const b = Buffer.from(s.otp_hmac, 'hex');
      match = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { match = false; }
  }

  if (!match) {
    if (expired || tooMany) delete req.session.signup;
    const msg = expired ? 'Code expired — please sign up again.'
      : tooMany ? 'Too many attempts — please sign up again.'
      : 'Invalid code.';
    return res.render('verify_signup.html', { error: msg, email: s.email });
  }

  // Re-check availability, then create with a strict insert so a username taken
  // between signup and verification can never hijack an existing workspace.
  try {
    if (await getUser(s.username)) {
      delete req.session.signup;
      return res.render('signup.html', { error: 'That username was just taken. Please choose another.', form: {} });
    }
    const { error: insErr } = await supabase.from('app_users').insert({
      username: s.username, password: s.password_hash, is_active: false, permissions: [],
    });
    if (insErr) {
      delete req.session.signup;
      return res.render('signup.html', { error: 'That username was just taken. Please choose another.', form: {} });
    }
    // A profile row (with the email) so login OTPs and the invoice header work.
    await saveSellerProfile(req, { company_name: s.company, email: s.email, invoice_prefix: 'TE' }, s.username);
    // Queue an activation request so the master is notified to approve the account
    // and grant module permissions (new accounts start inactive with no access).
    try {
      await addActivationRequest(`${s.username}_SIGNUP`, {
        user_id: s.username, company: s.company, email: s.email,
        amount: 0, utr: 'SIGNUP', status: 'Pending',
        date_display: new Date().toLocaleString('en-IN'),
      });
    } catch {}
  } catch (e) {
    return res.render('verify_signup.html', { error: 'Could not create account: ' + e.message, email: s.email });
  }

  // New accounts are inactive with NO permissions until the master approves them.
  // Deliberately no auto-login: the user signs in once approved, and that login
  // reads the fresh active status + granted permissions from the database.
  delete req.session.signup;
  res.render('signup_pending.html', { email: s.email, company: s.company });
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

router.get('/activation', loginRequired, (req, res) => {
  res.render('activation.html', { user_id: req.session.user && req.session.user.id });
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
