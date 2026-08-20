# Sahayak ERP — Working Rules

Node.js/Express + Supabase multi-tenant GST ERP. CommonJS is intentional (ignore the
VS Code "File is a CommonJS module" hint). Entry: `server.js` (local) / `api/index.js`
(Vercel). App factory: `src/app.js`.

## Documentation policy (MANDATORY — keep docs in sync with code)

Every change must update the matching doc **in the same commit**:

| Change | Update |
|---|---|
| Feature / behaviour / workflow added, changed, or removed | `docs/FEATURES.md` (relevant section + "Last updated" line) |
| HTTP route added / changed / removed | `docs/API.md` |
| Anything touching auth, sessions, permissions, tenant isolation, secrets, uploads, outbound requests, or input validation | `docs/SECURITY.md` (and run its §12 checklist) |

If a change fits none of these, no doc update is needed — but say so explicitly.

## Other rules

- All DB queries must be tenant-scoped via `getTenantId(req)` — never trust a client-sent tenant id.
- New routes need `loginRequired` plus the correct `requireAnyPermission(...)` / `masterOnly` guard.
- Never push to remote without explicit user approval in that turn.
- Tests: `npm test` (Node built-in runner, `tests/`).
