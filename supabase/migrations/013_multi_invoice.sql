-- ═══════════════════════════════════════════════════════════════════════════
-- 013_multi_invoice.sql — multi-invoice verification + 3-try lock + accounts
--                         can edit cartoons/lots on a query.
-- ═══════════════════════════════════════════════════════════════════════════
-- One query may span multiple Tally invoices (e.g., 5 cartoons split into a
-- 3-cartoon invoice + a 2-cartoon invoice). Each entry is verified
-- independently by the bridge. The query passes only when ALL entries are
-- verified AND together they cover the query's cartoons + lots.
--
-- Each entry shape:
--   {
--     invoice_no:          TEXT,
--     cartoons:            INTEGER,
--     lots:                INTEGER,
--     status:              'pending' | 'verified' | 'failed',
--     added_at:            ISO timestamp,
--     verified_at:         ISO timestamp | NULL,
--     verification_error:  TEXT | NULL
--   }

-- ─── 1. Add invoice_entries column ────────────────────────────────────────
ALTER TABLE public.queries
  ADD COLUMN IF NOT EXISTS invoice_entries JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ─── 2. Drop the old partial unique index — duplicate-checking is now done
-- in the RPC against the invoice_entries JSONB (it ignores tally_invoice_number).
DROP INDEX IF EXISTS public.queries_verified_invoice_unique_idx;

