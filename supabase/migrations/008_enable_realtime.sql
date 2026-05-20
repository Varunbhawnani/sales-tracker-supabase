-- ═══════════════════════════════════════════════════════════════════════════
-- 008_enable_realtime.sql — broadcast changes via Realtime for every table
-- the app subscribes to.
-- ═══════════════════════════════════════════════════════════════════════════
-- Without this, supabase.channel().on('postgres_changes', ...) listeners
-- silently never fire — every action requires a manual refresh.
--
-- The check inside the DO block is what makes this idempotent: re-running
-- the migration won't error if a table is already in the publication.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'queries',
    'users',
    'salesperson_stats',
    'settings',
    'customers_master',
    'products_master'
  ])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      RAISE NOTICE 'Added public.% to supabase_realtime publication.', t;
    ELSE
      RAISE NOTICE 'public.% already in supabase_realtime — skipping.', t;
    END IF;
  END LOOP;
END $$;

-- Verify (visible in the "Results" tab after running):
SELECT schemaname, tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
ORDER BY tablename;
