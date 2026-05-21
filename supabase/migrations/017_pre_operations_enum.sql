-- ═══════════════════════════════════════════════════════════════════════════
-- 017_pre_operations_enum.sql — preflight for the main 017 migration
-- ═══════════════════════════════════════════════════════════════════════════
-- Postgres requires a new enum value to be committed BEFORE any statement
-- can reference it as a literal. Supabase's SQL Editor wraps a multi-
-- statement script in a single transaction, so the ALTER TYPE and the
-- UPDATE that uses 'operations' can't live in the same run.
--
-- Run this file by itself first (a single statement = its own transaction
-- = auto-committed). Then run 017_operations_role_and_godowns.sql.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'operations';
