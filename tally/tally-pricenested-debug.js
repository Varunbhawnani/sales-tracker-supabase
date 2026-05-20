/**
 * tally-pricenested-debug.js — find where Tally Prime stores per-level prices.
 *
 * Your Tally has price levels (FS, OS, SS, BOX15, etc.) defined. The prices
 * for stock items at each level live somewhere — but querying the global
 * <TYPE>PriceList</TYPE> collection crashes Tally with "Incorrect Object Type".
 *
 * This script tests 6 TARGETED, SAFE approaches on a single stock item,
 * each in its own small request, with delays between tests. No bulk queries.
 *
 * USAGE:
 *   node tally-pricenested-debug.js "STOCK ITEM NAME"
 *
 * Pick an item you KNOW has prices set across multiple price levels (e.g.,
 * something that you can sell at both FS and OS rates).
 */

require('dotenv').config();
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');

const TALLY_URL = process.env.TALLY_URL || 'http://localhost:9003';
const COMPANY = process.env.TALLY_COMPANY || '';
const USER = process.env.TALLY_USER || '';
const PASS = process.env.TALLY_PASS || '';

const ITEM_NAME = process.argv[2];

if (!ITEM_NAME) {
  console.error('Usage: node tally-pricenested-debug.js "STOCK ITEM NAME"');
  console.error('Pick one that you know has prices defined at multiple price levels.\n');
  process.exit(1);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  textNodeName: '_text',
});

function staticVars() {
  return `<STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
    ${USER ? `<SVUSERNAME>${USER}</SVUSERNAME>` : ''}
    ${PASS ? `<SVPASSWORD>${PASS}</SVPASSWORD>` : ''}
  </STATICVARIABLES>`;
}

function envelope(collectionXml, extra = '') {
  const m = collectionXml.match(/COLLECTION NAME="([^"]+)"/);
  const id = m ? m[1] : 'PriceDebug';
  return `<ENVELOPE>
    <HEADER>
      <VERSION>1</VERSION>
      <TALLYREQUEST>Export</TALLYREQUEST>
      <TYPE>Collection</TYPE>
      <ID>${id}</ID>
    </HEADER>
    <BODY>
      <DESC>
        ${staticVars()}
        <TDL><TDLMESSAGE>
          ${collectionXml}
          ${extra}
        </TDLMESSAGE></TDL>
      </DESC>
    </BODY>
  </ENVELOPE>`;
}

// All tests filter to a single item, so responses stay tiny.
const FILTER = `<SYSTEM TYPE="Formulae" NAME="OneItem">$Name = "${ITEM_NAME}"</SYSTEM>`;

const TESTS = [
  {
    label: '1: FETCH directive with PriceLevelList (most likely pattern)',
    collectionXml: `<COLLECTION NAME="P1">
      <TYPE>StockItem</TYPE>
      <FILTER>OneItem</FILTER>
      <FETCH>Name, GUID, BaseUnits, PriceLevelList</FETCH>
    </COLLECTION>`,
  },
  {
    label: '2: FETCH wildcards expanding PriceLevelList sub-fields',
    collectionXml: `<COLLECTION NAME="P2">
      <TYPE>StockItem</TYPE>
      <FILTER>OneItem</FILTER>
      <FETCH>Name, GUID, BaseUnits, PriceLevelList.*</FETCH>
    </COLLECTION>`,
  },
  {
    label: '3: NATIVEMETHOD PriceLevelList (alternative spelling)',
    collectionXml: `<COLLECTION NAME="P3">
      <TYPE>StockItem</TYPE>
      <FILTER>OneItem</FILTER>
      <NATIVEMETHOD>Name, GUID, BaseUnits, PriceLevelList</NATIVEMETHOD>
    </COLLECTION>`,
  },
  {
    label: '4: BatchAllocations and BillDtlsList (sometimes Tally puts price data here)',
    collectionXml: `<COLLECTION NAME="P4">
      <TYPE>StockItem</TYPE>
      <FILTER>OneItem</FILTER>
      <FETCH>Name, GUID, BaseUnits, BatchAllocations, BillDtlsList, PriceList</FETCH>
    </COLLECTION>`,
  },
  {
    label: '5: METHOD with $PriceLevelList',
    collectionXml: `<COLLECTION NAME="P5">
      <TYPE>StockItem</TYPE>
      <FILTER>OneItem</FILTER>
      <NATIVEMETHOD>Name, GUID, BaseUnits</NATIVEMETHOD>
      <METHOD NAME="PriceLevels">$PriceLevelList</METHOD>
    </COLLECTION>`,
  },
  {
    label: '6: Explicit $$RateInGodown / $$ItemRateForBuyer / $$PriceLevel for FS, OS, SS',
    collectionXml: `<COLLECTION NAME="P6">
      <TYPE>StockItem</TYPE>
      <FILTER>OneItem</FILTER>
      <NATIVEMETHOD>Name, GUID, BaseUnits</NATIVEMETHOD>
      <METHOD NAME="FSRate">$$ItemRateForBuyer:$Name:"FS":$$Date</METHOD>
      <METHOD NAME="OSRate">$$ItemRateForBuyer:$Name:"OS":$$Date</METHOD>
      <METHOD NAME="SSRate">$$ItemRateForBuyer:$Name:"SS":$$Date</METHOD>
    </COLLECTION>`,
  },
];

