# Sahayak ERP — Security Document

> **Living document.** Any change touching authentication, sessions, permissions, tenant
> isolation, secrets, file uploads, external calls, or input validation MUST update this
> file in the same commit. Companion docs: [FEATURES.md](FEATURES.md), [API.md](API.md).

**Last updated:** 2026-08-11 (hardening pass applied: server-side revocable sessions,
CSRF protection, atomic numbering, error alerting — requires
`migrations/002_sessions_counters_indexes.sql`)

---

## 1. Threat Model (summary)

Multi-tenant business app holding invoices, GST data, bank transactions, and customer PII
for multiple companies on one deployment. Primary risks:

1. Cross-tenant data leakage (tenant A reading tenant B's books)
2. Account takeover (master account = full control of every tenant)
3. Financial-record tampering (books integrity, GST liability)
4. Leakage of stored third-party credentials (SMTP, RapidShyp, EasyEcom, Supabase)
5. Abuse of outbound integrations (SSRF, email relay)

## 2. Authentication

### 2.1 Two-step login (password + emailed OTP) — `src/routes/auth.routes.js`
- **Master**: username/password from env (`LOGIN_USER`/`LOGIN_PASS`); password compared via
  fixed-length SHA-256 digests + `crypto.timingSafeEqual` (no length/timing leak).
- **Sub-users**: bcrypt (cost 10) via `bcryptjs`; legacy Werkzeug `pbkdf2:sha256` hashes
  from the old Python app verify transparently (`src/utils/password.js`, timing-safe).
- **OTP**: 6 digits from `crypto.randomInt` (not `Math.random`). The session cookie stores
  only `HMAC-SHA256(SECRET_KEY, otp)` — never the plaintext — so a user reading their own
  (signed-but-readable) cookie cannot brute-force offline. 10-minute TTL, max 5 verify
  attempts, then the code is invalidated; comparison is timing-safe.
- OTP is emailed to the tenant's profile email (fallback: master profile email, then
  `EMAIL_USER`) — i.e. email-account compromise defeats the second factor.
- Signup uses the same OTP scheme; the account row is only created after email
  verification, via **strict insert** (a username taken between signup and verification
  cannot hijack an existing workspace). Master username can never be registered.

### 2.2 Session (server-side, revocable)
- `express-session` with a **Supabase-backed store** (`http_sessions` table,
  `src/services/sessionStore.js`; requires migration 002). The cookie `sahayak_sess`
  carries only a **signed session id** — session data never leaves the server.
- Cookie flags: `httpOnly`, `sameSite=lax`, `secure` in production; 7-day **absolute**
  expiry (`touch` is a no-op by design — no per-request DB write, no sliding renewal).
- **Revocation** (the reason for the switch):
  - Logout destroys the stored session (cookie is dead immediately).
  - Master **deactivates** a user → all their sessions deleted (`destroySessionsForUser`).
  - Master **resets a password** → all target sessions deleted.
  - User **changes own password** → all *other* sessions deleted (current kept).
  - **Rename** → old-username sessions deleted.
- Expired rows are deleted on read + opportunistically on ~1% of writes.
- `trust proxy = 1` set for correct secure-cookie + rate-limit IP behaviour behind Vercel.
- Store failures are logged loudly with the migration hint; a failed lookup fails closed
  (no session → login required).

### 2.3 CSRF protection
- `src/middleware/csrf.js`, applied globally to POST/PUT/PATCH/DELETE:
  - `Sec-Fetch-Site` present → allow only `same-origin`/`none`; `same-site` and
    `cross-site` are rejected 403.
  - Otherwise `Origin` header host must equal the request `Host`.
  - Requests with neither header (curl, server-to-server, Vercel cron) pass — CSRF is a
    browser-ambient-credential attack; non-browser clients carry no session cookie.
- Defense-in-depth with the `sameSite=lax` cookie. Remaining accepted quirk: state-changing
  **GETs** (`/logout`, `/set-view-mode`) aren't covered by this check (see §11).

### 2.3 Account activation gate
- `activationCheck` (global middleware): a logged-in non-master with
  `payment_active=false` can only reach `/activation`, `/logout`, `/static` — everything
  else redirects/403s. New signups start inactive with **zero permissions**.

## 3. Authorization

- **Master** bypasses all checks (single super-admin — protect these credentials above all).
- Sub-users hold a `permissions[]` array read fresh from DB at OTP verification.
- **Router-level guards** (`requireAnyPermission`): documents/payments/reports/accounting/
  vendors/inventory/products routers each require at least one relevant permission;
  RapidShyp (`shipping`) and EasyEcom (`easyecom`) use per-handler checks.
- **Stricter in-handler checks**: `masterOnly` on period locks, journal backfill, user
  management, password reset; `hasPermission(doc_category)` inside `/generate-invoice`;
  `easyecom` check on SKU mapping.
