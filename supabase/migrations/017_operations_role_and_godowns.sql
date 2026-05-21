-- ═══════════════════════════════════════════════════════════════════════════
-- 017_operations_role_and_godowns.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Two related changes bundled together because they touch the same RLS / RPC
-- layer and we want a single round trip in the SQL Editor:
--
--   1. Merge the packing + dispatch roles into a single 'operations' role.
--      The legacy enum values ('packing', 'dispatch') stay on the type for
--      data integrity, but every existing user whose role is 'packing' or
--      'dispatch' is migrated to 'operations'. All packing/dispatch RPCs
--      accept 'operations' as a valid caller as well.
--
--   2. Introduce a `godowns` table + a nullable `users.godown_id` column.
--      Godowns are an *admin-side* organisation aid — they do NOT gate data
--      access for any role. What each user sees is unchanged; the admin
--      panel can filter the users list by godown for easier management.
--
-- HOW TO RUN
--   1. Run `017_pre_operations_enum.sql` first (one-liner — adds the
--      'operations' value to the user_role enum so the UPDATE below can
--      reference it). Postgres requires a separate transaction for that.
--   2. Then run THIS file. Paste-and-run in the Supabase SQL Editor.
--
-- Re-runnable: every CREATE/ALTER uses IF NOT EXISTS / CREATE OR REPLACE.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. godowns table + users.godown_id column
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.godowns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique among active godowns only — deactivated names can be reused later.
CREATE UNIQUE INDEX IF NOT EXISTS godowns_active_name_uidx
  ON public.godowns (lower(name)) WHERE is_active = true;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS godown_id UUID
    REFERENCES public.godowns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_godown_idx ON public.users (godown_id);

-- ─── 1a. RLS for godowns ──────────────────────────────────────────────────
ALTER TABLE public.godowns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "godowns select" ON public.godowns;
CREATE POLICY "godowns select" ON public.godowns
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "godowns insert" ON public.godowns;
CREATE POLICY "godowns insert" ON public.godowns
  FOR INSERT WITH CHECK (public.current_user_role() = 'owner');

DROP POLICY IF EXISTS "godowns update" ON public.godowns;
CREATE POLICY "godowns update" ON public.godowns
  FOR UPDATE USING (public.current_user_role() = 'owner');

DROP POLICY IF EXISTS "godowns delete" ON public.godowns;
CREATE POLICY "godowns delete" ON public.godowns
  FOR DELETE USING (FALSE);

-- ─── 1b. Lock down users.godown_id so non-owners can't self-reassign ──────
-- The original "users update" policy allowed self-update with role+is_active
-- pinned to their current values. godown_id needs the same protection —
-- otherwise any user could reassign their own godown via a direct PATCH and
-- bypass admin control.
DROP POLICY IF EXISTS "users update" ON public.users;
CREATE POLICY "users update" ON public.users
  FOR UPDATE USING (
    public.current_user_role() = 'owner'
    OR (auth.uid() = id AND public.is_active_user())
  )
  WITH CHECK (
    public.current_user_role() = 'owner'
    OR (
      auth.uid() = id
      AND role = (SELECT role FROM public.users WHERE id = auth.uid())
      AND is_active = (SELECT is_active FROM public.users WHERE id = auth.uid())
      AND godown_id IS NOT DISTINCT FROM (SELECT godown_id FROM public.users WHERE id = auth.uid())
    )
  );

-- ─── 1c. Realtime publication for godowns ─────────────────────────────────
-- The Admin screen subscribes to godowns so a godown created by one owner
-- appears live on every other owner's session.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'godowns'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.godowns';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Migrate packing+dispatch users to operations
-- ───────────────────────────────────────────────────────────────────────────
-- Pre-requisite: 017_pre_operations_enum.sql must have been run already,
-- otherwise this UPDATE fails with "unsafe use of new value 'operations'".
-- Their UI flips on next login. The old enum values stay on the type for
-- historical safety; they're just not assigned to any user anymore.

UPDATE public.users
SET role = 'operations'
WHERE role IN ('packing', 'dispatch');

-- ───────────────────────────────────────────────────────────────────────────
-- 3. RPCs updated to accept 'operations' (plus legacy 'packing'/'dispatch')
-- ───────────────────────────────────────────────────────────────────────────

