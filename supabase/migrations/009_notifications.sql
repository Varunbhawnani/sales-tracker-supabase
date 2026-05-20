-- ═══════════════════════════════════════════════════════════════════════════
-- 009_notifications.sql — in-app notification bell system
-- ═══════════════════════════════════════════════════════════════════════════
-- Triggers on the queries table automatically create notification rows for
-- relevant users whenever:
--   • A new query is created   → notify all salespersons (except creator) + owner
--   • Status → pending_verification → notify all accounts users + owner
--   • Status → verified_pending_dispatch → notify all dispatch users + owner
--   • invoice_attempt_count hits 5 (query locked) → notify owner
--
-- Users see their unread notifications in a bell icon in the app header.
-- Marking as read is a simple UPDATE the user does on their own rows.

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  related_query_id UUID REFERENCES public.queries(id) ON DELETE CASCADE,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the most common query: "my unread, newest first".
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON public.notifications (user_id, is_read, created_at DESC);

-- ─── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_select_own ON public.notifications;
CREATE POLICY notifications_select_own
  ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_update_own ON public.notifications;
CREATE POLICY notifications_update_own
  ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- No INSERT or DELETE policy — only the SECURITY DEFINER trigger writes.

-- ─── Trigger function ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_query_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- New open query → salespersons (except creator) + owner
  IF TG_OP = 'INSERT' AND NEW.status = 'open_query' THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'new_query',
           'New query',
           NEW.customer_name || ' — ' || NEW.required_sets || ' sets',
           NEW.id
    FROM public.users u
    WHERE u.role IN ('salesperson', 'owner')
      AND u.is_active = true
      AND (NEW.created_by_user_id IS NULL OR u.id != NEW.created_by_user_id);
  END IF;

  -- Status flipped to pending_verification → accounts + owner
  IF TG_OP = 'UPDATE'
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.status = 'pending_verification' THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'pending_verification',
           'Invoice awaiting verification',
           NEW.customer_name || ' — Invoice ' || COALESCE(NEW.tally_invoice_number, '(none)'),
           NEW.id
    FROM public.users u
    WHERE u.role IN ('accounts', 'owner') AND u.is_active = true;
  END IF;

  -- Status flipped to verified_pending_dispatch → dispatch + owner
  IF TG_OP = 'UPDATE'
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.status = 'verified_pending_dispatch' THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'ready_to_dispatch',
           'Ready to dispatch',
           NEW.customer_name || ' — ' || NEW.required_sets || ' sets',
           NEW.id
    FROM public.users u
    WHERE u.role IN ('dispatch', 'owner') AND u.is_active = true;
  END IF;

  -- Status flipped to won_pending_accounts → claimer's salesperson sees it
  -- moving along the pipeline. Optional but helpful so sales know the deal
  -- is in accounts now.
  IF TG_OP = 'UPDATE'
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.status = 'won_pending_accounts'
     AND NEW.claimed_by_user_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    VALUES (
      NEW.claimed_by_user_id,
      'booked',
      'Booked — now with accounts',
      NEW.customer_name || ' — ' || NEW.required_sets || ' sets',
      NEW.id
    );
  END IF;

  -- Query locked after 5 failed invoice attempts → owner only (urgent)
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.invoice_attempt_count, 0) < 5
     AND COALESCE(NEW.invoice_attempt_count, 0) >= 5 THEN
    INSERT INTO public.notifications (user_id, type, title, message, related_query_id)
    SELECT u.id, 'query_locked',
           '🔒 Query locked — your attention needed',
           NEW.customer_name || ' — 5 failed invoice attempts',
           NEW.id
    FROM public.users u
    WHERE u.role = 'owner' AND u.is_active = true;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_query_events ON public.queries;
CREATE TRIGGER notify_query_events
  AFTER INSERT OR UPDATE ON public.queries
  FOR EACH ROW EXECUTE FUNCTION public.notify_query_event();

-- ─── Mark-all-read RPC (convenience) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.notifications
  SET is_read = true
  WHERE user_id = auth.uid() AND is_read = false;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read() TO authenticated;

-- ─── Enable Realtime so the bell updates live ─────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
    RAISE NOTICE 'Added public.notifications to supabase_realtime publication.';
  END IF;
END $$;
