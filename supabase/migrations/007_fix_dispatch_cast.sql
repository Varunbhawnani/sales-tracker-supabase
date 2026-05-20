-- ═══════════════════════════════════════════════════════════════════════════
-- 007_fix_dispatch_cast.sql — fix dispatch RPC enum cast
-- ═══════════════════════════════════════════════════════════════════════════
-- The update_dispatched_sets function in migration 003 used a CASE expression
-- to pick between 'completed' and 'partially_dispatched' for the status
-- column. Postgres doesn't auto-cast CASE TEXT → query_status enum, so the
-- UPDATE failed with "column 'status' is of type query_status but expression
-- is of type text".
--
-- All the other state-machine RPCs use direct literals (SET status = 'X')
-- which Postgres DOES auto-cast — so they were fine. Only this CASE breaks.
--
-- Fix: cast the CASE result with ::query_status.

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

  hist_len := jsonb_array_length(new_history);
  IF hist_len > 50 THEN
    trimmed_history := jsonb_path_query_array(new_history, '$[' || (hist_len - 50) || ' to last]');
  ELSE
    trimmed_history := new_history;
  END IF;

  UPDATE public.queries
  SET dispatched_sets = new_total,
      dispatch_history = trimmed_history,
      status = (CASE WHEN is_complete THEN 'completed' ELSE 'partially_dispatched' END)::query_status,
      completed_at = CASE WHEN is_complete THEN NOW() ELSE NULL END,
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true, 'completed', is_complete);
END;
$$;
