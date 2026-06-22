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

module.exports = { loginRequired, masterOnly, hasPermission, activationCheck };
