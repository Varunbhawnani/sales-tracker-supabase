-- ═══════════════════════════════════════════════════════════════════════════
-- 011_query_origin.sql — track whether a query originated online or offline
-- ═══════════════════════════════════════════════════════════════════════════
-- Salespersons pick "Online" or "Offline" at the top of the New Query screen
-- so the owner knows which channel each customer came in through (WhatsApp,
-- showroom walk-in, web form, dealer visit, etc.).
--
-- Stored as a free-form TEXT with a CHECK so we can add more values later
-- (e.g., "phone", "exhibition") without a migration.

ALTER TABLE public.queries
  ADD COLUMN IF NOT EXISTS origin TEXT
  CHECK (origin IS NULL OR origin IN ('online', 'offline'));

COMMENT ON COLUMN public.queries.origin IS
  'How the customer reached us for this query. "online" or "offline". Set at query-create time.';
