#!/usr/bin/env node
/* Parse a release PDF with the same code the page uses and print the model.
 * Use this when a release stops parsing cleanly, or to add a new profile.
 *
 *   node scripts/test-briefing.mjs path/to/release.pdf [--json]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfjs = require(path.join(root, 'briefing/vendor/pdf.min.js'));
const P = require(path.join(root, 'briefing/parse.js'));

// The minified build will not resolve its own worker outside a browser.
pdfjs.GlobalWorkerOptions.workerSrc = path.join(root, 'briefing/vendor/pdf.worker.min.js');

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/test-briefing.mjs <release.pdf> [--json]'); process.exit(2); }

const CW = 6.0; // release body is Courier 10pt

function buildLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5] * 2) / 2;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ col: Math.round((it.transform[4] - 50) / CW), s: it.str });
  }
  return [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => {
    items.sort((a, b) => a.col - b.col);
    let buf = '';
    for (const it of items) {
      const c = Math.max(0, it.col);
      if (buf.length < c) buf += ' '.repeat(c - buf.length);
      buf = buf.slice(0, c) + it.s;
    }
    return buf.replace(/\s+$/, '');
  }).join('\n');
}

// verbosity 0: silence Node-only canvas/font warnings that never occur in the browser
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
const pages = [];
let routeLink = null;
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  pages.push(buildLines((await page.getTextContent()).items));
  for (const a of await page.getAnnotations()) {
    const u = a.url || a.unsafeUrl || '';
    if (u.includes('route?')) routeLink = u;
  }
}

const M = P.parseRelease(pages, { routeLink });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(M, null, 1));
} else {
  const notams = M.notams.stations.reduce((n, s) => n + s.notams.length, 0);
  console.log(`profile      ${M.profile}   confidence ${Math.round(M.confidence * 100)}%`);
  console.log(`flight       ${M.carrier}${M.flightNo} ${M.origin.icao}-${M.dest.icao} ${M.dateDDMMM} rls ${M.release}`);
  console.log(`aircraft     ${M.acType} ${M.registration} ship ${M.shipNo}`);
  console.log(`route        ${M.route.raw}`);
  console.log(`cruise/ete   FL${M.cruiseFL}  ${M.derived.eteText}  ${M.distanceNM} nm`);
  console.log(`fuel         block ${M.fuel.block}  min t/o ${M.fuel.minTakeoff}`);
  console.log(`runways      dep ${M.derived.originRunways.join(',')}   arr ${M.derived.destRunways.join(',')}`);
  const iso = (ms) => ms === null || ms === undefined ? 'n/a' : new Date(ms).toISOString().replace('.000Z', 'Z');
  const unparsed = M.notams.stations.reduce((n, s) => n + s.notams.filter(x => !x.window.parsed).length, 0);
  console.log(`reference    dep ${M.derived.refDepZ}Z ${iso(M.derived.refDepMs)}   arr ${M.derived.refArrZ}Z ${iso(M.derived.refArrMs)}`);
  console.log(`notam windows ${notams - unparsed}/${notams} parsed`);
  console.log(`counts       notams ${notams}  mel ${M.mel.length}  discrepancies ${M.discrepancies.length}  howgozit ${M.howgozit.length}  crew ${M.crew.length}`);
  console.log(`wx           origin ${M.wx.originMetars.length} metar / dest ${M.wx.destMetars.length} metar, ${M.wx.destTaf.length} taf`);
  console.log(`warnings     ${M.warnings.length ? M.warnings.join(' | ') : 'none'}`);
}

if (M.warnings.length) process.exitCode = 1;
