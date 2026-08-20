# Sahayak ERP — Features, Functions & Workflows

> **Living document.** Every feature addition or change MUST be reflected here (and in
> [API.md](API.md) if the HTTP surface changed, and in [SECURITY.md](SECURITY.md) if
> auth/permissions/data-handling changed). See "Documentation policy" at the bottom.

**Last updated:** 2026-08-11 (documented against commit `f0eaabc` + hardening pass:
server-side sessions, CSRF, atomic numbering, indexed document columns, error alerting —
requires `migrations/002_sessions_counters_indexes.sql`)

---

## 1. What Sahayak Is

Sahayak ERP is a **multi-tenant, GST-compliant invoicing + light-ERP web application**
for Indian small businesses. One deployment serves a "master" (admin/owner) tenant and
any number of sub-user tenants, each with fully isolated data.

Core capabilities:

- Sales invoices, credit notes, Bills of Supply (non-GST)
- Purchase orders → GRNs → purchase bills → debit notes (full procurement workflow)
- Client/vendor master, product/particulars master with change history
- Inventory with stock ledger, manual adjustments, low-stock alerts
- Payments/receipts with automatic invoice status (Paid/Confirmed)
- Double-entry accounting journal, trial balance, P&L, balance sheet, party ledgers
- GST reports: GSTR-1 (B2B/B2CL/B2CS Excel) and GSTR-3B summary
- Bank statement import + reconciliation (match / classify)
- PDF generation (invoice, PO, GRN, receipt, ledger) with UPI QR codes
- Excel exports (sales report, purchase report, GSTR-1)
- Email delivery of invoices/receipts + scheduled daily report emails
- Shipping integration (RapidShyp B2B) and marketplace stock sync (EasyEcom)

## 2. Tech Stack & Architecture

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18, Express 4 (CommonJS — intentional) |
| Views | Nunjucks server-rendered HTML (`templates/*.html`), Jinja-compat shims (`url_for`, flash, `dict.get`) |
| Frontend | Vanilla JS per page (`static/js/invoice.js`, `po.js`, `grn.js`) + inline scripts in templates |
| Database | Supabase (PostgreSQL). Most tables use a JSONB `data` column keyed by `tenant_id` |
| Session | `express-session` + Supabase-backed store (`http_sessions` table, `src/services/sessionStore.js`); cookie `sahayak_sess` carries only the signed session id, 7-day absolute expiry, revocable |
| PDF | PDFKit via a custom FPDF-compatible shim (`src/services/pdf/fpdfShim.js`), Calibri font |
| Excel | ExcelJS |
| Email | Nodemailer (SMTP, Gmail by default) |
| Images | sharp (logo/signature compression to base64) |
| Deploy | Vercel serverless (`api/index.js` + `vercel.json` rewrite; cron at 16:30 UTC) or `node server.js` (port 5000) |
| CI | GitHub Actions: syntax-check every JS file + `npm test` (Node built-in runner) |

### Directory layout

```
server.js               Local entry (createApp + listen)
api/index.js            Vercel serverless entry (exports the Express app)
src/app.js              App factory: view engine, middleware, session, route mounting
src/config/             env.js (fail-fast secrets), supabase.js, constants.js (state codes)
src/middleware/         auth.js, tenant.js, rateLimit.js
src/routes/             15 routers (auth, documents, payments, reports, accounting, …)
src/repositories/       Supabase data access, all tenant-scoped (…repo.js)
src/services/           pdf/, excel/, accounting/ (journal, accounts, audit, bank), email,
                        otp, qr, docConversion, easyecom.service
src/utils/              dates, words (amount-in-words), password, imageCompress
templates/              Nunjucks pages + _shell partials
static/                 CSS, page JS, logos
migrations/             001_enable_rls_backstop.sql (run manually in Supabase)
tests/                  auth, dates, otp, password unit tests
docs/                   API.md, FEATURES.md (this file), SECURITY.md, SAAS-ROADMAP.md
```

### Request pipeline (src/app.js)

1. `cookieParser` → JSON/urlencoded body (20 MB limit) → `/static` files
2. `express-session` (server-side Supabase store; signed sid cookie, httpOnly,
   sameSite=lax, secure in production)
3. **CSRF guard** (`src/middleware/csrf.js`) — blocks cross-site POST/PUT/PATCH/DELETE
   via `Sec-Fetch-Site` / `Origin` checks (no token plumbing needed)
