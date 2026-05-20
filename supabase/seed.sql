-- ----------------------------------------------------------------------------
-- seed.sql — optional starter data for fresh Supabase projects
--
-- DO NOT run on production. Creates a placeholder owner, one salesperson,
-- two customers, two products, and one OPEN_QUERY.
--
-- Prerequisites:
--   1. Create two auth users in the Supabase dashboard first:
--      - owner@example.com (password: anything)
--      - sales@example.com (password: anything)
--   2. Replace the two UUIDs below with the auth.users.id of those users
--      (Dashboard → Authentication → Users → click user → copy ID).
-- ----------------------------------------------------------------------------

-- ⚠️ Replace these with real auth.uid() values before running ⚠️
\set owner_id '00000000-0000-0000-0000-000000000001'
\set sales_id '00000000-0000-0000-0000-000000000002'

INSERT INTO public.users (id, name, username, email, role, is_active)
VALUES
  (:'owner_id', 'Demo Owner',       'owner',  'owner@example.com', 'owner',       true),
  (:'sales_id', 'Demo Salesperson', 'sales1', 'sales@example.com', 'salesperson', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.customers_master (id, name, guid, tally_alter_id, category, price_level, parent_group, last_synced)
VALUES
  ('cust-seed-001', 'Acme Trading',    'cust-seed-001', 1, 'A', 'Standard', 'Sundry Debtors', NOW()),
  ('cust-seed-002', 'Bharti Footwear', 'cust-seed-002', 1, 'B', 'Standard', 'Sundry Debtors', NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.products_master (id, name, sku, guid, tally_alter_id, unit_type, price, price_tiers, last_synced)
VALUES
  ('prod-seed-001', 'BROTHERS SHOE', 'BROS-001', 'prod-seed-001', 1, 'PRS', 231,
   '{"OS": 231, "OS1": 245, "FO": 220}', NOW()),
  ('prod-seed-002', 'CAMPUS RUN',    'CAMP-002', 'prod-seed-002', 1, 'PRS', 499,
   '{"OS": 499, "OS1": 520, "FO": 480}', NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.settings (id, value)
VALUES ('app', '{"autoUnsnoozeWindowHours": 24, "dispatchedDeadlineHours": 48}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.queries (
  id, party_name, customer_id, items, required_sets, dispatched_sets,
  status, created_by_user_id, created_by_name, created_at, last_activity_at
)
VALUES (
  'query-seed-0001', 'Acme Trading', 'cust-seed-001',
  '[{"productId":"prod-seed-001","name":"BROTHERS SHOE","sets":10,"price":231,"unit":"PRS"}]',
  10, 0, 'open_query',
  :'owner_id', 'Demo Owner', NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
