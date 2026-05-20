# Supabase Setup — Step by Step

Follow these one at a time. Total time: 30–45 minutes for a first-time setup.

---

## Step 1 — Create a Supabase project (5 min)

1. Go to **https://supabase.com** → sign up (free).
2. Click **New Project**.
3. Give it a name (e.g. `sales-tracker`), set a database password (save this — you'll need it later), pick a region close to your users (Mumbai or Singapore for India), select the **Free** plan.
4. Wait ~2 minutes for the project to provision.
5. Once ready, you land on the project dashboard.

---

## Step 2 — Grab your API keys (2 min)

Project dashboard → **Settings** (gear icon, left sidebar) → **API**.

Copy three values:

| What | Used by | Looks like |
|---|---|---|
| **Project URL** | Mobile app + Tally scripts | `https://abc123.supabase.co` |
| **anon public key** | Mobile app (safe to ship in client) | A long JWT-looking string |
| **service_role key** | Tally scripts only (NEVER ship in client) | Another long JWT |

The anon key is meant to be public — it's safe in client code. RLS protects your data.
The service_role key bypasses RLS — it's like the firebase-admin key. Keep it server-side only.

---

## Step 3 — Run the database migrations (5 min)

Project dashboard → **SQL Editor** (in the left sidebar).

Run these three files **in order**:

### 3a. Initial schema

Click **New query**, paste the entire contents of `supabase/migrations/001_initial_schema.sql` from this repo, hit **Run**.

This creates the `users`, `queries`, `salesperson_stats`, `customers_master`, `products_master`, and `settings` tables along with their indexes.

You should see something like `Success. No rows returned`.

### 3b. RLS policies

New query → paste `supabase/migrations/002_rls_policies.sql` → Run.

This locks down each table so users can only do what their role allows.

### 3c. Atomic functions

New query → paste `supabase/migrations/003_functions_and_triggers.sql` → Run.

This creates the stored procedures (`claim_query`, `mark_won`, etc.) that handle atomic state transitions server-side.

### Verify

Dashboard → **Database** → **Tables** (left sidebar). You should see six tables: `users`, `queries`, `salesperson_stats`, `customers_master`, `products_master`, `settings`.

---

## Step 4 — Create the owner account (3 min)

You need one initial user to log in as. Supabase Auth doesn't auto-create the matching row in your `users` table, so you'll do it manually for the first one (the app handles it automatically for users created after).

### 4a. Create the auth user

Dashboard → **Authentication** → **Users** → **Add user** → choose **Create new user**.

- Email: pick any (e.g. `owner@example.com` or your real email)
- Password: pick something secure
- Auto Confirm User: **enable** (otherwise you have to confirm an email)

Save. You'll see the new user in the list.

### 4b. Note the user's UUID

Click the new user → copy their `id` (UUID, looks like `12345678-aaaa-bbbb-cccc-...`).

### 4c. Link to the public users table

Back in SQL Editor:

```sql
INSERT INTO public.users (id, name, username, email, role, is_active)
VALUES (
  '<paste the UUID here>',
  'Owner Name',
  'owner',
  'owner@example.com',
  'owner',
  true
);
```

Done. You now have a working owner account.

---

## Step 5 — Enable Realtime on the queries table (1 min)

Dashboard → **Database** → **Replication** (left sidebar).

Find the `queries` table → toggle **Realtime** to on.

This is what makes the mobile app receive live updates (`postgres_changes` events).

You may also want to enable it on `customers_master` and `products_master` if you want master-data updates to push to clients in real-time. For now, keep it just on `queries` — the masters are delta-synced on each NewQuery open anyway.

---

## Step 6 — Set up the app side (5 min)

In this folder:

```bash
cp .env.example .env
```

Edit `.env` and fill in three values from Step 2:

```
EXPO_PUBLIC_SUPABASE_URL=https://abc123.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJh...
```

Then:

```bash
npm install
npx expo start
```

Scan the QR with Expo Go (mobile) or press `w` to open it in a browser (web).

Log in with the email and password you set up in Step 4. You should land on the (currently empty) Feed screen as an Owner.

---

## Step 7 — Set up the Tally server side (15 min)

Only do this when you're ready to wire up Tally. The mobile app works fine without it; you just won't have customers/products in the dropdown and can't verify invoices.

### 7a. On your Windows Tally server

Copy `tally/tally-sync.js` and `tally/tally-bridge.js` from this repo to the Tally server.

Install dependencies:

```cmd
npm install @supabase/supabase-js dotenv axios fast-xml-parser node-cron
```

### 7b. Configure environment on the Tally server

Create a `.env` file next to the scripts:

```
SUPABASE_URL=https://abc123.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJh...   # the service_role key from Step 2!
                                     # NOT the anon key — this needs to bypass RLS

TALLY_URL=http://localhost:9003
TALLY_COMPANY=Your Real Tally Company Name
TALLY_USER=YourTallyUsername
TALLY_PASS=YourTallyPassword
TALLY_LOOKBACK_DAYS=14
```

### 7c. Start the scripts under PM2

```cmd
npm install -g pm2 pm2-windows-startup
pm2 start tally-sync.js
pm2 start tally-bridge.js
pm2 save
pm2-startup install
```

Both scripts now run 24/7 and auto-restart on crash/reboot.

### 7d. Verify

After ~5 minutes (the sync cron interval), check the Supabase dashboard → **Table Editor** → **customers_master**. You should see your Tally customer ledgers appearing.

If they don't:
- `pm2 logs tally-sync --lines 50` on the server to see what's happening
- Most common cause: wrong `TALLY_COMPANY` name or `TALLY_USER` / `TALLY_PASS` credentials
- See `OPERATIONS_GUIDE.md` from the original Firebase project — the troubleshooting steps are identical

---

## Step 8 (optional) — Deploy the web app (5 min)

The mobile app is the priority — `npx expo export --platform web` followed by deploying the `dist/` folder anywhere.

Recommended: **Vercel** (free, fast, easy):

1. Push this repo to GitHub.
2. Go to **https://vercel.com** → sign in with GitHub.
3. Import the repository.
4. **Framework Preset**: choose "Other" (or "None").
5. **Build command**: `npx expo export --platform web`
6. **Output directory**: `dist`
7. **Environment Variables**: add `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
8. Deploy. You get a URL like `sales-tracker-supabase.vercel.app`.

Or use Netlify (same idea, different UI). Or Cloudflare Pages.

Supabase doesn't host static sites — but every other free hosting service does.

---

## Common gotchas

### "JWT expired" or "invalid JWT"

You're using an old anon key, or the JWT expired (sessions expire after some time). Re-copy the anon key from the Supabase dashboard and update `.env`. If users get this mid-session, the `AuthContext` should handle it gracefully by signing them out and showing the login screen.

### Login fails with "invalid credentials"

Check the `auth.users` table in the Supabase dashboard. Make sure the user exists AND there's a corresponding row in `public.users` with `is_active = true`. The app's auth flow checks both.

### Customer/product dropdown is empty in the app

Check the `customers_master` and `products_master` tables. If they're empty, the Tally sync script hasn't run yet (or isn't running). See Step 7d.

### "Permission denied" errors from the database

RLS is doing its job — your account doesn't have the role to do that action. Check the user's row in `public.users` and confirm the `role` column has the right value.

To debug, run as service-role in the SQL editor to see what's actually in the table.

### Realtime events aren't firing

Check Step 5 — Realtime needs to be explicitly enabled on each table you want to subscribe to.

### The Tally scripts crash on startup

Most likely: `.env` is missing or has wrong values, or `serviceAccountKey.json`-style credentials weren't migrated correctly. The Supabase version uses the `SUPABASE_SERVICE_ROLE_KEY` from `.env` instead of a JSON file.

---

## TL;DR — the eight things you do, in order

1. Create Supabase project at supabase.com
2. Copy URL + anon key + service role key from Settings → API
3. Run the three SQL migrations in order
4. Create the first owner user (in Auth + matching row in `public.users`)
5. Toggle Realtime on for the `queries` table
6. `cp .env.example .env`, fill in values, `npm install`, `npx expo start`
7. (When ready) Copy Tally scripts to server, set `.env` with service role key, run via PM2
8. (Optional) Deploy web to Vercel

Once you've done it once, all subsequent deploys are just `git push` (if connected to Vercel auto-deploy) or `eas update` (for the mobile app).