4. Flash-message helper
5. Rate limiters: `dayLimiter` (200/day) + `defaultLimiter` (60/hour) on everything
6. `activationCheck` — inactive non-master users are locked to `/activation` + `/logout`
7. Template-locals injector: `current_user` (with `has_permission()`), seller `profile`,
   `all_users` (master only), `viewing_user`
8. All 15 routers mounted at root; `/` redirects to `/dashboard` or `/login`;
   `GET /health` uptime probe
9. Multer + generic error handler (JSON `{error}`, emails a throttled alert via
   `src/services/alerts.js`)

## 3. Multi-Tenancy Model

- Every data table carries `tenant_id`. The master's data lives under tenant `'master'`;
  each sub-user's under their username.
- `getTenantId(req)` ([src/middleware/tenant.js](../src/middleware/tenant.js)) resolves the
  effective tenant: sub-users always get their own id; the master gets `'master'` unless
  **view-as** is active.
- **View-as ("View data as")**: the master calls `GET /set-view-mode/:user_id` to browse and
  operate on any tenant's data. All repositories transparently follow `session.view_mode`.
- The master username itself is configurable (stored in `configs.tenant_id='master_config'`
  → `profile.master_username`, falls back to `LOGIN_USER` env).
- **User rename** (master) re-tenants rows across all 13 tenant tables.

### Users, roles & permissions

| Concept | Behaviour |
|---|---|
| **Master** | Credentials from env (`LOGIN_USER`/`LOGIN_PASS`). Bypasses every permission check. Manages users, permissions, activation, period locks, journal backfill. |
| **Sub-user** | Row in `app_users` (`username`, bcrypt `password`, `is_active`, `permissions[]`). |
| **Activation** | New accounts start `is_active:false` with `permissions:[]`. Inactive users only see `/activation`. |
| **Permissions** | `sale`, `purchase`, `shipping`, `easyecom`, `expenses`, `vendors`, `accounts`, `reports`, `inventory`, `products`, `profile`. Enforced by `requireAnyPermission(...)` at router level + inline checks. |

## 4. Database Tables (Supabase)

| Table | Key columns | Contents |
|---|---|---|
| `app_users` | `username` | password hash, `is_active`, `permissions[]` |
| `configs` | `tenant_id` | `profile` JSONB (company, GSTIN, banks, logo/signature base64, integration keys, EasyEcom hit counter), `counters`. Special rows: `master`, `master_config` |
| `activation_requests` | `request_id` | signup/activation queue for master approval |
| `documents` | `tenant_id`, `bill_no` (PK pair), `collection_name` | every document's full JSONB (`data`). Collections: `sales_invoices`, `sales_credit_notes`, `sales_debit_notes`, `purchase_orders`, `purchase_grns`, `purchase_bills`, `purchase_debit_notes`, `purchase_misc` |
| `clients` | `tenant_id`, `name` | client/vendor master (`data` JSONB incl. ship-to + bank) |
| `particulars` | `tenant_id`, `name` | item master: `product_id` (SKU), `hsn`, `rate`, `taxrate`, sub-particulars, ship dims |
| `product_changelog` | tenant | field-level audit of product edits |
| `inventory_products` | `tenant_id`, `safe_id` | stock cache: `current_stock`, `easyecom_sku`, `easyecom_stock`, `pending_easyecom_adj`, `reorder_level` |
| `inventory_ledger` | tenant | every stock movement (doc ref, qty change, running balance) |
| `payments` | `tenant_id`, `payment_id` | receipts & payments (`data` JSONB) |
| `expenses` | `tenant_id`, `expense_id` | expense entries |
| `accounts` | `tenant_id`, `code` | chart of accounts (seeded per tenant, see §8) |
| `journal_entries` | tenant, `ref_type`, `ref_id`, `line_no` | double-entry lines |
| `period_locks` | `tenant_id`, `fy` | locked financial years |
| `audit_log` | tenant | actor/action/ref audit trail |
| `bank_transactions` | `tenant_id`, `txn_id` | imported statement lines + match/classify state |
| `doc_links` | tenant, parent/child bill_no | PO→GRN→Bill conversion links with per-line qty map |
| `http_sessions` | `sid` | server-side sessions (`sess` JSONB, `expire`, `user_id` for revocation) |
| `doc_counters` | `tenant_id`, `series`, `fy` | atomic FY-sequence counters (`next_doc_seq()` RPC) |

`documents` additionally mirrors hot JSONB fields into indexed real columns
(`doc_date`, `grand_total`, `client_name`, `status`, `doc_type` — migration 002) so
filtering/pagination runs in the database; the app backfills them on every write and
falls back gracefully if the migration hasn't been applied.

