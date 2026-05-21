-- ═══════════════════════════════════════════════════════════════════════════
-- 019_query_godown.sql — godown-scoping for queries
-- ═══════════════════════════════════════════════════════════════════════════
-- Every new query now carries an optional godown_id. The visibility rule is
-- enforced client-side (the queries SELECT policy stays wide so the owner
-- can read everything) but the column is what every screen filters on:
--
--   * Non-owner users:
--       - user.godown_id IS NULL  → see all queries
--       - user.godown_id = X      → see queries where godown_id IS NULL or = X
--   * Owner:
--       - sees everything; the global Admin chip narrows their view
--   * Legacy queries with godown_id IS NULL: visible to everyone (matches
--     the migration policy we agreed on for pre-019 data).
--
-- Re-runnable. No enum changes here, safe to paste-and-run in one batch.

ALTER TABLE public.queries
  ADD COLUMN IF NOT EXISTS godown_id UUID
    REFERENCES public.godowns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS queries_godown_idx
  ON public.queries(godown_id);

-- The queries table is already in the supabase_realtime publication from
-- migration 008, so this new column is automatically published. No further
-- publication change needed.
