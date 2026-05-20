-- ═══════════════════════════════════════════════════════════════════════════
-- Sales Tracker — Initial Schema
-- ═══════════════════════════════════════════════════════════════════════════
-- Run this in Supabase SQL Editor. Creates all tables, indexes, and enums.
-- Re-runnable: every CREATE uses "IF NOT EXISTS" so you can safely re-run.

-- ─── Enums (status, role) ──────────────────────────────────────────────────
-- Encode the state machine as a Postgres enum so invalid values are rejected
-- at the database level, not just in app code.
DO $$ BEGIN
  CREATE TYPE query_status AS ENUM (
    'open_query',
    'claimed_by_sales',
    'snoozed',
    'won_pending_accounts',
    'pending_verification',
    'verification_failed',
    'verified_pending_dispatch',
    'partially_dispatched',
    'completed',
    'lost_cancelled',
    -- Legacy values from the original Firebase project (kept for migrated data)
    'pending',
    'claimed',
    'successful',
    'unsuccessful'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('owner', 'salesperson', 'accounts', 'dispatch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── users ─────────────────────────────────────────────────────────────────
-- Mirrors auth.users with the app's per-user metadata. The id column
-- references auth.users(id) so creating an auth user and inserting here
-- are two separate steps (intentional — the app's authService.createUser
-- handles both atomically).
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  role user_role NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  expo_push_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_role_idx ON public.users(role);
CREATE INDEX IF NOT EXISTS users_active_idx ON public.users(is_active) WHERE is_active = TRUE;

-- ─── customers_master ──────────────────────────────────────────────────────
-- Synced from Tally by tally-sync.js. The id is Tally's GUID; we use it as
-- the primary key so re-syncing the same customer upserts cleanly.
CREATE TABLE IF NOT EXISTS public.customers_master (
  id TEXT PRIMARY KEY,                        -- Tally GUID
  name TEXT NOT NULL,
  guid TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'D',         -- A / B / C / D party grade
  price_level TEXT NOT NULL DEFAULT 'Standard',
  parent_group TEXT,
  tally_alter_id BIGINT,                      -- For delta-sync vs Tally's watermark
  last_synced TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The delta-sync watermark on the client side queries by last_synced.
-- A descending index makes "give me everything synced after X" cheap.
CREATE INDEX IF NOT EXISTS customers_last_synced_idx
  ON public.customers_master(last_synced DESC);
CREATE INDEX IF NOT EXISTS customers_name_idx ON public.customers_master(name);

-- ─── products_master ───────────────────────────────────────────────────────
-- Same model as customers_master. price_tiers is JSONB so the shape (OS,
-- OS1, FO, ...) can vary per company without schema changes.
CREATE TABLE IF NOT EXISTS public.products_master (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  guid TEXT NOT NULL,
  tally_alter_id BIGINT,
  unit_type TEXT NOT NULL DEFAULT 'PRS',
  price NUMERIC NOT NULL DEFAULT 0,
  price_tiers JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS products_last_synced_idx
  ON public.products_master(last_synced DESC);
CREATE INDEX IF NOT EXISTS products_name_idx ON public.products_master(name);

-- ─── queries ───────────────────────────────────────────────────────────────
-- The heart of the application. Every sales query goes through the 10-state
-- workflow. JSONB is used for the flexible bits (items, snooze_history,
-- dispatch_history, gamification) so we don't need 3+ extra tables.
CREATE TABLE IF NOT EXISTS public.queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Denormalized customer info (snapshot at query creation; the master record
  -- can change later but we keep this for audit purposes)
  customer_master_id TEXT REFERENCES public.customers_master(id),
  customer_name TEXT NOT NULL,
  customer_category TEXT,

  -- Line items: [{ product_id, product_name, quantity, unit_price, total_price }]
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_sets INTEGER NOT NULL CHECK (required_sets >= 0),
  projected_revenue NUMERIC DEFAULT 0,
  notes TEXT DEFAULT '',

  status query_status NOT NULL DEFAULT 'open_query',

  -- Created-by snapshot (Firestore-style — useful for audit, even after user changes)
  created_by_user_id UUID REFERENCES public.users(id),
  created_by_name TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bumped on every state change. Used by the leaderboard's time-filtered queries.
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Sales-side fields
  claimed_by_user_id UUID REFERENCES public.users(id),
  claimed_by_name TEXT,
  claimed_at TIMESTAMPTZ,

  snoozed_at TIMESTAMPTZ,
  follow_up_date DATE,
  snooze_history JSONB NOT NULL DEFAULT '[]'::jsonb,

  won_at TIMESTAMPTZ,

  -- Accounts-side fields
  tally_invoice_number TEXT,
  verification_timestamp TIMESTAMPTZ,
  verification_error TEXT,
  verification_note TEXT,
  -- For the Tally-bridge auth-failure retry logic
  auth_failure_count INTEGER NOT NULL DEFAULT 0,
  last_auth_failure_at TIMESTAMPTZ,

  -- Dispatch-side fields
  dispatched_sets INTEGER NOT NULL DEFAULT 0 CHECK (dispatched_sets >= 0),
  dispatch_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed_at TIMESTAMPTZ,

  -- Close fields (used by lost_cancelled and the legacy markUnsuccessful)
  closed_at TIMESTAMPTZ,
  failure_reason TEXT,

  -- Gamification: { total_snooze_ms, time_to_win_ms }
  gamification JSONB NOT NULL DEFAULT '{"total_snooze_ms": 0, "time_to_win_ms": null}'::jsonb,

  -- Server-side state machine invariants — block obviously wrong states.
  CONSTRAINT dispatched_within_required CHECK (dispatched_sets <= required_sets OR required_sets = 0)
);

-- Indexes optimised for the dashboard queries the app actually issues.
CREATE INDEX IF NOT EXISTS queries_status_idx ON public.queries(status);
CREATE INDEX IF NOT EXISTS queries_last_activity_idx ON public.queries(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS queries_claimed_by_idx ON public.queries(claimed_by_user_id);
CREATE INDEX IF NOT EXISTS queries_customer_idx ON public.queries(customer_master_id);
CREATE INDEX IF NOT EXISTS queries_created_at_idx ON public.queries(created_at DESC);

-- ─── salesperson_stats ────────────────────────────────────────────────────
-- Cached per-salesperson counters. Kept in sync by the stored functions in
-- migration 003 (mark_won, cancel_verification_failed, etc).
CREATE TABLE IF NOT EXISTS public.salesperson_stats (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  total_claimed INTEGER NOT NULL DEFAULT 0 CHECK (total_claimed >= 0),
  total_successful INTEGER NOT NULL DEFAULT 0 CHECK (total_successful >= 0),
  total_unsuccessful INTEGER NOT NULL DEFAULT 0 CHECK (total_unsuccessful >= 0),
  total_sets_sold INTEGER NOT NULL DEFAULT 0 CHECK (total_sets_sold >= 0)
);

CREATE INDEX IF NOT EXISTS stats_sets_sold_idx
  ON public.salesperson_stats(total_sets_sold DESC);

-- ─── settings (single row) ────────────────────────────────────────────────
-- App-wide configuration. Keyed by 'app' so there's only ever one row.
CREATE TABLE IF NOT EXISTS public.settings (
  id TEXT PRIMARY KEY,
  gone_quiet_threshold_days INTEGER NOT NULL DEFAULT 30,
  sla_escalation_days INTEGER NOT NULL DEFAULT 10,
  sla_accounts_days INTEGER NOT NULL DEFAULT 3,
  sla_dispatch_days INTEGER NOT NULL DEFAULT 7
);

-- Seed the default row.
INSERT INTO public.settings (id) VALUES ('app') ON CONFLICT (id) DO NOTHING;

-- ─── Trigger: auto-update last_synced on master tables ─────────────────────
-- When tally-sync upserts a master record, last_synced should always reflect
-- the actual write time. The script sets it explicitly, but the trigger is a
-- safety net.
CREATE OR REPLACE FUNCTION public.set_last_synced()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_synced = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_last_synced_trigger ON public.customers_master;
CREATE TRIGGER customers_last_synced_trigger
  BEFORE UPDATE ON public.customers_master
  FOR EACH ROW EXECUTE FUNCTION public.set_last_synced();

DROP TRIGGER IF EXISTS products_last_synced_trigger ON public.products_master;
CREATE TRIGGER products_last_synced_trigger
  BEFORE UPDATE ON public.products_master
  FOR EACH ROW EXECUTE FUNCTION public.set_last_synced();
