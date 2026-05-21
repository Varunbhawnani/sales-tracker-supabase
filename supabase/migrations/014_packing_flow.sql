-- ═══════════════════════════════════════════════════════════════════════════
-- 014_packing_flow.sql — packing role + packing toggle + simplified dispatch.
-- ═══════════════════════════════════════════════════════════════════════════
-- After accounts verifies, a query goes to the Packing team. Once packed,
-- it goes to the Dispatch team. Each step is a SINGLE TOGGLE, no quantity-
-- per-shipment tracking. Both toggles have a 3-minute undo window before
-- they lock.
--
-- The status enum is unchanged. Instead, an `is_packed` boolean indicates
-- whether the packing step is done. The flow is:
--
--   verified_pending_dispatch + is_packed=false → Packing portal sees it
--   verified_pending_dispatch + is_packed=true  → Dispatch portal sees it
--   completed                                    → done
--
-- partially_dispatched is no longer used by the new code path; we keep it
-- only so existing rows still display correctly.

-- ─── 1. New role ──────────────────────────────────────────────────────────
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'packing';

-- ─── 2. Packing + dispatch toggle columns ─────────────────────────────────
ALTER TABLE public.queries
  ADD COLUMN IF NOT EXISTS is_packed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS packed_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS packed_by_name TEXT,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS dispatched_by_name TEXT;

-- ─── 3. Allow admin_create_user to create a packing user ──────────────────
CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_username TEXT,
  p_password TEXT,
  p_name TEXT,
  p_role TEXT
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
  IF p_role NOT IN ('owner', 'salesperson', 'accounts', 'dispatch', 'packing') THEN
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
  INSERT INTO public.users (id, name, username, email, role, is_active)
  VALUES (new_uid, trim(p_name), lower(p_username), new_email, p_role::user_role, true);

  IF p_role = 'salesperson' THEN
    INSERT INTO public.salesperson_stats (user_id, name)
    VALUES (new_uid, trim(p_name));
  END IF;

  RETURN jsonb_build_object('success', true, 'uid', new_uid);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', 'Database error: ' || SQLERRM);
END;
$$;

-- ─── 4. mark_packed: packing team marks a verified query as packed ────────
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
  IF caller_role NOT IN ('packing', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only packing team or owner can mark packed.');
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
GRANT EXECUTE ON FUNCTION public.mark_packed(UUID) TO authenticated;

-- ─── 5. undo_packed: reverse within 3 minutes ─────────────────────────────
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
  IF caller_role NOT IN ('packing', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only packing team or owner can undo.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF NOT q.is_packed THEN RETURN jsonb_build_object('success', false, 'message', 'Not packed yet.'); END IF;
  IF q.packed_at IS NULL OR (NOW() - q.packed_at) > interval '3 minutes' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Undo window expired (3 minutes).');
  END IF;
  -- And only the person who packed it can undo (or the owner)
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
GRANT EXECUTE ON FUNCTION public.undo_packed(UUID) TO authenticated;

-- ─── 6. mark_dispatched: dispatch team marks packed query as dispatched ──
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
  IF caller_role NOT IN ('dispatch', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only dispatch team or owner can mark dispatched.');
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
      dispatched_sets = COALESCE(q.cartoons, 0) + COALESCE(q.lots, 0),  -- legacy mirror
      completed_at = NOW(),
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_dispatched(UUID) TO authenticated;

-- ─── 7. undo_dispatched: reverse within 3 minutes ─────────────────────────
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
  IF caller_role NOT IN ('dispatch', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only dispatch team or owner can undo.');
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
GRANT EXECUTE ON FUNCTION public.undo_dispatched(UUID) TO authenticated;

-- ─── 8. Update notify_query_event for the packing notification ────────────
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

  -- verified_pending_dispatch now goes to PACKING first
  IF TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.status = 'verified_pending_dispatch' THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'ready_to_pack', 'Ready to pack',
           NEW.customer_name || ' — ' || COALESCE(NEW.cartoons, 0) || ' cartons, ' || COALESCE(NEW.lots, 0) || ' lots',
           NEW.id
    FROM public.users u WHERE u.role IN ('packing', 'owner') AND u.is_active = true;
  END IF;

  -- When packing is_packed turns true, notify dispatch
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.is_packed, false) = false
     AND COALESCE(NEW.is_packed, false) = true THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'ready_to_dispatch', 'Ready to dispatch',
           NEW.customer_name || ' — packed, awaiting dispatch',
           NEW.id
    FROM public.users u WHERE u.role IN ('dispatch', 'owner') AND u.is_active = true;
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
