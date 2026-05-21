-- ═══════════════════════════════════════════════════════════════════════════
-- 012_cartoons_lots_followups.sql — replace "sets" with cartoons + lots, add
-- follow-up fields, and tighten the snooze / lost / mark-booked RPCs.
-- ═══════════════════════════════════════════════════════════════════════════
-- Cartoons and lots are two SEPARATE quantities a query can have (a single
-- order may include both). They're entered at Mark Booked time — not at
-- query creation.
--
-- Stats now also track totals per unit (cartoons + lots). When Accounts
-- later edits these on a query, the stats recompute from queries directly
-- (statsService recomputes on demand), so no extra hooks are needed here.

-- ─── 1. New columns on queries ─────────────────────────────────────────────
ALTER TABLE public.queries
  ADD COLUMN IF NOT EXISTS cartoons INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lots INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS follow_up_note TEXT,
  ADD COLUMN IF NOT EXISTS follow_up_origin TEXT
    CHECK (follow_up_origin IS NULL OR follow_up_origin IN ('booked', 'snoozed')),
  ADD COLUMN IF NOT EXISTS follow_up_resolved BOOLEAN NOT NULL DEFAULT false;

-- ─── 2. Per-unit counters on salesperson_stats ─────────────────────────────
ALTER TABLE public.salesperson_stats
  ADD COLUMN IF NOT EXISTS total_cartoons_sold INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_lots_sold INTEGER NOT NULL DEFAULT 0;

-- ─── 3. mark_won → now takes cartoons + lots + optional follow_up_note ────
CREATE OR REPLACE FUNCTION public.mark_won(
  query_id UUID,
  p_cartoons INTEGER,
  p_lots INTEGER,
  follow_up_note TEXT DEFAULT NULL
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

  UPDATE public.queries
  SET status = 'won_pending_accounts',
      cartoons = p_cartoons,
      lots = p_lots,
      required_sets = p_cartoons + p_lots,   -- kept in sync for legacy fields
      won_at = NOW(),
      gamification = jsonb_set(q.gamification, '{time_to_win_ms}', to_jsonb(time_to_win_ms)),
      last_activity_at = NOW(),
      follow_up_note = CASE
        WHEN follow_up_note IS NOT NULL AND length(trim(follow_up_note)) > 0
          THEN trim(follow_up_note)
        ELSE q.follow_up_note  -- keep previous if no new one passed
      END,
      follow_up_origin = CASE
        WHEN follow_up_note IS NOT NULL AND length(trim(follow_up_note)) > 0
          THEN 'booked'
        ELSE q.follow_up_origin
      END,
      follow_up_resolved = CASE
        WHEN follow_up_note IS NOT NULL AND length(trim(follow_up_note)) > 0
          THEN false   -- a new follow-up is unresolved
        ELSE q.follow_up_resolved
      END
  WHERE id = query_id;

  -- Stats upsert. Counters are best-effort cache; statsService recomputes
  -- on the fly anyway so accounts-edits propagate correctly.
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

-- Old signature mark_won(UUID, INTEGER) is retained by Postgres because the
-- new function has a different parameter list (overloads coexist). Drop the
-- old one to avoid client confusion.
DROP FUNCTION IF EXISTS public.mark_won(UUID, INTEGER);

GRANT EXECUTE ON FUNCTION public.mark_won(UUID, INTEGER, INTEGER, TEXT) TO authenticated;

-- ─── 4. snooze_query → now requires a non-empty note ───────────────────────
CREATE OR REPLACE FUNCTION public.snooze_query(
  query_id UUID,
  follow_up DATE,
  note TEXT
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
  IF note IS NULL OR length(trim(note)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'A note is required when snoozing — say what you are following up on.');
  END IF;

  new_history := (q.snooze_history || jsonb_build_array(jsonb_build_object(
    'snoozed_at', NOW(), 'follow_up_date', follow_up, 'unsnoozed_at', NULL,
    'note', trim(note)
  )));

  UPDATE public.queries
  SET status = 'snoozed',
      snoozed_at = NOW(),
      follow_up_date = follow_up,
      snooze_history = new_history,
      follow_up_note = trim(note),
      follow_up_origin = 'snoozed',
      follow_up_resolved = false,
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

DROP FUNCTION IF EXISTS public.snooze_query(UUID, DATE);
GRANT EXECUTE ON FUNCTION public.snooze_query(UUID, DATE, TEXT) TO authenticated;

-- ─── 5. mark_lost_cancelled → reason now required ─────────────────────────
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
  IF reason IS NULL OR length(trim(reason)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'A reason is required when marking lost.');
  END IF;

  UPDATE public.queries
  SET status = 'lost_cancelled',
      failure_reason = trim(reason),
      closed_at = NOW(),
      last_activity_at = NOW()
  WHERE id = query_id;

  INSERT INTO public.salesperson_stats (user_id, name, total_unsuccessful)
  VALUES (current_uid, (SELECT name FROM public.users WHERE id = current_uid), 1)
  ON CONFLICT (user_id) DO UPDATE
    SET total_unsuccessful = salesperson_stats.total_unsuccessful + 1;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_lost_cancelled(UUID, TEXT) TO authenticated;

-- ─── 6. cancel_verification_failed → reverse cartoons + lots in stats too ──
CREATE OR REPLACE FUNCTION public.cancel_verification_failed(
  query_id UUID,
  reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.status != 'verification_failed' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only failed-verification queries can be cancelled here.');
  END IF;

  IF q.claimed_by_user_id IS NOT NULL THEN
    UPDATE public.salesperson_stats
    SET total_successful = GREATEST(0, total_successful - 1),
        total_sets_sold = GREATEST(0, total_sets_sold - COALESCE(q.cartoons + q.lots, q.required_sets, 0)),
        total_cartoons_sold = GREATEST(0, total_cartoons_sold - COALESCE(q.cartoons, 0)),
        total_lots_sold = GREATEST(0, total_lots_sold - COALESCE(q.lots, 0)),
        total_unsuccessful = total_unsuccessful + 1
    WHERE user_id = q.claimed_by_user_id;
  END IF;

  UPDATE public.queries
  SET status = 'lost_cancelled',
      failure_reason = COALESCE(reason, 'Verification failed — cancelled'),
      closed_at = NOW(),
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true, 'completed', true);
END;
$$;

-- ─── 7. Mark-follow-up-resolved RPC (used from Follow-Ups tab in Segment D) ─
CREATE OR REPLACE FUNCTION public.resolve_follow_up(query_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  caller_role TEXT;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = current_uid;
  IF caller_role IS NULL OR caller_role NOT IN ('salesperson', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only salesperson or owner can resolve follow-ups.');
  END IF;

  UPDATE public.queries
  SET follow_up_resolved = true,
      last_activity_at = NOW()
  WHERE id = query_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_follow_up(UUID) TO authenticated;
