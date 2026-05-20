/**
 * tally-sync.js — Supabase Edition
 *
 * Syncs Customers (Sundry Debtors) and Products (Stock Items) from Tally to
 * Supabase every 5 minutes. Uses GUID as the stable Supabase row id and
 * AlterID for delta change detection (Tally-side; the app side uses
 * last_synced timestamps to delta-fetch from Supabase).
 *
 * Differences from the Firebase version: writes go to Supabase via the
 * service-role key. The Tally side (XML payloads, AlterID watermark file,
 * delta-detection logic) is unchanged.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cron = require('node-cron');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TALLY_URL = process.env.TALLY_URL || 'http://localhost:9003';
const COMPANY_NAME = process.env.TALLY_COMPANY || '';
const TALLY_USER = process.env.TALLY_USER || '';
const TALLY_PASS = process.env.TALLY_PASS || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set in .env. Exiting.');
  process.exit(1);
}
if (!COMPANY_NAME) {
  console.error('❌ TALLY_COMPANY is not set in your .env file. Exiting.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '',
  parseTagValue: false, textNodeName: '_text',
  isArray: (tag) => ['LEDGER', 'STOCKITEM'].includes(tag),
});

const TRACKING_FILE = './sync-track-masters.json';
let syncState = { lastCustomerAlterId: 0, lastProductAlterId: 0 };
if (fs.existsSync(TRACKING_FILE)) {
  try { syncState = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); }
  catch (e) { console.warn('⚠️  Could not read tracking file. Starting from scratch.'); }
}

console.log('🚀 Tally → Supabase Sync Service Started');
console.log(`📌 Company   : ${COMPANY_NAME}`);
console.log(`🔗 Tally URL : ${TALLY_URL}`);
console.log(`👤 Tally User: ${TALLY_USER || '(none)'}`);
console.log(`📈 Benchmarks → Customer AlterID: ${syncState.lastCustomerAlterId} | Product AlterID: ${syncState.lastProductAlterId}\n`);

let isSyncing = false;
cron.schedule('*/5 * * * *', async () => {
  if (isSyncing) { console.log('⚠️  Previous sync still in progress. Skipping this tick.'); return; }
  isSyncing = true;
  console.log(`\n⏰ [${new Date().toLocaleTimeString()}] Starting sync cycle…`);
  try { await syncCustomers(); await syncProducts(); console.log('✔️  Sync cycle complete.\n'); }
  catch (err) { console.error('❌ Unexpected sync cycle error:', err.message); }
  finally { isSyncing = false; }
});

// ─── Helpers ───
function buildStaticVars() {
  return `
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>${COMPANY_NAME}</SVCURRENTCOMPANY>
      ${TALLY_USER ? `<SVUSERNAME>${TALLY_USER}</SVUSERNAME>` : ''}
      ${TALLY_PASS ? `<SVPASSWORD>${TALLY_PASS}</SVPASSWORD>` : ''}
    </STATICVARIABLES>`;
}
function tallyVal(field) {
  if (field === null || field === undefined) return '';
  if (typeof field === 'object' && '_text' in field) return String(field['_text']).trim();
  return String(field).trim();
}
function cleanPrice(val) {
  if (!val) return 0;
  return parseFloat(val.toString().split('/')[0].replace(/[^0-9.]/g, '')) || 0;
}
function lastOf(val) { return Array.isArray(val) ? val[val.length - 1] : val ?? null; }
function saveSyncState() {
  try { fs.writeFileSync(TRACKING_FILE, JSON.stringify(syncState, null, 2)); }
  catch (e) { console.error('❌ Failed to persist sync state:', e.message); }
}

