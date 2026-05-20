-- ═══════════════════════════════════════════════════════════════════════════
-- 006_invoice_attempt_lock.sql — limit accounts to 5 invoice attempts per query
-- ═══════════════════════════════════════════════════════════════════════════
-- Behaviour:
--   • Each time the bridge marks a query 'verification_failed', the counter
--     bumps up by 1.
--   • submit_invoice_number() refuses to accept another attempt once the
--     counter hits 5 — the query is "locked" and must be unlocked by an owner.
--   • flag_back_to_sales() resets the counter to 0 (since the query goes
--     back to sales for correction; accounts gets fresh attempts when it
--     returns).
--   • Owner can reset the counter directly via admin_reset_invoice_attempts()
--     without bouncing the query back to sales.

ALTER TABLE public.queries
  ADD COLUMN IF NOT EXISTS invoice_attempt_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.queries.invoice_attempt_count IS
  'Number of failed invoice-verification attempts for this query. Locked at 5.';

-- ─── Replace submit_invoice_number with the 5-attempt guard ───
CREATE OR REPLACE FUNCTION public.submit_invoice_number(
  query_id UUID,
  invoice TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF NOT is_valid_transition(q.status, 'pending_verification') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot submit invoice from current status.');
  END IF;
  IF COALESCE(q.invoice_attempt_count, 0) >= 5 THEN
    RETURN jsonb_build_object('success', false,
      'message', 'This query is locked after 5 failed invoice attempts. Escalate to the owner to unlock.');
  END IF;

  UPDATE public.queries
  SET status = 'pending_verification',
      tally_invoice_number = TRIM(invoice),
      verification_error = NULL,
      verification_note = NULL,
      verification_timestamp = NOW(),
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── Replace flag_back_to_sales to also reset the counter ───
CREATE OR REPLACE FUNCTION public.flag_back_to_sales(
  query_id UUID,
  note TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF NOT is_valid_transition(q.status, 'won_pending_accounts') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot flag back from current status.');
  END IF;

  UPDATE public.queries
  SET status = 'won_pending_accounts',
      verification_note = COALESCE(note, 'Flagged back by accounts team'),
      tally_invoice_number = NULL,
      verification_error = NULL,
      invoice_attempt_count = 0,
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── Owner-only reset of the attempt counter (without flagging back) ───
CREATE OR REPLACE FUNCTION public.admin_reset_invoice_attempts(query_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_role TEXT;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();
  IF caller_role IS NULL OR caller_role != 'owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only owner can reset invoice attempts.');
  END IF;

  UPDATE public.queries
  SET invoice_attempt_count = 0,
      verification_error = NULL,
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reset_invoice_attempts(UUID) TO authenticated;
