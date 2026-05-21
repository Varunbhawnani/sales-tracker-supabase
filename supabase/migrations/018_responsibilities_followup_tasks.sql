-- ═══════════════════════════════════════════════════════════════════════════
-- 018_responsibilities_followup_tasks.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Bundles four related changes — they touch the same area (RPCs + RLS) and
-- a single migration keeps the apply path linear.
--
--   1. Split Operations back into Packing + Dispatch.
--        All current 'operations' users are demoted to 'packing'; the owner
--        manually promotes specific people to 'dispatch' afterwards from
--        the Admin screen. The 'operations' enum value stays for any
--        historical attribution on queries.
--
--   2. Role Responsibilities — admin-managed reference docs per role.
--        Each role can have many responsibilities; each responsibility has a
--        title + ordered list of steps stored as JSONB. Anyone reads; only
--        the owner writes.
--
--   3. Follow-up date + pickup_follow_up RPC.
--        Salespeople can attach an optional date to a follow-up. When they
--        "pick up" a follow-up, the query is reset back to claimed_by_sales
--        so they get the three actions (Mark Booked / Snooze / Cancel)
--        again.
--
--   4. Tasks: due_date + recurrence + notify settings.
--        Tasks can be one-time or recurring (every-N-days / weekday list /
--        day-of-month). Each completion either closes the task (one-time)
--        or rolls next_due_date forward (recurring) and reopens the task.
--
-- Paste-and-run in the Supabase SQL Editor after the 017 pair. No new enum
-- values are introduced here so it's safe to run in one batch.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Demote operations users back to packing
-- ───────────────────────────────────────────────────────────────────────────

UPDATE public.users
SET role = 'packing'
WHERE role = 'operations';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. role_responsibilities — per-role reference docs (admin-managed)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.role_responsibilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role user_role NOT NULL,
  title TEXT NOT NULL,
  -- Array of step strings, ordered. Keeping the list inline as JSONB so the
  -- admin UI just patches one row when reordering steps.
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS role_responsibilities_role_idx
  ON public.role_responsibilities(role, order_index);

ALTER TABLE public.role_responsibilities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "responsibilities select" ON public.role_responsibilities;
CREATE POLICY "responsibilities select" ON public.role_responsibilities
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "responsibilities insert" ON public.role_responsibilities;
CREATE POLICY "responsibilities insert" ON public.role_responsibilities
  FOR INSERT WITH CHECK (public.current_user_role() = 'owner');

DROP POLICY IF EXISTS "responsibilities update" ON public.role_responsibilities;
CREATE POLICY "responsibilities update" ON public.role_responsibilities
  FOR UPDATE USING (public.current_user_role() = 'owner');

DROP POLICY IF EXISTS "responsibilities delete" ON public.role_responsibilities;
CREATE POLICY "responsibilities delete" ON public.role_responsibilities
  FOR DELETE USING (public.current_user_role() = 'owner');

-- Trigger to keep updated_at fresh.
CREATE OR REPLACE FUNCTION public.bump_responsibility_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS responsibilities_updated_at ON public.role_responsibilities;
CREATE TRIGGER responsibilities_updated_at
  BEFORE UPDATE ON public.role_responsibilities
  FOR EACH ROW EXECUTE FUNCTION public.bump_responsibility_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Follow-up date + pickup_follow_up
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.queries
  ADD COLUMN IF NOT EXISTS follow_up_date DATE;

