# Sales Tracker — Supabase Edition

A sales-tracking ERP for a shoe distribution business. Salespeople log customer queries (online / offline), claim them, mark them booked / lost in **cartons + lots**. Accounts verifies invoices against Tally Prime (multi-invoice with a 3-try lock). **Packing** packs the order, **Dispatch** ships it — each team sees the other's queue read-only. The owner has a full view of the pipeline and can scope the whole app to any **godown**; non-owner users automatically only see queries from their own godown. Anyone can assign **tasks** (one-time or recurring) to anyone else; **follow-ups** roll up across the team with an optional date and pick-up-to-rework flow.

Runs as a **mobile app (Android, iOS) and a web app** from one codebase (React Native + Expo). Data lives in **Supabase (PostgreSQL)**. Tally Prime integration runs as two Node.js scripts on the Windows server where Tally is installed.

---

## Table of contents

1. [What the system does](#1-what-the-system-does)
2. [Roles & dashboards](#2-roles--dashboards)
3. [Godowns — how scoping works](#3-godowns--how-scoping-works)
4. [Architecture](#4-architecture)
5. [State workflow](#5-state-workflow)
6. [Database schema](#6-database-schema)
7. [Realtime updates](#7-realtime-updates)
8. [Caching strategy](#8-caching-strategy)
9. [Tally integration](#9-tally-integration)
10. [Tally setup on your cloud Windows server (RDP)](#10-tally-setup-on-your-cloud-windows-server-rdp)
11. [PM2 setup so the scripts survive reboots](#11-pm2-setup-so-the-scripts-survive-reboots)
12. [Day-to-day operations](#12-day-to-day-operations)
13. [Deploying changes (web + mobile OTA)](#13-deploying-changes-web--mobile-ota)
14. [Supabase free-tier usage — where you stand and when to upgrade](#14-supabase-free-tier-usage--where-you-stand-and-when-to-upgrade)
15. [Troubleshooting](#15-troubleshooting)
16. [File layout](#16-file-layout)

---

## 1. What the system does

1. Salesperson opens the app, picks Online or Offline, picks a customer (synced from Tally Sundry Debtors), types a mandatory note, optionally tags products, **picks a godown** (defaults to their own), and submits. The query lands in the live Feed for everyone in that godown.
2. Someone in the same godown claims the query. When booked, they tap **Mark Booked** and enter **cartons + lots** (two separate quantities), plus an optional follow-up note + optional follow-up date.
3. **Accounts** (in the same godown) sees the booked query, enters one or more Tally invoice numbers, and the system auto-verifies each against Tally's Day Book within seconds. Cross-checks the customer name. Rejects duplicate invoice numbers. **3 failed attempts** locks the query — the owner unlocks it or flags it back.
4. Once every invoice is verified and the cartons + lots cover the query total, the query moves to **Packing**. Packing team marks it Packed (3-minute undo). Then **Dispatch** sees it on their dashboard and marks it Dispatched (3-minute undo). Each team can see the *other* team's queue as read-only context.
5. Salespeople get a **Follow-Ups** tab. Each unresolved follow-up lists by upcoming date. Tap **Pick Up** to convert the follow-up back into a workable query — it returns to `claimed_by_sales` and the three actions (Mark Booked / Snooze / Cancel) are available again.
6. Anyone can **assign tasks** to anyone else. Tasks support: one-time / every N days / specific weekdays / day-of-month, with optional start + end dates. Notifications fire on assign + 5 PM + 6 PM of the due date.
7. **Owner** sees the entire pipeline. From a single godown chip in the top bar, the owner can switch the whole app to view a specific godown — Feed, Dashboard, Leaderboard, Follow-Ups all scope to that godown's queries. "All Godowns" shows everything.
8. **Admin** also manages "Role Responsibilities" — per-role lists of duties with multi-step checklists that every user of that role sees as guidance via the 📋 button in their header.

Queries older than 15 days drop out of every list (except Follow-Ups). Salesperson's view caps completed queries to the most recent 10 to keep the feed focused.

---

## 2. Roles & dashboards

| Role | Tabs | What they do |
|---|---|---|
| **Owner** | Feed, Follow-Ups, Tasks, Leaderboard, Dashboard, Admin | Sees everything. Scopes the whole app to any godown via the top-bar chip. Manages users, godowns, role responsibilities, SLAs. |
| **Salesperson** | Feed, Follow-Ups, Tasks, Leaderboard, My Stats | Creates / claims / marks queries. Picks a godown when creating a query (defaults to their own). |
| **Accounts** | Accounts, Tasks | Enters Tally invoice numbers, splits a query across multiple invoices, flags failures back to sales. Sees only their godown's queries. |
| **Packing** | Packing, Tasks | "To Pack" tab editable + "In Dispatch" tab read-only. 3-min undo on Mark Packed. Sees only their godown's queries. |
| **Dispatch** | Dispatch, Tasks | "To Dispatch" tab editable + "In Packing" tab read-only + Completed. 3-min undo on Mark Dispatched. Sees only their godown's queries. |

Stats screens (Leaderboard, My Stats) are **NOT** godown-scoped for non-owners — the whole sales team appears on the leaderboard, regardless of which godown each person is in.

---

## 3. Godowns — how scoping works

A godown is a warehouse / branch. Each user *optionally* has a `godown_id`. Each query (new ones, post-migration 019) *optionally* has a `godown_id`. The matching rule is uniform across roles:

**A query is visible to a non-owner user if:**
- The user has no godown assigned (= "see all"), OR
- The query has no godown (= "visible to all"), OR
- The user's godown matches the query's godown.

**The owner** always sees every query, narrowed by the top-bar chip:
- **All Godowns** → everything
- **Unassigned** → only queries with no godown
- A specific godown → only queries tagged with that godown.

**On New Query**, the salesperson sees a Godown picker:
- Defaults to their assigned godown.
- Can override to any other godown, or pick "None" (visible to everyone).
- Owner sees the picker too, with the same options.

What's **not** godown-scoped: the Leaderboard, My Stats, the in-app notification bell, the tasks list. These stay team-wide. Stats reflect everyone's work; tasks are person-to-person.

What about pre-019 queries that have no `godown_id`? Per design, they fall into the "visible to all" bucket — nothing disappears when migration 019 runs.

---

## 4. Architecture

```
   ┌─────────────────────────────────────┐
   │  Owner / Sales / Accounts /         │
   │  Packing / Dispatch (humans)        │
   └────────────────┬────────────────────┘
                    │ log in
                    ▼
   ┌─────────────────────────────────┐    ┌──────────────────────┐
   │  Mobile app (Android / iOS APK) │    │  Web app (browser)   │
   │  + cached customer/product list │◄──►│  hosted on Vercel    │
   │  via EAS Build + EAS Update     │    │                      │
   └─────────────────┬───────────────┘    └──────────┬───────────┘
                     │                                │
                     │   authenticated requests       │
                     ▼                                ▼
        ┌──────────────────────────────────────────────────┐
        │             SUPABASE (cloud, free plan)          │
        │  ┌─────────────────────────────────────────────┐ │
        │  │  Postgres tables                            │ │
        │  │    users, queries, customers_master,        │ │
        │  │    products_master, salesperson_stats,      │ │
        │  │    settings, notifications, tasks,          │ │
        │  │    godowns, role_responsibilities           │ │
        │  │                                             │ │
        │  │  Row-Level Security: role-based at DB level │ │
        │  │                                             │ │
        │  │  RPC functions (SECURITY DEFINER):          │ │
        │  │    claim_query, mark_won, add_invoice_entry,│ │
        │  │    mark_packed, mark_dispatched,            │ │
        │  │    pickup_follow_up, create_task,           │ │
        │  │    toggle_task, assign_user_godown, …       │ │
        │  │                                             │ │
        │  │  Realtime: streams row changes to clients   │ │
        │  └─────────────────────────────────────────────┘ │
        └──────────────────────────────────────────────────┘
                  ▲                              ▲
                  │ writes verified status       │ writes customers +
                  │ on each invoice              │ products master
                  │                              │
        ┌─────────┴─────────────┐    ┌───────────┴────────────┐
        │   tally-bridge.js     │    │      tally-sync.js     │
        │ (realtime listener +  │    │  (node-cron, every 5   │
        │  initial sweep)       │    │   minutes)             │
        └─────────┬─────────────┘    └───────────┬────────────┘
                  │                              │
                  │  XML over HTTP               │
                  ▼                              ▼
        ┌────────────────────────────────────────────────────┐
        │  CLOUD WINDOWS SERVER (accessed via Remote Desktop)│
        │  ┌──────────────────────────────────────────────┐  │
        │  │  Tally Prime — always open, company loaded,  │  │
        │  │  HTTP port 9003 listening                    │  │
        │  └──────────────────────────────────────────────┘  │
        │  PM2 keeps both scripts alive and auto-restarts    │
        │  them on crash / Windows reboot.                   │
        └────────────────────────────────────────────────────┘
```

Three things must always run on the Windows box: **Tally Prime** with the company loaded, **`tally-bridge.js`** (invoice verifier), and **`tally-sync.js`** (master-data sync). Without these, the app still works for create/claim/mark-booked, but invoice verification stops and new Tally customers/products don't sync.

---

## 5. State workflow

```
open_query
    │ claim_query()
    ▼
claimed_by_sales ──snooze_query()──► snoozed
    │              ◄──unsnooze_query()  (auto-unsnooze on follow_up_date)
    │
    │ mark_lost_cancelled()
    ▼
lost_cancelled

claimed_by_sales ──mark_won(cartons, lots, follow_up_note?, follow_up_date?)──►
    ▼
won_pending_accounts ──add_invoice_entry()──► pending_verification
   ▲                  (one or more entries, each verified independently)
   │                  (3-try lock per entry; admin can reset)
   │
   │ accounts_update_quantity() — edit cartons/lots inline
   │ flag_back_to_sales() — bounce back with a note
   │
   │ All entries verified AND sum(entries.cartons+lots) ≥ query.cartons+lots:
   ▼
verified_pending_dispatch  (is_packed = false → Packing's queue)
    │ mark_packed() / undo_packed() within 3 minutes
    ▼
verified_pending_dispatch  (is_packed = true → Dispatch's queue)
    │ mark_dispatched() / undo_dispatched() within 3 minutes
    ▼
completed

verification_failed  (3 failed attempts on a single entry)
    └─flag_back_to_sales() → won_pending_accounts
    └─cancel_verification_failed() → lost_cancelled

Any query with an unresolved follow-up
    └─pickup_follow_up() → claimed_by_sales (re-opens the 3 actions)
```

Every transition goes through a `SECURITY DEFINER` Postgres function that takes a row lock, validates the actor's role, validates the transition, and bumps `last_activity_at`. The state machine can't be bypassed from a client.

**Packing is a flag, not a status.** The query stays at `verified_pending_dispatch` while `is_packed` flips false → true.

---

## 6. Database schema

Tables (snake_case in DB, camelCase before reaching screens):

| Table | Purpose |
|---|---|
| `users` | One per human. `role` enum: `owner / salesperson / accounts / packing / dispatch` (legacy `operations` retained from a prior merge). `godown_id` optional. |
| `godowns` | Warehouses. Name + active flag. Owner-only writes via RLS. |
| `role_responsibilities` | Per-role reference docs. Each row has `role`, `title`, and a `steps` JSONB array. Owner writes; everyone reads. |
| `customers_master` | Mirror of Tally Sundry Debtors, keyed by GUID. Category (A/B/C/D), price level, tally_alter_id, last_synced. |
| `products_master` | Mirror of Tally Stock Items. `price` + `price_tiers` JSONB. |
| `queries` | Core table. Cartons, lots, status, items, claim/snooze/won/dispatch fields, `invoice_entries` JSONB, `is_packed`, follow-up fields (note/date/origin/resolved), `last_activity_at`, **`godown_id`** (added in 019). |
| `tasks` | Person-to-person tasks. `due_date`, `recurrence` JSONB, `next_due_date`, `last_completed_at`, `notify_settings`. |
| `notifications` | In-app bell. Triggered by DB triggers on key state changes. |
| `salesperson_stats` | Cached counters (legacy `total_sets_sold` kept for migrated rows; live UI recomputes cartons + lots from `queries`). |
| `settings` | Single row (`id = 'app'`) for SLA thresholds + gone-quiet days. |

### Migrations (run sequentially in Supabase SQL Editor)

```
001..016                                  setup, RLS, RPCs, invoice flow, packing
017_pre_operations_enum.sql               (RUN FIRST — one-line enum add)
017_operations_role_and_godowns.sql       (then) — godowns table + 'operations' enum
018_responsibilities_followup_tasks.sql   — split ops→packing, responsibilities,
                                            follow-up date, tasks (due+recurrence)
019_query_godown.sql                      — queries.godown_id column
```

`019` introduces no new enum values, so it's safe to paste-and-run as one batch.

### Indexes worth knowing

- `queries.status` and `queries.last_activity_at` — drives Feed + time-window filters.
- `queries.tally_invoice_number` — partial **unique** index over verified/partial/completed (defense-in-depth duplicate-invoice block).
- `queries.godown_id`, `users.godown_id` — godown filtering.
- `tasks(to_user_id, next_due_date)` — recurring task scheduling.

---

## 7. Realtime updates

Every screen that displays live data uses a Supabase Realtime channel + an `AppState` re-fetch on foreground. Together they cover all of: row inserts, updates, deletes, and the offline → foreground gap.

| Surface | What's live |
|---|---|
| Feed / Owner Dashboard | 50-most-recent query updates |
| Accounts dashboard | `where status in (won_pending_accounts, pending_verification, …)` |
| Packing / Dispatch dashboards | `where status in (verified_pending_dispatch, completed)` + each team sees the other's queue read-only |
| Follow-Ups | unresolved follow-ups sorted by upcoming date |
| Leaderboard, My Stats | recompute on any `queries` change (godown-agnostic) |
| Admin (users, godowns, settings, responsibilities) | live across owner sessions |
| Tasks | inbox + sent live; local notifications rescheduled on every change |
| Notifications bell | new notifications stream to the user |

The client layer also adds:
- **Local refresh bus** — every mutating action fans out to all subscribers immediately on the calling device (no waiting for the Realtime roundtrip).
- **In-flight + dirty refs** — prevents listener storms when many events arrive in a burst.
- **Safe error path** — if the initial fetch fails, `callback([])` still fires so screens never sit on a spinner forever.

Migrations 008 and 017 add the right tables to the `supabase_realtime` publication.

---

## 8. Caching strategy

**Customer + product master data** — local AsyncStorage (mobile) / localStorage (web). First launch downloads everything; every subsequent open paints the cache instantly, then in the background does a delta sync (`where last_synced > localWatermark`) — typically a handful of rows. A 7-day full resync catches deletions.

**Session** — Supabase persists the JWT + refresh token. Stale tokens are caught at boot and cleared silently (no noisy `AuthApiError`).

**Per-device throttles** — `autoUnsnoozeExpired()` runs at most once every 5 min per device, so multiple opens don't fan out duplicate writes.

---

## 9. Tally integration

### `tally-sync.js` (master data, every 5 min)

1. Hits Tally's HTTP-XML API at `localhost:9003` for ledgers (Sundry Debtors) and stock items.
2. Parses with `fast-xml-parser`, normalises into `customers_master` / `products_master`.
3. Persistent watermark in `sync-track-masters.json` — only Tally rows with a higher AlterID are pulled on the next tick.
4. Upserts via the service-role key. The `set_last_synced` trigger stamps each row.
5. Runs under `node-cron` at `*/5 * * * *`. Refuses to start a second cycle if one is still running.

### `tally-bridge.js` (invoice verifier, always-on)

1. On boot: one-time sweep of every `pending_verification` query.
2. Realtime listener: picks up new ones the instant accounts submits them.
3. For each pending invoice entry inside `queries.invoice_entries`:
   - Posts a Day Book XML to Tally for the configured lookback / forward window.
   - Searches for `<VOUCHERNUMBER>{entry.invoiceNo}</VOUCHERNUMBER>`.
   - Cross-checks the voucher's party name against the query's customer.
   - Rejects duplicates already verified on another query.
   - Updates the entry's status and the parent query when all entries pass.
4. **5-min cooldown** after a Tally auth failure (no hammering during misconfig).
5. **3-try lock** per invoice entry; admin gets a "🔒 locked" notification.

Both scripts use the **service-role key** (server-only). Never deploy these scripts to a client.

---

## 10. Tally setup on your cloud Windows server (RDP)

Your setup: a cloud-hosted Windows machine you reach via Remote Desktop, with Tally Prime installed.

### 10.1. Expose Tally's HTTP API

In Tally Prime:
1. **F1 → Settings → Connectivity → Client/Server configuration**.
2. **TallyPrime acts as** → **Both**.
3. **Port** → `9003` (anything 9000–9009 works; we use 9003 throughout).
4. Save (Ctrl+A).

Verify from a Command Prompt on the Windows machine:

```cmd
curl http://localhost:9003
```

You should see an `<ENVELOPE>...` XML response.

### 10.2. Install Node.js

1. On the RDP'd Windows machine, open Edge / Chrome, go to **https://nodejs.org/en/download** → Windows Installer (.msi) — LTS (Node.js 20 is fine).
2. Run the installer with defaults.
3. Verify:
   ```cmd
   node --version
   npm --version
   ```

### 10.3. Copy the `tally/` folder onto the server

Either clone the repo (install Git first: `winget install --id Git.Git -e`) or zip-and-copy from your Mac. End result: `C:\sales-tracker\tally\` contains `tally-bridge.js`, `tally-sync.js`, `package.json`.

### 10.4. Install dependencies

```cmd
cd C:\sales-tracker\tally
npm install
```

### 10.5. Create `.env`

```cmd
cd C:\sales-tracker\tally
notepad .env
```

Paste:

```
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...   # the service_role key, NOT the anon key
TALLY_URL=http://localhost:9003
TALLY_COMPANY=Your Tally Company Name Exactly As It Appears
TALLY_USER=tallyuser
TALLY_PASS=tallypassword
TALLY_LOOKBACK_DAYS=14
TALLY_FORWARD_DAYS=14
```

Get `SUPABASE_SERVICE_ROLE_KEY` from **Supabase dashboard → Project Settings → API → `service_role` (Reveal)**.

### 10.6. Smoke-test both scripts

Two Command Prompt windows:

```cmd
node tally-bridge.js
```
Expect `🎧 Listening for pending verifications…`.

```cmd
node tally-sync.js
```
Expect `🚀 Tally → Supabase Sync Service Started` and within 5 min `Customers synced. Products synced.`.

When clean, close both windows (Ctrl+C). Move on to PM2.

---

## 11. PM2 setup so the scripts survive reboots

PM2 is a process supervisor that auto-restarts your scripts on crash and after Windows reboots.

### 11.1. Open Command Prompt **as Administrator**

Press the Windows key → type `cmd` → **right-click** → **Run as administrator** → accept UAC.

### 11.2. Install PM2 + Windows startup helper

```cmd
npm install -g pm2 pm2-windows-startup
pm2-startup install
```

### 11.3. Start the scripts under PM2

```cmd
cd C:\sales-tracker\tally
pm2 start tally-bridge.js --name tally-bridge
pm2 start tally-sync.js --name tally-sync
pm2 save
```

### 11.4. Verify

```cmd
pm2 list
```

Both should show `online`.

### 11.5. Test reboot survival

Restart Windows. RDP back in. `pm2 list` — both should already be `online`.

### 11.6. PM2 commands you'll use

| Command | What it does |
|---|---|
| `pm2 list` | Show status of all processes |
| `pm2 logs tally-bridge` | Live-tail bridge logs (Ctrl+C exits, script keeps running) |
| `pm2 logs tally-sync` | Same for sync |
| `pm2 restart tally-bridge` | Force restart after a `.env` change |
| `pm2 stop tally-bridge` | Pause |
| `pm2 delete tally-bridge` | Remove from PM2's list |
| `pm2 save` | Persist current list (after add/remove) |

### 11.7. Keep the Windows session alive

| Action | Effect |
|---|---|
| **Close the Remote Desktop window** (X button) | Session keeps running. ✅ |
| **`Start → Sign out`** | Session is killed. Tally closes. ❌ Avoid. |

If your cloud provider auto-signs-out idle sessions, set up **Windows auto-login** (`netplwiz`, uncheck "Users must enter a username and password") and drop a Tally Prime shortcut into `shell:startup`. Inside Tally: **F1 → Configure → Startup → Auto-load the company on launch**.

After any reboot: Windows auto-logs-in → Tally auto-launches → company loads → PM2 (Windows startup) starts both scripts → verifications resume in ~2 min.

---

## 12. Day-to-day operations

### Onboarding a new user

Owner → Admin → **+ Add User** → name, username, password, role, optional godown. Submit. They can log in immediately.

### Reassigning a user's role or godown

Owner → Admin → tap user card → **Change Role** or **Assign Godown**.

### Adding a godown

Owner → Admin → **Manage Godowns** → **+ Add Godown** → name it. Existing users can be tagged via the user action menu.

### Defining role responsibilities

Owner → Admin → **Role Responsibilities** → pick the role pill → **+ Add**. Type a title and add steps one by one. Save. Every user of that role sees it under the 📋 button in their dashboard header.

### Updating SLA thresholds

Owner → Admin → **Settings & SLA Thresholds**. Saves live on every dashboard.

### Recovering from a Tally auth failure

1. Accounts sees "🔐 Tally auth failed N× — escalate to admin".
2. Admin RDPs into the Windows box, checks `.env` for the right `TALLY_USER` / `TALLY_PASS`.
3. `pm2 restart tally-bridge`.
4. After the 5-min cooldown, the bridge retries stuck queries.

### Unlocking a query after 3 failed invoice attempts

Owner Dashboard shows locked queries with an **Unlock** button. Tap → entry's attempt counter resets → accounts can re-enter.

### Healthy weekly check (2 min)

| Where | What | Healthy if |
|---|---|---|
| Windows RDP | `pm2 list` | Both processes `online`, uptime > 1 day |
| Supabase dashboard | Reports → Usage | Well under free-plan ceilings (see §14) |
| Accounts dashboard | "Tally auth failed" banner | Not present |

---

## 13. Deploying changes (web + mobile OTA)

### Mobile — over-the-air JS update (95% of changes)

Any change inside `src/` or any Supabase migration — push as an OTA:

```bash
cd sales-tracker-supabase
eas update --branch preview --message "describe what changed"
```

~30 seconds. Phones pick it up on the next **cold-start** (force-close the app fully — swipe it away from recent apps — then reopen).

**Important caveat:** OTA only works if the installed APK was built **with the `expo-updates` plugin already active**. If you ever see "I pushed an OTA but the app didn't update" — even after force-closing — the cause is almost always that the APK on the device predates `expo-updates`. One-time fix: rebuild the APK once.

### Mobile — new APK (rare)

Needed only when:
- `app.json` changes (icon, name, permissions, splash)
- A native dependency is added (e.g. `expo-camera`)
- Expo SDK is upgraded
- You haven't yet built an APK with `expo-updates` wired up

```bash
eas build -p android --profile preview
```

~10–15 min in the cloud. Share the APK URL with the team — they install once. After that, future updates flow OTA.

### Verify OTA before pushing

Confirm the cloud side is healthy before each push:

```bash
eas update:list --branch preview --limit 5
```

You should see your recent updates with timestamps + bundle sizes. If `eas update` reports success and this list shows the entry, the cloud side is fine — any phone "not seeing the change" is an APK-side problem (most often: APK predates OTA, or app wasn't force-closed and reopened).

### Web — Vercel

```bash
npx expo export -p web      # builds to dist/
vercel --prod               # deploys dist/ to Vercel
```

~1 minute. Anyone on the Vercel URL gets the new version on their next reload.

### Supabase migrations

When the SQL schema changes:

1. Supabase Dashboard → **SQL Editor → New query** → paste the migration → Run.
2. After it succeeds, push the JS via `eas update` and `vercel --prod`.

**Order for migrations that add an enum value** (like `017_pre_operations_enum.sql` → `017_operations_role_and_godowns.sql`): the `ALTER TYPE ... ADD VALUE` line must be in its own run, because Postgres requires a separate transaction before any statement can reference the new value.

---

## 14. Supabase free-tier usage — where you stand and when to upgrade

You're on the **Free Plan** (`$0 / month`). Here's exactly where you sit (from the usage screen you shared):

| Resource | Free quota | Your current use | Headroom |
|---|---|---|---|
| Database size | 500 MB | **30 MB** | ~16,000× — years of runway |
| Egress / month | 5 GB | **7 MB** | ~700× current |
| Monthly Active Users | 50,000 | **12 MAU** | ~4,000× current |
| Realtime concurrent peak | 200 | **8** | ~25× current |
| Realtime messages / month | 2 million | **213** | astronomical |
| Edge function invocations | 500K / month | **0** | unused |
| Storage | 1 GB | **0 GB** | unused |

**Bottom line: you're using under 0.1% of every meter.** If you 100× the team and 100× query volume tomorrow, you'd still sit comfortably on Free.

### When you'd actually need Pro ($25/mo)

In rough order of likelihood for your business:

1. **You want daily backups stored for 14 days.** This is the single most-real reason for a business your size — Free has only point-in-time recovery on the running Postgres instance; Pro adds 14-day backups. If you store anything you can't afford to lose, that's worth $25/mo.
2. **DB grows past 500 MB.** At ~5 KB / query row, that's ~100,000 query rows. At your current pace you have 5+ years of runway.
3. **Egress exceeds 5 GB / month.** Would need ~1,000× current activity.
4. **MAU exceeds 50,000.** Effectively impossible for a single-business team.
5. **Free-plan project pauses after 7 days of zero activity.** With daily usage you'll never hit this.

**My recommendation:** Stay on Free indefinitely. The one trigger worth upgrading early for is the daily-backup peace of mind — pay $25/mo once you start trusting the system enough to depend on it for audit history. Until then, every meter has multiple orders of magnitude of room.

How to keep an eye: Supabase Dashboard → **Organization → Usage** is the page you screenshotted. Check it monthly until you have a feel for the curve.

---

## 15. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| OTA pushed but phone shows old UI | APK predates `expo-updates` plugin OR app wasn't force-closed | Verify with `eas update:list`. Force-close (swipe away from recent apps) and reopen. If still old: rebuild the APK once with `eas build -p android --profile preview`. |
| Login spinner forever | Network is too slow or stuck refresh token | The app now hard-times-out at 20s and shows a "network too slow" error. Stale tokens are cleared on next launch. |
| `AuthApiError: Invalid Refresh Token` in console | Benign — stored session is stale | LogBox is configured to ignore it in dev. App auto-signs-out and lands on login screen. |
| User can log in but immediately gets logged out | No row in `public.users` for that UID | Owner → Admin → Add User with the same username, OR insert a `public.users` row matching the auth UID. |
| Owner switched godown but Feed still shows everything | The chip is on "All Godowns" | Tap the chip in the top bar → pick a specific godown. The choice persists across screen navigation and reopens. |
| Salesperson sees only some queries | That's by design — they only see queries from their godown + ungodowned queries | Owner can re-tag a query's godown via SQL update, or tag new queries appropriately at creation. |
| Invoice stuck on `pending_verification` 30+ min | Bridge is down, Tally is closed, or wrong company is loaded | RDP into Windows. `pm2 list` — both `online`? Tally open with the right company? |
| `🔐 Tally auth failed` banner | Wrong `TALLY_USER` / `TALLY_PASS` in `.env` | Fix `.env`, then `pm2 restart tally-bridge`. 5-min cooldown prevents hammering. |
| Sync says "All up to date" but Supabase customer list is empty | `sync-track-masters.json` watermark is too high (e.g. after a Tally backup restore) | Delete `C:\sales-tracker\tally\sync-track-masters.json` → `pm2 restart tally-sync`. |
| Vercel deploy → blank page | Env vars not set in Vercel | Vercel project → Settings → Environment Variables → set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` → redeploy. |
| `unsafe use of new value 'X' of enum` on migration | `ALTER TYPE ... ADD VALUE` + a statement using it must be in separate transactions | Split the migration (017 pair is the example). |
| Customer list slow on first open | Fresh device — pulling ~2,500 customers + ~5,000 products | Expected. Progressive batches make the dropdown searchable within ~1 sec; subsequent opens are near-instant. |
| Tasks not firing notifications at the right time | Local notifications require permission + device on | Make sure the user granted notification permission. Local notifications fire even with the app closed but require the device to be on — Android may delay by minutes on Doze. |

---

## 16. File layout

```
sales-tracker-supabase/
├── README.md                     ← this file
├── SUPABASE_SETUP.md             ← initial Supabase project + migrations setup
├── App.js                        ← root component, providers, LogBox config
├── app.json / eas.json           ← Expo + EAS config (channel: preview)
├── package.json
├── .env                          ← Supabase URL + anon key (gitignored)
│
├── supabase/migrations/          ← run sequentially in Supabase SQL Editor
│   ├── 001_initial_schema.sql
│   ├── 002_rls_policies.sql
│   ├── 003_functions_and_triggers.sql
│   ├── 004_invoice_dedup.sql
│   ├── 005_admin_create_user.sql
│   ├── 006_invoice_attempt_lock.sql
│   ├── 007_fix_dispatch_cast.sql
│   ├── 008_enable_realtime.sql
│   ├── 009_notifications.sql
│   ├── 010_admin_can_claim.sql
│   ├── 011_query_origin.sql
│   ├── 012_cartoons_lots_followups.sql
│   ├── 013_multi_invoice.sql
│   ├── 014_packing_flow.sql
│   ├── 015_tasks.sql
│   ├── 016_fix_markwon_ambiguity.sql
│   ├── 017_pre_operations_enum.sql       ← RUN FIRST (one-line enum add)
│   ├── 017_operations_role_and_godowns.sql ← then this — godowns + (legacy) operations enum
│   ├── 018_responsibilities_followup_tasks.sql  ← split ops→packing, responsibilities, follow-up date, recurring tasks
│   └── 019_query_godown.sql              ← queries.godown_id column for per-query scoping
│
├── src/
│   ├── lib/supabase.js              ← Supabase client (15s fetch timeout, native + web storage)
│   ├── contexts/
│   │   ├── AuthContext.js           ← single-fetch login, refresh-token recovery
│   │   └── GodownFilterContext.js   ← global godown filter (owner chip + role-based)
│   ├── navigation/AppNavigator.js   ← top bar + sidebar (web), bottom tabs (native)
│   ├── components/
│   │   ├── GodownFilterChip.js      ← top-bar / header chip (owner only)
│   │   ├── NotificationBell.js, BottomSheet.js, StatusBadge.js, FilterTabs.js, …
│   │   └── PlatformDatePicker.{native,web}.js
│   ├── screens/
│   │   ├── LoginScreen.js           ← 20s hard timeout
│   │   ├── FeedScreen.js
│   │   ├── NewQueryScreen.js        ← godown picker (defaults to user's godown)
│   │   ├── QueryDetailScreen.js     ← Mark Booked / Snooze / Lost sheets, follow-up date
│   │   ├── AccountsDashboardScreen.js
│   │   ├── PackingDashboardScreen.js  ← To Pack (editable) + In Dispatch (view-only)
│   │   ├── DispatchDashboardScreen.js ← To Dispatch (editable) + In Packing (view-only) + Completed
│   │   ├── FollowUpsScreen.js       ← sorted by upcoming date; "Pick Up" → claimed_by_sales
│   │   ├── TasksScreen.js           ← one-time / days / weekdays / day-of-month + local notifications
│   │   ├── OwnerDashboardScreen.js  ← chip-scoped stats + pipeline
│   │   ├── AdminScreen.js           ← Users + Godowns + Responsibilities + Settings + Export
│   │   ├── ResponsibilitiesScreen.js ← read-only viewer per role
│   │   ├── LeaderboardScreen.js     ← cartons + lots; NOT godown-scoped for non-owners
│   │   └── MyStatsScreen.js         ← realtime; personal stats
│   ├── services/
│   │   ├── queryService.js          ← realtime + state-machine RPCs + safe error paths
│   │   ├── authService.js           ← createUser (godown-aware), subscribeToUsers
│   │   ├── godownService.js         ← CRUD + assign + realtime
│   │   ├── responsibilitiesService.js
│   │   ├── settingsService.js
│   │   ├── statsService.js          ← on-the-fly from queries
│   │   ├── tasksService.js          ← due_date, recurrence, describeRecurrence
│   │   ├── taskNotifications.js     ← local notifications scheduler
│   │   ├── notificationService.js   ← Expo Push (mobile only)
│   │   ├── notificationsService.js  ← in-app bell
│   │   ├── masterDataService.js     ← customers + products cache + delta sync
│   │   └── exportService.js + exportShare.{native,web}.js
│   └── utils/
│       ├── constants.js             ← ROLES, STATUS, COLORS, TIME_PERIODS
│       ├── formatUtils.js           ← formatPercentage only
│       └── timeUtils.js
│
└── tally/                              ← lives on the Windows server
    ├── tally-bridge.js                 ← realtime invoice verifier
    ├── tally-sync.js                   ← 5-min master-data sync
    ├── tally-*-debug.js                ← Tally diagnostic helpers
    ├── package.json
    ├── .env                            ← Supabase service-role + Tally creds
    └── README.md
```

---

## TL;DR — five things to remember

1. **3 things must always run on the cloud Windows server**: Tally Prime (with the right company), `tally-bridge.js`, `tally-sync.js`. PM2 handles the last two.
2. **Close the RDP window, don't Sign Out.** Sign Out kills the session. Closing the window leaves it running.
3. **OTA updates handle 95% of changes.** After the one-time APK rebuild (with `expo-updates` baked in), every future `eas update --branch preview --message "..."` reaches every installed APK in ~30 seconds. Phones need a full force-close + reopen to pick it up.
4. **Godowns scope queries but NOT stats.** Non-owners only see their godown's queries; the Leaderboard shows everyone. Owner has the top-bar chip to switch view.
5. **Free Supabase is more than enough.** Current usage is under 0.1% of every meter. The single Pro-tier feature worth upgrading early for is daily backups (and only when audit history matters).