- Profile rules: non-masters need the `profile` permission and can only edit **their own**
  profile; own-password change requires the current password; master reset does not.
- Deliberate breadth (documented, not accidental): `sale`/`purchase` users also reach
  Accounts/Reports/Vendors/Products areas, matching the navigation gating.

## 4. Tenant Isolation

- Every repository call resolves `tenant_id` server-side via `getTenantId(req)` — the
  client never supplies a tenant id. Sub-users are hard-pinned to their own tenant;
  only the master's session can set `view_mode`.
- All Supabase queries filter `.eq('tenant_id', …)`; documents use a
  `(tenant_id, bill_no)` primary key.
- **RLS backstop** (`migrations/001_enable_rls_backstop.sql`, run manually): enables RLS
  with no policies on every tenant table → the anon/publishable key is denied everything;
  only the server's `service_role` key works. NOTE: because the app uses `service_role`
  (BYPASSRLS), this protects against *key leakage*, **not** against a forgotten
  `tenant_id` filter in app code — the "Level 2" per-request-role refactor described in
  the migration header is the future backstop for that.
- User rename re-tenants rows across all 13 tables (master-only).

## 5. Secrets & Credential Handling

| Secret | Storage | Notes |
|---|---|---|
| `SECRET_KEY`, `CRON_SECRET`, `LOGIN_USER/PASS`, `SUPABASE_URL/KEY`, SMTP creds | Environment (`.env` git-ignored; `.env.example` is the template) | **Fail-fast boot validation** (`src/config/env.js`): missing or known-insecure values refuse to start; short values warn loudly. |
| Sub-user passwords | `app_users` | bcrypt hashes only. |
| RapidShyp API key, EasyEcom API key/JWT/**password** | `configs.profile` JSONB per tenant | **Plaintext in DB** — protected only by DB access controls + RLS. See §10. |
| UPI id, bank account numbers | `configs.profile` | Business data, plaintext. |

- The Supabase key used is service-role: it must never reach a client. The frontend never
  talks to Supabase directly — all access goes through Express.

## 6. Input Handling & Injection Surface

- **SQL injection**: no raw SQL — all DB access via supabase-js query builder with bound
  values.
- **XSS**: Nunjucks `autoescape: true` for all server-rendered templates. (Client-side JS
  builds some DOM from API data; keep using `textContent`/escaping there.)
- **Validation** is endpoint-local: signup enforces username charset `[a-zA-Z0-9_.-]{3,32}`,
  email regex, min password length; document/payment endpoints validate presence, numeric
  parsing (`parseFloat` with fallbacks), status enum, doc-type combinations; product SKU
  uniqueness enforced.
- Bill numbers arrive URL-encoded in wildcard params and are `decodeURIComponent`ed; they
  are used as DB keys (slashes normalised to `_`), never as file paths.
- Body-size limit 20 MB (JSON + form).

## 7. File Uploads

| Endpoint | Field | Limit | Handling |
|---|---|---|---|
| `POST /profile` | `logo`, `signature` | 10 MB | Multer memory storage → **re-encoded via sharp to PNG** (content-type laundering neutralises polyglot files) → stored as base64 in profile. |
| `POST /v2/bank/import` | `statement` | 20 MB | Parsed in memory (xlsx/csv/pdf/text); rows validated/deduped; nothing written to disk. |
| `POST /rapidshyp/attach-invoice` | `invoice_file` | 10 MB | Forwarded to RapidShyp; not persisted. |

Multer errors are caught by a dedicated handler (400 JSON). No user upload is ever served
back from disk.

## 8. Outbound Requests (SSRF posture)

- `GET /rapidshyp/proxy-pdf` — the only user-supplied URL fetch; **allowlisted** to the
  `https://storage.googleapis.com/rapidshyp-live/` prefix (400 otherwise).
- Pincode lookup: fixed host `api.postalpincode.in`, sanitised 6-digit path segment.
- RapidShyp/EasyEcom calls: fixed base URLs from env; only bodies/tokens vary.
- SMTP: fixed transport from env.

## 9. Abuse Protection & Rate Limiting

- Global: 200 requests/day + 60/hour per IP (`express-rate-limit`, standard headers).
- Login/OTP/signup endpoints: 10/min (`loginLimiter`) + OTP attempt caps.
- Heavy endpoints: `/generate-invoice` 30/min; invoice/receipt email 10/min
  (also caps outbound-mail abuse).
- EasyEcom: per-tenant monthly API-hit budget (429 when exhausted).
- ⚠ Limits are **in-memory per process** — on serverless (Vercel) each instance counts
  separately, so effective limits are softer than configured. Acceptable today;
  a shared store (e.g. Upstash) is the upgrade path.
- Cron endpoint `/send-daily-report`: no session; requires
  `Authorization: Bearer <CRON_SECRET>` (403 otherwise) and only acts at the configured
  UTC hour.

## 10. Data-Integrity Protections (books cannot be silently corrupted)

- **Strict inserts** for new documents and credit notes: `(tenant_id, bill_no)` PK makes
  duplicate numbers impossible; concurrent collisions retry with the next number instead
  of overwriting. Numbering itself is now **atomic** (`next_doc_seq()` upsert in
  `doc_counters`, migration 002) rather than a count-all-documents scan.
- **Error alerting** (`src/services/alerts.js`): journal-posting failures (books drift)
  and unhandled errors email `ALERT_EMAIL`/`EMAIL_USER`, throttled to one email per error
  kind per hour. `GET /health` exists for external uptime monitoring.
- Edits preserve payment-status/shipment fields; status and shipment updates use
  **targeted field merges**, never whole-document writes from stale snapshots.
- 24-hour edit window on invoices; deletes reverse inventory + EasyEcom effects with
  auditable `cancellation` ledger rows.
- **Period locks**: writes to documents dated in a locked FY fail with 423 (master-only to
  lock/unlock, audited).
- Journal writes are serialized per (tenant, ref) and idempotent; posting failures are
  loudly logged with the recovery instruction (`/v2/backfill-journal`, master-only,
  idempotent).
- **Audit log** on document upsert/insert/delete, bank match/classify/delete, period
  lock/unlock, bank-account changes (actor + tenant + details, best-effort).
- CSRF-sensitive mutation moved off GET (`generate-credit-note` is POST).

## 11. Known Gaps / Accepted Risks / Roadmap

Tracked knowingly — revisit when hardening (see also [SAAS-ROADMAP.md](SAAS-ROADMAP.md)):

1. ~~No CSRF tokens~~ **RESOLVED 2026-08-11** — fetch-metadata/Origin CSRF guard (§2.3).
   Residual accepted quirk: `GET /logout` (nuisance only) and `GET /set-view-mode/:id`
   (master-only display state) remain state-changing GETs.
2. **Service-role DB key in app** — a forgotten `tenant_id` filter would not be stopped by
   RLS ("Level 2" refactor documented in the migration is the fix).
3. **Integration credentials stored plaintext** in `configs.profile` (RapidShyp key,
   EasyEcom key/JWT/password). Encrypt-at-rest (app-level, keyed from env) is the upgrade.
4. ~~Client-side session cookie, no revocation~~ **RESOLVED 2026-08-11** — server-side
   sessions with kill-on-deactivate/reset/rename (§2.2). Requires migration 002 applied.
5. **Rate limits per-instance** on serverless (see §9).
6. **`GET /api/get-branding/:username` is public** — allows username enumeration and
   returns company name + logo. Accepted for login-page branding UX.
7. **`GET /easyecom/debug`** exposes the raw upstream response to easyecom-permission
   holders — keep permission tightly granted.
8. **Master is a single super-user** with env-stored password — no MFA beyond the email
   OTP, no break-glass second admin. Protect the mailbox and the env. Note: master
   sessions are stored with `user_id` = master username, but there is no UI to revoke
   them — rotate `SECRET_KEY` (invalidates all session cookies) if the master account is
   suspected compromised.
9. `.env` holds real secrets locally — it is git-ignored; never commit it, never widen the
   gitignore.
10. RLS backstop migration (001) applied 2026-08-11. **Migration 002 must also be run**
    for server-side sessions and atomic counters to be active (the code falls back to
    legacy numbering and fails sessions loudly until then).

## 12. Security Checklist for Every Change (MANDATORY)

Before merging any change, verify and **update this document** if the answer changes:

- [ ] New route? → added `loginRequired` + correct permission guard; added to API.md.
- [ ] New DB query? → filters by `tenant_id` from `getTenantId(req)` (never from client input).
- [ ] New mutation? → not reachable via GET; validates input; considers period locks/audit.
- [ ] New secret/credential? → env-validated in `env.js` or consciously accepted in §5/§11.
- [ ] New upload? → Multer memory storage + size limit + content re-encoding where possible.
- [ ] New outbound fetch? → fixed host or explicit allowlist (§8).
- [ ] New email-sending path? → rate-limited.
- [ ] Anything in §11 fixed? → remove it from the list, describe the control above.

## 13. Reporting / Handling Incidents

- Rotate: `SECRET_KEY` (invalidates all sessions), `LOGIN_PASS`, `CRON_SECRET`,
  `SUPABASE_KEY` (Supabase dashboard), SMTP app password, tenant integration keys
  (from each provider's dashboard, then update profiles).
- Review `audit_log` per tenant and Supabase logs for the window in question.
- Master can deactivate any sub-user immediately from `/profile` (blocks next request).