## 5. Feature Catalog by Module

### 5.1 Authentication & Onboarding (`auth.routes.js`)
- Two-step login: password check → **6-digit OTP emailed** to the tenant's profile email →
  session established. (Full security detail in [SECURITY.md](SECURITY.md).)
- Self-serve **signup** with email OTP verification → account created inactive → activation
  request queued for the master → master approves + grants permissions → user logs in.
- Master **view-as** switcher; per-tenant login-page branding API (`/api/get-branding`).
- Logout clears the whole session.

### 5.2 Profile & Administration (`profile.routes.js`)
- Seller profile: company, address, phone, email, GSTIN, state, invoice prefix,
  bank details, UPI id, logo + signature upload (compressed → base64, preserved on re-save).
- Integration settings: RapidShyp API key/pickup/store; EasyEcom key/JWT/email/password/
  location key, auto-push toggle, monthly hit limit.
- Master-only: approve activation requests, grant/revoke module permissions, create user,
  activate/deactivate, **rename user** (re-tenants all data), reset any password.
- Sub-user: edit own profile (needs `profile` permission), change own password (verifies
  current password).

### 5.3 Documents Engine (`documents.routes.js`) — the core
Single endpoint `POST /generate-invoice` creates/edits **all** document types and returns the
PDF. See §6.2 for the full workflow. Supporting features:

- **Document types & numbering** (FY-sequential, prefix from profile, collision-retry):
  sale invoice `PFX/FY/NNN`, credit note `PFX-CN/…`, PO `PFX-PO/…`, GRN `PFX-GRN/…`,
  purchase bill `PFX-PB/…`, purchase debit note `PFX-PDN/…`. Sequences come from the
  **atomic `next_doc_seq()` counter** (`doc_counters`, race-safe upsert; the legacy
  full-document scan only seeds a new series or serves as pre-migration fallback).
  Manual numbers allowed (duplicates rejected 409).
- **GST math**: intra/inter-state detection from GSTIN prefix (fallback: state names) →
  CGST+SGST vs IGST split. Goods amounts are tax-inclusive (taxable back-computed);
  service amounts are taxable + tax added. Non-GST "Bill of Supply" mode zeroes tax and
  suffixes items `_NONGST`. Discount tracked when qty×rate exceeds the charged amount.
- Client + item masters **auto-updated** on every save (case-insensitive item merge,
  sub-particulars with per-sub HSN/rate/tax, ship-to fields protected from blanking).
- Duplicate-guard: a new client name with an email/mobile already registered to another
  client is rejected (409).
- **Edit window**: invoices editable for 24 h after creation; edits preserve payment status
  + shipment fields; new docs use strict insert (never silently overwrite a bill number).
- **Inventory side-effects** (new docs only): sale invoice −stock, sale CN +stock,
  GRN +stock, purchase DN −stock; each writes a stock-ledger row. Delete reverses both
  local stock and EasyEcom (as `cancellation` / `DEL:<bill>` entries).
- Status lifecycle `Draft → Confirmed → Paid / Cancelled` via targeted-merge endpoint.
- Credit note generator from an existing invoice (negated amounts, own numbering,
  re-download if it already exists).
- List endpoints (full + paginated/filtered v2), single/ZIP PDF downloads.

### 5.4 Purchase Workflow PO → GRN → Bill (`docConversion.js`, `docLinks.repo.js`)
- Valid conversions: `po → grn`, `po → bill`, `grn → bill`.
- Per-line quantity tracking: each conversion stores a `line_map` (parent line index →
  qty carried). "Pending" view computes ordered/carried/pending per line; parent status is
  **Open / Partial / Closed**.
- Prefill API builds the child-document body from pending lines only; on save the child is
  auto-linked to the parent. Links can be removed. Dashboard widget rolls up open/partial
  POs and GRNs.
- Dedicated purpose-built screens: `purchase_order.html` + `static/js/po.js`,
  `grn.html` + `static/js/grn.js` (support `?edit=<bill_no>`).

### 5.5 Payments & Receipts (`payments.routes.js`)
- Record receipts (money in) and payments (money out) with party, mode, ref invoice, notes.
- Receipt against an invoice **auto-updates invoice status**: total receipts ≥ grand total
  → `Paid`, else `Confirmed`; deleting a receipt downgrades accordingly.
