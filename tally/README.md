# Tally Integration Scripts — Supabase Edition

These two Node.js scripts run **on the Windows machine that has Tally installed**.
They are the "glue" between Tally ERP and the Supabase backend.

| Script           | What it does                                                                       | Triggered by                                |
|------------------|------------------------------------------------------------------------------------|---------------------------------------------|
| `tally-bridge.js`| Watches Supabase for `queries.status = 'pending_verification'` rows, verifies each invoice against Tally's Day Book, then updates the row to `verified_pending_dispatch` (or `verification_failed`). | Supabase Realtime + initial sweep on boot   |
| `tally-sync.js`  | Every 5 minutes, pulls Sundry Debtors → `customers_master` and Stock Items → `products_master` from Tally, using AlterID for delta detection. | `node-cron` every `*/5 * * * *`             |

Both scripts use the **Supabase service-role key**, which bypasses Row-Level Security. **Never deploy these scripts to a client/browser** — the key would be extracted in seconds.

---

## 1. Prerequisites

- **Windows 10/11** machine where Tally Prime is installed and stays logged in
- **Node.js 18+** (https://nodejs.org/en/download)
- Tally configured to listen on a TCP port (default 9000–9003). In Tally:
  `F1 → Settings → Connectivity → Client/Server configuration → TallyPrime acts as → Both`
  and set a port (e.g. `9003`).
- Supabase project URL + **service-role** key (Supabase Dashboard → Project Settings → API)

## 2. Install

```bash
cd C:\sales-tracker\tally
npm install
```

The `package.json` in this folder lists the only runtime deps:
`@supabase/supabase-js, axios, dotenv, fast-xml-parser, node-cron`.

## 3. Configure

Create `C:\sales-tracker\tally\.env` with:

```dotenv
# Supabase
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...      # service_role key, NOT anon
# Tally
TALLY_URL=http://localhost:9003
TALLY_COMPANY=Your Tally Company Name Exactly As It Appears
TALLY_USER=tallyuser                          # Tally login user
TALLY_PASS=tallypassword                      # Tally login password
```

> The same `.env` is read by both scripts.

## 4. Verify Tally is reachable

```bash
curl http://localhost:9003
```

You should get back an `<ENVELOPE>` XML response.
If it errors, Tally isn't listening on that port — re-check step 1.

## 5. Run the scripts

### One-off (foreground, to confirm everything works):

```bash
node tally-bridge.js
node tally-sync.js
```

Open two terminals and watch the logs. You should see:
- `tally-bridge`: `🎧 Listening for pending verifications…`
- `tally-sync`:  `🚀 Tally → Supabase Sync Service Started`

### Production (PM2, so they auto-restart on Windows reboot):

```bash
npm install -g pm2 pm2-windows-startup
pm2-startup install
pm2 start tally-bridge.js --name tally-bridge
pm2 start tally-sync.js   --name tally-sync
pm2 save
```

Now both scripts will:
- Restart automatically on crash
- Restart automatically when Windows reboots (provided Tally is set to auto-launch and auto-load the company)

Useful PM2 commands:

```bash
pm2 list                       # see status
pm2 logs tally-bridge          # tail bridge logs
pm2 logs tally-sync            # tail sync logs
pm2 restart all                # restart both
pm2 stop tally-sync            # stop one
```

## 6. State files

`tally-sync.js` writes a file called `sync-track-masters.json` in the working directory:

```json
{ "lastCustomerAlterId": 4521, "lastProductAlterId": 9803 }
```

This is the **AlterID watermark** — the highest Tally AlterID we've synced so far.
On the next tick, only rows with `AlterID > watermark` are pulled.

**Do not delete this file**, or the sync will re-pull every customer and stock item on the next tick (which is fine but slow).

If you ever need to force a full re-sync (rare — for example, after recovering from a corrupted upsert), delete `sync-track-masters.json` and restart `tally-sync`.

## 7. Differences from the Firebase version

| Concern                | Firebase version                                | Supabase version                       |
|------------------------|-------------------------------------------------|----------------------------------------|
| DB writes              | Firebase Admin SDK + service account JSON       | `@supabase/supabase-js` + service-role key |
| Listening for queries  | `onSnapshot(query(where('status','==','pending_verification')))` | `supabase.channel('public:queries:pending').on('postgres_changes', filter='status=eq.pending_verification')` |
| App-side delta read    | Firestore `where('lastSynced','>',watermark)`   | Supabase `.gt('last_synced', watermarkISO)` |
| Auth-failure cooldown  | 5 min, stored on the document                   | 5 min, stored on the row (same logic)  |

The **Tally side** (XML payloads, AlterID watermark, customer/product mapping) is **byte-for-byte identical**. If your Firebase scripts worked, the Tally calls in these scripts will work too.

## 8. Troubleshooting

| Symptom                                                       | Probable cause                                                                 | Fix                                                                                  |
|---------------------------------------------------------------|--------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set`     | `.env` not present or missing keys                                             | Create `.env` with both keys (see §3)                                                |
| `🔐 Tally auth failed for ...`                                | `TALLY_USER` / `TALLY_PASS` wrong, OR Tally user account locked                | Re-check creds in Tally → Security. Bridge will retry after 5 min.                   |
| `❌ Tally connection error: ECONNREFUSED`                     | Tally is closed, or not listening on the configured port                       | Open Tally, load the company, and set ODBC connectivity. Then restart the script.    |
| Sync runs but nothing changes in Supabase                     | All Tally rows have AlterID ≤ watermark (i.e. no changes since last run)       | Make a tiny change to a Sundry Debtor in Tally and wait for the next 5-min tick.     |
| App says products list is stale                               | `last_synced` not updating                                                     | Check the trigger `set_last_synced_on_update` exists; re-run `001_initial_schema.sql`. |
| Bridge processes an invoice twice                             | Two PM2 instances running                                                      | `pm2 list` — kill duplicates. The auth-failure cooldown logic is the only de-dup.    |

## 9. Why service-role and not anon?

The bridge needs to write to `queries.status`, which RLS only allows the *original creator + roles {accounts, owner}* to do. The sync writes to `customers_master` / `products_master`, which RLS only allows owners to write. Using anon would force you to either log in as an owner (token expiry, cron-hostile) or weaken RLS.

The service-role key bypasses RLS entirely — fine for a script on a private server, dangerous anywhere a user could see it. Keep the `.env` file off any shared drive.
