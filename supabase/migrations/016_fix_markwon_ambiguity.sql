-- ═══════════════════════════════════════════════════════════════════════════
-- 016_fix_markwon_ambiguity.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- mark_won had a parameter named `follow_up_note` that collided with the
-- column of the same name on the queries table — Postgres errored with
-- "column reference 'follow_up_note' is ambiguous". Rename the parameter
-- to `p_follow_up_note`.

-- Drop the old signature so the client doesn't keep matching it.
DROP FUNCTION IF EXISTS public.mark_won(UUID, INTEGER, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION public.mark_won(
  query_id UUID,
  p_cartoons INTEGER,
  p_lots INTEGER,
  p_follow_up_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  q public.queries%ROWTYPE;
  user_record public.users%ROWTYPE;
  total_ms BIGINT;
  total_snooze_ms BIGINT;
  time_to_win_ms BIGINT;
  has_follow_up BOOLEAN;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.claimed_by_user_id != current_uid THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the claimer can mark this query as booked.');
  END IF;
  IF NOT is_valid_transition(q.status, 'won_pending_accounts') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot mark booked from current status.');
  END IF;
  IF COALESCE(p_cartoons, 0) < 0 OR COALESCE(p_lots, 0) < 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cartoons and lots must be zero or positive.');
  END IF;
  IF COALESCE(p_cartoons, 0) + COALESCE(p_lots, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Enter at least one cartoon or one lot.');
  END IF;

  SELECT * INTO user_record FROM public.users WHERE id = current_uid;

  total_ms := EXTRACT(EPOCH FROM (NOW() - q.created_at)) * 1000;
  total_snooze_ms := COALESCE((q.gamification->>'total_snooze_ms')::BIGINT, 0);
  time_to_win_ms := total_ms - total_snooze_ms;

  has_follow_up := p_follow_up_note IS NOT NULL AND length(trim(p_follow_up_note)) > 0;

  UPDATE public.queries
  SET status = 'won_pending_accounts',
      cartoons = p_cartoons,
      lots = p_lots,
      required_sets = p_cartoons + p_lots,
      won_at = NOW(),
      gamification = jsonb_set(q.gamification, '{time_to_win_ms}', to_jsonb(time_to_win_ms)),
      last_activity_at = NOW(),
      follow_up_note = CASE WHEN has_follow_up THEN trim(p_follow_up_note) ELSE q.follow_up_note END,
      follow_up_origin = CASE WHEN has_follow_up THEN 'booked' ELSE q.follow_up_origin END,
      follow_up_resolved = CASE WHEN has_follow_up THEN false ELSE q.follow_up_resolved END
  WHERE id = query_id;

  INSERT INTO public.salesperson_stats
    (user_id, name, total_successful, total_sets_sold, total_cartoons_sold, total_lots_sold)
  VALUES (current_uid, user_record.name, 1, p_cartoons + p_lots, p_cartoons, p_lots)
  ON CONFLICT (user_id) DO UPDATE
    SET total_successful = salesperson_stats.total_successful + 1,
        total_sets_sold = salesperson_stats.total_sets_sold + (p_cartoons + p_lots),
        total_cartoons_sold = salesperson_stats.total_cartoons_sold + p_cartoons,
        total_lots_sold = salesperson_stats.total_lots_sold + p_lots;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_won(UUID, INTEGER, INTEGER, TEXT) TO authenticated;
