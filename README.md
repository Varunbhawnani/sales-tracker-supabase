# Sales Tracker — Supabase Edition

A complete sales-tracking ERP for a shoe distribution business. Salespersons log customer queries, claim them, mark them won/lost. Accounts verifies invoices against Tally Prime. Dispatch logs shipments. Owner sees everything.

Runs as a **mobile app (Android, iOS) and a web app** from one codebase (React Native + Expo). Data lives in **Supabase (PostgreSQL)**. Tally Prime integration happens through two small Node.js scripts running on the Windows machine where Tally is installed.

This is the **Supabase port** of an older Firebase version. The business logic, screens, and Tally bridge are identical to the Firebase original — only the backend database, auth, and security rules were swapped.

---

## Table of contents

1. [What the system does](#1-what-the-system-does)
2. [Architecture / how everything connects](#2-architecture--how-everything-connects)
3. [File layout](#3-file-layout)
4. [Tech stack](#4-tech-stack)
5. [Database design](#5-database-design)
6. [The 10-state workflow](#6-the-10-state-workflow)
7. [Caching & delta-sync (how the app stays fast)](#7-caching--delta-sync-how-the-app-stays-fast)
8. [Realtime updates — how the app stays in sync across devices](#8-realtime-updates--how-the-app-stays-in-sync-across-devices)
9. [In-app notifications (the bell)](#9-in-app-notifications-the-bell)
10. [Safeguards: 5-try invoice lock, party-name cross-check, duplicate-invoice dedup](#10-safeguards-5-try-invoice-lock-party-name-cross-check-duplicate-invoice-dedup)
11. [Setup — one-time, end-to-end](#11-setup--one-time-end-to-end)
12. [Deploying for your team (web + mobile)](#12-deploying-for-your-team-web--mobile)
13. [Day-to-day operations](#13-day-to-day-operations)
14. [Optional: PM2 auto-restart, Windows auto-login, etc.](#14-optional-pm2-auto-restart-windows-auto-login-etc)
15. [Tally pricing — known limitation in your setup](#15-tally-pricing--known-limitation-in-your-setup)
16. [Other known limitations & edge cases](#16-other-known-limitations--edge-cases)
17. [Troubleshooting](#17-troubleshooting)
18. [Files to know](#18-files-to-know)

---

## 1. What the system does

A salesperson is in front of a customer. The customer says they want 50 sets of shoes. The salesperson:

1. Opens the app, picks the customer from a dropdown (data flowing from Tally Sundry Debtors).
2. Picks products + quantity.
3. Submits — the query lands in the Feed for everyone to see.
4. Same salesperson (or another) claims it. They negotiate. If won, they mark it **Won**.
5. The accounts team (a different role) sees the won query, types in the Tally invoice number once the actual invoice is cut.
6. The system auto-verifies the invoice against Tally within seconds. Cross-checks that the invoice's party matches the query's customer.
7. Dispatch sees the verified query, logs shipments as they go out — partial or full.
8. Owner sees the entire pipeline at a glance: who claimed what, who's stuck, who's winning, who's losing.

The whole flow is visible to the owner. Each step is gated by role (salesperson can't act as accounts, etc.) via Row-Level Security in Postgres.

---

## 2. Architecture / how everything connects

```
   ┌─────────────────────────────────┐
   │  Salesperson / Accounts /       │
   │  Dispatch / Owner (humans)      │
   └────────────┬────────────────────┘
                │  log in
                ▼
   ┌─────────────────────────────────┐         ┌──────────────────────┐
   │  Mobile app (Expo Go / APK)     │         │  Web app (browser)   │
   │  + cached customer/product list │◄───────►│  (same React code,   │
   └────────────┬────────────────────┘         │   served from Vercel)│
                │                              └──────────┬───────────┘
                │  authenticated requests                 │
                ▼                                         ▼
            ┌───────────────────────────────────────────────────┐
            │             SUPABASE (cloud, free tier)           │
            │  ┌──────────────────────────────────────────────┐ │
            │  │ Postgres tables:                             │ │
            │  │   users, queries, customers_master,          │ │
            │  │   products_master, salesperson_stats,        │ │
            │  │   settings                                   │ │
            │  │                                              │ │
            │  │ Row-Level Security: enforces role rules      │ │
            │  │ RPC functions: claim_query, mark_won,        │ │
            │  │   submit_invoice, update_dispatched, ...     │ │
            │  │                                              │ │
            │  │ Realtime: pushes row changes to subscribers  │ │
            │  └──────────────────────────────────────────────┘ │
            └───────────────────────────────────────────────────┘
                       ▲                          ▲
                       │ writes verified-status   │ writes customer +
                       │ on each invoice          │ product master data
                       │                          │
            ┌──────────┴──────────┐   ┌──────────┴──────────┐
            │  tally-bridge.js    │   │  tally-sync.js      │
            │  (Realtime listener │   │  (5-min cron)       │
            │   for pending       │   │                     │
            │   verifications)    │   │                     │
            └──────────┬──────────┘   └──────────┬──────────┘
                       │                          │
                       │  XML over HTTP           │
                       ▼                          ▼
            ┌─────────────────────────────────────────────────┐
            │  WINDOWS MACHINE (the "cloud server")           │
            │                                                 │
            │  ┌──────────────────────────────┐               │
            │  │ Tally Prime (always open,    │               │
            │  │ company file loaded, HTTP    │               │
            │  │ port 9003 listening)         │               │
            │  └──────────────────────────────┘               │
            └─────────────────────────────────────────────────┘
```

**Three things must always be running:**
- **Tally Prime** with your company file loaded, HTTP port open (usually `9003`).
- **`tally-bridge.js`** — listens to Supabase for pending verifications, talks to Tally, writes the result back.
- **`tally-sync.js`** — every 5 minutes, pulls customer + stock-item changes from Tally and upserts them into Supabase.

Without these, the app still works for create/claim/won — but invoice verification stops, and new customers/products you add in Tally don't appear in the dropdown.

---

## 3. File layout

```
sales-tracker-supabase/
├── README.md                     ← this file
├── SUPABASE_SETUP.md             ← step-by-step Supabase setup
├── package.json
├── app.json
├── eas.json                      ← EAS build profiles (Android/iOS)
├── .env.example                  ← template for Supabase + Tally env vars
├── .env                          ← (you create this, never committed)
├── .gitignore
├── App.js                        ← app entry point
├── index.js                      ← Expo registers the root component here
│
├── supabase/                     ← the backend
│   ├── migrations/  (apply IN ORDER in Supabase SQL Editor)
│   │   ├── 001_initial_schema.sql          (tables, enums, indexes)
│   │   ├── 002_rls_policies.sql            (Row-Level Security per role)
│   │   ├── 003_functions_and_triggers.sql  (atomic state-machine RPCs)
│   │   ├── 004_invoice_dedup.sql           (unique partial index — no two queries can verify with the same invoice)
│   │   ├── 005_admin_create_user.sql       (Postgres-side user creation — bypasses signup/email)
│   │   ├── 006_invoice_attempt_lock.sql    (5-try lock on invoice verification + admin-reset RPC)
│   │   ├── 007_fix_dispatch_cast.sql       (enum cast fix in update_dispatched_sets)
│   │   ├── 008_enable_realtime.sql         (adds every table to supabase_realtime publication)
│   │   └── 009_notifications.sql           (notifications table + trigger + bell-style RLS)
│   ├── seed.sql                  ← optional starter data
│   └── README.md                 ← what each migration does
│
├── src/
│   ├── lib/
│   │   └── supabase.js           ← Supabase client setup (web + native)
│   ├── contexts/
│   │   └── AuthContext.js        ← login, logout, session, role helpers
│   ├── navigation/
│   │   └── AppNavigator.js       ← top-bar + sidebar (web), bottom tabs (native)
│   ├── services/
│   │   ├── queryService.js       ← query CRUD + RPC calls (state machine, debounced realtime, AppState refresh, local event bus)
│   │   ├── authService.js        ← user CRUD via admin_create_user RPC
│   │   ├── masterDataService.js  ← cached customer/product list + delta sync
│   │   ├── statsService.js       ← leaderboard data
│   │   ├── settingsService.js
│   │   ├── exportService.js + exportShare.{native,web}.js
│   │   ├── notificationService.js  ← Expo push tokens (mobile only — not currently used)
│   │   └── notificationsService.js ← in-app bell notifications (the bell icon you see in headers)
│   ├── screens/                  ← all 10 screens
│   │   ├── LoginScreen.js
│   │   ├── FeedScreen.js
│   │   ├── NewQueryScreen.js
│   │   ├── QueryDetailScreen.js
│   │   ├── AccountsDashboardScreen.js
│   │   ├── DispatchDashboardScreen.js
│   │   ├── OwnerDashboardScreen.js
│   │   ├── AdminScreen.js
│   │   ├── LeaderboardScreen.js
│   │   └── MyStatsScreen.js
│   ├── components/               ← BottomSheet, StatusBadge, ProductSelector, NotificationBell, etc.
│   └── utils/                    ← constants, formatUtils, timeUtils
│
└── tally/                              ← Windows-server scripts
    ├── tally-bridge.js                  ← verifies invoices against Tally Day Book (with party-name cross-check, duplicate dedup, 5-try counter)
    ├── tally-sync.js                    ← every 5 min pulls customer + product changes
    ├── tally-price-debug.js             ← (diagnostic) inspect how prices live in your Tally
    ├── tally-pricelist-debug.js         ← (diagnostic) safer follow-up — query stock groups
    ├── tally-pricenested-debug.js       ← (diagnostic) targeted item-level price queries
    ├── package.json                     ← scripts' own deps
    ├── .env.example
    ├── .env                             ← (you create this, never committed)
    └── README.md                        ← Tally-side setup notes
```

---

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| **App framework** | React Native + Expo SDK 54 | Single codebase → Android, iOS, web. OTA updates. Free EAS Build tier. |
| **Web rendering** | react-native-web | Same React Native components render to DOM. No separate web app needed. |
| **Database** | Supabase Postgres (free tier) | Real SQL, no daily caps, generous free quota, easy auth + realtime built in. |
| **Auth** | Supabase Auth (email/password) | Username → `username@salestracker.app` is the synthetic email format. |
| **Realtime updates** | Supabase Realtime (Postgres changes channel) | Same UX as Firestore's `onSnapshot` but over Postgres logical replication. |
| **State-machine logic** | Postgres SECURITY DEFINER functions | Atomic transitions can't be bypassed by a misbehaving client. |
| **Access control** | Postgres Row-Level Security | Each role only sees / writes what their role allows. |
| **Tally connector** | Custom Node.js + axios + fast-xml-parser | Talks to Tally's HTTP-XML API (port 9003) over the LAN. |
| **Master-data cache** | AsyncStorage (mobile) / localStorage (web) | Last_synced timestamp watermark drives delta sync. |
| **Web hosting** | Vercel free tier (or Netlify, Cloudflare Pages) | Static export from `npx expo export -p web`. |
| **Mobile distribution** | EAS Build → APK / IPA + EAS Update OTA | Build once in cloud, share APK via WhatsApp. Future updates flow OTA. |

---

## 5. Database design

Six tables. All snake_case in DB; the service layer maps to camelCase before screens see it.

### `users`
One row per human who can log in. References `auth.users.id`. Holds name, username, email, role, is_active, expo_push_token, gamification.

### `customers_master`
Mirror of Tally's Sundry Debtors. Keyed by GUID (Tally's stable identifier). Includes `tally_alter_id` (delta watermark), `category` (A/B/C/D customer grade), `price_level` (which price tier this customer gets), `last_synced` (read-side delta watermark).

### `products_master`
Mirror of Tally's Stock Items. Keyed by GUID. Holds `price` and a JSONB `price_tiers` like `{OS: 231, OS1: 245, FO: 220}` — picked based on the customer's `price_level`.

### `queries`
The core table. One row per customer query. Columns track every state-machine field: who created it, who claimed it, what items, dispatched count, dispatch history (JSONB array), snooze history (JSONB array), invoice number, verification timestamps, gamification timings.

### `salesperson_stats`
One row per salesperson. Cached counters: `total_claimed`, `total_successful`, `total_unsuccessful`, `total_sets_sold`. Updated atomically inside the RPC functions, never directly writable from the client.

### `settings`
Single row (`id = 'app'`). Holds the configurable thresholds: gone-quiet days, SLA targets for sales/accounts/dispatch escalation.

### Indexes
- `queries.status`, `queries.claimed_by_user_id` for the Feed filters.
- `queries.last_activity_at` for the time-windowed leaderboard.
- `queries.tally_invoice_number` with a **partial unique index** for `status IN (verified, partial, completed)` — defense against the duplicate-invoice bug at the DB level.

---

## 6. The 10-state workflow

```
open_query
    │ claim_query()
    ▼
claimed_by_sales ──snooze_query()──► snoozed ──unsnooze_query()──► claimed_by_sales
    │                                    │ (auto-unsnooze when follow_up_date hits)
    │ mark_lost_cancelled()              │ mark_lost_cancelled()
    ▼                                    ▼
lost_cancelled                       lost_cancelled
    │
mark_won()
    ▼
won_pending_accounts ──submit_invoice_number()──► pending_verification
                                                      │
                              (Tally bridge auto-checks invoice + party)
                                  /                        \
                            verified                      invoice not found
                                /                          OR party mismatch
                                ▼                            ▼
              verified_pending_dispatch              verification_failed ──flag_back_to_sales()──► won_pending_accounts
                          │                                  │ cancel_verification_failed()
                          │ update_dispatched_sets() (partial)  ▼
                          ▼                              lost_cancelled
              partially_dispatched
                          │ update_dispatched_sets() (last)
                          ▼
                      completed
```

Every transition runs server-side as a stored PostgreSQL function (`claim_query`, `mark_won`, `submit_invoice_number`, etc.). The function:
1. Locks the row (`SELECT ... FOR UPDATE`).
2. Verifies the actor is allowed to make this transition (claimer-only checks, role checks).
3. Confirms `is_valid_transition(current, target)` returns true.
4. Updates the row, updates `salesperson_stats` counters, returns `{success, message}` JSON.

A malicious client can't skip steps because the only way to change state is via these functions.

---

## 7. Caching & delta-sync (how the app stays fast)

The Feed and the New Query dropdown can't wait 3 seconds to load the customer / product list. So:

**Customer + product master data:**
- On first launch, the app pulls everything from `customers_master` and `products_master` and stashes it in AsyncStorage (mobile) / localStorage (web).
- On every subsequent launch, it reads the cache instantly (under 100 ms even on a slow connection).
- Then, in the background, it fetches only rows where `last_synced > local_watermark`. Typically a handful of rows.
- A trigger on the DB bumps `last_synced` to `NOW()` whenever a row is upserted (which Tally-sync does every 5 minutes).
- Every 7 days, the app forces a full resync as a self-heal.

**Queries (the Feed):**
- Subscribes via Supabase Realtime to the 50 most-recent queries. New inserts / updates flow in within ~1 second.
- Full Feed is not cached — it's small (capped at 50) and changes constantly.

**Stats / leaderboards:**
- `salesperson_stats` table is essentially a materialized counter, written atomically by RPC functions on every mark-won / mark-lost.
- All-time leaderboard is one read per user. Weekly/monthly leaderboards recompute from `queries` with a `last_activity_at` filter.

---

## 8. Setup — one-time, end-to-end

### 8.1. Create the Supabase project

1. Go to https://app.supabase.com → **New project**.
2. Name: `sales-tracker`, region: `Mumbai (ap-south-1)`, strong DB password.
3. Wait ~2 minutes for provisioning.

### 8.2. Apply the four SQL migrations in order

In Supabase Dashboard → **SQL Editor → New query**, paste-and-run each of these in order:

1. `supabase/migrations/001_initial_schema.sql` (tables, enums, indexes)
2. `supabase/migrations/002_rls_policies.sql` (Row-Level Security)
3. `supabase/migrations/003_functions_and_triggers.sql` (atomic RPCs)
4. `supabase/migrations/004_invoice_dedup.sql` (partial unique index)

Each should print "Success. No rows returned."

### 8.3. Create the first user (owner)

1. **Authentication → Users → Add user → Create new user.**
2. Email: `owner@salestracker.app`, Password: anything ≥ 6 chars (save it), **check "Auto Confirm User"**.
3. Copy the user's **UID**.
4. SQL Editor → run:
```sql
INSERT INTO public.users (id, name, username, email, role, is_active)
VALUES ('<uid-from-step-3>', 'Your Name', 'owner', 'owner@salestracker.app', 'owner', true);
```

### 8.4. Configure the app

```bash
cd sales-tracker-supabase
cp .env.example .env
```

Edit `.env` and paste your real values:
```
EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<the "anon public" key from Project Settings → API>
```

**Tip:** Don't paste the anon key in TextEdit — macOS Smart Substitution turns hyphens into em-dashes and silently breaks the key. Use the terminal instead:
```bash
echo "EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co" > .env
echo "EXPO_PUBLIC_SUPABASE_ANON_KEY=$(pbpaste)" >> .env
```
(after clicking the copy icon next to the anon key in the dashboard).

### 8.5. Run the app locally

```bash
npm install
npx expo start --web      # web at http://localhost:8081
# or:
npx expo start            # scan QR with Expo Go for mobile
```

Log in with `owner` and your password.

### 8.6. Set up the Tally scripts (Windows machine where Tally runs)

1. On Windows, install **Node.js 18+** from https://nodejs.org/en/download.
2. Copy the `tally/` folder to `C:\sales-tracker\tally\`.
3. Edit `C:\sales-tracker\tally\.env`:
```
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<the service_role key from API → secret>
TALLY_URL=http://localhost:9003
TALLY_COMPANY=<your Tally company name, exact spelling>
TALLY_USER=<your Tally username>
TALLY_PASS=<your Tally password>
TALLY_LOOKBACK_DAYS=14
TALLY_FORWARD_DAYS=14
```
4. Install dependencies + start:
```cmd
cd C:\sales-tracker\tally
npm install
node tally-bridge.js     :: in one window
node tally-sync.js       :: in another window
```

You should see startup banners showing the Tally company and lookback window. Within 5 minutes the first sync cycle prints "Customers synced. Products synced."

### 8.7. Add your real team

Owner → Admin tab → **+ Add User** for each:
- Salespersons (role: Salesperson)
- Accounts staff (role: Accounts)
- Dispatch staff (role: Dispatch)

Hand them their credentials privately.

### 8.8. Disable public signups

Supabase Dashboard → **Authentication → Sign In / Providers → Email** → uncheck **"Enable email signups"** → Save.

Now random people can't sign themselves up. Only the Admin panel can create users.

---

## 9. Deploying for your team (web + mobile)

### Web deployment to Vercel (free)

```bash
cd sales-tracker-supabase
npx expo export -p web   # creates dist/
npm i -g vercel
vercel login
vercel --prod
```

When prompted:
- "Code directory?" → press Enter (uses current folder)
- "Override settings?" → Y → Output directory: `dist`

After deploy, in the Vercel dashboard for your project → **Settings → Environment Variables**, add:
- `EXPO_PUBLIC_SUPABASE_URL` → your project URL
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` → the anon key

Redeploy: `vercel --prod`. You'll get a URL like `https://sales-tracker-xyz.vercel.app`. Anyone with a valid login can use it from any browser, anywhere.

### Mobile (Android APK)

```bash
npm i -g eas-cli
eas login                                 # sign up free at expo.dev
eas build:configure                       # one-time
eas build -p android --profile preview
```

EAS builds the APK in the cloud (~10–15 minutes). You get a download link — share via WhatsApp / Drive. Team installs once. Future updates flow over-the-air:

```bash
eas update --branch preview --message "what changed"
```

iOS needs an Apple Developer account ($99/year) — skip unless someone uses iPhone.

---

## 10. Day-to-day operations

### Keeping the Windows machine alive

The Tally machine must stay running 24/7 with Tally Prime open and the correct company loaded. When you connect via RDP and leave:

| Action | Effect |
|---|---|
| **Close the RDP window** (X) or `Start → Disconnect` | Windows session stays alive. Tally + scripts keep running. ✅ Do this. |
| **Sign Out / Log Off** | Windows kills the session. Tally closes. Scripts die. ❌ Avoid. |

### How to tell if the bridge / sync are healthy

Two black cmd windows on the Windows machine. Each shows a "heartbeat" — the bridge logs each verification, the sync logs every 5-minute cycle. If they're scrolling, you're good.

The **Accounts Dashboard** in the app also shows warnings:
- After 10 min in `pending_verification` → yellow "⏳ Awaiting verification…"
- After 30 min → red "🔴 Bridge may be down. Escalate to Admin."

These are your alarm bell. If you see them, RDP into Windows and check the cmd windows.

### Monitoring checklist (weekly, 2 min)

| Check | Where | Healthy if |
|---|---|---|
| Supabase DB size | Dashboard → Reports | < 500 MB (free tier limit) |
| Supabase requests / day | Dashboard → Reports | < ~50k (you'll be well under) |
| Bridge logs | Windows cmd window | scrolling, no repeated `🔐 Tally auth failed` |
| Sync logs | Windows cmd window | every 5 min you see "Customers synced / Products synced" |

---

## 11. Upcoming additions (PM2, auto-Tally launch, etc.)

These are operational hardening steps. **The system works without them**, but they make it self-healing against reboots and crashes.

### 11.1. PM2 (auto-restart the scripts)

Today, the Tally scripts run in two manually-launched cmd windows. If they crash, or if Windows reboots, you have to RDP in and start them again manually.

**PM2** is a small "babysitter" that:
- Auto-restarts the scripts within 1 second if they crash
- Re-launches them automatically every time Windows boots

#### How to set up PM2 (one-time, ~5 min)

Requires **admin rights** on the Windows machine. RDP in as admin (use Microsoft Remote Desktop on Mac with admin credentials — not TSplus, which doesn't expose admin shell).

1. Open Command Prompt **as Administrator**: press Win key → type `cmd` → right-click → **Run as administrator** → Yes on the UAC dialog.

2. Run these commands:
```cmd
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd C:\sales-tracker\tally
pm2 start tally-bridge.js --name tally-bridge
pm2 start tally-sync.js --name tally-sync
pm2 save
```

3. Verify both online:
```cmd
pm2 list
```
You should see a table with both as `online`.

4. **Close the manually-launched cmd windows** (Ctrl+C, then X) — otherwise you'll have two copies running, which double-processes every invoice.

5. **Test reboot survival**: restart Windows. After it comes back and Tally auto-opens, run `pm2 list` again. Both should still show online — PM2 brought them back automatically.

#### Useful PM2 commands

| Command | What it does |
|---|---|
| `pm2 list` | Show status |
| `pm2 logs tally-bridge` | Live tail bridge logs (Ctrl+C to exit, script keeps running) |
| `pm2 logs tally-sync` | Same for sync |
| `pm2 restart tally-bridge` | Force restart (after `.env` change) |
| `pm2 stop tally-sync` | Pause |
| `pm2 delete tally-bridge` | Remove from PM2 |

### 11.2. Windows auto-login + Tally in Startup folder

Even with PM2, if Windows reboots and no user is logged in, Tally doesn't auto-start (PM2 brings up the scripts, but they have no Tally to talk to).

Fix: configure Windows to auto-log-in to a specific user account and put a Tally shortcut in that user's Startup folder.

1. On the Windows machine, press Win+R → type `netplwiz` → uncheck "Users must enter a username and password" → enter the user's password when prompted → OK.
2. Open File Explorer → address bar → type `shell:startup` → Enter.
3. Drag a shortcut to `Tally Prime` into that folder.
4. Inside Tally: **F1 → Configure → Startup → Auto-load the production company on launch**.

Now: Windows reboot → auto-login → Tally launches → company loads → PM2 (already on Windows service) starts → scripts come online → everything's back in ~2 minutes with zero human intervention.

### 11.3. Nightly Tally restart (defensive)

Tally can develop memory issues if open for weeks. Schedule a Task Scheduler job to:
- Every night at 2 AM: kill Tally, wait 30 sec, relaunch.

The scripts retry on their next 5-minute cycle, so the brief interruption is invisible to users (and at 2 AM nobody's using the app anyway).

### 11.4. India Standard Time on the cloud server

If your Windows machine's clock isn't on IST, the `TALLY_LOOKBACK_DAYS` window can drift by a day. Fix once:

In Command Prompt (as admin):
```cmd
tzutil /s "India Standard Time"
```
Persistent across reboots. Five-second task.

---

## 12. Known limitations & edge cases

### Recently fixed ✅

| Limitation | Status |
|---|---|
| 3-day Tally lookback (backdated / future-dated invoices failed) | ✅ Now `TALLY_LOOKBACK_DAYS` / `TALLY_FORWARD_DAYS`, default 14/14 |
| Salesperson could enter wrong invoice number; bridge wouldn't catch | ✅ Bridge now cross-checks party name on the Tally voucher vs query's customer |
| Same invoice could verify two different queries | ✅ Bridge rejects duplicates with a clear message; partial unique index in Postgres enforces it at DB level too |
| Auth-failure looped forever | ✅ 5-min cooldown after Tally rejects login (carried over from the Firebase original) |

### Still present (deferred by design or low priority)

| Limitation | Workaround |
|---|---|
| Tally deletions don't propagate. Deleted customer in Tally stays in Supabase. | Acceptable per your call. Old customers just clutter the dropdown. Manually delete from Supabase if needed. |
| No "undo mark-won" button (24-hour window) | Salesperson asks accounts to flag back to sales. |
| No "queries open more than X days" alert on Owner Dashboard | Owner scrolls the Feed periodically. |
| Verified-invoice cross-check only matches party name, not amount or item list | Party name is the highest-value signal. Amount checks are tricky because of GST and partial dispatch. Owner spot-checks high-value sales. |
| Restoring Tally from a backup confuses the sync (AlterID watermark too high) | After restore: delete `C:\sales-tracker\tally\sync-track-masters.json` and restart sync. Documented in `tally/README.md`. |

---

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Login fails with "Invalid username or password" but credentials look right | The anon key in `.env` has an em-dash from macOS Smart Substitution. Open the browser console — you'll see `non ISO-8859-1 code point` errors. | Re-paste the anon key via terminal: `echo "EXPO_PUBLIC_SUPABASE_ANON_KEY=$(pbpaste)" >> .env`, then restart Expo with `--clear`. |
| App shows "Cannot resolve entry file" | `package.json` says `main: index.js` but no `index.js` exists | Create `index.js` with `import { registerRootComponent } from 'expo'; import App from './App'; registerRootComponent(App);` |
| User can log in but immediately gets logged out | No matching row in `public.users` for that auth user. The auth account exists but isn't whitelisted. | Insert a row in `public.users` with the same UID (see step 8.3). |
| Invoice stays stuck on `pending_verification` for 30+ min | Bridge is down, or Tally is closed, or wrong company is loaded | RDP into Windows. Check both cmd windows are running (or `pm2 list`). Confirm Tally is open with the right company. |
| Bridge logs `🔐 Tally auth failed` repeatedly | `TALLY_USER` / `TALLY_PASS` wrong | Fix `.env`, restart bridge. The 5-min cooldown automatically pauses retries to avoid hammering Tally. |
| Bridge logs `Authentication Failed` but credentials look right | Tally's HTTP API doesn't expect those credentials there. Some Tally setups require the **TallyPrime → F1 → Users** password, not the company-open password. | Check the actual Tally user / password matrix. |
| Sync says "All up to date" but Supabase is empty | The `sync-track-masters.json` watermark is too high (often after a Tally backup restore) | Delete `sync-track-masters.json` → `pm2 restart tally-sync` → it'll re-pull everything. |
| Customers verify but invoice is for "the wrong customer" | New cross-check is doing its job — the salesperson typed the wrong invoice. | Re-enter the correct invoice in the Accounts Dashboard. |
| Vercel deploy shows blank page | Env vars not set, or build output directory misconfigured | In Vercel project → Settings → Environment Variables: set both `EXPO_PUBLIC_SUPABASE_*`. Redeploy. |

---

## 14. Files to know

If something's broken, these are the files to check first:

| What's broken | File to look at |
|---|---|
| Login | `src/contexts/AuthContext.js` |
| Feed not loading | `src/services/queryService.js` (subscribeToQueries) |
| Customer dropdown empty | `src/services/masterDataService.js` |
| State transition not working | `supabase/migrations/003_functions_and_triggers.sql` |
| RLS rejecting a write | `supabase/migrations/002_rls_policies.sql` |
| Tally invoice verification | `tally/tally-bridge.js` |
| Tally master-data sync | `tally/tally-sync.js` |
| Time period filters / leaderboard | `src/services/statsService.js` + `src/utils/timeUtils.js` |
| Excel export | `src/services/exportService.js` + `exportShare.{native,web}.js` |

---

## TL;DR — the 5 things to remember

1. **3 things must always run** on the Windows machine: Tally Prime (with the right company), `tally-bridge.js`, `tally-sync.js`. The first is GUI, the next two are cmd / PM2.
2. **The app works on web (Vercel URL) and mobile (Android APK from EAS Build)** — same codebase, no extra work.
3. **Never click Sign Out on the Windows machine** — just close the RDP window. Sign Out kills everything.
4. **Setting up PM2 + Windows auto-login** (section 11) makes the whole thing self-healing through crashes and reboots. Without it, you'll occasionally need to RDP in after a reboot.
5. **Cost at your scale: ₹0/month**. Supabase Free, Vercel Free, EAS Free. The Windows machine is your only ongoing cost.

When you forget how this works in 6 months, this README is here. Good luck.