async function runTest(t) {
  try {
    const xml = envelope(t.collectionXml, FILTER);
    const res = await axios.post(TALLY_URL, xml, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 15000,
    });
    // Detect Tally error responses (HTTP 200 but contains error text)
    if (typeof res.data === 'string' && /Internal Error|Incorrect Object|Object not found/i.test(res.data)) {
      return { ok: false, error: 'Tally returned an internal error', raw: res.data };
    }
    return { ok: true, raw: res.data, parsed: parser.parse(res.data) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

(async () => {
  let out = `═══════════════════════════════════════════════════════════════════\n`;
  out += `  TALLY NESTED PRICE DEBUG — TARGETED ITEM\n`;
  out += `═══════════════════════════════════════════════════════════════════\n`;
  out += `Stock Item       : ${ITEM_NAME}\n`;
  out += `Company          : ${COMPANY}\n`;
  out += `Tally URL        : ${TALLY_URL}\n`;
  out += `Run date         : ${new Date().toISOString()}\n\n`;
  out += `WHAT TO LOOK FOR:\n`;
  out += `  • Any test that contains rupee values matching what you see in Tally.\n`;
  out += `  • The structure under PriceLevelList / BatchAllocations / etc.\n`;
  out += `  • The TEST NUMBER + FIELD PATH where the rate lives.\n\n`;

  for (const test of TESTS) {
    out += `\n${'─'.repeat(75)}\nTEST: ${test.label}\n${'─'.repeat(75)}\n\n`;
    console.log(`Running: ${test.label.substring(0, 70)}…`);
    const result = await runTest(test);

    if (!result.ok) {
      out += `❌ ERROR: ${result.error}\n`;
      if (result.raw) out += `\nRaw response:\n${result.raw.substring(0, 2000)}\n`;
      await new Promise(r => setTimeout(r, 2000)); // longer pause after errors
      continue;
    }

    out += `--- RAW XML (first 4000 chars) ---\n`;
    out += result.raw.substring(0, 4000);
    if (result.raw.length > 4000) out += `\n... [truncated, original ${result.raw.length} chars]\n`;
    out += '\n\n--- PARSED JSON (first 4000 chars) ---\n';
    let parsedStr;
    try { parsedStr = JSON.stringify(result.parsed, null, 2); } catch (e) { parsedStr = 'JSON.stringify failed.'; }
    out += parsedStr.substring(0, 4000);
    out += '\n\n';
    await new Promise(r => setTimeout(r, 1500));
  }

  fs.writeFileSync('./pricenested-debug-output.txt', out);
  console.log(`\n✅ Done! Output saved to pricenested-debug-output.txt`);
})().catch(err => {
  console.error('Fatal error:', err.message);
  fs.writeFileSync('./pricenested-debug-output.txt', `FATAL ERROR: ${err.message}\n${err.stack}`);
  process.exit(1);
});
