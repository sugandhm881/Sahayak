-- ============================================================================
-- Sahayak ERP — RLS backstop (Step 3)
-- Run this in the Supabase SQL Editor for the ERP project.
--
-- WHAT THIS DOES
--   Enables Row-Level Security on every public table that has a `tenant_id`
--   column, with NO policies — which means the anon / authenticated Supabase
--   roles are denied all access to tenant data. Only the service_role key
--   (used by the Express server) can read/write, because it has BYPASSRLS.
--
-- WHY IT IS SAFE TO APPLY NOW
--   The app talks to Supabase exclusively through the Express server using the
--   service_role key, which bypasses RLS — so enabling RLS does NOT change how
--   the app behaves. It only slams the door on the anon/publishable key, so if
--   that key ever leaks it cannot be used to read another tenant's invoices.
--
--   ⚠ BEFORE RUNNING: confirm nothing in your frontend calls Supabase directly
--   with the anon/publishable key (this codebase does not — it goes through
--   /api routes). If you later add a client-direct feature, you must add
--   per-tenant policies for it, or it will be denied.
--
-- WHAT THIS DOES *NOT* DO  (important — read this)
--   Because the app uses the service_role key, this RLS does NOT protect
--   against a bug in the application code (a query that forgets its
--   `.eq('tenant_id', ...)` filter) — service_role bypasses RLS. To make RLS a
--   real backstop against app-layer mistakes you need "Level 2" below.
-- ============================================================================

-- Level 1 — enable RLS (deny-all for anon/authenticated). Safe, reversible.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
    GROUP BY table_name
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    RAISE NOTICE 'RLS enabled on public.%', t;
  END LOOP;
END $$;

-- To roll back (re-open to anon — not recommended):
--   Replace ENABLE with DISABLE in the loop above and re-run.

-- ============================================================================
-- Level 2 (bigger project, NOT in this file) — make RLS protect against
-- app-code bugs too:
--   1. Stop using the service_role key for tenant reads/writes in the Express
--      app. Instead, per request, set a tenant claim (e.g. a signed JWT or
--      `SET LOCAL request.tenant_id = '<id>'`) and use a NON-bypass role.
--   2. Add policies like:
--        CREATE POLICY tenant_isolation ON public.documents
--          USING (tenant_id = current_setting('request.tenant_id', true));
--   3. Then a forgotten filter in app code fails closed instead of leaking.
-- This is a meaningful refactor and should be planned separately.
-- ============================================================================