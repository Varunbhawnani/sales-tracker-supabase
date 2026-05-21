/**
 * tally-bridge.js — Supabase Edition (multi-invoice)
 *
 * Watches Supabase for queries with status='pending_verification' and verifies
 * each PENDING entry in `invoice_entries` against Tally's Day Book.
 *
 * Per-entry verification:
 *   1. Look the invoice up in Tally Day Book (configurable lookback window).
 *   2. Party-name cross-check: voucher's PARTYLEDGERNAME must match the query's
 *      customer_name (case-insensitive).
 *
 * Query-level state machine after processing:
 *   • All entries verified AND sum covers query cartoons/lots → 'verified_pending_dispatch'.
 *   • Any entry failed → 'verification_failed' AND invoice_attempt_count += 1.
 *   • Some entries still pending (entry count > processed) → stay 'pending_verification'.
 *   • All processed entries verified but sum doesn't cover → stay 'pending_verification'
 *     (waiting for accounts to add more entries).
 *
 * Duplicate-invoice rejection (within a query and across queries) happens
 * in the add_invoice_entry RPC before the bridge runs — the bridge trusts
 * the entries it sees.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// ─── Config ───
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TALLY_URL = process.env.TALLY_URL || 'http://localhost:9003';
const TALLY_USER = process.env.TALLY_USER || '';
const TALLY_PASS = process.env.TALLY_PASS || '';
const TALLY_COMPANY = process.env.TALLY_COMPANY || '';
const TALLY_LOOKBACK_DAYS = parseInt(process.env.TALLY_LOOKBACK_DAYS, 10) || 14;
const TALLY_FORWARD_DAYS = parseInt(process.env.TALLY_FORWARD_DAYS, 10) || 14;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set in .env. Exiting.');
  process.exit(1);
}
if (!TALLY_USER || !TALLY_PASS) {
  console.warn('⚠️  TALLY_USER / TALLY_PASS not set in .env — Tally will likely reject the request.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  textNodeName: '_text',
});

const AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

console.log('🚀 Tally Bridge (Supabase, multi-invoice) running…');
console.log(`📌 Company           : ${TALLY_COMPANY || '(none)'}`);
console.log(`🔗 Tally URL         : ${TALLY_URL}`);
console.log(`📆 Lookback window   : ${TALLY_LOOKBACK_DAYS} days back, ${TALLY_FORWARD_DAYS} ahead`);
console.log(`👤 Tally user        : ${TALLY_USER || '(none)'}\n`);

// ─── XML helpers ──────────────────────────────────────────────────────────
function tallyVal(field) {
  if (field === null || field === undefined) return '';
  if (typeof field === 'object' && '_text' in field) return String(field['_text']).trim();
  return String(field).trim();
}

function normalizeInvoice(s) {
  return (s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function collectVouchers(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) collectVouchers(n, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'VOUCHER') {
      if (Array.isArray(v)) out.push(...v);
      else if (v && typeof v === 'object') out.push(v);
    } else if (v !== null && typeof v === 'object') {
      collectVouchers(v, out);
    }
  }
  return out;
}

function fmtTallyDate(d) {
  return d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
}

function buildDayBookXml() {
  const today = new Date();
  const pastDate = new Date();
  pastDate.setDate(today.getDate() - TALLY_LOOKBACK_DAYS);
  const futureDate = new Date();
  futureDate.setDate(today.getDate() + TALLY_FORWARD_DAYS);

  return `<ENVELOPE>
    <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
    <BODY><EXPORTDATA><REQUESTDESC>
      <REPORTNAME>Day Book</REPORTNAME>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${TALLY_COMPANY ? `<SVCURRENTCOMPANY>${TALLY_COMPANY}</SVCURRENTCOMPANY>` : ''}
        ${TALLY_USER ? `<SVUSERNAME>${TALLY_USER}</SVUSERNAME>` : ''}
        ${TALLY_PASS ? `<SVPASSWORD>${TALLY_PASS}</SVPASSWORD>` : ''}
        <SVFROMDATE>${fmtTallyDate(pastDate)}</SVFROMDATE>
        <SVTODATE>${fmtTallyDate(futureDate)}</SVTODATE>
        <SVVOUCHERTYPE>BOX SALES (FACTORIES)</SVVOUCHERTYPE>
      </STATICVARIABLES>
    </REQUESTDESC></EXPORTDATA></BODY>
  </ENVELOPE>`;
}

// ─── Per-query verification ───────────────────────────────────────────────
async function processVerification(row) {
  const entries = Array.isArray(row.invoice_entries) ? row.invoice_entries : [];
  const pendingEntries = entries.filter(e => e && e.status === 'pending');
  if (pendingEntries.length === 0) return;

  // Auth-failure cooldown
  if (row.last_auth_failure_at) {
    const sinceFailMs = Date.now() - new Date(row.last_auth_failure_at).getTime();
    if (sinceFailMs < AUTH_FAILURE_COOLDOWN_MS) {
      console.log(`⏸  Auth-failure cooldown active for query ${row.id}, skipping.`);
      return;
    }
  }

  console.log(`\n🔍 Verifying query ${row.id} — ${pendingEntries.length} pending invoice(s).`);

  // Fetch Day Book once for all entries (cheaper than per-entry queries)
  let response;
  try {
    response = await axios.post(TALLY_URL, buildDayBookXml(), {
      headers: { 'Content-Type': 'application/xml' }, timeout: 30000,
    });
  } catch (err) {
    console.error(`❌ Tally connection error for query ${row.id}:`, err.message);
    return;
  }
  const tallyData = response.data;

  // Tally auth failure (apply cooldown, don't process any entries this round)
  if (typeof tallyData === 'string' && tallyData.includes('Authentication Failed')) {
    console.error(`🔐 Tally auth failed for query ${row.id}. Bumping retry counter.`);
    await supabase.from('queries').update({
      verification_error: 'Tally authentication failed — escalate to admin',
      auth_failure_count: (row.auth_failure_count || 0) + 1,
      last_auth_failure_at: new Date().toISOString(),
    }).eq('id', row.id);
    return;
  }

  // Parse XML once
  let vouchers = [];
  try {
    const parsed = parser.parse(tallyData);
    vouchers = collectVouchers(parsed);
  } catch (e) {
    console.warn('XML parse error (will fall back to substring):', e.message);
  }

  const queryCustomer = (row.customer_name || '').trim();

  // Process each entry independently
  const updatedEntries = entries.map((entry) => {
    if (!entry || entry.status !== 'pending') return entry;

    const invoiceNo = entry.invoice_no;
    const targetNum = normalizeInvoice(invoiceNo);

    let voucher = vouchers.find(v => normalizeInvoice(tallyVal(v.VOUCHERNUMBER)) === targetNum);

    let foundViaSubstring = false;
    if (!voucher && typeof tallyData === 'string') {
      const escapedInv = invoiceNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`<VOUCHERNUMBER[^>]*>\\s*${escapedInv}\\s*</VOUCHERNUMBER>`, 'i');
      foundViaSubstring = pattern.test(tallyData);
    }

    if (!voucher && !foundViaSubstring) {
      console.log(`   ❌ ${invoiceNo} not found in Tally.`);
      return {
        ...entry,
        status: 'failed',
        verified_at: null,
        verification_error: `Invoice "${invoiceNo}" not found in Tally (checked ${TALLY_LOOKBACK_DAYS}d back, ${TALLY_FORWARD_DAYS}d ahead).`,
      };
    }

    // Party-name cross-check when XML parse succeeded
    if (voucher) {
      const tallyParty = (tallyVal(voucher.PARTYLEDGERNAME) || tallyVal(voucher.PARTYNAME) || '').trim();
      if (tallyParty && queryCustomer &&
          tallyParty.toLowerCase() !== queryCustomer.toLowerCase()) {
        console.log(`   ⚠ ${invoiceNo} party mismatch — Tally: "${tallyParty}" vs Query: "${queryCustomer}".`);
        return {
          ...entry,
          status: 'failed',
          verified_at: null,
          verification_error: `Invoice "${invoiceNo}" is for "${tallyParty}", not "${queryCustomer}". Re-check the invoice number.`,
        };
      }
    }

    console.log(`   ✅ ${invoiceNo} verified for "${queryCustomer}".`);
    return {
      ...entry,
      status: 'verified',
      verified_at: new Date().toISOString(),
      verification_error: null,
    };
  });

  // ─── Roll up to query state ─────
  const anyFailed = updatedEntries.some(e => e && e.status === 'failed');
  const allVerified = updatedEntries.every(e => e && e.status === 'verified');
  const verifiedCartoons = updatedEntries.filter(e => e && e.status === 'verified')
    .reduce((s, e) => s + (e.cartoons || 0), 0);
  const verifiedLots = updatedEntries.filter(e => e && e.status === 'verified')
    .reduce((s, e) => s + (e.lots || 0), 0);
  const needCartoons = row.cartoons || 0;
  const needLots = row.lots || 0;
  const coversQuery = verifiedCartoons >= needCartoons && verifiedLots >= needLots;

  let newStatus, errorMessage = null, attemptIncrement = 0;
  if (anyFailed) {
    newStatus = 'verification_failed';
    const firstFailed = updatedEntries.find(e => e && e.status === 'failed');
    errorMessage = firstFailed?.verification_error || 'One or more invoices failed verification.';
    attemptIncrement = 1;
  } else if (allVerified && coversQuery) {
    newStatus = 'verified_pending_dispatch';
  } else {
    // Still waiting (all good so far but quantity not yet covered).
    newStatus = 'pending_verification';
  }

  await supabase.from('queries').update({
    invoice_entries: updatedEntries,
    status: newStatus,
    verification_error: errorMessage,
    verification_timestamp: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    invoice_attempt_count: (row.invoice_attempt_count || 0) + attemptIncrement,
  }).eq('id', row.id);
}

// ─── Boot ────────────────────────────────────────────────────────────────
async function initialSweep() {
  const { data, error } = await supabase
    .from('queries').select('*').eq('status', 'pending_verification');
  if (error) {
    console.error('Initial sweep failed:', error);
    return;
  }
  console.log(`Initial sweep: ${(data || []).length} pending-verification queries.`);
  for (const row of data || []) {
    try { await processVerification(row); }
    catch (e) { console.error(`Error processing query ${row.id}:`, e.message); }
  }
}

function subscribe() {
  return supabase
    .channel('public:queries:pending')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'queries',
      filter: 'status=eq.pending_verification',
    }, async (payload) => {
      const row = payload.new;
      if (!row) return;
      try {
        await processVerification(row);
      } catch (e) {
        console.error(`❌ Error processing verification for query ${row?.id}:`, e.message);
      }
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('🎧 Realtime SUBSCRIBED — listening for pending verifications.');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.error(`⚠ Realtime ${status}${err ? `: ${err.message}` : ''}`);
      } else {
        console.log(`🎧 Realtime status: ${status}`);
      }
    });
}

(async () => {
  await initialSweep();
  subscribe();
  console.log('🎧 Listening for pending verifications…\n');
})();
