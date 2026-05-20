/**
 * tally-price-debug.js — diagnose where stock-item prices actually live in Tally.
 *
 * USAGE:
 *   1. Pick a stock item name that you KNOW has a price set in Tally
 *      (open Tally → Inventory Info → Stock Items → pick one with a real
 *      selling price visible).
 *   2. Run:
 *        cd C:\sales-tracker\tally
 *        node tally-price-debug.js "ITEM NAME EXACTLY AS IT APPEARS IN TALLY"
 *   3. After it finishes, share the file `price-debug-output.txt` with me.
 *
 * The script runs 7 different queries against your Tally, each trying a
 * different price-storage convention. The output shows the raw XML and the
 * parsed JSON for each, so we can spot where the actual rupee value lives.
 *
 * This script ONLY reads from Tally. It does not write to Tally or Supabase.
 */

require('dotenv').config();
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');

// ─── Config ───
const TALLY_URL = process.env.TALLY_URL || 'http://localhost:9003';
const COMPANY = process.env.TALLY_COMPANY || '';
const USER = process.env.TALLY_USER || '';
const PASS = process.env.TALLY_PASS || '';

const ITEM_NAME = process.argv[2];

if (!ITEM_NAME) {
  console.error('\nUsage: node tally-price-debug.js "STOCK ITEM NAME"');
  console.error('Example: node tally-price-debug.js "BROTHERS SHOE"');
  console.error('\nPick a stock item that you KNOW has a real price set in Tally.\n');
  process.exit(1);
}

if (!COMPANY) {
  console.error('\n❌ TALLY_COMPANY not set in .env — exiting.\n');
  process.exit(1);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  textNodeName: '_text',
});

// ─── Helpers ───
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

// ─── Tests ───
// Each test tries a different convention for where prices might be stored.
// After running all 7, the raw output makes it obvious which one your Tally uses.
const TESTS = [
  {
    label: 'A: Specific item, default Tally export (no method overrides — see everything Tally gives by default)',
    collectionXml: `<COLLECTION NAME="PriceDebugA">
      <TYPE>StockItem</TYPE>
      <FILTER>NameA</FILTER>
    </COLLECTION>`,
    extra: `<SYSTEM TYPE="Formulae" NAME="NameA">$Name = "${ITEM_NAME}"</SYSTEM>`,
  },
  {
    label: 'B: Specific item, NATIVE price fields (StandardPrice, StandardCost, RateOfSale, OpeningRate, ClosingRate)',
    collectionXml: `<COLLECTION NAME="PriceDebugB">
      <TYPE>StockItem</TYPE>
      <FILTER>NameB</FILTER>
      <NATIVEMETHOD>Name, GUID, BaseUnits, StandardPrice, StandardCost, RateOfSale, OpeningRate, OpeningValue, ClosingRate, ClosingValue, PriceListLevel</NATIVEMETHOD>
    </COLLECTION>`,
    extra: `<SYSTEM TYPE="Formulae" NAME="NameB">$Name = "${ITEM_NAME}"</SYSTEM>`,
  },
  {
    label: 'C: Specific item, METHOD-style ($-prefixed) expressions for the same price fields',
    collectionXml: `<COLLECTION NAME="PriceDebugC">
      <TYPE>StockItem</TYPE>
      <FILTER>NameC</FILTER>
      <NATIVEMETHOD>Name, GUID</NATIVEMETHOD>
      <METHOD NAME="StdPrice">$StandardPrice</METHOD>
      <METHOD NAME="StdCost">$StandardCost</METHOD>
      <METHOD NAME="OpenRate">$OpeningRate</METHOD>
      <METHOD NAME="CloseRate">$ClosingRate</METHOD>
      <METHOD NAME="RateOfSale">$RateOfSale</METHOD>
      <METHOD NAME="PriceLevelList">$PriceLevelList</METHOD>
    </COLLECTION>`,
    extra: `<SYSTEM TYPE="Formulae" NAME="NameC">$Name = "${ITEM_NAME}"</SYSTEM>`,
  },
  {
    label: 'D: Specific item, common UDF aliases (PriceListAmtOS family, MRP, FS, Rate, Price)',
    collectionXml: `<COLLECTION NAME="PriceDebugD">
      <TYPE>StockItem</TYPE>
      <FILTER>NameD</FILTER>
      <NATIVEMETHOD>Name, GUID, BaseUnits, PriceListAmtOS, PriceListAmtOS1, PriceListAmtFO, PriceListAmtSC, MRP, MRPRate, FS, SalePrice, ListPrice</NATIVEMETHOD>
    </COLLECTION>`,
    extra: `<SYSTEM TYPE="Formulae" NAME="NameD">$Name = "${ITEM_NAME}"</SYSTEM>`,
  },
  {
    label: 'E: Built-in PriceList master collection (Tally Prime multi-tier price masters)',
    collectionXml: `<COLLECTION NAME="PriceDebugE">
      <TYPE>PriceList</TYPE>
    </COLLECTION>`,
  },
  {
    label: 'F: Built-in StandardPrice collection (single default price master)',
    collectionXml: `<COLLECTION NAME="PriceDebugF">
      <TYPE>StandardPrice</TYPE>
    </COLLECTION>`,
  },
  {
    label: 'G: $$ functional price lookups — RateOnDate / PriceFor as of today',
    collectionXml: `<COLLECTION NAME="PriceDebugG">
      <TYPE>StockItem</TYPE>
      <FILTER>NameG</FILTER>
      <NATIVEMETHOD>Name, GUID</NATIVEMETHOD>
      <METHOD NAME="RateOnDate">$$RateOnDate:$Name:$$Date:$$YesNo:$Name:#PriceLevelList</METHOD>
      <METHOD NAME="LastVchRate">$LastVchRate</METHOD>
      <METHOD NAME="LastSaleDate">$LastVchDate</METHOD>
      <METHOD NAME="LastSalePartyName">$LastVchPartyName</METHOD>
    </COLLECTION>`,
    extra: `<SYSTEM TYPE="Formulae" NAME="NameG">$Name = "${ITEM_NAME}"</SYSTEM>`,
  },
];

