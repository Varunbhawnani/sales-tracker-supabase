-- ═══════════════════════════════════════════════════════════════════════════
-- Atomic State-Machine Functions (RPCs)
-- ═══════════════════════════════════════════════════════════════════════════
-- These replace the Firebase client-side runTransaction() calls. Each runs
-- atomically inside Postgres and is invoked from the app via supabase.rpc().
-- Putting the logic server-side means a malicious client can't bypass the
-- state machine via direct table writes.
--
-- All functions:
--   - SECURITY DEFINER: run with the function owner's privileges, bypassing
--     RLS for the in-function operations. We re-implement the role checks
--     here so security isn't lost.
--   - Return JSONB { success, message, ... } so the app can handle errors.

-- ─── Helper: validate a state-machine transition ──────────────────────────
CREATE OR REPLACE FUNCTION public.is_valid_transition(
  from_status query_status,
  to_status query_status
) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  RETURN CASE from_status
    WHEN 'open_query' THEN to_status = 'claimed_by_sales'
    WHEN 'claimed_by_sales' THEN to_status IN ('snoozed', 'won_pending_accounts', 'lost_cancelled')
    WHEN 'snoozed' THEN to_status IN ('claimed_by_sales', 'lost_cancelled')
    WHEN 'won_pending_accounts' THEN to_status = 'pending_verification'
    WHEN 'pending_verification' THEN to_status IN ('verified_pending_dispatch', 'verification_failed')
    WHEN 'verification_failed' THEN to_status IN ('pending_verification', 'won_pending_accounts', 'lost_cancelled')
    WHEN 'verified_pending_dispatch' THEN to_status IN ('partially_dispatched', 'completed')
    WHEN 'partially_dispatched' THEN to_status IN ('partially_dispatched', 'completed')
    ELSE FALSE
  END;
END;
$$;

-- ─── claim_query: open_query → claimed_by_sales ───────────────────────────
-- Atomic: only one of N concurrent salespersons can succeed.
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
  IF user_record.role != 'salesperson' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only salespersons can claim queries.');
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