-- pickup_follow_up: salesperson re-opens a follow-up. The query reverts to
-- claimed_by_sales so they can act on it again with the 3 standard options.
-- The follow-up note + date are cleared so the same follow-up doesn't keep
-- re-appearing in the Follow-Ups tab.
CREATE OR REPLACE FUNCTION public.pickup_follow_up(query_id UUID)
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
  IF caller_role NOT IN ('salesperson', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only sales or owner can pick up a follow-up.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.follow_up_note IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No follow-up on this query.');
  END IF;

  -- Revert the state to claimed_by_sales so the three standard actions are
  -- available again. We deliberately allow this transition from any current
  -- status the follow-up could have come from (won_pending_accounts, snoozed,
  -- pending_verification, verification_failed). Any in-flight invoice work
  -- is also cleared so accounts doesn't keep verifying a re-opened query.
  UPDATE public.queries
  SET status = 'claimed_by_sales',
      claimed_by_user_id = COALESCE(claimed_by_user_id, current_uid),
      claimed_by_name = COALESCE(claimed_by_name, caller_name),
      claimed_at = COALESCE(claimed_at, NOW()),
      snoozed_at = NULL,
      follow_up_date = NULL,
      follow_up_note = NULL,
      follow_up_origin = NULL,
      follow_up_resolved = true,
      tally_invoice_number = NULL,
      invoice_entries = '[]'::jsonb,
      invoice_attempt_count = 0,
      verification_error = NULL,
      verification_note = NULL,
      verification_timestamp = NULL,
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.pickup_follow_up(UUID) TO authenticated;

-- Update mark_won so it also stores the follow-up date. Earlier migrations
-- only persisted the note; the date column is new. We re-define here.
-- Note: the parameter name p_follow_up_note (from migration 016) is preserved
-- to keep the client-side RPC call site unchanged.
CREATE OR REPLACE FUNCTION public.mark_won(
  query_id UUID,
  p_cartoons INTEGER,
  p_lots INTEGER,
  p_follow_up_note TEXT DEFAULT NULL,
  p_follow_up_date DATE DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  caller_role TEXT;
  q public.queries%ROWTYPE;
  total_ms BIGINT;
  snooze_ms BIGINT;
  time_to_win_ms BIGINT;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = current_uid;
  IF caller_role NOT IN ('salesperson', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only sales or owner can mark booked.');
  END IF;
  IF p_cartoons IS NULL OR p_cartoons < 0 OR p_lots IS NULL OR p_lots < 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cartons and lots must be non-negative.');
  END IF;
  IF (p_cartoons + p_lots) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Enter at least one cartoon or one lot.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.claimed_by_user_id IS DISTINCT FROM current_uid AND caller_role != 'owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the claiming salesperson can mark it booked.');
  END IF;
  IF q.status NOT IN ('claimed_by_sales', 'snoozed') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Query is not in a markable state.');
  END IF;

  total_ms := COALESCE(EXTRACT(EPOCH FROM (NOW() - q.created_at)) * 1000, 0)::BIGINT;
  snooze_ms := COALESCE((q.gamification ->> 'total_snooze_ms')::BIGINT, 0);
  time_to_win_ms := total_ms - snooze_ms;

  UPDATE public.queries
  SET status = 'won_pending_accounts',
      cartoons = p_cartoons,
      lots = p_lots,
      won_at = NOW(),
      follow_up_note = NULLIF(trim(COALESCE(p_follow_up_note, '')), ''),
      follow_up_date = p_follow_up_date,
      follow_up_origin = CASE WHEN NULLIF(trim(COALESCE(p_follow_up_note, '')), '') IS NOT NULL THEN 'booked' ELSE NULL END,
      follow_up_resolved = CASE WHEN NULLIF(trim(COALESCE(p_follow_up_note, '')), '') IS NOT NULL THEN false ELSE true END,
      gamification = jsonb_set(
        COALESCE(q.gamification, '{}'::jsonb),
        '{time_to_win_ms}',
        to_jsonb(time_to_win_ms)
      ),
      last_activity_at = NOW()
  WHERE id = query_id;

  -- Increment salesperson_stats: totalSuccessful++, totalSetsSold += cartons+lots.
  INSERT INTO public.salesperson_stats (user_id, name, total_successful, total_sets_sold)
  VALUES (q.claimed_by_user_id, q.claimed_by_name, 1, p_cartoons + p_lots)
  ON CONFLICT (user_id) DO UPDATE
  SET total_successful = public.salesperson_stats.total_successful + 1,
      total_sets_sold = public.salesperson_stats.total_sets_sold + p_cartoons + p_lots;

  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_won(UUID, INTEGER, INTEGER, TEXT, DATE) TO authenticated;

-- snooze_query similarly accepts an optional follow_up_date.
CREATE OR REPLACE FUNCTION public.snooze_query(
  query_id UUID,
  follow_up DATE,
  note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  caller_role TEXT;
  q public.queries%ROWTYPE;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = current_uid;
  IF caller_role NOT IN ('salesperson', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only sales or owner can snooze.');
  END IF;
  IF follow_up IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Follow-up date is required.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF q.claimed_by_user_id IS DISTINCT FROM current_uid AND caller_role != 'owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the claiming salesperson can snooze it.');
  END IF;
  IF q.status NOT IN ('claimed_by_sales', 'snoozed') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only claimed/snoozed queries can be snoozed.');
  END IF;

  UPDATE public.queries
  SET status = 'snoozed',
      snoozed_at = NOW(),
      follow_up_date = follow_up,
      follow_up_note = NULLIF(trim(COALESCE(note, '')), ''),
      follow_up_origin = 'snoozed',
      follow_up_resolved = false,
      snooze_history = COALESCE(q.snooze_history, '[]'::jsonb) || jsonb_build_object(
        'snoozed_at', NOW(),
        'follow_up_date', follow_up,
        'note', COALESCE(note, '')
      ),
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.snooze_query(UUID, DATE, TEXT) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Tasks — due dates, recurrence, notify settings
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS due_date DATE,
  -- Recurrence rule (NULL = one-time task). Shape:
  --   { "type": "days"|"weekday"|"day_of_month",
  --     "interval": 1,          -- every N units (N=1 for "weekly", etc.)
  --     "weekdays": [1,3,5],    -- ISO weekday numbers, only for type=weekday
  --     "day_of_month": 15,     -- only for type=day_of_month
  --     "start_date": "2026-06-01",
  --     "end_date": null }
  ADD COLUMN IF NOT EXISTS recurrence JSONB,
  ADD COLUMN IF NOT EXISTS next_due_date DATE,
  ADD COLUMN IF NOT EXISTS last_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notify_settings JSONB NOT NULL
    DEFAULT '{"on_assign": true, "before_due_hours": 1, "at_due": true}'::jsonb;

CREATE INDEX IF NOT EXISTS tasks_next_due_idx ON public.tasks (to_user_id, next_due_date);

-- Helper: compute the next due date given a base date and a recurrence rule.
-- Returns the FIRST date strictly after `from_date` that matches the rule.
-- For weekday lists, weekdays are 1=Mon..7=Sun (ISO).
CREATE OR REPLACE FUNCTION public.compute_next_due(
  from_date DATE,
  rule JSONB
) RETURNS DATE
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  t TEXT := rule ->> 'type';
  interval_n INTEGER := COALESCE((rule ->> 'interval')::INTEGER, 1);
  end_date DATE := NULLIF(rule ->> 'end_date', '')::DATE;
  candidate DATE;
  wd INTEGER;
  weekdays JSONB := rule -> 'weekdays';
  dom INTEGER := COALESCE((rule ->> 'day_of_month')::INTEGER, 1);
  i INTEGER;
BEGIN
  IF rule IS NULL OR from_date IS NULL THEN RETURN NULL; END IF;

  IF t = 'days' THEN
    candidate := from_date + (GREATEST(interval_n, 1) || ' days')::INTERVAL;
  ELSIF t = 'weekday' AND weekdays IS NOT NULL THEN
    candidate := from_date;
    FOR i IN 1..14 LOOP
      candidate := candidate + INTERVAL '1 day';
      wd := EXTRACT(ISODOW FROM candidate)::INTEGER;
      IF weekdays @> to_jsonb(wd) THEN
        EXIT;
      END IF;
    END LOOP;
  ELSIF t = 'day_of_month' THEN
    -- Land on the requested day-of-month in the next interval months.
    candidate := (date_trunc('month', from_date) + (GREATEST(interval_n, 1) || ' months')::INTERVAL)::DATE
                 + (LEAST(GREATEST(dom, 1), 28) - 1);
  ELSE
    RETURN NULL;
  END IF;

  IF end_date IS NOT NULL AND candidate > end_date THEN
    RETURN NULL;
  END IF;
  RETURN candidate;
END;
$$;

-- create_task: extended to accept due_date + recurrence + notify_settings.
DROP FUNCTION IF EXISTS public.create_task(UUID, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.create_task(
  to_user_id UUID,
  title TEXT,
  description TEXT DEFAULT NULL,
  p_due_date DATE DEFAULT NULL,
  p_recurrence JSONB DEFAULT NULL,
  p_notify_settings JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller public.users%ROWTYPE;
  recipient public.users%ROWTYPE;
  initial_due DATE;
BEGIN
  SELECT * INTO caller FROM public.users WHERE id = auth.uid();
  IF NOT FOUND OR NOT caller.is_active THEN
    RETURN jsonb_build_object('success', false, 'message', 'Caller not active.');
  END IF;

  SELECT * INTO recipient FROM public.users WHERE id = to_user_id;
  IF NOT FOUND OR NOT recipient.is_active THEN
    RETURN jsonb_build_object('success', false, 'message', 'Recipient not found.');
  END IF;

  IF caller.role != 'owner' AND recipient.role != 'owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Tasks must involve the owner on either side.');
  END IF;

  IF title IS NULL OR length(trim(title)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Task title is required.');
  END IF;

  -- For one-time tasks, initial due is just p_due_date. For recurring, prefer
  -- start_date from the rule, else today.
  IF p_recurrence IS NOT NULL THEN
    initial_due := COALESCE(
      NULLIF(p_recurrence ->> 'start_date', '')::DATE,
      p_due_date,
      CURRENT_DATE
    );
  ELSE
    initial_due := p_due_date;
  END IF;

  INSERT INTO public.tasks (
    from_user_id, from_user_name, to_user_id, to_user_name,
    title, description,
    due_date, recurrence, next_due_date,
    notify_settings
  )
  VALUES (
    caller.id, caller.name, recipient.id, recipient.name,
    trim(title), NULLIF(trim(COALESCE(description,'')), ''),
    initial_due, p_recurrence, initial_due,
    COALESCE(p_notify_settings, '{"on_assign": true, "before_due_hours": 1, "at_due": true}'::jsonb)
  );

  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_task(UUID, TEXT, TEXT, DATE, JSONB, JSONB) TO authenticated;

-- toggle_task: complete a task. For recurring tasks, roll next_due_date
-- forward instead of marking the task fully done.
CREATE OR REPLACE FUNCTION public.toggle_task(task_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  t public.tasks%ROWTYPE;
  new_next DATE;
BEGIN
  SELECT * INTO t FROM public.tasks WHERE id = task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Task not found.'); END IF;
  IF t.to_user_id != current_uid AND t.from_user_id != current_uid THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not your task.');
  END IF;

  IF t.recurrence IS NOT NULL AND NOT t.is_completed THEN
    -- Recurring + currently active → mark this occurrence done, roll forward.
    new_next := public.compute_next_due(
      COALESCE(t.next_due_date, t.due_date, CURRENT_DATE),
      t.recurrence
    );
    IF new_next IS NULL THEN
      -- Past end_date → close the task permanently.
      UPDATE public.tasks
      SET is_completed = true,
          completed_at = NOW(),
          completed_by_user_id = current_uid,
          last_completed_at = NOW(),
          next_due_date = NULL
      WHERE id = task_id;
    ELSE
      UPDATE public.tasks
      SET is_completed = false,
          completed_at = NULL,
          completed_by_user_id = NULL,
          last_completed_at = NOW(),
          next_due_date = new_next
      WHERE id = task_id;
    END IF;
  ELSE
    -- One-time, or already-completed recurring (toggle back open).
    UPDATE public.tasks
    SET is_completed = NOT t.is_completed,
        completed_at = CASE WHEN NOT t.is_completed THEN NOW() ELSE NULL END,
        completed_by_user_id = CASE WHEN NOT t.is_completed THEN current_uid ELSE NULL END
    WHERE id = task_id;
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.toggle_task(UUID) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Realtime publication for role_responsibilities
-- ───────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'role_responsibilities'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.role_responsibilities';
  END IF;
END $$;