-- ─── 3a. admin_create_user accepts 'operations' + optional godown ─────────
CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_username TEXT,
  p_password TEXT,
  p_name TEXT,
  p_role TEXT,
  p_godown_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  caller_role TEXT;
  new_uid UUID;
  new_email TEXT;
  encrypted_pw TEXT;
BEGIN
  SELECT u.role INTO caller_role FROM public.users u WHERE u.id = auth.uid();
  IF caller_role IS NULL OR caller_role != 'owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only owner can create users.');
  END IF;
  IF p_role NOT IN ('owner', 'salesperson', 'accounts', 'operations', 'dispatch', 'packing') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid role.');
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Password must be at least 6 characters.');
  END IF;
  IF p_username IS NULL OR length(trim(p_username)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Username is required.');
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Name is required.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE username = lower(p_username)) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Username is already taken.');
  END IF;
  IF p_godown_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.godowns WHERE id = p_godown_id AND is_active = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid or inactive godown.');
  END IF;

  new_email := lower(p_username) || '@salestracker.app';
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = new_email) THEN
    RETURN jsonb_build_object('success', false, 'message', 'An account with this username already exists.');
  END IF;

  new_uid := gen_random_uuid();
  encrypted_pw := crypt(p_password, gen_salt('bf'));

  INSERT INTO auth.users (
    instance_id, id, aud, role,
    email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', new_uid, 'authenticated', 'authenticated',
    new_email, encrypted_pw, NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    NOW(), NOW(),
    '', '', '', ''
  );
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), new_uid,
    jsonb_build_object('sub', new_uid::text, 'email', new_email),
    'email', new_uid::text,
    NOW(), NOW(), NOW()
  );
  INSERT INTO public.users (id, name, username, email, role, is_active, godown_id)
  VALUES (new_uid, trim(p_name), lower(p_username), new_email, p_role::user_role, true, p_godown_id);

  IF p_role = 'salesperson' THEN
    INSERT INTO public.salesperson_stats (user_id, name)
    VALUES (new_uid, trim(p_name));
  END IF;

  RETURN jsonb_build_object('success', true, 'uid', new_uid);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', 'Database error: ' || SQLERRM);
END;
$$;

