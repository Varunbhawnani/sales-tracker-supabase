-- ═══════════════════════════════════════════════════════════════════════════
-- 005_admin_create_user.sql — bypass Supabase's email-signup flow entirely
-- ═══════════════════════════════════════════════════════════════════════════
-- The Admin panel used to call supabase.auth.signUp() to create new users,
-- which depended on the dashboard's "Allow signups" + "Confirm email" toggles
-- and hit Supabase's free-tier email rate limit (3/hour).
--
-- This stored function bypasses all of that — it writes directly into the
-- auth.users + auth.identities tables using the encrypted_password format
-- Supabase Auth expects, then inserts the matching public.users row in the
-- same transaction. No emails sent, no toggles required, no rate limits.
--
-- Security:
--   - SECURITY DEFINER runs as the function owner (postgres), giving it
--     access to the auth schema that anon/authenticated normally can't touch.
--   - The first thing it does is verify auth.uid() belongs to a row in
--     public.users with role='owner'. Non-owners get rejected.
--   - The whole operation is atomic — either everything commits or nothing
--     does, so you can't end up with an auth user and no public.users row.

CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_username TEXT,
  p_password TEXT,
  p_name TEXT,
  p_role TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  caller_role TEXT;
  new_uid UUID;
  new_email TEXT;
  encrypted_pw TEXT;
BEGIN
  -- Caller must be a logged-in owner
  SELECT u.role INTO caller_role FROM public.users u WHERE u.id = auth.uid();
  IF caller_role IS NULL OR caller_role != 'owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only owner can create users.');
  END IF;

  -- Validate role
  IF p_role NOT IN ('owner', 'salesperson', 'accounts', 'dispatch') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid role.');
  END IF;

  -- Validate inputs
  IF p_password IS NULL OR length(p_password) < 6 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Password must be at least 6 characters.');
  END IF;
  IF p_username IS NULL OR length(trim(p_username)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Username is required.');
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Name is required.');
  END IF;

  -- Username uniqueness in our app
  IF EXISTS (SELECT 1 FROM public.users WHERE username = lower(p_username)) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Username is already taken.');
  END IF;

  new_email := lower(p_username) || '@salestracker.app';

  -- Email uniqueness in Supabase auth (defensive — should be covered by username check)
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = new_email) THEN
    RETURN jsonb_build_object('success', false, 'message', 'An account with this username already exists.');
  END IF;

  new_uid := gen_random_uuid();
  encrypted_pw := crypt(p_password, gen_salt('bf'));

  -- Insert into auth.users with pre-confirmed email so the user can log in immediately
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

  -- Companion auth.identities row (Supabase needs this for the email-provider login flow)
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), new_uid,
    jsonb_build_object('sub', new_uid::text, 'email', new_email),
    'email', new_uid::text,
    NOW(), NOW(), NOW()
  );

  -- App-side profile row (cast TEXT → user_role enum)
  INSERT INTO public.users (id, name, username, email, role, is_active)
  VALUES (new_uid, trim(p_name), lower(p_username), new_email, p_role::user_role, true);

  -- Stats row for salespersons
  IF p_role = 'salesperson' THEN
    INSERT INTO public.salesperson_stats (user_id, name, total_claimed, total_successful, total_unsuccessful, total_sets_sold)
    VALUES (new_uid, trim(p_name), 0, 0, 0, 0);
  END IF;

  RETURN jsonb_build_object('success', true, 'uid', new_uid);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', 'Database error: ' || SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.admin_create_user IS
  'Owner-only RPC to create a new user (auth + profile + stats) without going through Supabase signup or sending emails.';