- Receipt / payment-voucher PDF; email-to-party (looks up email from client master, falls
  back to any invoice of that party).

### 5.6 Reports (`reports.routes.js`)
- **Sales report** and **purchase report** Excel (styled, ExcelJS).
- **GSTR-1 Excel** with B2B / B2CL (>₹2.5 L inter-state) / B2CS sheets, state codes.
- **Party ledger** (JSON + PDF): built from `journal_entries` first, raw invoices+payments
  as fallback; FY selector with auto-discovered FY list.
- **Outstanding/aging**: unpaid sales invoices with paid-so-far, balance, days overdue,
  buckets 0-30/31-60/61-90/90+.

### 5.7 Accounting (`accounting.routes.js` + `services/accounting/`)
- **Double-entry journal** auto-posted on every invoice/payment/expense save (see §8).
- Financial statements from the journal: party ledger, trial balance, P&L, balance sheet
  (with control-account DEBTORS/CREDITORS from party sub-ledger), receivables, payables.
- **GST summaries** from the journal: GSTR-1 totals and GSTR-3B (output vs input,
  net payable).
- **Expenses**: CRUD with expense account categories (`EXP_RENT`, `EXP_SALARY`, …), posted
  to the journal.
- **Period locks** (master-only): lock an FY → any write to a document dated inside it is
  rejected (423). Non-financial metadata (status, shipment ids) bypasses the lock by design.
- **Audit log**: fire-and-forget rows for document/bank/period actions, viewable per tenant.
- **Backfill** (master-only): idempotently re-posts every invoice/payment/expense to the
  journal (recovery from drift).

### 5.8 Bank Reconciliation (`accounting.routes.js` + `services/accounting/bank.js`)
- Multiple named bank accounts stored in the profile (legacy single-account backfilled).
- **Statement import**: multi-format parser — XLSX, XLS-as-HTML (HDFC/SBI style), CSV/TSV
  (any delimiter), text PDF, fixed-width text; recognises Indian number formats and many
  bank column-name variants; dedups by computed `txn_id`.
- **Match**: candidate payments suggested by equal amount (±0.01) and direction; match /
  unmatch with audit.
- **Classify** an unmatched line as: expense (creates expense), vendor payment (creates
  payment), manual journal (Dr/Cr pair), transfer, or other. Unclassify deletes the linked
  record. Single and bulk delete of statement lines.

### 5.9 Inventory (`inventory.routes.js`)
- Product stock list (from `inventory_products`), stock ledger with per-item filter.
- Manual adjustments (± qty with reason) → ledger entry.
- Stock is otherwise driven automatically by documents (§5.3).
- Low-stock (`current_stock ≤ reorder_level`) surfaces on the dashboard.
- EasyEcom SKU mapping per item (needs `easyecom` permission).

### 5.10 Products / Item Master (`products.routes.js`)
- Manage particulars: name, Product ID (SKU, uniqueness enforced), HSN, rate, tax rate;
  rename preserves history.
- **Field-level changelog** (`product_changelog`) for every edit/create/delete.
- Lookup-by-SKU API used by the invoice form to auto-fill.
- Per-product shipping weight/dimensions saved after B2B order creation.

### 5.11 Vendors / Parties (`vendors.routes.js`)
- Vendor CRUD with billing + ship-to addresses and bank details; merge-save preserves
  invoice-populated fields; rename is copy-then-delete (no data-loss window).
- **Pincode lookup** proxy (postalpincode.in) → auto-fill district/state.

### 5.12 Shipping — RapidShyp B2B (`rapidshyp.routes.js`)
- Requires `shipping` permission; per-tenant API key from profile.
- Create B2B order, attach invoice file, assign AWB, fetch label PDF, tracking info,
  cancel shipment — thin authenticated proxies to the RapidShyp API.
- Shipment id + latest tracking status persisted on the invoice (drives UI: hides
  Cancel/Assign-AWB once delivered/cancelled; hidden entirely for service invoices).
- Same-origin label-PDF proxy locked to the RapidShyp storage bucket URL prefix.

### 5.13 Marketplace Stock Sync — EasyEcom (`easyecom.routes.js`, `easyecom.service.js`)
- Requires `easyecom` permission; credentials per tenant (API key + 90-day JWT, or
  email/password auto-JWT with in-process cache).
- **Monthly API-hit budget** (default 250, configurable) tracked in the profile; sync/push
  blocked with 429 when exhausted.
- **Sync (pull)**: paginated inventory fetch → local cache for catalog SKUs only
  (case-insensitive match), preserving unsent local deltas; ensures every catalog product
  has an inventory row.