-- ─── 3b. mark_packed accepts 'operations' (and still 'packing' for safety)
CREATE OR REPLACE FUNCTION public.mark_packed(query_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  caller_role TEXT;
  caller_name TEXT;
  q public.queries%ROWTYPE;
BEGIN
  SELECT role, name INTO caller_role, caller_name FROM public.users WHERE id = current_uid;
  IF caller_role NOT IN ('operations', 'packing', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only operations team or owner can mark packed.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.status != 'verified_pending_dispatch' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only verified queries can be packed.');
  END IF;
  IF q.is_packed THEN
    RETURN jsonb_build_object('success', false, 'message', 'Already packed.');
  END IF;

  UPDATE public.queries
  SET is_packed = true,
      packed_at = NOW(),
      packed_by_user_id = current_uid,
      packed_by_name = caller_name,
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 3c. undo_packed accepts 'operations' ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.undo_packed(query_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  caller_role TEXT;
  q public.queries%ROWTYPE;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = current_uid;
  IF caller_role NOT IN ('operations', 'packing', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only operations team or owner can undo.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF NOT q.is_packed THEN RETURN jsonb_build_object('success', false, 'message', 'Not packed yet.'); END IF;
  IF q.packed_at IS NULL OR (NOW() - q.packed_at) > interval '3 minutes' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Undo window expired (3 minutes).');
  END IF;
  IF caller_role != 'owner' AND q.packed_by_user_id != current_uid THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the person who packed it can undo.');
  END IF;

  UPDATE public.queries
  SET is_packed = false,
      packed_at = NULL,
      packed_by_user_id = NULL,
      packed_by_name = NULL,
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 3d. mark_dispatched accepts 'operations' ─────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_dispatched(query_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  caller_role TEXT;
  caller_name TEXT;
  q public.queries%ROWTYPE;
BEGIN
  SELECT role, name INTO caller_role, caller_name FROM public.users WHERE id = current_uid;
  IF caller_role NOT IN ('operations', 'dispatch', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only operations team or owner can mark dispatched.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.status != 'verified_pending_dispatch' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Query is not in a dispatchable state.');
  END IF;
  IF NOT q.is_packed THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot dispatch — packing not done yet.');
  END IF;

  UPDATE public.queries
  SET status = 'completed',
      dispatched_at = NOW(),
      dispatched_by_user_id = current_uid,
      dispatched_by_name = caller_name,
      dispatched_sets = COALESCE(q.cartoons, 0) + COALESCE(q.lots, 0),
      completed_at = NOW(),
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 3e. undo_dispatched accepts 'operations' ─────────────────────────────
CREATE OR REPLACE FUNCTION public.undo_dispatched(query_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  caller_role TEXT;
  q public.queries%ROWTYPE;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = current_uid;
  IF caller_role NOT IN ('operations', 'dispatch', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only operations team or owner can undo.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.status != 'completed' THEN RETURN jsonb_build_object('success', false, 'message', 'Not dispatched.'); END IF;
  IF q.dispatched_at IS NULL OR (NOW() - q.dispatched_at) > interval '3 minutes' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Undo window expired (3 minutes).');
  END IF;
  IF caller_role != 'owner' AND q.dispatched_by_user_id != current_uid THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the person who dispatched it can undo.');
  END IF;

  UPDATE public.queries
  SET status = 'verified_pending_dispatch',
      dispatched_at = NULL,
      dispatched_by_user_id = NULL,
      dispatched_by_name = NULL,
      dispatched_sets = 0,
      completed_at = NULL,
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 3f. notify_query_event picks up 'operations' for pack/dispatch nudges
CREATE OR REPLACE FUNCTION public.notify_query_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'open_query' THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'new_query', 'New query',
           NEW.customer_name || ' — query raised',
           NEW.id
    FROM public.users u
    WHERE u.role IN ('salesperson', 'owner')
      AND u.is_active = true
      AND (NEW.created_by_user_id IS NULL OR u.id != NEW.created_by_user_id);
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.status = 'pending_verification' THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'pending_verification', 'Invoice awaiting verification',
           NEW.customer_name || ' — Invoice ' || COALESCE(NEW.tally_invoice_number, '(none)'),
           NEW.id
    FROM public.users u WHERE u.role IN ('accounts', 'owner') AND u.is_active = true;
  END IF;

  -- verified_pending_dispatch goes to operations first (the packing leg).
  IF TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.status = 'verified_pending_dispatch' THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'ready_to_pack', 'Ready to pack',
           NEW.customer_name || ' — ' || COALESCE(NEW.cartoons, 0) || ' cartons, ' || COALESCE(NEW.lots, 0) || ' lots',
           NEW.id
    FROM public.users u WHERE u.role IN ('operations', 'packing', 'owner') AND u.is_active = true;
  END IF;

  -- When is_packed flips to true, the same operations team gets the dispatch nudge.
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.is_packed, false) = false
     AND COALESCE(NEW.is_packed, false) = true THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'ready_to_dispatch', 'Ready to dispatch',
           NEW.customer_name || ' — packed, awaiting dispatch',
           NEW.id
    FROM public.users u WHERE u.role IN ('operations', 'dispatch', 'owner') AND u.is_active = true;
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.status = 'won_pending_accounts' AND NEW.claimed_by_user_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    VALUES (NEW.claimed_by_user_id, 'booked', 'Booked — now with accounts',
            NEW.customer_name, NEW.id);
  END IF;

  IF TG_OP = 'UPDATE' AND COALESCE(OLD.invoice_attempt_count, 0) < 3
     AND COALESCE(NEW.invoice_attempt_count, 0) >= 3 THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'query_locked', '🔒 Query locked — your attention needed',
           NEW.customer_name || ' — 3 failed invoice attempts', NEW.id
    FROM public.users u WHERE u.role = 'owner' AND u.is_active = true;
  END IF;

  RETURN NEW;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Helper RPC: assign a godown to an existing user
-- ───────────────────────────────────────────────────────────────────────────
-- The Admin panel could write users.godown_id directly (RLS allows it for
-- owners), but a small RPC keeps the contract obvious and centralises
-- validation in case we add audit logging later.
CREATE OR REPLACE FUNCTION public.assign_user_godown(
  p_user_id UUID,
  p_godown_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller_role TEXT;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();
  IF caller_role IS NULL OR caller_role != 'owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only owner can assign godowns.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'User not found.');
  END IF;

  IF p_godown_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.godowns WHERE id = p_godown_id AND is_active = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid or inactive godown.');
  END IF;

  UPDATE public.users SET godown_id = p_godown_id WHERE id = p_user_id;
  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.assign_user_godown(UUID, UUID) TO authenticated;
