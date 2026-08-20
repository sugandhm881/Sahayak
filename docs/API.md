# Sahayak ERP — API Reference

A multi-tenant, GST-compliant invoicing & accounting ERP (Node.js / Express + Supabase, Nunjucks server-rendered UI). This document describes the full HTTP surface: the server-rendered **page routes** (return HTML) and the **JSON/data + binary endpoints** consumed by the front-end JavaScript.

- **Stack:** Express, Supabase (PostgreSQL, JSONB `data` columns), Nunjucks, cookie-session.
- **Style:** Not a public REST API — endpoints are consumed by the app's own front-end over a **session cookie**. There is no API-key/bearer auth for normal endpoints (the one exception is the cron endpoint).
- **All routers mount at the root** (no `/api` prefix). Newer JSON endpoints are grouped under `/v2/…`; a few legacy ones under `/api/…`.

---

## Table of Contents

1. [Conventions](#conventions)
2. [Authentication](#1-authentication)
3. [Profile & Users](#2-profile--users)
4. [Dashboard](#3-dashboard)
5. [Documents (Invoices, PO, GRN, Notes)](#4-documents)
6. [Masters (Clients & Particulars)](#5-masters)
7. [Payments](#6-payments)
8. [Reports](#7-reports)
9. [Accounting](#8-accounting)
10. [Inventory](#9-inventory)
11. [Products](#10-products)
12. [Vendors](#11-vendors)
13. [Shipping — RapidShyp](#12-shipping-rapidshyp)
14. [Marketplace Sync — EasyEcom](#13-marketplace-sync-easyecom)
15. [Email](#14-email)
16. [Cron & Ops](#15-cron--ops)

---

## Conventions

### Base URL
All paths are relative to the deployment origin (e.g. `https://your-host/`). No version prefix at the router level.

### Authentication (session cookie)
Auth is a **2-factor, session-cookie** flow — there are no per-request API tokens.

1. `POST /login` with `username` + `password` → validates credentials and **emails a 6-digit OTP**.
2. `POST /verify-otp` with the `otp` → establishes `req.session.user = { id, is_master, payment_active, permissions }`.
3. The session cookie `sahayak_sess` (httpOnly, `sameSite=lax`, `secure` in production, **7-day** max age) carries only a **signed session id**; session data lives **server-side** in the `http_sessions` table (Supabase store, migration 002). Sessions are revocable: logout, deactivation, password reset, and rename destroy the stored session immediately.

**CSRF:** all state-changing methods (POST/PUT/PATCH/DELETE) are guarded by fetch-metadata / Origin checks (`src/middleware/csrf.js`) — cross-site browser requests receive 403 `{error:"Cross-site request blocked (CSRF protection)."}`. Non-browser clients (no `Sec-Fetch-Site`/`Origin` headers, e.g. the cron caller) are unaffected.

Middleware:
- **`loginRequired`** — 401 `{error:"Unauthorized"}` for JSON requests, or redirect to `/login` for HTML GETs.
- **`activationCheck`** — a logged-in but **inactive** (`payment_active=false`) non-master is redirected to `/activation` (or 403 `{error:"Account inactive"}` for JSON). New self-serve signups start inactive.

### Authorization (permission model)
- **Master** (`is_master`) bypasses all permission checks.
- Other users hold a `permissions` string array. New users default to **`[]`** (no access until a master grants it).
- **`requireAnyPermission(...perms)`** — allows the request if the user is master **or** holds **any** listed permission; otherwise 403 (`{error}` for JSON, HTML message for pages).

**Permission keys:** `sale`, `purchase`, `shipping`, `easyecom`, `expenses`, `vendors`, `accounts`, `reports`, `inventory`, `products`, `profile`.

Several routers apply a **router-level** `requireAnyPermission(...)` guard to every route in the file — noted per section.

### Multi-tenancy & "view as"
Every data row is scoped by `tenant_id`, resolved from the session via `getTenantId(req)`. A **master** can impersonate a tenant with `GET /set-view-mode/:user_id`, which sets `session.view_mode`; data reads then target that tenant.

### Rate limiting
- Global: `dayLimiter` + `defaultLimiter` on all routes.
- `loginLimiter` on the auth endpoints.
- `perMinute(N)` on specific heavy/abusable endpoints (e.g. `POST /generate-invoice` = 30/min; email endpoints = 10/min).

### Request / response formats
- Bodies: JSON or `application/x-www-form-urlencoded` (limit **20 MB**). File uploads use `multipart/form-data` (Multer, memory storage; limits noted per endpoint).
- **JSON endpoints** return `application/json`. **Page routes** return server-rendered HTML. Some endpoints stream **binary** (PDF / Excel / ZIP) with `Content-Disposition: attachment`.
- **Errors:** JSON endpoints return an appropriate status with `{ "error": "message" }`. Page/form routes redirect with a flash message.

### Bill numbers in paths (`(*)` wildcards)
Document identifiers (bill numbers) contain slashes, e.g. `TE/2025-26/001`. Routes that take one use an Express wildcard (`:bill_no(*)`) so the slash is captured. **Callers must URL-encode** the bill number in the path; the server `decodeURIComponent`s it.

### Document types & numbering
`POST /generate-invoice` produces all document types. Numbers are FY-sequential via the **atomic `next_doc_seq()` counter** (`doc_counters` table, migration 002; legacy full-scan count is used only to seed a new series or as a pre-migration fallback); `<PFX>` is the tenant's `invoice_prefix` (default `TE`), `<FY>` like `2025-26`, `<NNN>` a zero-padded sequence.

| `doc_category` | `doc_type` | Meaning | Number format |
|---|---|---|---|
| `sale` | `invoice` | Tax invoice | `<PFX>/<FY>/<NNN>` |
| `sale` | `cn` | Credit note | `<PFX>-CN/<FY>/<NNN>` |
| `purchase` | `po` | Purchase order | `<PFX>-PO/<FY>/<NNN>` |
| `purchase` | `grn` | Goods receipt note | `<PFX>-GRN/<FY>/<NNN>` |
| `purchase` | `bill` | Purchase bill | `<PFX>-PB/<FY>/<NNN>` |
| `purchase` | `dn` | Debit note | `<PFX>-PDN/<FY>/<NNN>` |

Amounts are **tax-inclusive for goods** (server derives taxable = amount ÷ (1 + rate/100)) and **tax-exclusive for services**. Edits are allowed within a **24-hour** window.

---

## 1. Authentication

> All auth routes are **public** (no session required) unless noted. Rate-limited by `loginLimiter`.

### `GET /login`
Render the login form. If already logged in → redirect `/dashboard`. Else renders `login.html`.

### `POST /login`
Validate credentials and start the OTP flow. **Rate limit:** `loginLimiter`.
- **Body (form):** `username`, `password`.
- **Returns:** on success renders `verify_otp.html`; invalid → re-renders `login.html` with error.
- **Effects:** stores `temp_user_id`, `temp_is_master`, an **HMAC** of the OTP (keyed by `SECRET_KEY`; plaintext never stored), a 10-min expiry, and attempt counter in the session; emails the OTP to the tenant's profile email. Master password is compared in constant time against `MASTER_PASSWORD`; sub-users via bcrypt hash.

### `POST /verify-otp`
Verify the login OTP and create the authenticated session. **Rate limit:** `loginLimiter`.
- **Body (form):** `otp` (6 digits).
- **Returns:** on match → redirect `/dashboard`; failure → re-renders `verify_otp.html` (`OTP expired…` / `Too many attempts…` / `Invalid OTP`).
- **Effects:** OTP rejected if expired (>10 min), >5 attempts (`OTP_MAX_ATTEMPTS`), or HMAC mismatch (timing-safe). On success sets `session.user = { id, is_master, payment_active, permissions }` (sub-users read `is_active`/`permissions` from DB; missing perms default to `[]`).

### `GET /signup`
Render the self-serve signup form (redirects to `/dashboard` if logged in).

### `POST /signup`
Validate a new-account request and email a verification OTP (no billing). **Rate limit:** `loginLimiter`.
- **Body (form):** `username` (3–32 chars, `[a-zA-Z0-9_.-]`), `email`, `company_name`, `password` (≥8), `confirm_password` (must match).
- **Returns:** success → renders `verify_signup.html`; failures re-render `signup.html` with error.
- **Effects:** rejects master/taken usernames; stashes a pending signup (bcrypt hash + OTP HMAC + 10-min expiry) in the session and emails the OTP. **No user is created yet.**

### `POST /verify-signup`
Verify the signup OTP and create the account. **Rate limit:** `loginLimiter`.
- **Body (form):** `otp`.
- **Returns:** success → renders `signup_pending.html`; OTP failure re-renders `verify_signup.html`.
- **Effects:** strict-inserts into `app_users` with **`is_active:false, permissions:[]`**; creates a seller-profile row (company/email, prefix `TE`); queues an activation request `<username>_SIGNUP` so the master is notified. **No auto-login** — the user signs in after a master approves.

### `GET /logout`
**Auth:** `loginRequired`. Clears the session and redirects `/login`.

### `GET /activation`
**Auth:** `loginRequired`. Renders `activation.html` ("Awaiting admin approval") for an inactive account.

### `GET /set-view-mode/:user_id`
**Auth:** `loginRequired` + **master-only** (in-handler). Sets `session.view_mode = user_id` so the master views another tenant's data; redirects `/home`. Non-master → 403.

### `GET /api/get-branding/:username`
**Auth:** public. Returns a tenant's login-page branding.
- **Returns:** `{ found:true, company_name, logo_base64 }` if a profile exists, else `{ found:false }`.

---

## 2. Profile & Users

### `GET /profile`
**Auth:** `loginRequired`. Renders `user_profile.html` for the current or (master-selected) target user.
- **Query:** `edit_user` (master only) — which user to edit (defaults to master).
- **Data:** profile, `target_user`, `target_is_active`, `target_perms`, and `pending_requests` (master only, from activation requests).

### `POST /profile`
**Auth:** `loginRequired` (several actions **master-only**; profile-save requires `profile` permission for non-masters, own-record only). **Body:** `multipart/form-data` (Multer `upload.fields([logo, signature])`, 10 MB). Action is dispatched by the first matching flag:

| Flag | Who | Body fields | Effect |
|---|---|---|---|
| `verify_request` | master | `request_id`, `user_to_activate` | Approve an activation request → `is_active:true`; marks request Approved; redirects to that user's editor to grant perms. |
| `update_perms` | master | `target_user_id`, `perm_<key>` checkboxes | Set the user's `permissions` to the checked keys. |
| `toggle_active` | master | `target_user_id`, `toggle_active` (`true`/other) | Activate/deactivate a user. |
| `new_username` | master | `new_username`, `new_password`, `new_perm_sale?`, `new_perm_purchase?` | Create a sub-user (`is_active:false`). |
| `action_rename_user` | master | `target_user_id` (old), `new_sub_username` (new) | Rename user and re-tenant all their rows across 13 tables. |
| *(default: profile save)* | self/master | `company_name`, `invoice_prefix`, `address_1/2`, `phone`, `email`, `gstin`, `bank_name`, `account_holder`, `account_no`, `ifsc`, `state`, `upi_id`, `rapidshyp_*`, `easyecom_*`, master-only `invoice_type`; files `logo`, `signature` | Merge-saves the seller profile (unlisted fields preserved); compresses & stores logo/signature. |

- **Returns:** redirects (usually `/profile?edit_user=<target>`) with a flash message.

### `POST /profile/change-own-password`
**Auth:** `loginRequired` (sub-users; masters redirected out).
- **Body (form):** `current_password`, `new_password` (≥6), `confirm_password`.
- **Effects:** verifies current password, then updates to the new bcrypt hash.

### `POST /reset-password`
**Auth:** `loginRequired` + **`masterOnly`**.
- **Body (form):** `target_user_id`, `reset_password` (new password).
- **Effects:** master resets another user's password (no current-password check).

---

## 3. Dashboard

### `GET /dashboard`
**Auth:** `loginRequired`. Renders `dashboard.html`.

### `GET /dashboard-data`
**Auth:** `loginRequired`. Aggregated dashboard metrics.
- **Query:** `fy` (`YYYY-MM`, e.g. `2025-04`) — restricts trend/top-clients/outstanding to that financial year.
- **Returns:** `{ today_sales, month_sales, today_purchase, month_purchase, outstanding_count, outstanding_total, low_stock_count, low_stock_items[], monthly_trend[[label,total]], top_clients[[name,total]], doc_counts{invoice,cn,po,grn,bill,dn}, total_invoices }` (excludes Cancelled).

---

## 4. Documents

The core document engine — invoices, credit/debit notes, purchase bills, POs and GRNs, plus the PO→GRN→Bill workflow.

### `GET /home`
**Auth:** `loginRequired`. Smart landing: redirects to `/sales/new` (sale-only users) or `/purchase/new` (purchase-only), else renders the unified `index.html`.

### `GET /sales/new`
**Auth:** `loginRequired` (+ inline `sale` check). Renders the sales form (`index.html`, `module:'sale'`); users without `sale` are redirected to `/purchase/new`.

### `GET /purchase/new`
**Auth:** `loginRequired` (+ inline `purchase` check). Renders the purchase form (`index.html`, `module:'purchase'`).

### `GET /purchase/po/new`
**Auth:** `requireAnyPermission('purchase')`. Renders the dedicated Purchase Order page (`purchase_order.html`). Supports `?edit=<bill_no>` (client-side).

### `GET /purchase/grn/new`
**Auth:** `requireAnyPermission('purchase')`. Renders the dedicated GRN page (`grn.html`). Supports `?edit=<bill_no>` (client-side).

### `GET /invoices-list`
**Auth:** `loginRequired`. Returns the full array of the tenant's documents (JSON).

### `GET /v2/invoices-list`
**Auth:** `loginRequired`. Paginated/filtered document list.
- **Query:** `category`, `from`, `to`, `page` (default 1), `limit` (default 50, clamped 1–200).
- **Returns:** the paginated result object.

### `POST /generate-invoice`
**Auth:** `loginRequired` + inline `hasPermission(doc_category)` (403 otherwise). **Rate limit:** `perMinute(30)`. The central create/edit endpoint for every document type.
- **Body (JSON/form):**
  - **Type:** `doc_category` (`sale`|`purchase`, default `sale`), `doc_type` (`invoice`|`cn`|`bill`|`po`|`grn`|`dn`), `invoice_type` (`goods`|`service`), `is_non_gst` (bool).
  - **Buyer:** `client_name`, `client_email`, `client_mobile`, `client_address1/2`, `client_pincode`, `client_district`, `client_state`, `client_gstin`.
  - **Ship-to:** `shipto_name`, `shipto_address1/2`, `shipto_pincode`, `shipto_district`, `shipto_state`, `shipto_gstin`, `shipto_email`, `shipto_mobile`.
  - **Lines (parallel arrays):** `particulars[]`, `qtys[]`, `rates[]`, `taxrates[]` (%), `hsns[]`, `amounts[]` (inclusive for goods / taxable for service), `discounts[]`, `sub_particulars[]`.
  - **Purchase/meta:** `po_number`, `payment_term`, `expected_delivery_date`, `payment_mode`, `vendor_contact_person`, `vendor_invoice_number`, `original_invoice_no`, `tds_applicable`.
  - **Numbering/edit:** `auto_generate` (default true), `manual_bill_no`/`bill_no`, `manual_invoice_date`/`invoice_date`, `is_edit`.
  - **Conversion linkage:** `_parent_bill_no`, `_parent_type`, `_parent_line_indexes[]`, `_parent_line_qtys[]`.
- **Returns:** binary **PDF** (`application/pdf`, `attachment; filename="<Type>_<bill_no>.pdf"`).
- **Errors:** 403 (no permission / edit window expired), 400 (no sales DN / no purchase CN), 409 (email/mobile already registered to another client), 500.
- **Effects:** upserts client + particulars/sub-particulars; generates an FY-sequential number with duplicate-collision retry (`DUPLICATE_BILL_NO`, up to 20 attempts); persists via strict insert (posts to journal/ledger) or edit-upsert (preserving status/shipment fields); adjusts inventory + stock ledger (+1 GRN, −1 purchase DN, −1 sale invoice, +1 sale CN); queues an EasyEcom stock delta (non-blocking); auto-links to a parent document when converted.

### `DELETE /delete-invoice/:bill_no`
**Auth:** `requireAnyPermission('sale','purchase')`. Deletes a document and **reverses** its inventory + EasyEcom effects (writes a `cancellation` stock-ledger entry). 404 if not found.

### `GET /download-invoice/:bill_no`
**Auth:** `loginRequired`. Re-renders and downloads a document's PDF (no persistence). Filename `<CreditNote|DebitNote|Invoice>_<bill_no>.pdf`. 404 if unknown.

### `POST /download-zip`
**Auth:** `loginRequired`. Bundles multiple documents' PDFs into one ZIP.
- **Body:** `bill_nos[]`.
- **Returns:** `application/zip`, `Invoices_Bundle.zip`. 400 if empty.

### `POST /generate-credit-note/:bill_no`
**Auth:** `requireAnyPermission('sale','purchase')`. Creates (or re-downloads an existing) credit note against the original invoice in the path.
- **Returns:** credit-note PDF.
- **Effects:** if a CN already exists, just re-renders it; else builds a CN with negated totals/quantities (strips status/shipment fields), assigns a `-CN/` number with retry, and posts it to the ledger. 404 if original not found.

### `POST /update-status/:bill_no`
**Auth:** `requireAnyPermission('sale','purchase')`.
- **Body:** `status` (`Draft`|`Confirmed`|`Paid`|`Cancelled`).
- **Effects:** targeted merge of `status` + `status_updated_at` only (won't clobber concurrent edits). 400 invalid status, 404 not found.

### `GET /v2/doc/:bill_no/pending`
**Auth:** `loginRequired`. Returns pending/outstanding line quantities + fulfillment status (PO→GRN→Bill). 404 if not found.

### `GET /v2/doc/:bill_no/prefill/:to_type`
**Auth:** `loginRequired`. Returns prefill data to convert a parent doc into a child of `:to_type` (e.g. PO→GRN). 400 on invalid conversion.

### `GET /v2/doc/:bill_no/children`
**Auth:** `loginRequired`. Lists child documents linked downstream. Returns `{ rows:[…] }`.

### `GET /v2/doc/:bill_no/parents`
**Auth:** `loginRequired`. Lists parent documents linked upstream. Returns `{ rows:[…] }`.

### `DELETE /v2/doc/link/:child_bill_no`
**Auth:** `loginRequired`. Removes the parent→child workflow link. Returns `{ status:'ok' }`.

### `GET /v2/workflow/open`
**Auth:** `loginRequired`. Roll-up counts of open/partial POs and GRNs: `{ po:{open,partial,total}, grn:{open,partial,total} }`.

---

## 5. Masters

### `GET /clients`
**Auth:** `loginRequired`. All saved clients/vendors for the tenant (JSON map).

### `GET /particulars`
**Auth:** `loginRequired`. All saved particulars (item master) for the tenant (JSON map).

### `GET /api/check-stock/:item_name`
**Auth:** `loginRequired`. Current stock for an item.
- **Returns:** `{ exists, stock }` (`{exists:false, stock:0}` when unknown; errors are swallowed → always 200).

---

## 6. Payments

> **Router guard:** `requireAnyPermission('sale','purchase','accounts')` on all routes.

### `GET /payments`
List all payment/receipt entries (JSON array; returns `[]` on error).

### `POST /payments`
Create or update a payment/receipt.
- **Body:** `party_name` (required), `amount` (required, >0), `payment_id` (auto if omitted), `payment_type` (`receipt`|`payment`, default `receipt`), `mode` (default `Cash`), `ref_invoice`, `notes`, `payment_date`, `timestamp`.
- **Returns:** `{ success:true, payment_id }`. 400 if party/amount missing.
- **Effects:** upserts the payment; if a `receipt` references an invoice, recomputes and patches the invoice status to `Paid` (fully covered) or `Confirmed`.

### `DELETE /delete-payment/:payment_id`
Delete a payment; if it was a receipt against an invoice, downgrades that invoice's status when it's no longer fully paid. 404 if not found.

### `GET /download-receipt/:payment_id`
Receipt / payment-voucher **PDF** (`Receipt_<last6>.pdf` or `Payment_Voucher_<last6>.pdf`). 404 if not found.

### `POST /email-receipt/:payment_id`
**Rate limit:** `perMinute(10)`. Emails the receipt PDF to the party's email on file. 404 (payment) / 400 (no email) / success `{ message }`.

---

## 7. Reports

> **Router guard:** `requireAnyPermission('reports','accounts','sale','purchase')` on all routes.

### `GET /download-report`
Sales report **Excel** (`Sales_Report_<date>.xlsx`). 404 if no invoices.

### `GET /download-purchase-report`
Purchase report **Excel** (`Purchase_Report_<date>.xlsx`). 404 if none.

### `GET /download-gstr1`
GSTR-1 **Excel**.
- **Query:** `month_year` (optional; used in the filename `GSTR1_<month_year>.xlsx`).

### `GET /ledger/:party_name`
Party ledger with running balance (JSON).
- **Query:** `fy` (default current FY).
- **Returns:** `{ party_name, entries[], closing_balance, available_fys, fy }`.

### `GET /download-ledger/:party_name`
Party ledger **PDF** for a financial year.
- **Query:** `fy` (default current FY). Filename `Ledger_<party>_<fy>.pdf`.

### `GET /outstanding`
Unpaid/partly-paid sales invoices with aging.
- **Query:** `fy` (optional).
- **Returns:** array of `{ bill_no, invoice_date, client_name, client_mobile, grand_total, paid, balance, days_overdue, age_bucket, status }` (buckets `0-30`/`31-60`/`61-90`/`90+ days`).

---

## 8. Accounting

> **Router guard:** `requireAnyPermission('accounts','expenses','sale','purchase')` on all routes. Financial statements read from double-entry `journal_entries`.

### `GET /accounts`
Render `accounts.html`.

### `GET /v2/ledger/:party_name`
Party ledger from journal entries → `{ party_name, entries[{date,doc_no,doc_type,narration,debit,credit,balance}], closing_balance }`.

### `GET /v2/trial-balance`
- **Query:** `from`, `to`. → `{ from, to, rows[{account,debit,credit,balance}] }`.

### `GET /v2/profit-loss`
- **Query:** `from`, `to`. → `{ from, to, income{}, expense{}, total_income, total_expense, net_profit }`.

### `GET /v2/balance-sheet`
- **Query:** `to` (as-of date). → `{ as_of, asset{…,DEBTORS?}, liability{…,CREDITORS?}, equity{} }`.

### `GET /v2/receivables`
- **Query:** `to`. → `{ rows[{party,balance}], total }` (positive sub-ledger balances).

### `GET /v2/payables`
- **Query:** `to`. → `{ rows[{party,balance}], total }` (negative sub-ledger balances, shown positive).

### `GET /v2/gstr-1`
- **Query:** `from`, `to`. → `{ from, to, sales, cgst, sgst, igst, gst_legacy }`.

### `GET /v2/gstr-3b`
- **Query:** `from`, `to`. → `{ …, cgst_output, sgst_output, igst_output, cgst_input, sgst_input, igst_input, total_output, total_input, net_payable }`.

### Expenses
- **`GET /expenses`** — render `expenses.html`.
- **`GET /v2/expenses`** — list expenses → `{ rows }`.
- **`POST /v2/expenses`** — create/update. Body: `expense_id?`, `expense_date`, `account_code` (default `EXP_GENERAL`), `category`, `vendor`, `note`, `amount` (required), `mode` (default `Bank`). → `{ status:'ok', expense }`. 400 if amount missing.
- **`DELETE /v2/expenses/:id`** — delete → `{ status:'ok' }`.
- **`GET /v2/expense-accounts`** — standard `EXP_*` expense accounts → `{ rows }`.

### Period locks
- **`GET /v2/period-locks`** — list FY locks → `{ rows }`.
- **`POST /v2/period-locks`** — **`masterOnly`**. Body `fy` (e.g. `"2025-26"`) → locks the FY (+ audit log). 400 if missing.
- **`DELETE /v2/period-locks/:fy`** — **`masterOnly`**. Unlocks the FY (+ audit log).
- **`GET /v2/current-fy`** — `{ fy }`.
- **`GET /v2/audit-log`** — recent audit entries. Query `limit` (default 200, max 1000) → `{ rows }`.

### Bank reconciliation
- **`GET /v2/bank/accounts`** — list bank accounts from the seller profile → `{ accounts[] }`.
- **`POST /v2/bank/accounts`** — add/update. Body: `id?`, `label` (required), `bank_name`, `account_holder`, `account_no` (required), `ifsc`, `branch` → `{ status:'ok', account }` (+ audit).
- **`DELETE /v2/bank/accounts/:id`** — remove an account.
- **`POST /v2/bank/import`** — **multipart** (`statement` file via Multer, 20 MB; form field `account_tag`). Parses CSV/Excel, dedups by `txn_id`, inserts rows → `{ status:'ok', inserted, skipped, total }` (+ audit).
- **`GET /v2/bank/transactions`** — list (max 500). Query: `status` (`unmatched`/`matched`), `account`, `from`, `to` → `{ rows }`.
- **`GET /v2/party-names`** — deduped party names across journal/clients/payments → `{ names[] }`.
- **`GET /v2/bank/candidates/:txn_id`** — suggested matching payments (amount within 0.01, same direction) → `{ txn, candidates[] }`.
- **`POST /v2/bank/match`** — Body `txn_id`, `payment_id` → reconcile (+ audit).
- **`POST /v2/bank/unmatch/:txn_id`** — remove a match (+ audit).
- **`POST /v2/bank/classify`** — Body: `txn_id` (required), `mapping_type` (`expense`|`vendor_payment`|`journal`|`transfer`|`other`), plus `date`, `amount`, `vendor`, `narration`, `note`, `account_code`, `dr_account`/`cr_account` (required for `journal`), `party_name`, `ref_invoice`. Creates the corresponding expense/payment/journal record → `{ status:'ok', mapped_ref_id }` (+ audit).
- **`POST /v2/bank/unclassify/:txn_id`** — deletes the linked record and clears the mapping (+ audit). 404 if txn not found.
- **`DELETE /v2/bank/transactions/:txn_id`** — delete a txn → `{ status:'ok', deleted:1 }` (+ audit).
- **`POST /v2/bank/transactions/bulk-delete`** — Body `txn_ids[]` (required) → `{ status:'ok', deleted }` (+ audit each). 400 if empty.

### `POST /v2/backfill-journal`
**`masterOnly`.** Idempotently re-posts all invoices, payments, and expenses into the journal → `{ status:'ok', invoices, payments, expenses, posted }`.

---

## 9. Inventory

> **Router guard:** `requireAnyPermission('inventory','purchase','easyecom')` on all routes.

### `GET /inventory`
Render `inventory.html`.

### `GET /inventory/list`
All inventory products sorted by name (JSON array).

### `GET /inventory/ledger`
Stock-ledger entries. Query: `item` (optional filter), `limit` (default 300).

### `POST /inventory/adjust`
Manual stock adjustment.
- **Body:** `item_name` (required), `qty_change` (required, non-zero), `reason` (default `Manual adjustment`).
- **Returns:** `{ ok:true, item_name, current_stock }`. 400 on missing/zero.
- **Effects:** updates stock + writes an `adjustment` ledger entry.

### `POST /inventory/set-easyecom-sku`
Map an item to an EasyEcom SKU. **Extra auth:** master or `easyecom` permission (403 otherwise).
- **Body:** `item_name` (required), `sku` (empty → clears). → `{ ok:true }`.

---

## 10. Products

> **Router guard:** `requireAnyPermission('products','purchase','sale')` on all routes. "Products" = the particulars/item master with change history.

### `GET /products`
Render `products.html`.

### `GET /products/list`
All particulars → array of `{ name, product_id, hsn, rate, taxrate, sub_particulars, sub_details }` sorted by name.

### `GET /products/lookup/:product_id`
Look up a particular by Product ID → `{ name, product_id, hsn, rate, taxrate }`. 404 if none.

### `POST /products/update`
Create/update a particular (with rename).
- **Body:** `original_name?` (for rename), `name` (required), `product_id?`, `hsn?`, `rate`, `taxrate`.
- **Returns:** `{ ok:true }`. 400 (no name), 409 (product_id already used).
- **Effects:** saves the particular; logs each changed field to `product_changelog`; on rename, deletes the old row.

### `POST /products/delete`
- **Body:** `name` (required). Logs a `delete` snapshot, then removes. 404 if not found.

### `GET /products/history`
Change log. Query: `name` (optional; blank = tenant-wide), `limit` (default 200).

### `POST /products/save-ship-dims`
Persist per-product shipping weight/dimensions (after B2B order creation).
- **Body (JSON array):** `[{ name, wt, l, b, h }]` (only truthy dims saved as `ship_wt/ship_l/ship_b/ship_h`).
- **Returns:** `{ ok:true, saved }`.

---

## 11. Vendors

> **Router guard:** `requireAnyPermission('vendors','sale','purchase')` on all routes.

### `GET /vendors`
Render `vendors.html`.

### `GET /v2/vendors`
List all vendors/parties → `{ vendors:[{ name, data }] }` ordered by name.

### `POST /v2/vendors`
Create/update/rename a vendor (merges over existing to preserve invoice-populated fields). **Body (JSON):** `name` (required), `original_name?` (triggers rename), `type` (default `vendor`), `gstin`, `email`, `mobile`, `address1/2`, `pincode`, `district`, `state`, `shipto_*`, `bank_name`, `bank_account`, `bank_ifsc`. → `{ ok:true }`. 400 if no name. On rename, the old row is deleted only after the new one is saved.

### `DELETE /v2/vendors/:name`
Delete a vendor by (URL-encoded) name → `{ ok:true }`.

### `GET /v2/pincode/:pin`
Look up district/state for a 6-digit pincode via the external `postalpincode.in` API → `{ district, state }`. 400 invalid / 404 not found.

---

## 12. Shipping (RapidShyp)

> **Auth:** every route uses `loginRequired` **plus** an in-handler check requiring master or the **`shipping`** permission (403 otherwise). The seller's `rapidshyp_api_key` is sent as the `rapidshyp-token` header to `RAPIDSHYP_API_URL`; if unset → 500. Most routes are thin pass-throughs of the client body to RapidShyp.

### `POST /rapidshyp/b2b-order`
Create a B2B order. The entire body is forwarded to `…/b2b/orders/b2b_ext_create_order`; RapidShyp's JSON is returned as-is.

### `POST /rapidshyp/attach-invoice`
Attach an invoice file to an order. **Multipart** (`invoice_file` via Multer, 10 MB) + `order_id` (required). Forwards to `…/b2b_ext_upload_invoice`. 400 if missing file/order_id.

### `POST /rapidshyp/mark-shipped`
Save/clear the RapidShyp shipment ID on a local document. **Body:** `bill_no` (required), `shipment_id` (falsy clears). → `{ ok:true }`. *(No external call.)*

### `POST /rapidshyp/save-status`
Persist the latest tracking status on the invoice (so the UI can hide Cancel/Assign-AWB once delivered). **Body:** `bill_no` (required), `status_code`, `status_desc`. → `{ ok:true }`. *(No external call.)*

### `POST /rapidshyp/b2b-assign-awb`
Assign an AWB. Body forwarded to `…/b2b_ext_assign_awb`.

### `POST /rapidshyp/get-label`
Fetch a shipping-label PDF. **Body:** `shipment_id` (required). Calls `…/get_label` with `{shipmentId}`; if the upstream is a PDF, streams `application/pdf` (`label_<id>.pdf`), else proxies the JSON. 400 if missing.

### `POST /rapidshyp/tracking-info`
Scan/tracking history. Body forwarded to `…/get_tracking_info`.

### `POST /rapidshyp/b2b-cancel`
Cancel a B2B shipment. Body forwarded to `…/b2b_ext_shipment_cancel`.

### `GET /rapidshyp/proxy-pdf`
**Auth:** `loginRequired` only (no shipping check). Same-origin proxy for a RapidShyp-hosted label PDF.
- **Query:** `url` (required) — **must** start with `https://storage.googleapis.com/rapidshyp-live/` (SSRF allowlist; 400 otherwise).
- **Returns:** streamed `application/pdf`.

---

## 13. Marketplace Sync (EasyEcom)

> **Auth:** every route uses `loginRequired` **plus** an in-handler check requiring master or the **`easyecom`** permission (403 otherwise). Sync/push routes also enforce a **monthly API-hit budget** (429 when exhausted). Credentials come from the seller profile (`easyecom_api_key`, `easyecom_jwt_token`).

### `GET /easyecom/status`
Integration status → `{ configured, auto_push, hits:{count,limit,remaining,ok}, pending:[{item_name,sku,adj}] }`. *(No external call.)*

### `POST /easyecom/sync`
Pull all stock quantities from EasyEcom into the local cache. **429** if the hit budget is exhausted. → `{ ok:true, … }`. Consumes API hits.

### `GET /easyecom/debug`
Raw first-page EasyEcom inventory response → `{ status, data }`. 400 if no JWT token. *(Bypasses the hit counter.)*

### `POST /easyecom/push`
Push all locally-pending stock deltas to EasyEcom. **429** if budget exhausted. → `{ ok:true, … }`. Clears pending on success.

### `POST /easyecom/reconcile`
Zero out all pending adjustments locally (after a manual EasyEcom update) → `{ ok:true, cleared }`. *(No external call.)*

---

## 14. Email

### `POST /email-invoice/:bill_no`
**Auth:** `requireAnyPermission('sale','purchase')`. **Rate limit:** `perMinute(10)`. Emails the invoice / credit note / debit note PDF to the client's email on the document.
- **Returns:** `{ message:'Email sent successfully!' }`. 404 (invoice) / 400 (no client email).

---

## 15. Cron & Ops

### `GET /health`
**Auth:** public. Uptime probe (point UptimeRobot or similar here). Returns `{ ok:true, ts }`. No DB call.

### `GET /send-daily-report`
**Auth:** **not session-based** — requires header `Authorization: Bearer <CRON_SECRET>` (403 on mismatch). No session/permission middleware.
- **Behavior:** only runs at the configured `REPORT_HOUR_UTC` (otherwise `{ status:'skipped', reason }`). For each user, generates the daily sales-report Excel and emails it to the tenant's profile email.
- **Returns:** `{ status:'success', log:[…] }`.

---

*Generated from the Express route definitions in `src/routes/*.js`. When adding or changing a route, update the corresponding section here.*