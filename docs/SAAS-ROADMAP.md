# Sahayak — SaaS Hardening Roadmap

Status of the "make this a professional SaaS" plan.

## ✅ Done (in code, verified)

**Step 1 — Auth & secret hardening**
- Fail-fast on missing/insecure secrets (`src/config/env.js`).
- Per-module permission enforcement on every data/mutating route
  (`requireAnyPermission` in `src/middleware/auth.js` + all routers).
- OTP hardening: crypto-random code, HMAC-in-cookie (not plaintext), 10-min
  expiry, 5-attempt cap, rate-limited verify, constant-time master-password
  check (`src/routes/auth.routes.js`, `src/services/otp.js`).
- Mutating `generate-credit-note` moved from GET to POST.

**Step 2 — Data integrity (protect the books)**
- Credit-note numbering race fixed (strict insert + retry; now also posts to the
  ledger) — `src/routes/documents.routes.js`.
- Invoice edit preserves payment status + shipment fields (no longer wiped).
- Status updates use targeted field merges, not whole-document overwrites
  (`documents.routes.js`, `payments.routes.js`).
- Journal-posting failures are logged instead of silently swallowed
  (`src/repositories/documents.repo.js`).

**Step 4a — Tests + CI**
- Zero-dependency test suite via Node's built-in runner (`tests/`, `npm test`).
- GitHub Actions CI: syntax-checks every file + runs the suite (`.github/workflows/ci.yml`).

## 🟡 Ready for you to apply

**Step 3 — RLS backstop** → `migrations/001_enable_rls_backstop.sql`
Run it in the Supabase SQL Editor. It's safe (the app uses the service_role key,
which bypasses RLS, so app behaviour is unchanged) and closes anon-key exposure.
See the file header for the "Level 2" refactor that makes RLS protect against
app-code bugs too.

## ⬜ Step 4b — Signup + Billing (needs your decisions/keys)

This is the part that turns "a tool you run for clients" into a self-serve SaaS.
I can build it, but I need inputs first.

### Self-serve signup (design)
- New public `POST /signup`: create tenant → `createUser()` → send email
  verification → land in a setup wizard. Replaces today's master-only user
  creation.
- Security change to decide: today only the master can create accounts. Self-serve
  signup opens that up, so it needs email verification + abuse protection
  (rate limit, captcha?).

### Billing (design)
- Recommend **Razorpay** (India-first, UPI/cards/netbanking, subscriptions API).
- Plans + quotas replace the current binary `is_active` flag.
- Razorpay webhook → activate/suspend tenant on payment success/failure.
- New tables: `plans`, `subscriptions`, `invoices_billing` (careful: distinct
  from the GST invoices the app generates).

### What I need from you to build Step 4b
1. **Pricing model** — how many plans, prices, what each unlocks (users? docs/mo?).
2. **Payment gateway** — Razorpay (recommended) or Stripe? A test-mode account +
   API keys (key id + secret) and a webhook secret.
3. **Trial policy** — free trial length, or paid-only?
4. **Signup policy** — open self-serve, or invite/approval-gated?

Give me those and I'll build signup + billing in verified increments like the rest.

## Production checklist (do these on Vercel)
- Set all required env vars: `SECRET_KEY`, `LOGIN_USER`, `LOGIN_PASS`,
  `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_KEY` (app now fails fast if any is missing).
- Set `NODE_ENV=production` so the session cookie gets the `Secure` flag.
- Apply `migrations/001_enable_rls_backstop.sql`.