-- ═══════════════════════════════════════════════════════════════════════════
-- 015_tasks.sql — 2-way task assignment between admin and other roles.
-- ═══════════════════════════════════════════════════════════════════════════
-- A task is from one specific user to one specific user. The owner can
-- assign tasks to any role; non-owners can assign tasks to the owner.
-- Either party can mark a task as completed (it's the assignee in practice
-- but we allow the sender too for cancellations).

CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_user_name TEXT NOT NULL,
  to_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_user_name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  is_completed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  completed_by_user_id UUID
);

CREATE INDEX IF NOT EXISTS tasks_to_idx   ON public.tasks (to_user_id, is_completed, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_from_idx ON public.tasks (from_user_id, is_completed, created_at DESC);

-- ─── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_select_mine ON public.tasks;
CREATE POLICY tasks_select_mine ON public.tasks FOR SELECT TO authenticated
  USING (from_user_id = auth.uid() OR to_user_id = auth.uid());

DROP POLICY IF EXISTS tasks_update_mine ON public.tasks;
CREATE POLICY tasks_update_mine ON public.tasks FOR UPDATE TO authenticated
  USING (from_user_id = auth.uid() OR to_user_id = auth.uid())
  WITH CHECK (from_user_id = auth.uid() OR to_user_id = auth.uid());

-- No direct INSERT or DELETE — go through RPCs.

-- ─── create_task RPC ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_task(
  to_user_id UUID,
  title TEXT,
  description TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller public.users%ROWTYPE;
  recipient public.users%ROWTYPE;
BEGIN
  SELECT * INTO caller FROM public.users WHERE id = auth.uid();
  IF NOT FOUND OR NOT caller.is_active THEN
    RETURN jsonb_build_object('success', false, 'message', 'Caller not active.');
  END IF;

  SELECT * INTO recipient FROM public.users WHERE id = to_user_id;
  IF NOT FOUND OR NOT recipient.is_active THEN
    RETURN jsonb_build_object('success', false, 'message', 'Recipient not found.');
  END IF;

  -- Allow admin↔any, and any↔admin. No peer-to-peer between non-owners.
  IF caller.role != 'owner' AND recipient.role != 'owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Tasks must involve the owner on either side.');
  END IF;

  IF title IS NULL OR length(trim(title)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Task title is required.');
  END IF;

  INSERT INTO public.tasks (from_user_id, from_user_name, to_user_id, to_user_name, title, description)
  VALUES (caller.id, caller.name, recipient.id, recipient.name, trim(title), NULLIF(trim(COALESCE(description,'')), ''));

  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_task(UUID, TEXT, TEXT) TO authenticated;

-- ─── toggle_task RPC ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.toggle_task(task_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_uid UUID := auth.uid();
  t public.tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.tasks WHERE id = task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Task not found.'); END IF;
  IF t.from_user_id != current_uid AND t.to_user_id != current_uid THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not your task.');
  END IF;

  IF t.is_completed THEN
    UPDATE public.tasks SET is_completed = false, completed_at = NULL, completed_by_user_id = NULL WHERE id = task_id;
  ELSE
    UPDATE public.tasks SET is_completed = true, completed_at = NOW(), completed_by_user_id = current_uid WHERE id = task_id;
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.toggle_task(UUID) TO authenticated;

-- ─── Notify when a new task is assigned ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_task_assigned()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, type, title, message)
  VALUES (NEW.to_user_id, 'task_assigned', 'New task from ' || NEW.from_user_name, NEW.title);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS notify_task_assigned_trg ON public.tasks;
CREATE TRIGGER notify_task_assigned_trg AFTER INSERT ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.notify_task_assigned();

-- ─── Enable Realtime on tasks ────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
END $$;
