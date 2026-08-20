-- ============================================================================
-- Sahayak ERP — Migration 002: server-side sessions, atomic doc counters,
--                              indexed document columns
-- Run this in the Supabase SQL Editor BEFORE deploying the matching app code.
-- (The app degrades gracefully if this hasn't run yet — sessions will fail
--  loudly, counters/columns fall back to the legacy full-scan path — but the
--  security and performance wins only exist once this is applied.)
-- ============================================================================

-- ── 1. Server-side session store ─────────────────────────────────────────────
-- Replaces the client-side signed cookie session. Sessions become revocable:
-- deactivating a user / resetting a password kills their live sessions.
CREATE TABLE IF NOT EXISTS public.http_sessions (
  sid     text PRIMARY KEY,
  sess    jsonb NOT NULL,
  expire  timestamptz NOT NULL,
  user_id text
);
CREATE INDEX IF NOT EXISTS http_sessions_expire_idx ON public.http_sessions (expire);
CREATE INDEX IF NOT EXISTS http_sessions_user_idx   ON public.http_sessions (user_id);
-- Deny-all RLS (service_role bypasses; anon key gets nothing)
ALTER TABLE public.http_sessions ENABLE ROW LEVEL SECURITY;

-- ── 2. Atomic document-number counters ───────────────────────────────────────
-- Replaces "load every document and count" numbering with a single atomic
-- upsert. p_seed is used only to initialise a missing counter row from the
-- legacy count; concurrent first calls are race-safe via ON CONFLICT.
CREATE TABLE IF NOT EXISTS public.doc_counters (
  tenant_id text NOT NULL,
  series    text NOT NULL,   -- e.g. 'sale_invoice', 'sale_cn', 'purchase_po'
  fy        text NOT NULL,   -- e.g. '2026-27'
  last_seq  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, series, fy)
);
ALTER TABLE public.doc_counters ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.next_doc_seq(
  p_tenant text, p_series text, p_fy text, p_seed integer DEFAULT 0
) RETURNS integer
LANGUAGE sql AS $$
  INSERT INTO public.doc_counters (tenant_id, series, fy, last_seq)
  VALUES (p_tenant, p_series, p_fy, GREATEST(p_seed, 0) + 1)
  ON CONFLICT (tenant_id, series, fy)
  DO UPDATE SET last_seq = GREATEST(doc_counters.last_seq, GREATEST(EXCLUDED.last_seq - 1, 0)) + 1
  RETURNING last_seq;
$$;
-- Only the server (service_role) may call it
REVOKE EXECUTE ON FUNCTION public.next_doc_seq(text, text, text, integer)
  FROM anon, authenticated;

-- ── 3. Indexed real columns on documents ─────────────────────────────────────
-- Promotes hot fields out of the JSONB blob so lists/filters/aggregates can
-- run in the database instead of loading every document into Node.
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS doc_date    date,
  ADD COLUMN IF NOT EXISTS grand_total numeric,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS status      text,
  ADD COLUMN IF NOT EXISTS doc_type    text;

-- Safe parser for the app's stored date formats ('05-Aug-2025', ISO, '05-08-2025')
CREATE OR REPLACE FUNCTION public.safe_parse_invoice_date(s text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF s IS NULL OR s = '' THEN RETURN NULL; END IF;
  BEGIN RETURN to_date(s, 'DD-Mon-YYYY'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN RETURN to_date(s, 'YYYY-MM-DD');  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN RETURN to_date(s, 'DD-MM-YYYY');  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN NULL;
END $$;

-- One-time backfill from JSONB (idempotent — only touches unfilled rows)
UPDATE public.documents SET
  doc_date    = public.safe_parse_invoice_date(data->>'invoice_date'),
  grand_total = CASE WHEN data->>'grand_total' ~ '^-?[0-9]+(\.[0-9]+)?$'
                     THEN (data->>'grand_total')::numeric ELSE NULL END,
  client_name = NULLIF(data->>'client_name', ''),
  status      = NULLIF(data->>'status', ''),
  doc_type    = COALESCE(NULLIF(data->>'doc_type', ''), 'invoice')
WHERE doc_date IS NULL AND doc_type IS NULL;

CREATE INDEX IF NOT EXISTS documents_tenant_date_idx
  ON public.documents (tenant_id, doc_date);
CREATE INDEX IF NOT EXISTS documents_tenant_coll_idx
  ON public.documents (tenant_id, collection_name);
CREATE INDEX IF NOT EXISTS documents_tenant_status_idx
  ON public.documents (tenant_id, status);