// ─── Runner ───
async function runTest(t) {
  try {
    const xml = envelope(t.collectionXml, t.extra || '');
    const res = await axios.post(TALLY_URL, xml, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000,
    });
    return { ok: true, raw: res.data, parsed: parser.parse(res.data) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

(async () => {
  let out = `═══════════════════════════════════════════════════════════════════\n`;
  out += `  TALLY PRICE DEBUG REPORT\n`;
  out += `═══════════════════════════════════════════════════════════════════\n`;
  out += `Stock Item       : ${ITEM_NAME}\n`;
  out += `Company          : ${COMPANY}\n`;
  out += `Tally URL        : ${TALLY_URL}\n`;
  out += `Run date         : ${new Date().toISOString()}\n`;
  out += '\n';
  out += `What to look for in the output below:\n`;
  out += `  • Find a number that matches the price you see in Tally for this item.\n`;
  out += `  • Note which TEST it appeared under, and which FIELD it lives in.\n`;
  out += `  • That tells us how to extract it in tally-sync.js.\n`;
  out += '\n';

  for (const test of TESTS) {
    out += `\n${'─'.repeat(75)}\nTEST: ${test.label}\n${'─'.repeat(75)}\n\n`;
    console.log(`Running test: ${test.label.substring(0, 70)}…`);
    const result = await runTest(test);

    if (!result.ok) {
      out += `❌ ERROR: ${result.error}\n`;
      await new Promise(r => setTimeout(r, 800));
      continue;
    }

    // Show raw XML — capped at 5000 chars so the file stays readable
    out += `--- RAW XML (first 5000 chars) ---\n`;
    out += result.raw.substring(0, 5000);
    if (result.raw.length > 5000) out += `\n... [response truncated; original was ${result.raw.length} chars]\n`;
    out += '\n\n';

    // Show parsed JSON — capped at 5000 chars
    let parsedStr;
    try {
      parsedStr = JSON.stringify(result.parsed, null, 2);
    } catch (e) {
      parsedStr = `[JSON.stringify failed: ${e.message}]`;
    }
    out += `--- PARSED JSON (first 5000 chars) ---\n`;
    out += parsedStr.substring(0, 5000);
    if (parsedStr.length > 5000) out += `\n... [JSON truncated; original was ${parsedStr.length} chars]\n`;
    out += '\n\n';

    // Small delay between tests so Tally isn't slammed
    await new Promise(r => setTimeout(r, 800));
  }

  fs.writeFileSync('./price-debug-output.txt', out);
  console.log(`\n✅ Done!`);
  console.log(`Output saved to: price-debug-output.txt`);
  console.log(`Share that file so I can pinpoint where the prices actually live.\n`);
})().catch(err => {
  console.error('Fatal error:', err.message);
  fs.writeFileSync('./price-debug-output.txt', `FATAL ERROR: ${err.message}\n${err.stack}`);
  process.exit(1);
});
