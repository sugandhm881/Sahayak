const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const cookieParser = require('cookie-parser');
const nunjucks = require('nunjucks');
const multer = require('multer');

const env = require('./config/env');
const { defaultLimiter, dayLimiter } = require('./middleware/rateLimit');
const { activationCheck } = require('./middleware/auth');
const { getSellerProfile } = require('./repositories/configs.repo');
const { getAllUsers } = require('./middleware/tenant');

const BASE_DIR = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(BASE_DIR, 'templates');
const STATIC_DIR = path.join(BASE_DIR, 'static');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  // View engine
  const nunjucksEnv = nunjucks.configure(TEMPLATE_DIR, {
    autoescape: true,
    express: app,
    noCache: env.NODE_ENV !== 'production',
  });
  // Jinja `url_for(name, arg=val)` shim: map to path strings.
  nunjucksEnv.addGlobal('url_for', (name, kwargs = {}) => {
    const map = {
      login: '/login',
      logout: '/logout',
      dashboard: '/dashboard',
      home: '/home',
      user_profile: '/profile',
      activation_page: '/activation',
      verify_otp: '/verify-otp',
      root_redirect: '/',
      static: null,
    };
    if (name === 'static') {
      const file = kwargs.filename || '';
      return `/static/${file}`;
    }
    let base = map[name];
    if (!base) base = `/${name}`;
    const qs = Object.entries(kwargs || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return qs ? `${base}?${qs}` : base;
  });
  nunjucksEnv.addGlobal('get_flashed_messages', function (opts = {}) {
    const req = this.ctx.__request__;
    if (!req) return [];
    const msgs = req.session && req.session.flashes ? req.session.flashes : [];
    if (req.session) req.session.flashes = [];
    // opts.with_categories=true -> [[category, message], ...]
    if (opts && opts.with_categories) return msgs;
    return msgs.map(([, m]) => m);
  });
  // Python dict.get() compat + has_permission on user
  function dictGet(key, def = '') {
    if (this === null || this === undefined) return def;
    const v = this[key];
    return (v === undefined || v === null) ? def : v;
  }
  nunjucksEnv.addFilter('get', (obj, key, def = '') => {
    if (obj === null || obj === undefined) return def;
    const v = obj[key];
    return (v === undefined || v === null) ? def : v;
  });

  app.set('view engine', 'html');
  app.engine('html', nunjucksEnv.render.bind(nunjucksEnv));

  // Middleware
  app.use(cookieParser());
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));
  app.use('/static', express.static(STATIC_DIR));

  app.use(
    cookieSession({
      name: 'sahayak_sess',
      keys: [env.SECRET_KEY],
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
    })
  );

  // Flash helper
  app.use((req, res, next) => {
    req.flash = (category, message) => {
      // support both flash(msg, cat) and flash(cat, msg) (we use cat, msg)
      if (!req.session.flashes) req.session.flashes = [];
      req.session.flashes.push([category, message]);
    };
    next();
  });

  app.use(dayLimiter);
  app.use(defaultLimiter);
  app.use(activationCheck);

  // Wrap plain objects with a .get() method so Jinja-style `.get('k','def')` works.
  const wrapDict = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const proxy = Object.assign({}, obj);
    Object.defineProperty(proxy, 'get', {
      value: function (key, def = '') {
        const v = this[key];
        return (v === undefined || v === null) ? def : v;
      },
      enumerable: false,
    });
    return proxy;
  };
  const wrapUser = (u) => {
    if (!u) return null;
    const out = Object.assign({}, u);
    out.is_authenticated = true;
    out.is_active = true;
    Object.defineProperty(out, 'has_permission', {
      value: function (perm) {
        if (this.is_master) return true;
        return Array.isArray(this.permissions) && this.permissions.includes(perm);
      },
      enumerable: false,
    });
    return out;
  };

  // Inject global template vars (profile, current_user, all_users, viewing_user)
  app.use(async (req, res, next) => {
    const user = wrapUser(req.session.user);
    res.locals.current_user = user || { is_authenticated: false, is_master: false };
    res.locals.__request__ = req;
    res.locals.profile = wrapDict({});
    res.locals.all_users = [];
    res.locals.viewing_user = null;
    if (user) {
      try {
        res.locals.profile = wrapDict(await getSellerProfile(req));
        res.locals.all_users = user.is_master ? await getAllUsers(req) : [];
        res.locals.viewing_user = req.session.view_mode || user.id;
      } catch (e) { /* ignore */ }
    }
    // expose helpers so per-route renders can re-wrap
    res.locals._wrap = wrapDict;
    next();
  });

  // Routes
  app.use(require('./routes/auth.routes'));
  app.use(require('./routes/masters.routes'));
  app.use(require('./routes/profile.routes'));
  app.use(require('./routes/documents.routes'));
  app.use(require('./routes/payments.routes'));
  app.use(require('./routes/reports.routes'));
  app.use(require('./routes/dashboard.routes'));
  app.use(require('./routes/email.routes'));
  app.use(require('./routes/cron.routes'));
  app.use(require('./routes/accounting.routes'));
  app.use(require('./routes/inventory.routes'));
  app.use(require('./routes/products.routes'));

  // Root
  app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

  // Multer error handler and generic error handler
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Unhandled error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message || 'Internal error' });
  });

  return app;
}

module.exports = { createApp, TEMPLATE_DIR, STATIC_DIR, BASE_DIR };
