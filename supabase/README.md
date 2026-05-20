# `supabase/` — Backend schema & policies

Everything Postgres-side for the Supabase port lives here.

```
supabase/
├── migrations/
│   ├── 001_initial_schema.sql       — tables, enums, indexes, the last_synced trigger
│   ├── 002_rls_policies.sql         — Row-Level Security (mirrors the Firestore rules)
│   └── 003_functions_and_triggers.sql — atomic state-machine RPC functions
└── seed.sql                          — optional starter data for fresh dev projects
```

## How to apply

Apply the three migrations **in order**, on a fresh Supabase project:

**Option A — Supabase Dashboard (easiest)**
1. Open your project at https://app.supabase.com
2. Go to **SQL Editor** → **New query**
3. Paste the contents of `001_initial_schema.sql`, click **Run**
4. Repeat for `002_rls_policies.sql`, then `003_functions_and_triggers.sql`

**Option B — Supabase CLI**
```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push
```

The CLI will read everything in `migrations/` and apply in lexicographic order.

## What each migration does

### `001_initial_schema.sql`
- Enums: `user_role` (owner, salesperson, accounts, dispatch), `query_status` (10-state machine + 4 legacy values for backward-compat).
- Tables: `users`, `customers_master`, `products_master`, `queries`, `salesperson_stats`, `settings`.
- `queries.items`, `queries.snooze_history`, `queries.dispatch_history`, `users.gamification` are all JSONB — same shape as the Firestore docs.
- `CHECK (dispatched_sets <= required_sets)` constraint to prevent the §6 over-dispatch bug.
- Indexes on hot read paths: `queries.status`, `queries.claimed_by_user_id`, `queries.last_activity_at` (for the time-windowed leaderboard).
- A `set_last_synced` trigger on `customers_master` and `products_master` that bumps `last_synced` whenever the row is modified. The app's delta sync depends on this.

### `002_rls_policies.sql`
Two helpers:
- `current_user_role()` — looks up `auth.uid()` in `public.users`, returns the role
- `is_active_user()` — returns true if the row exists and `is_active = true`

Then per-table policies:
- `users` — every signed-in user can read; only the row owner can update self; only role=owner can insert/delete
- `queries` — visible to any active user. Inserts allowed for owner/salesperson. Updates locked down to the assigned salesperson, accounts, or owner (mirroring the Firestore rules).
- `customers_master`, `products_master` — read for any signed-in user, write only for owner (sync uses service-role and bypasses RLS).
- `salesperson_stats` — read for any active user, write only via the stored functions (no client-side writes).
- `settings` — read for any active user, write only by owner.

### `003_functions_and_triggers.sql`
SECURITY DEFINER functions, each returning `JSONB {success, message, ...}`:
- `claim_query(p_query_id, p_user_id, p_user_name)` — atomic claim
- `snooze_query(p_query_id, p_until, p_reason)` — sets status + history
- `unsnooze_query(p_query_id)` — back to claimed_by_sales
- `auto_unsnooze_expired()` — called from a periodic check or cron
- `mark_won(...)`, `mark_lost_cancelled(...)`, `cancel_verification_failed(...)`, `submit_invoice_number(...)`, `flag_back_to_sales(...)`, `update_dispatched_sets(...)`
- `is_valid_transition(from_status, to_status)` — internal guard used by the above

`GRANT EXECUTE TO authenticated` is set on each, so the React Native client can call them as `supabase.rpc('claim_query', { ... })`.

## seed.sql

Optional starter data. **Do not run on a production project** — it inserts placeholder users and one sample query. Useful for local dev or a fresh test project. See the file's header for details.

## Resetting a dev project

```sql
-- Run this in the SQL editor to nuke and reapply (DEV ONLY)
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres, anon, authenticated, service_role;
-- then re-run the three migrations
```

## Going forward

When you add a column or function, **create a new migration file** (`004_*.sql`, `005_*.sql`, ...). Don't edit applied migrations — Supabase tracks which have been applied and treats edits as drift.
