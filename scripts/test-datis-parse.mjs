#!/usr/bin/env node
/**
 * Regression: D-ATIS text splits into header / weather / runways / NOTAMs / closing.
 * Usage: node scripts/test-datis-parse.mjs
 */
import { parseAtis, splitSentences, classifyNotam, atisInfo } from "../shared/datis-parse.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const JFK = "JFK ATIS INFO S 1551Z. 03020G32KT 10SM BKN016 OVC035 14/13 A2976 (TWO NINER SEVEN SIX) RMK AO2 PK WND 02032/1543 SLP076 P0006 T01440128. APPROACH IN USE ILS RY 4R, ILS RY 4L. DEPG RY 4L. TWY F TURNOFF CLSD, TWY FA TURNOFF CLSD. LOW LEVEL WIND SHEAR ADZYS IN EFFECT. NUM CRANES OPERATING AT JFK. BIRD ACTIVITY VICINITY ARPT. READBACK ALL RWY ASSIGNMENTS AND HOLD SHORT INSTRUCTIONS. ...ADVS YOU HAVE INFO S.";

const segs = parseAtis(JFK);
const kinds = segs.map(s => s.kind);
assert(kinds[0] === "header" && segs[0].text === "JFK ATIS INFO S 1551Z", "header");
assert(kinds[1] === "weather" && segs[1].text.startsWith("03020G32KT"), "weather");
assert(kinds[2] === "runways" && /ILS RY 4R/.test(segs[2].text), "approach in use");
assert(kinds[3] === "runways" && segs[3].text === "DEPG RY 4L", "departure runway");
const notams = segs.filter(s => s.kind === "notam");
assert(notams.length === 6, "6 NOTAMs, got " + notams.length);
assert(notams[0].text === "TWY F TURNOFF CLSD" && notams[0].category === "twy-closed", "TWY F split + category");
assert(notams[1].text === "TWY FA TURNOFF CLSD" && notams[1].category === "twy-closed", "TWY FA split");
assert(notams[2].category === "wx-hazard", "wind shear");
assert(notams[3].category === "obstruction", "cranes");
assert(notams[4].category === "wildlife", "birds");
assert(notams[5].category === "procedure", "readback");
assert(notams.map(n => n.notamIndex).join() === "0,1,2,3,4,5", "notam indexes");
assert(kinds[kinds.length - 1] === "closing", "closing");
assert(atisInfo(JFK).letter === "S" && atisInfo(JFK).time === "1551Z", "info letter/time");

// Header with METAR on the same sentence, "..." separated NOTAMs, decimals kept.
const DCA = "DCA ARR/DEP INFO B 1452Z 36010KT 1 1/2SM BR OVC008 12/11 A3001. ILS RWY 1 APCH IN USE. DEPARTING RWY 1. NOTAMS... RWY 4/22 CLSD... TWY J CLSD... RWY 1 PAPI OTS... VIS 1.5 MILES IN FOG. ADVS YOU HAVE INFO B.";
const d = parseAtis(DCA);
assert(d[0].kind === "header" && d[1].kind === "weather", "same-sentence header split");
const dn = d.filter(s => s.kind === "notam");
assert(dn[0].text === "RWY 4/22 CLSD" && dn[0].category === "rwy-closed", "rwy closed");
assert(dn[1].category === "twy-closed", "twy closed");
assert(dn[2].category === "navaid", "PAPI OTS");
assert(dn[3].text === "VIS 1.5 MILES IN FOG", "decimal not split");

assert(splitSentences("").length === 0, "empty");
assert(classifyNotam("RAMP 5 CLSD").id === "closed", "generic closure");
assert(classifyNotam("SOMETHING ELSE ENTIRELY").id === "general", "fallback");

console.log(`OK ${passed} assertions`);