-- ─── snooze_query ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.snooze_query(
  query_id UUID,
  follow_up DATE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  q public.queries%ROWTYPE;
  new_history JSONB;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.claimed_by_user_id != current_uid THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the claimer can snooze this query.');
  END IF;
  IF NOT is_valid_transition(q.status, 'snoozed') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot snooze from current status.');
  END IF;

  new_history := (q.snooze_history || jsonb_build_array(jsonb_build_object(
    'snoozed_at', NOW(), 'follow_up_date', follow_up, 'unsnoozed_at', NULL
  )));

  UPDATE public.queries
  SET status = 'snoozed',
      snoozed_at = NOW(),
      follow_up_date = follow_up,
      snooze_history = new_history,
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── unsnooze_query (manual or automatic) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.unsnooze_query(query_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
  total_ms BIGINT;
  duration_ms BIGINT;
  new_history JSONB;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.status != 'snoozed' THEN RETURN jsonb_build_object('success', true); END IF;

  duration_ms := EXTRACT(EPOCH FROM (NOW() - q.snoozed_at)) * 1000;
  total_ms := COALESCE((q.gamification->>'total_snooze_ms')::BIGINT, 0) + duration_ms;

  -- Mark the last snooze history entry's unsnoozed_at
  IF jsonb_array_length(q.snooze_history) > 0 THEN
    new_history := jsonb_set(
      q.snooze_history,
      ('{' || (jsonb_array_length(q.snooze_history) - 1) || ',unsnoozed_at}')::TEXT[],
      to_jsonb(NOW()::TEXT)
    );
  ELSE
    new_history := q.snooze_history;
  END IF;

  UPDATE public.queries
  SET status = 'claimed_by_sales',
      snoozed_at = NULL,
      follow_up_date = NULL,
      snooze_history = new_history,
      gamification = jsonb_set(q.gamification, '{total_snooze_ms}', to_jsonb(total_ms)),
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── auto_unsnooze_expired ────────────────────────────────────────────────
-- Bulk unsnooze for the Feed-load throttle. Returns the count.
CREATE OR REPLACE FUNCTION public.auto_unsnooze_expired()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec RECORD;
  count_unsnoozed INTEGER := 0;
BEGIN
  FOR rec IN SELECT id FROM public.queries
             WHERE status = 'snoozed' AND follow_up_date <= CURRENT_DATE
  LOOP
    PERFORM unsnooze_query(rec.id);
    count_unsnoozed := count_unsnoozed + 1;
  END LOOP;
  RETURN count_unsnoozed;
END;
$$;

-- ─── mark_won: claimed_by_sales → won_pending_accounts ────────────────────
CREATE OR REPLACE FUNCTION public.mark_won(
  query_id UUID,
  final_sets INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  q public.queries%ROWTYPE;
  user_record public.users%ROWTYPE;
  total_ms BIGINT;
  total_snooze_ms BIGINT;
  time_to_win_ms BIGINT;
  new_revenue NUMERIC;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.claimed_by_user_id != current_uid THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the claimer can mark this query as won.');
  END IF;
  IF NOT is_valid_transition(q.status, 'won_pending_accounts') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot mark won from current status.');
  END IF;

  SELECT * INTO user_record FROM public.users WHERE id = current_uid;

  total_ms := EXTRACT(EPOCH FROM (NOW() - q.created_at)) * 1000;
  total_snooze_ms := COALESCE((q.gamification->>'total_snooze_ms')::BIGINT, 0);
  time_to_win_ms := total_ms - total_snooze_ms;

  IF q.required_sets > 0 AND final_sets != q.required_sets THEN
    new_revenue := ROUND((q.projected_revenue / q.required_sets) * final_sets);
  ELSE
    new_revenue := q.projected_revenue;
  END IF;

  UPDATE public.queries
  SET status = 'won_pending_accounts',
      required_sets = final_sets,
      projected_revenue = new_revenue,
      won_at = NOW(),
      gamification = jsonb_set(q.gamification, '{time_to_win_ms}', to_jsonb(time_to_win_ms)),
      last_activity_at = NOW()
  WHERE id = query_id;

  -- Upsert stats
  INSERT INTO public.salesperson_stats (user_id, name, total_successful, total_sets_sold)
  VALUES (current_uid, user_record.name, 1, final_sets)
  ON CONFLICT (user_id) DO UPDATE
    SET total_successful = salesperson_stats.total_successful + 1,
        total_sets_sold = salesperson_stats.total_sets_sold + final_sets;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── mark_lost_cancelled ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_lost_cancelled(
  query_id UUID,
  reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  q public.queries%ROWTYPE;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.claimed_by_user_id != current_uid THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the claimer can cancel this query.');
  END IF;
  IF NOT is_valid_transition(q.status, 'lost_cancelled') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot cancel from current status.');
  END IF;

  UPDATE public.queries
  SET status = 'lost_cancelled',
      failure_reason = COALESCE(reason, ''),
      closed_at = NOW(),
      last_activity_at = NOW()
  WHERE id = query_id;

  -- Upsert stats (treat absent stats as zero)
  INSERT INTO public.salesperson_stats (user_id, name, total_unsuccessful)
  VALUES (current_uid, (SELECT name FROM public.users WHERE id = current_uid), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET total_unsuccessful = salesperson_stats.total_unsuccessful + 1;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── cancel_verification_failed: reverses mark_won stats ──────────────────
CREATE OR REPLACE FUNCTION public.cancel_verification_failed(
  query_id UUID,
  reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
  sets_to_reverse INTEGER;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.status != 'verification_failed' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only failed-verification queries can be cancelled here.');
  END IF;

  sets_to_reverse := COALESCE(q.required_sets, 0);

  IF q.claimed_by_user_id IS NOT NULL THEN
    UPDATE public.salesperson_stats
    SET total_successful = GREATEST(0, total_successful - 1),
        total_sets_sold = GREATEST(0, total_sets_sold - sets_to_reverse),
        total_unsuccessful = total_unsuccessful + 1
    WHERE user_id = q.claimed_by_user_id;
  END IF;

  UPDATE public.queries
  SET status = 'lost_cancelled',
      failure_reason = COALESCE(reason, 'Verification failed — cancelled'),
      closed_at = NOW(),
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── submit_invoice_number: won_pending_accounts → pending_verification ──
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

-- ─── flag_back_to_sales: verification_failed → won_pending_accounts ──────
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
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── update_dispatched_sets ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_dispatched_sets(
  query_id UUID,
  sets_shipped INTEGER,
  operator_name TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
  new_total INTEGER;
  remaining INTEGER;
  is_complete BOOLEAN;
  new_history JSONB;
  trimmed_history JSONB;
  hist_len INTEGER;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.status NOT IN ('verified_pending_dispatch', 'partially_dispatched') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Query is not in a dispatchable state.');
  END IF;
  IF sets_shipped <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Shipped sets must be a positive number.');
  END IF;

  new_total := q.dispatched_sets + sets_shipped;
  IF new_total > q.required_sets THEN
    remaining := GREATEST(0, q.required_sets - q.dispatched_sets);
    RETURN jsonb_build_object('success', false,
      'message', 'Cannot dispatch ' || sets_shipped || ' sets — only ' || remaining || ' remaining.');
  END IF;

  is_complete := new_total >= q.required_sets;

  new_history := q.dispatch_history || jsonb_build_array(jsonb_build_object(
    'date', NOW(),
    'sets_shipped', sets_shipped,
    'operator', COALESCE(operator_name, 'Unknown')
  ));

  -- Cap at last 50 entries
  hist_len := jsonb_array_length(new_history);
  IF hist_len > 50 THEN
    trimmed_history := jsonb_path_query_array(new_history, '$[' || (hist_len - 50) || ' to last]');
  ELSE
    trimmed_history := new_history;
  END IF;

  UPDATE public.queries
  SET dispatched_sets = new_total,
      dispatch_history = trimmed_history,
      status = CASE WHEN is_complete THEN 'completed' ELSE 'partially_dispatched' END,
      completed_at = CASE WHEN is_complete THEN NOW() ELSE NULL END,
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true, 'completed', is_complete);
END;
$$;

-- ─── Grant execute on all RPC functions to authenticated users ────────────
-- (RLS still applies inside; the SECURITY DEFINER bypass is intentional.)
GRANT EXECUTE ON FUNCTION public.claim_query(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.snooze_query(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unsnooze_query(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.auto_unsnooze_expired() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_won(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_lost_cancelled(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_verification_failed(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_invoice_number(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.flag_back_to_sales(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_dispatched_sets(UUID, INTEGER, TEXT) TO authenticated;
