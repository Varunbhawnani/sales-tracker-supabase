-- ═══════════════════════════════════════════════════════════════════════════
-- 004_invoice_dedup.sql — defense in depth against the duplicate-invoice bug
-- (Ops Guide §8.1)
-- ═══════════════════════════════════════════════════════════════════════════
-- The tally-bridge does an application-level check before marking a query
-- verified, but if two pending verifications race (or if someone bypasses
-- the bridge), this partial unique index will catch it at the database
-- level.
--
-- Effect: at any moment, at most ONE query can be in (verified_pending_dispatch
-- | partially_dispatched | completed) state with a given tally_invoice_number.
-- Earlier-state queries (won_pending_accounts, pending_verification, etc.)
-- are excluded — so re-submission of a typo'd invoice is still allowed.

CREATE UNIQUE INDEX IF NOT EXISTS queries_verified_invoice_unique_idx
  ON public.queries (tally_invoice_number)
  WHERE status IN ('verified_pending_dispatch', 'partially_dispatched', 'completed')
    AND tally_invoice_number IS NOT NULL;

COMMENT ON INDEX public.queries_verified_invoice_unique_idx IS
  'Prevents the same Tally invoice number from verifying two different queries (Ops Guide §8.1).';