-- ─── 3. add_invoice_entry RPC — accounts adds an invoice to a query ───────
CREATE OR REPLACE FUNCTION public.add_invoice_entry(
  query_id UUID,
  invoice_no TEXT,
  entry_cartoons INTEGER,
  entry_lots INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
  trimmed_invoice TEXT;
  existing_cartoons INTEGER;
  existing_lots INTEGER;
  caller_role TEXT;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();
  IF caller_role NOT IN ('accounts', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only accounts or owner can add invoices.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;

  IF q.status NOT IN ('won_pending_accounts', 'pending_verification', 'verification_failed') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot add an invoice from current status.');
  END IF;

  IF COALESCE(q.invoice_attempt_count, 0) >= 3 THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Query is locked after 3 failed invoice attempts. Escalate to the owner.');
  END IF;

  trimmed_invoice := trim(invoice_no);
  IF length(trimmed_invoice) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invoice number is required.');
  END IF;
  IF COALESCE(entry_cartoons, 0) < 0 OR COALESCE(entry_lots, 0) < 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cartoons and lots must be zero or positive.');
  END IF;
  IF COALESCE(entry_cartoons, 0) + COALESCE(entry_lots, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Enter at least one cartoon or one lot for this invoice.');
  END IF;

  -- Duplicate WITHIN this query → reject
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(q.invoice_entries) AS e
    WHERE upper(trim(e->>'invoice_no')) = upper(trimmed_invoice)
  ) THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Invoice "' || trimmed_invoice || '" is already added to this query.');
  END IF;

  -- Duplicate across queries (any verified entry in any other query) → reject
  IF EXISTS (
    SELECT 1 FROM public.queries q2,
      LATERAL jsonb_array_elements(q2.invoice_entries) AS e
    WHERE q2.id != query_id
      AND upper(trim(e->>'invoice_no')) = upper(trimmed_invoice)
      AND e->>'status' = 'verified'
  ) THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Invoice "' || trimmed_invoice || '" is already verified for another query.');
  END IF;

  -- Quantity over-allocation guard
  SELECT
    COALESCE(SUM((e->>'cartoons')::INTEGER), 0),
    COALESCE(SUM((e->>'lots')::INTEGER), 0)
  INTO existing_cartoons, existing_lots
  FROM jsonb_array_elements(q.invoice_entries) AS e;

  IF (existing_cartoons + entry_cartoons) > COALESCE(q.cartoons, 0) THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Total cartoons across invoices (' || (existing_cartoons + entry_cartoons) ||
                 ') would exceed the query target (' || COALESCE(q.cartoons, 0) || ').');
  END IF;
  IF (existing_lots + entry_lots) > COALESCE(q.lots, 0) THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Total lots across invoices (' || (existing_lots + entry_lots) ||
                 ') would exceed the query target (' || COALESCE(q.lots, 0) || ').');
  END IF;

  -- Append + move to pending_verification
  UPDATE public.queries
  SET invoice_entries = invoice_entries || jsonb_build_array(jsonb_build_object(
        'invoice_no', trimmed_invoice,
        'cartoons', entry_cartoons,
        'lots', entry_lots,
        'status', 'pending',
        'added_at', NOW(),
        'verified_at', NULL,
        'verification_error', NULL
      )),
      status = 'pending_verification',
      tally_invoice_number = trimmed_invoice,        -- legacy mirror (most recent)
      verification_timestamp = NOW(),
      verification_error = NULL,
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_invoice_entry(UUID, TEXT, INTEGER, INTEGER) TO authenticated;

-- ─── 4. accounts_update_quantity RPC — accounts edits cartoons/lots ───────
CREATE OR REPLACE FUNCTION public.accounts_update_quantity(
  query_id UUID,
  new_cartoons INTEGER,
  new_lots INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
  total_entry_cartoons INTEGER;
  total_entry_lots INTEGER;
  caller_role TEXT;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();
  IF caller_role NOT IN ('accounts', 'owner') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only accounts or owner can update quantity.');
  END IF;

  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;

  IF q.status NOT IN ('won_pending_accounts', 'pending_verification', 'verification_failed') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot edit quantity from current status.');
  END IF;

  IF COALESCE(new_cartoons, 0) < 0 OR COALESCE(new_lots, 0) < 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cartoons and lots must be zero or positive.');
  END IF;
  IF COALESCE(new_cartoons, 0) + COALESCE(new_lots, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'At least one of cartoons or lots must be positive.');
  END IF;

  -- Already-invoiced totals can't be reduced below
  SELECT
    COALESCE(SUM((e->>'cartoons')::INTEGER), 0),
    COALESCE(SUM((e->>'lots')::INTEGER), 0)
  INTO total_entry_cartoons, total_entry_lots
  FROM jsonb_array_elements(q.invoice_entries) AS e;

  IF new_cartoons < total_entry_cartoons THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Cannot reduce cartoons below already-invoiced total (' || total_entry_cartoons || ').');
  END IF;
  IF new_lots < total_entry_lots THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Cannot reduce lots below already-invoiced total (' || total_entry_lots || ').');
  END IF;

  UPDATE public.queries
  SET cartoons = new_cartoons,
      lots = new_lots,
      required_sets = new_cartoons + new_lots,
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.accounts_update_quantity(UUID, INTEGER, INTEGER) TO authenticated;

-- ─── 5. flag_back_to_sales: clear invoice_entries + reset counter ─────────
CREATE OR REPLACE FUNCTION public.flag_back_to_sales(
  query_id UUID,
  note TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
BEGIN
  SELECT * INTO q FROM public.queries WHERE id = query_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'Query not found.'); END IF;
  IF NOT is_valid_transition(q.status, 'won_pending_accounts') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot flag back from current status.');
  END IF;

  UPDATE public.queries
  SET status = 'won_pending_accounts',
      verification_note = COALESCE(note, 'Flagged back by accounts team'),
      tally_invoice_number = NULL,
      verification_error = NULL,
      invoice_entries = '[]'::jsonb,
      invoice_attempt_count = 0,
      last_activity_at = NOW()
  WHERE id = query_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── 6. submit_invoice_number now redirects to add_invoice_entry ──────────
-- Old single-invoice flow is replaced by add_invoice_entry. Keep the old RPC
-- name as a redirect for any legacy callers (it adds an entry covering ALL
-- cartoons + lots — i.e. the single-invoice behaviour).
CREATE OR REPLACE FUNCTION public.submit_invoice_number(
  query_id UUID,
  invoice TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  q public.queries%ROWTYPE;
BEGIN
  SELECT cartoons, lots INTO q FROM public.queries WHERE id = query_id;
  RETURN public.add_invoice_entry(
    query_id,
    invoice,
    COALESCE(q.cartoons, 0),
    COALESCE(q.lots, 0)
  );
END;
$$;
