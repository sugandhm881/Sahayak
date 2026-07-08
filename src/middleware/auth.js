function loginRequired(req, res, next) {
  if (!req.session || !req.session.user) {
    if (req.method === 'GET' && req.accepts('html')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function masterOnly(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.is_master) {
    return res.status(403).send('Unauthorized');
  }
  next();
}

function hasPermission(user, perm) {
  if (!user) return false;
  if (user.is_master) return true;
  return Array.isArray(user.permissions) && user.permissions.includes(perm);
}

// Route guard: allow the request only if the logged-in user is master OR holds
// ANY of the listed permissions. Mirrors the nav's own gating (e.g. the Accounts
// area is shown to users with 'accounts' OR 'sale' OR 'purchase'), so it does not
// lock out staff who are legitimately meant to reach a module.
function requireAnyPermission(...perms) {
  return function (req, res, next) {
    const user = req.session && req.session.user;
    if (!user) {
      if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (user.is_master) return next();
    const ok = Array.isArray(user.permissions) && perms.some((p) => user.permissions.includes(p));
    if (ok) return next();
    if (req.method === 'GET' && req.accepts('html')) {
      return res.status(403).send('You do not have permission to access this section.');
    }
    return res.status(403).json({ error: 'You do not have permission for this action.' });
  };
}

function activationCheck(req, res, next) {
  const u = req.session && req.session.user;
  if (!u) return next();
  if (u.is_master) return next();
  if (u.payment_active) return next();
  const whitelisted = ['/activation', '/logout'];
  if (whitelisted.some((p) => req.path.startsWith(p))) return next();
  if (req.path.startsWith('/static')) return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/activation');
  return res.status(403).json({ error: 'Account inactive' });
}

module.exports = { loginRequired, masterOnly, hasPermission, requireAnyPermission, activationCheck };