// ─── Customer sync ───
async function syncCustomers() {
  console.log('🔍 Checking Tally Ledgers (Sundry Debtors)…');
  const payload = `<ENVELOPE>
    <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>SyncDebtorsCollection</ID></HEADER>
    <BODY><DESC>${buildStaticVars()}<TDL><TDLMESSAGE>
      <COLLECTION NAME="SyncDebtorsCollection">
        <TYPE>Ledger</TYPE><CHILD_OF>Sundry Debtors</CHILD_OF>
        <NATIVEMETHOD>Name, AlterID, GUID, Parent, PriceLevel, IsPartyGrade</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL></DESC></BODY>
  </ENVELOPE>`;

  try {
    const response = await axios.post(TALLY_URL, payload, {
      headers: { 'Content-Type': 'application/xml' }, timeout: 60000,
    });
    const ledgers = parser.parse(response.data)?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER;
    if (!ledgers || ledgers.length === 0) { console.log('   ↳ No customer records returned.'); return; }

    const changed = ledgers.filter(
      (l) => (parseInt(tallyVal(l.ALTERID)) || 0) > syncState.lastCustomerAlterId,
    );
    if (changed.length === 0) { console.log('   ↳ Customers are fully up to date.'); return; }

    console.log(`   ↳ ${changed.length} customer record(s) to sync…`);
    let localMaxId = syncState.lastCustomerAlterId;
    const rows = [];

    for (const ledger of changed) {
      const alterId = parseInt(tallyVal(ledger.ALTERID)) || 0;
      const name = tallyVal(ledger.NAME);
      const guid = tallyVal(ledger.GUID);
      if (!guid) { console.warn(`   ⚠️  Skipping "${name}" — GUID missing.`); continue; }

      const rawGrade = tallyVal(ledger['UDF:ISPARTYGRADE']);
      rows.push({
        id: guid,
        name,
        guid,
        tally_alter_id: alterId,
        category: (rawGrade || 'D').toString().trim(),
        price_level: tallyVal(ledger.PRICELEVEL) || 'Standard',
        parent_group: tallyVal(ledger.PARENT) || '',
        last_synced: new Date().toISOString(),
      });
      if (alterId > localMaxId) localMaxId = alterId;
    }

    // Upsert in batches of 200 (Supabase has size limits per request)
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const { error } = await supabase.from('customers_master').upsert(slice);
      if (error) throw error;
    }

    syncState.lastCustomerAlterId = localMaxId;
    saveSyncState();
    console.log(`   ✅ Customers synced. New AlterID benchmark: ${localMaxId}`);
  } catch (err) {
    console.error('❌ Customer sync failed:', err.message);
    if (err.response) console.error('   HTTP status:', err.response.status);
  }
}

// ─── Product sync ───
async function syncProducts() {
  console.log('🔍 Checking Tally Stock Items…');
  const payload = `<ENVELOPE>
    <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>SyncStockCollection</ID></HEADER>
    <BODY><DESC>${buildStaticVars()}<TDL><TDLMESSAGE>
      <COLLECTION NAME="SyncStockCollection">
        <TYPE>StockItem</TYPE>
        <NATIVEMETHOD>Name, AlterID, GUID, BaseUnits, MailingName, PriceListAmtOS, PriceListAmtOS1, PriceListAmtFO</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL></DESC></BODY>
  </ENVELOPE>`;

  try {
    const response = await axios.post(TALLY_URL, payload, {
      headers: { 'Content-Type': 'application/xml' }, timeout: 60000,
    });
    const items = parser.parse(response.data)?.ENVELOPE?.BODY?.DATA?.COLLECTION?.STOCKITEM;
    if (!items || items.length === 0) { console.log('   ↳ No stock item records returned.'); return; }

    const changed = items.filter(
      (i) => (parseInt(tallyVal(i.ALTERID)) || 0) > syncState.lastProductAlterId,
    );
    if (changed.length === 0) { console.log('   ↳ Products are fully up to date.'); return; }

    console.log(`   ↳ ${changed.length} product record(s) to sync…`);
    let localMaxId = syncState.lastProductAlterId;
    const rows = [];

    for (const item of changed) {
      const alterId = parseInt(tallyVal(item.ALTERID)) || 0;
      const name = tallyVal(item.NAME);
      const guid = tallyVal(item.GUID);
      if (!guid) { console.warn(`   ⚠️  Skipping "${name}" — GUID missing.`); continue; }

      const osPrice = cleanPrice(tallyVal(lastOf(item['UDF:PRICELISTAMTOS'])));
      const os1Price = cleanPrice(tallyVal(lastOf(item['UDF:PRICELISTAMTOS1'])));
      const foPrice = cleanPrice(tallyVal(lastOf(item['UDF:PRICELISTAMTFO'])));
      const primaryPrice = osPrice || foPrice || 0;

      rows.push({
        id: guid, name,
        sku: tallyVal(item.MAILINGNAME) || '',
        guid,
        tally_alter_id: alterId,
        unit_type: tallyVal(item.BASEUNITS) || 'PRS',
        price: primaryPrice,
        price_tiers: {
          OS: osPrice || primaryPrice,
          OS1: os1Price || primaryPrice,
          FO: foPrice || primaryPrice,
        },
        last_synced: new Date().toISOString(),
      });
      if (alterId > localMaxId) localMaxId = alterId;
    }

    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const { error } = await supabase.from('products_master').upsert(slice);
      if (error) throw error;
    }

    syncState.lastProductAlterId = localMaxId;
    saveSyncState();
    console.log(`   ✅ Products synced. New AlterID benchmark: ${localMaxId}`);
  } catch (err) {
    console.error('❌ Product sync failed:', err.message);
    if (err.response) console.error('   HTTP status:', err.response.status);
  }
}
