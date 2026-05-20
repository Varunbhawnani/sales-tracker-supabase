-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security (RLS) Policies
-- ═══════════════════════════════════════════════════════════════════════════
-- Postgres equivalent of the firestore.rules from the original project.
-- These policies enforce role-aware access at the database level.
--
-- Important: the service_role key bypasses RLS entirely, so tally-sync and
-- tally-bridge (which use the service role) operate unrestricted. The anon
-- key + an authenticated user session is what these policies apply to.

-- ─── Enable RLS on every table ─────────────────────────────────────────────
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salesperson_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- ─── Helper: get the caller's user row ─────────────────────────────────────
-- Caches a single SELECT per query, so subsequent role checks are free.
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS user_role
LANGUAGE sql STABLE
AS $$
  SELECT role FROM public.users WHERE id = auth.uid() AND is_active = TRUE
$$;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS(SELECT 1 FROM public.users WHERE id = auth.uid() AND is_active = TRUE)
$$;

-- ─── users table ──────────────────────────────────────────────────────────
-- Reads are open to any authenticated user (the app legitimately needs to
-- read other users' names and push tokens for notifications and UI badges).
-- Writes are restricted: only owners create new users; only self / owner
-- can update; nobody deletes.
DROP POLICY IF EXISTS "users select" ON public.users;
CREATE POLICY "users select" ON public.users
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "users insert" ON public.users;
CREATE POLICY "users insert" ON public.users
  FOR INSERT WITH CHECK (public.current_user_role() = 'owner');

DROP POLICY IF EXISTS "users update" ON public.users;
CREATE POLICY "users update" ON public.users
  FOR UPDATE USING (
    public.current_user_role() = 'owner'
    OR (auth.uid() = id AND public.is_active_user())
  )
  WITH CHECK (
    -- Owner can change anything. Non-owner self can update their doc
    -- but cannot escalate role or undo deactivation.
    public.current_user_role() = 'owner'
    OR (
      auth.uid() = id
      AND role = (SELECT role FROM public.users WHERE id = auth.uid())
      AND is_active = (SELECT is_active FROM public.users WHERE id = auth.uid())
    )
  );

-- ─── queries table ────────────────────────────────────────────────────────
-- The state machine itself is enforced inside the stored functions
-- (migration 003), so these RLS policies are the second line of defence —
-- a user trying to bypass the app and write directly to the table.
DROP POLICY IF EXISTS "queries select" ON public.queries;
CREATE POLICY "queries select" ON public.queries
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "queries insert" ON public.queries;
CREATE POLICY "queries insert" ON public.queries
  FOR INSERT WITH CHECK (
    public.is_active_user()
    AND public.current_user_role() IN ('salesperson', 'owner')
  );

DROP POLICY IF EXISTS "queries update" ON public.queries;
CREATE POLICY "queries update" ON public.queries
  FOR UPDATE USING (
    public.is_active_user() AND (
      public.current_user_role() = 'owner'
      -- Salesperson: claim an open query or act on their own claimed/snoozed
      OR (
        public.current_user_role() = 'salesperson'
        AND (
          status IN ('open_query', 'pending')
          OR (
            status IN ('claimed_by_sales', 'snoozed', 'claimed')
            AND claimed_by_user_id = auth.uid()
          )
        )
      )
      -- Accounts: invoice flow
      OR (
        public.current_user_role() = 'accounts'
        AND status IN ('won_pending_accounts', 'pending_verification', 'verification_failed')
      )
      -- Dispatch: shipment flow
      OR (
        public.current_user_role() = 'dispatch'
        AND status IN ('verified_pending_dispatch', 'partially_dispatched')
      )
    )
  );

-- No deletes — preserve audit trail.
DROP POLICY IF EXISTS "queries delete" ON public.queries;
CREATE POLICY "queries delete" ON public.queries FOR DELETE USING (FALSE);

-- ─── salesperson_stats ────────────────────────────────────────────────────
-- Read open. Writes: self, owner, or accounts (the latter needs to decrement
-- on cancel_verification_failed).
DROP POLICY IF EXISTS "stats select" ON public.salesperson_stats;
CREATE POLICY "stats select" ON public.salesperson_stats
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "stats insert" ON public.salesperson_stats;
CREATE POLICY "stats insert" ON public.salesperson_stats
  FOR INSERT WITH CHECK (
    public.current_user_role() = 'owner'
    OR (public.is_active_user() AND auth.uid() = user_id)
  );

DROP POLICY IF EXISTS "stats update" ON public.salesperson_stats;
CREATE POLICY "stats update" ON public.salesperson_stats
  FOR UPDATE USING (
    public.is_active_user() AND (
      public.current_user_role() IN ('owner', 'accounts')
      OR auth.uid() = user_id
    )
  );

-- ─── customers_master & products_master ───────────────────────────────────
-- App reads master data; the Tally sync script (using service_role) writes it.
-- Client writes are forbidden.
DROP POLICY IF EXISTS "customers select" ON public.customers_master;
CREATE POLICY "customers select" ON public.customers_master
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "products select" ON public.products_master;
CREATE POLICY "products select" ON public.products_master
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ─── settings ─────────────────────────────────────────────────────────────
-- Read open, write owner-only.
DROP POLICY IF EXISTS "settings select" ON public.settings;
CREATE POLICY "settings select" ON public.settings
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "settings update" ON public.settings;
CREATE POLICY "settings update" ON public.settings
  FOR UPDATE USING (public.current_user_role() = 'owner');