- **Queue & push**: every stock-affecting document accumulates `pending_easyecom_adj`
  per item (no API cost); push sends absolute quantities (cached stock + delta) per SKU;
  optional **auto-push** after each invoice (never blocks the save). Reconcile clears
  pending after manual updates. Status endpoint + raw-response debug endpoint.

### 5.14 Dashboard (`dashboard.routes.js`)
- KPI cards: today/month sales & purchases, outstanding count/total, low-stock count.
- Monthly sales trend (last 6 months, or a chosen FY), top 5 clients, document-type counts,
  low-stock items, open-PO/GRN workflow widget. Cancelled docs excluded.

### 5.15 Email & Scheduled Reports (`email.routes.js`, `cron.routes.js`)
- Email any invoice/CN/DN PDF to the client (rate-limited 10/min).
- **Daily report cron** (`GET /send-daily-report`, Vercel cron 16:30 UTC, guarded by
  `CRON_SECRET` bearer): generates and emails each tenant's cumulative sales report Excel
  to their profile email; double-checks the hour matches `REPORT_HOUR_UTC`.

### 5.16 PDF & Excel Generation (`services/pdf/`, `services/excel/`)
- FPDF-compatible shim over PDFKit (Calibri TTF); generators: invoice/CN/DN
  (`invoicePdf.js` — logo, place of supply, HSN table, tax split, amount in words,
  **UPI QR code** for the payable amount, signature, SKU column hidden for service
  invoices), PO (`poPdf.js`), GRN (`grnPdf.js`), receipt/voucher (`receiptPdf.js`),
  party ledger (`ledgerPdf.js`).
- Excel: styled sales/purchase report (`report.js`, SKU column, doc-type labels) and
  GSTR-1 (`gstr1.js`).

## 6. Key Workflows

### 6.1 Login (2-step)
```
User → POST /login (username+password)
  ├─ master: constant-time compare vs env password
  └─ sub-user: bcrypt/Werkzeug-compatible verify vs app_users
  → generate 6-digit OTP → email to tenant profile email
  → session stores HMAC(otp) + 10-min expiry + attempt counter
User → POST /verify-otp
  → timing-safe HMAC compare; ≤5 attempts; else invalidated
  → session.user = { id, is_master, payment_active, permissions } → /dashboard
```

### 6.2 Create a document (POST /generate-invoice)
```
1. Permission check (sale|purchase); reject invalid type combos
2. Client dedup guard (email/mobile) → upsert client + particulars masters
3. Edit? → verify 24h window, preserve status/shipment fields, upsert
   New?  → FY-sequential number → STRICT INSERT (retry next number on collision)
4. GST computation (intra/inter, goods/service, non-GST)
5. Period-lock check (423 if FY locked)
6. Journal auto-post (async; failure logged → run backfill)
7. Inventory delta + stock ledger row (per direction table §5.3)
8. EasyEcom pending delta queued (+optional auto-push, never blocking)
9. Parent-link recorded when converted from PO/GRN
10. PDF rendered and returned as the response
```

### 6.3 Procurement chain
```
PO (no stock, no journal)
 └─ convert pending lines → GRN (stock IN, no journal)
      └─ convert → Purchase Bill (journal: purchases + input GST)
 └─ or convert directly PO → Bill
Purchase Debit Note reverses (stock OUT, journal reversed)
Status per parent: Open → Partial → Closed (per-line qty maps in doc_links)
```

### 6.4 Payment → invoice status
```
Receipt saved (ref_invoice set)
  → sum all receipts for that invoice
  → ≥ grand_total ? status=Paid : status=Confirmed   (targeted merge)
Receipt deleted → recompute → downgrade to Confirmed if under-paid
Journal: Dr BANK/CASH, Cr SUBLEDGER(party)  (reverse for payments out)
```

### 6.5 Bank reconciliation
```
Import statement file → parse (auto-detect format/columns) → dedup insert
For each unmatched txn:
  ├─ Match → link to an existing payment (amount+direction candidates)
  └─ Classify → create expense / vendor payment / journal pair / transfer / other
Unmatch/Unclassify reverses (deletes created record). All actions audited.
```

### 6.6 Signup & activation
```
POST /signup (validated) → email OTP → POST /verify-signup
  → app_users insert (inactive, no perms) + profile row + activation request
Master approves on /profile → user active → master grants permissions
User logs in normally (reads fresh perms at OTP verify)
```

