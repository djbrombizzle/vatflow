#!/usr/bin/env node
/**
 * Airport → ARTCC ownership used by Airport TMU canEditAirport.
 * Usage: node scripts/test-artcc-access.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIRPORT_ARTCC, primaryAirportArtcc } from "../shared/artcc-access.js";
import { seedArtccBoundaries, pointInArtcc, artccForPoint } from "../shared/artcc-scope.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const geo = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "artcc-boundaries-high.geojson"), "utf8"),
);
seedArtccBoundaries(geo);

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

assert(AIRPORT_ARTCC.KLBB === "ZFW", "AIRPORT_ARTCC lists KLBB as ZFW");
assert(AIRPORT_ARTCC.KMAF === "ZFW", "AIRPORT_ARTCC lists KMAF as ZFW");
assert(primaryAirportArtcc("KLBB") === "ZFW", "primaryAirportArtcc(KLBB) → ZFW");
assert(primaryAirportArtcc("KMAF") === "ZFW", "primaryAirportArtcc(KMAF) → ZFW");
assert(primaryAirportArtcc("lbb") === "ZFW", "3-letter LBB → ZFW");
assert(primaryAirportArtcc("maf") === "ZFW", "3-letter MAF → ZFW");
assert(primaryAirportArtcc("KDFW") === "ZFW", "KDFW still ZFW");
assert(primaryAirportArtcc("KDAL") === "ZFW", "KDAL still ZFW");

const zfwClaims = { fullAccess: true, isAdmin: false, artccs: ["ZFW"] };
function canEdit(claims, icao) {
  if (!claims || !claims.fullAccess) return false;
  if (claims.isAdmin) return true;
  if ((claims.artccs || []).includes("*")) return true;
  const owner = primaryAirportArtcc(icao);
  if (!owner) return false;
  return (claims.artccs || []).includes(owner);
}
assert(canEdit(zfwClaims, "KLBB") === true, "ZFW editor can set KLBB TMU program");
assert(canEdit(zfwClaims, "KMAF") === true, "ZFW editor can set KMAF TMU program");
assert(canEdit({ fullAccess: true, artccs: ["ZAB"] }, "KLBB") === false, "ZAB editor cannot set KLBB");
assert(canEdit({ fullAccess: true, artccs: ["ZAB"] }, "KMAF") === false, "ZAB editor cannot set KMAF");

const klbb = [33.66364, -101.82278];
const kmaf = [31.94253, -102.20191];
assert(artccForPoint(klbb[0], klbb[1]) === "ZFW", "KLBB coordinates inside ZFW polygon");
assert(artccForPoint(kmaf[0], kmaf[1]) === "ZFW", "KMAF coordinates inside ZFW polygon");
assert(pointInArtcc("ZFW", klbb[0], klbb[1]) === true, "KLBB pointInArtcc ZFW");
assert(pointInArtcc("ZFW", kmaf[0], kmaf[1]) === true, "KMAF pointInArtcc ZFW");
assert(pointInArtcc("ZAB", klbb[0], klbb[1]) === false, "KLBB not in ZAB");
assert(pointInArtcc("ZAB", kmaf[0], kmaf[1]) === false, "KMAF not in ZAB");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
