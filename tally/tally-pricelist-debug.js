/**
 * tally-pricelist-debug.js — safer follow-up to tally-price-debug.js.
 *
 * Your Tally uses Price List (Stock Group)-style pricing, so prices live in
 * a Price List Master keyed by group + level, NOT on the stock item itself.
 *
 * Tests E/F/G in the previous script crashed Tally because they pulled too
 * much data at once. This script:
 *   1. Queries Price Levels (a tiny list of tier names)
 *   2. Queries one specific Stock Group's price list at a time
 *   3. Uses small LIMIT bounds so Tally doesn't crash
 *
 * USAGE:
 *   node tally-pricelist-debug.js "STOCK GROUP NAME"
 *
 * Don't know your group names? Run with no argument first to see the list.
 *
 *   node tally-pricelist-debug.js
 */

require('dotenv').config();
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');

const TALLY_URL = process.env.TALLY_URL || 'http://localhost:9003';
const COMPANY = process.env.TALLY_COMPANY || '';
const USER = process.env.TALLY_USER || '';
const PASS = process.env.TALLY_PASS || '';

const STOCK_GROUP = process.argv[2];

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

const TESTS = [
  {
    label: '1: Price Levels list (the tier names like OS, OS1, FO)',
    collectionXml: `<COLLECTION NAME="PriceLevels">
      <TYPE>CompanyPriceLevel</TYPE>
    </COLLECTION>`,
  },
  {
    label: '2: Stock Groups (top 10 — to help you pick the right group name)',
    collectionXml: `<COLLECTION NAME="StockGroups" LIMIT="20">
      <TYPE>StockGroup</TYPE>
      <NATIVEMETHOD>Name, AlterID, GUID</NATIVEMETHOD>
    </COLLECTION>`,
  },
  ...(STOCK_GROUP ? [{
    label: `3: PriceList for stock group "${STOCK_GROUP}" (price master)`,
    collectionXml: `<COLLECTION NAME="GroupPriceList">
      <TYPE>PriceList</TYPE>
      <FILTER>MatchGroup</FILTER>
    </COLLECTION>`,
    extra: `<SYSTEM TYPE="Formulae" NAME="MatchGroup">$ParentGroup = "${STOCK_GROUP}" OR $Name = "${STOCK_GROUP}"</SYSTEM>`,
  }, {
    label: `4: Stock Items in group "${STOCK_GROUP}" (3 items — see if any have prices)`,
    collectionXml: `<COLLECTION NAME="ItemsInGroup" LIMIT="3">
      <TYPE>StockItem</TYPE>
      <FILTER>InThisGroup</FILTER>
      <NATIVEMETHOD>Name, GUID, BaseUnits, Parent, StandardPrice, StandardCost, OpeningRate, ClosingRate</NATIVEMETHOD>
    </COLLECTION>`,
    extra: `<SYSTEM TYPE="Formulae" NAME="InThisGroup">$Parent = "${STOCK_GROUP}"</SYSTEM>`,
  }] : []),
];

async function runTest(t) {
  try {
    const xml = envelope(t.collectionXml, t.extra || '');
    const res = await axios.post(TALLY_URL, xml, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 20000, // shorter timeout so we don't hang Tally if a test blows up
    });
    return { ok: true, raw: res.data, parsed: parser.parse(res.data) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

(async () => {
  let out = `═══════════════════════════════════════════════════════════════════\n`;
  out += `  TALLY PRICE LIST DEBUG — SAFE VERSION\n`;
  out += `═══════════════════════════════════════════════════════════════════\n`;
  out += `Stock Group      : ${STOCK_GROUP || '(none — pass one as argument)'}\n`;
  out += `Company          : ${COMPANY}\n`;
  out += `Tally URL        : ${TALLY_URL}\n`;
  out += `Run date         : ${new Date().toISOString()}\n\n`;

  if (!STOCK_GROUP) {
    out += `WHAT TO DO NEXT:\n`;
    out += `  1. Look at Test 2 (Stock Groups) below.\n`;
    out += `  2. Pick a group that you know has prices set.\n`;
    out += `  3. Re-run: node tally-pricelist-debug.js "YOUR GROUP NAME"\n\n`;
  }

  for (const test of TESTS) {
    out += `\n${'─'.repeat(75)}\nTEST: ${test.label}\n${'─'.repeat(75)}\n\n`;
    console.log(`Running: ${test.label.substring(0, 70)}…`);
    const result = await runTest(test);

    if (!result.ok) {
      out += `❌ ERROR: ${result.error}\n`;
      await new Promise(r => setTimeout(r, 1000));
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
    await new Promise(r => setTimeout(r, 1500)); // longer pause between tests
  }

  fs.writeFileSync('./pricelist-debug-output.txt', out);
  console.log(`\n✅ Done! Output saved to pricelist-debug-output.txt`);
})().catch(err => {
  console.error('Fatal error:', err.message);
  fs.writeFileSync('./pricelist-debug-output.txt', `FATAL ERROR: ${err.message}\n${err.stack}`);
  process.exit(1);
});