### 6.7 EasyEcom stock sync
```
Document save → pending_easyecom_adj += qty×direction (per item, free)
Auto-push ON + budget OK → push absolute qty per SKU (1 hit each)
Manual: /easyecom/sync (pull, 1 hit/page) · /easyecom/push · /easyecom/reconcile
Monthly hit counter stored in profile; 429 past the limit
```

## 7. Frontend Pages

| Page | Template | Purpose |
|---|---|---|
| `/login`, `/verify-otp` | login.html, verify_otp.html | 2-step login (per-tenant branding) |
| `/signup`, `/verify-signup` | signup*.html | self-serve onboarding |
| `/dashboard` | dashboard.html | KPIs, charts, FY filter, workflow widget |
| `/home`, `/sales/new`, `/purchase/new` | index.html (+ invoice.js, 1690 lines) | unified document form: line items, client auto-fill, stock check, GST preview, doc list with actions (download, email, edit, delete, CN, ship) |
| `/purchase/po/new`, `/purchase/grn/new` | purchase_order.html, grn.html | dedicated PO/GRN forms with conversion prefill |
| `/accounts` | accounts.html | ledgers, TB/P&L/BS, GST, period locks, bank reconciliation, audit log |
| `/expenses` | expenses.html | expense entry & list |
| `/inventory` | inventory.html | stock list, ledger, adjust, EasyEcom panel |
| `/products` | products.html | item master + changelog |
| `/vendors` | vendors.html | vendor CRUD with pincode auto-fill |
| `/profile` | user_profile.html | profile, integrations, user management (master) |
| `/activation` | activation.html | pending-approval holding page |

## 8. Accounting Model (reference)

Chart of accounts seeded per tenant (`services/accounting/accounts.js`):
`SALES`, `PURCHASES`, `CGST/SGST/IGST_OUTPUT` (liability), `CGST/SGST/IGST_INPUT` (asset),
legacy `GST_OUTPUT/INPUT`, `SUBLEDGER` (party control, asset), `BANK`, `CASH`,
`TDS_RECEIVABLE`, `EXP_*` categories, `DISCOUNT_GIVEN`, `ROUND_OFF`, `OPENING_EQUITY`.

Posting rules (`services/accounting/journal.js`):

| Event | Debit | Credit |
|---|---|---|
| Sale invoice | SUBLEDGER(party) grand | SALES sub + C/S/IGST_OUTPUT |
| Sale credit note | reverse of above | |
| Purchase bill | PURCHASES sub + C/S/IGST_INPUT | SUBLEDGER(vendor) grand |
| Purchase debit note | reverse of above | |
| Receipt | BANK/CASH | SUBLEDGER(party) |
| Payment | SUBLEDGER(party) | BANK/CASH |
| Expense | EXP_xxx | BANK/CASH |

PO/GRN are non-financial (never posted). Unbalanced lines >5p get an automatic `ROUND_OFF`
line. Writes per (tenant, ref) are serialized and idempotent (delete-then-insert), so
re-posting/backfill never duplicates.

## 9. Configuration (environment)

Required (server refuses to boot without them — `src/config/env.js`):
`SECRET_KEY` (≥24 chars), `CRON_SECRET` (≥16), `LOGIN_USER`, `LOGIN_PASS` (≥10),
`SUPABASE_URL`, `SUPABASE_KEY`.
Optional: `EMAIL_HOST/PORT/USER/PASSWORD`, `ALERT_EMAIL` (critical-error alert recipient,
defaults to `EMAIL_USER`), `RAPIDSHYP_API_URL`, `EASYECOM_API_URL/JWT_PATH`,
plus per-tenant integration keys stored in the profile. See `.env.example`.

**Database migrations** (run manually in the Supabase SQL editor, in order):
`001_enable_rls_backstop.sql` (RLS deny-all backstop) and
`002_sessions_counters_indexes.sql` (session table, doc counters, indexed document
columns) — 002 must be applied **before** deploying the session/counter code.

## 10. Documentation Policy (MANDATORY)

When you change this codebase:

1. **Any feature added/changed/removed** → update the relevant section of **this file**
   (and the workflow diagrams if a flow changed) and bump "Last updated".
2. **Any route added/changed/removed** → update **[API.md](API.md)**.
3. **Anything touching auth, sessions, permissions, tenant isolation, secrets, uploads,
   external calls, or data validation** → update **[SECURITY.md](SECURITY.md)**.
4. Documentation updates belong **in the same commit** as the code change.
