-- ═══════════════════════════════════════════════════════════════════════════
-- 010_admin_can_claim.sql — allow the owner/admin to claim open queries too
-- ═══════════════════════════════════════════════════════════════════════════
-- Previously claim_query only allowed role='salesperson'. Many small teams
-- have the owner directly working leads alongside the sales team, so this
-- broadens the allowed roles to {salesperson, owner}. All other security
-- checks (active user, valid transition) are unchanged.

CREATE OR REPLACE FUNCTION public.claim_query(query_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  user_record public.users%ROWTYPE;
  updated_count INTEGER;
BEGIN
  SELECT * INTO user_record FROM public.users WHERE id = current_uid;
  IF NOT FOUND OR NOT user_record.is_active THEN
    RETURN jsonb_build_object('success', false, 'message', 'Account not active.');
  END IF;
  IF user_record.role NOT IN ('salesperson', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only salesperson or owner can claim queries.');
  END IF;

  UPDATE public.queries
  SET status = 'claimed_by_sales',
      claimed_by_user_id = current_uid,
      claimed_by_name = user_record.name,
      claimed_at = NOW(),
      last_activity_at = NOW()
  WHERE id = query_id AND status = 'open_query';
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  IF updated_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'This query was already claimed.');
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;
