// CSRF protection via browser fetch-metadata / Origin checks.
// Blocks state-changing requests initiated by another site, with zero changes
// required in templates or frontend JS (no token plumbing):
//   1. Modern browsers send Sec-Fetch-Site — allow only 'same-origin' (and
//      'none', which is a direct navigation/bookmark, not an attack vector for
//      POST bodies from another page).
//   2. Fallback for browsers without it: compare the Origin header host to the
//      request Host.
//   3. Requests with neither header (curl, server-to-server, the Vercel cron)
//      are allowed — CSRF is a browser-credential attack; non-browser clients
//      carry no ambient session cookie.
// Combined with the sameSite=lax session cookie this closes the cross-site
// form-POST gap documented in SECURITY.md.

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function csrfProtect(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs) {
    if (sfs === 'same-origin' || sfs === 'none') return next();
    // 'same-site' (sibling subdomain) and 'cross-site' are both foreign here.
    return res.status(403).json({ error: 'Cross-site request blocked (CSRF protection).' });
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host === req.headers.host) return next();
    } catch { /* malformed origin → block below */ }
    return res.status(403).json({ error: 'Cross-site request blocked (CSRF protection).' });
  }

  return next();
}

module.exports = { csrfProtect };
