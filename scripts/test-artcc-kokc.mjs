#!/usr/bin/env node
/**
 * KOKC ownership used by Airport TMU canEditAirport.
 * Usage: node scripts/test-artcc-kokc.mjs
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

assert(AIRPORT_ARTCC.KOKC === "ZFW", "AIRPORT_ARTCC lists KOKC as ZFW");
assert(primaryAirportArtcc("KOKC") === "ZFW", "primaryAirportArtcc(KOKC) → ZFW");
assert(primaryAirportArtcc("okc") === "ZFW", "3-letter OKC → ZFW");
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
assert(canEdit(zfwClaims, "KOKC") === true, "ZFW editor can set KOKC TMU program");
assert(canEdit({ fullAccess: true, artccs: ["ZKC"] }, "KOKC") === false, "ZKC editor cannot set KOKC");

const kokc = [35.3931, -97.6007];
assert(artccForPoint(kokc[0], kokc[1]) === "ZFW", "KOKC coordinates inside ZFW polygon");
assert(pointInArtcc("ZFW", kokc[0], kokc[1]) === true, "KOKC pointInArtcc ZFW");
assert(pointInArtcc("ZKC", kokc[0], kokc[1]) === false, "KOKC not in ZKC");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
