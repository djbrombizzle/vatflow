#!/usr/bin/env node
/**
 * Build data/aoc/icao-fuel.json from the ICAO Carbon Emissions Calculator
 * methodology (v13.1, Aug 2024), Appendix C "ICAO Fuel Consumption Table":
 * fuel burned (kg) by equivalent aircraft type at fixed flight distances (nm).
 *
 * Usage: node scripts/build-icao-fuel.mjs [path/to/methodology.pdf]
 * Needs pdfjs-dist (npm i --no-save pdfjs-dist@4). Without a path it downloads
 * the PDF from icec.icao.int.
 *
 * ICAO designators (A20N, B38M, E75L...) are mapped to the table's equivalent
 * codes by TYPE_MAP below (VATFLOW's own mapping for common VATSIM types).
 */
import { readFileSync, writeFileSync } from "node:fs";

const PDF_URL = "https://icec.icao.int/Documents/Methodology%20ICAO%20Carbon%20Emissions%20Calculator_v13_Final.pdf";
const DIST = [125, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500];

/** ICAO type designator -> ICAO table equivalent code. */
export const TYPE_MAP = {
  A318: "318", A319: "319", A320: "320", A321: "321", A19N: "31N", A20N: "32N", A21N: "32Q",
  BCS1: "221", BCS3: "223", A306: "AB6", A30B: "AB4", A310: "310",
  A332: "332", A333: "333", A338: "338", A339: "339", A342: "342", A343: "343", A345: "345", A346: "346",
  A359: "359", A35K: "351", A388: "388",
  B712: "717", B722: "722", B732: "732", B733: "733", B734: "734", B735: "735", B736: "736", B737: "737", B738: "738", B739: "739",
  B37M: "7M8", B38M: "7M8", B39M: "7M9", B3XM: "7M9",
  B741: "741", B742: "742", B743: "743", B744: "744", B748: "74H",
  B752: "752", B753: "753", B762: "762", B763: "763", B764: "764",
  B772: "772", B773: "773", B77L: "77L", B77W: "77W", B778: "77W", B779: "77W",
  B788: "788", B789: "789", B78X: "781",
  MD11: "M11", MD81: "M81", MD82: "M82", MD83: "M83", MD87: "M87", MD88: "M88", MD90: "M90", DC10: "D10", DC93: "D93", DC95: "D95",
  E170: "E70", E75L: "E75", E75S: "E75", E175: "E75", E190: "E90", E195: "E95", E290: "290", E295: "295",
  E135: "ER3", E145: "ER4", E45X: "ER4",
  CRJ1: "CR1", CRJ2: "CR2", CRJ7: "CR7", CRJ9: "CR9", CRJX: "CRK",
  DH8A: "DH1", DH8B: "DH2", DH8C: "DH3", DH8D: "DH4",
  AT43: "AT4", AT45: "AT5", AT72: "AT7", AT76: "AT7",
  B461: "141", B462: "142", B463: "143", RJ70: "AR7", RJ85: "AR8", RJ1H: "AR1",
  F70: "F70", F100: "100", F50: "F50", SF34: "SF3", JS41: "J41",
  L101: "L10", A124: "A4F", IL76: "IL7",
};

async function pdfText(buf) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    const rows = new Map();
    for (const it of c.items) {
      const y = Math.round(it.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push([it.transform[4], it.str]);
    }
    out += `\n=====PAGE ${i}=====\n` + [...rows.entries()].sort((a, b) => b[0] - a[0])
      .map(([, r]) => r.sort((a, b) => a[0] - b[0]).map(x => x[1]).join(" ").replace(/\s+/g, " ").trim())
      .filter(Boolean).join("\n");
  }
  return out;
}

const src = process.argv[2];
const buf = src ? readFileSync(src) : Buffer.from(await (await fetch(PDF_URL)).arrayBuffer());
const text = await pdfText(buf);
const start = text.indexOf("Appendix C");
const end = text.indexOf("Appendix D");
if (start < 0 || end < 0) throw new Error("Appendix C not found");
const types = {};
for (const ln of text.slice(start, end).split("\n")) {
  const m = ln.trim().match(/^([0-9A-Z]{3}) ((?:\d+ ?)+)$/);
  if (!m) continue;
  const vals = m[2].trim().split(" ").map(Number);
  if (vals.length > DIST.length) continue;
  types[m[1]] = vals;
}
const missing = Object.entries(TYPE_MAP).filter(([, eq]) => !types[eq]);
if (missing.length) throw new Error("mapped to codes not in the table: " + missing.map(x => x.join("->")).join(", "));
const out = {
  source: "ICAO Carbon Emissions Calculator Methodology v13.1 (Aug 2024), Appendix C: ICAO Fuel Consumption Table",
  sourceUrl: PDF_URL,
  units: "kg of fuel for the whole flight (block), by flight distance in nm",
  gcdCorrectionKm: [[550, 50], [5500, 100], [Infinity, 125]].map(([lt, add]) => ({ below: lt === Infinity ? null : lt, add })),
  distancesNm: DIST,
  types,
  icaoTypes: TYPE_MAP,
};
writeFileSync(new URL("../data/aoc/icao-fuel.json", import.meta.url), JSON.stringify(out));
console.log(`icao-fuel.json: ${Object.keys(types).length} equivalent types, ${Object.keys(TYPE_MAP).length} ICAO designators mapped`);
