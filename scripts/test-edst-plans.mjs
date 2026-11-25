#!/usr/bin/env node
// Tests for shared/edst-plans.js (EDST Plans Display text). Run: node scripts/test-edst-plans.mjs
import {
  fpFromVatsim, indexFeed, isNonAdsb, fpAltText, latLonFix, eramRoute, routeTokens, remainingRoute,
  readoutRoute, readoutLines, amLine, directRoute, routeDest, etaAlong, trialFixes, icaoLines,
  problemText, countdown, crcAmendLines, ptimeMs, planCid, planSuffix, sortPlans, hhmm,
} from "../shared/edst-plans.js";

let failed = 0;
function eq(got, want, msg) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error("FAIL:", msg, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); }
  else console.log("ok:", msg);
}

const pilot = {
  callsign: "dal123", cid: 1234567,
  flight_plan: {
    flight_rules: "I", aircraft: "B738/M-SDE3FGHIRWXY/LB1", aircraft_faa: "H/B738/L", cruise_tas: "450",
    departure: "KATL", arrival: "KIAD", alternate: "KBWI", altitude: "35000",
    route: "PENCL3 PENCL SOT J14 LVL DCT AML", remarks: "PBN/A1B1 /V/", deptime: "1530", enroute_time: "0130",
    assigned_transponder: "4231",
  },
};
const fp = fpFromVatsim(pilot);
eq(fp.cs, "DAL123", "callsign upper-cased");
eq(fp.type, "B738/L", "FAA type without wake prefix");
eq(fp.tas, 450, "cruise TAS");
eq(fp.bcn, "4231", "assigned beacon");
eq(fpFromVatsim({ callsign: "X", flight_plan: { assigned_transponder: "0000" } }).bcn, "", "0000 is no beacon");
eq(fpAltText(fp.alt), "350", "35000 ft -> 350");
eq(fpAltText("FL240"), "240", "FL240 -> 240");
eq(fpAltText("VFR/105"), "VFR/105", "VFR kept");
eq(fpAltText(""), "", "no altitude");

const feed = { pilots: [pilot, { callsign: "N1", cid: 1 }], prefiles: [{ callsign: "AAL1", cid: 9, flight_plan: { departure: "KJFK" } }] };
const idx = indexFeed(feed);
eq([...idx.keys()].sort(), ["AAL1", "DAL123"], "feed index: prefiles + pilots with a plan");

eq(isNonAdsb("B738/M-SDE3FGHIRWXY/LB1"), false, "B1 is ADS-B");
eq(isNonAdsb("C172/L-G/C"), true, "mode C only is non-ADS-B");
eq(isNonAdsb("C172/L-G/U1"), false, "UAT is ADS-B");
eq(isNonAdsb("B738"), false, "no ICAO equipment: not flagged");

eq(latLonFix(38.57, -80.67), "3834/8040", "lat/lon fix");
eq(latLonFix(21.6667, -88.6667), "2140/8840", "lat/lon fix under 100W");
eq(latLonFix(33.5, -118.25), "3330/11815", "lat/lon fix past 100W");
eq(latLonFix(null, 1), "", "no position");

eq(eramRoute("KBOS SSOXS7 SSOXS Q167 ZIZZI KNUKK"), "KBOS.SSOXS7.SSOXS.Q167.ZIZZI..KNUKK", "ERAM dots");
eq(routeTokens("N0450F350 PENCL DCT SOT/N0450F360 J14"), ["PENCL", "SOT", "J14"], "tokens drop DCT and speed/level");
eq(remainingRoute("KATL PENCL3 PENCL SOT J14 LVL AML KIAD", ["LVL", "AML"], "KATL", "KIAD"), "LVL AML", "remaining route starts at the next fix");
eq(remainingRoute("PENCL SOT", ["XYZ"], "", ""), "PENCL SOT", "no fix ahead on the route: whole route");

eq(readoutRoute({ dep: "KATL", arr: "KIAD", route: "PENCL3 PENCL SOT J14 LVL" }),
  "KATL.PENCL3.PENCL..SOT.J14.LVL..KIAD", "proposed route line");
eq(readoutRoute({ dep: "KATL", arr: "KIAD", route: "LVL AML", pos: "3834/8040", eta: "1534" }),
  "KATL./.3834/8040..LVL..AML..KIAD/1534", "airborne route line with ETA");
eq(readoutRoute({ dep: "KATL", arr: "KIAD", route: "KATL PENCL KIAD" }), "KATL..PENCL..KIAD", "dep/arr not doubled");

const lines = readoutLines(fp, { fix: "KATL", tim: "P1530" });
eq(lines, ["B738/L 4231 450 KATL P1530 350", "KATL.PENCL3.PENCL..SOT.J14.LVL..AML..KIAD"], "proposed readout");
const air = readoutLines(fp, { fix: "3834/8040", tim: "E1305", alt: "340", pos: "3834/8040", aheadNames: ["LVL", "AML"] });
eq(air[0], "B738/L 4231 450 3834/8040 E1305 340", "airborne readout line 1 uses the assigned altitude");
eq(air[1], "KATL./.3834/8040..LVL..AML..KIAD", "airborne readout route");

eq(amLine("321", { alt: 290 }, { fix: "3834/8040", tim: "E1305" }), "AM 321 ALT 290 FIX 3834/8040 TIM E1305", "trial altitude line");
eq(amLine("321", { alt: 110, int: true }), "AM 321 INT 110", "interim altitude line");
eq(amLine("321", { spd: 450 }), "AM 321 SPD 450", "trial speed line");
eq(amLine("321", { spd: 78, mach: true }), "AM 321 SPD M78", "trial Mach line");

eq(directRoute("KATL PENCL SOT J14 LVL AML KIAD", "LVL", "KATL", "KIAD"), "LVL AML", "direct-to keeps the route after the fix");
eq(directRoute("PENCL SOT", "ZZZ", "", ""), "ZZZ PENCL SOT", "direct-to a fix not on the route");
eq(routeDest("SEY VALRE HAARP3 KLGA"), "KLGA", "destination at the end of a route");
eq(routeDest("SEY VALRE"), "", "no destination");

const now = Date.UTC(2026, 10, 25, 13, 0);
eq(hhmm(now), "1300", "hhmm");
eq(etaAlong(0, 0, [{ lat: 0, lon: 1 }], 600, now), "1306", "ETA 60 NM at 600 kt = 6 min");
eq(etaAlong(0, 0, [], 600, now), "", "no fixes: no ETA");
const fixes = [{ name: "A", lat: 0, lon: 0 }, { name: "B", lat: 0, lon: 1 }, { name: "C", lat: 0, lon: 2 }];
eq(trialFixes(fixes, "C A").map((f) => f.name), ["C", "A"], "trial fixes follow the trial route");

const icao = icaoLines(fp);
eq(icao[0], "-DAL123-IS", "ICAO line 1");
eq(icao[1], "-B738/M-SDE3FGHIRWXY/LB1", "ICAO equipment");
eq(icao[2], "-KATL1530", "ICAO departure + time");
eq(icao[3], "-N0450F350 PENCL3 PENCL SOT J14 LVL DCT AML", "ICAO speed, level, route");
eq(icao[4], "-KIAD0130 KBWI", "ICAO destination, EET, alternate");
eq(icao[5], "-PBN/A1B1 /V/", "ICAO remarks");

eq(problemText({ cs: "N22T", tMin: 5, sector: "25" }, now), "N22T 5 min 1305Z (25)", "problem line");
eq(problemText({ cs: "N22T", tMin: 0.4 }, now), "N22T 0 min 1300Z", "problem line, no sector");
eq(countdown(now + 299500, now), "5:00", "countdown rounds up");
eq(countdown(now - 5, now), "0:00", "countdown never negative");

eq(crcAmendLines({ alt: 240 }), ["QZ 240 {FLID}"], "CRC: altitude is QZ");
eq(crcAmendLines({ alt: 110, int: true }), ["QQ 110 {FLID}"], "CRC: interim is QQ");
eq(crcAmendLines({ spd: 450, route: "KATL PENCL3 PENCL SOT", rmk: "NEW PILOT", bcn: "1301", type: "B737/L" }),
  ["AM {FLID} TYP B737/L", "AM {FLID} BCN 1301", "AM {FLID} SPD 450", "AM {FLID} RTE KATL.PENCL3.PENCL..SOT", "AM {FLID} RMK ++NEW PILOT++"],
  "CRC: one AM per field");
eq(crcAmendLines({ rmk: "" }), ["AM {FLID} RMK"], "CRC: empty remarks clears them");
eq(crcAmendLines({ spd: 78, mach: true }), [], "CRC: no Mach speed amendment");
eq(crcAmendLines({ route: "LVL AML", direct: "LVL" }), ["QU LVL {FLID}"], "CRC: direct-to is QU");

eq(ptimeMs("1330", now), Date.UTC(2026, 10, 25, 13, 30), "P time later today");
eq(ptimeMs("1200", now), Date.UTC(2026, 10, 26, 12, 0), "P time more than 30 min ago is tomorrow");
eq(ptimeMs("1245", now), Date.UTC(2026, 10, 25, 12, 45), "P time within 30 min stays today");
eq(ptimeMs("2500", now), null, "bad P time");

eq(planCid("413", 1234567), "413", "CRC CID wins");
eq(planCid("", 1234567), "567", "VATSIM CID last 3");
eq(planCid("", ""), "---", "no CID");
eq(planSuffix({ kind: "trial", tn: 2 }), ".T2", "trial suffix");
eq(planSuffix({ kind: "prev" }), ".PR", "previous route suffix");
eq(sortPlans([{ kind: "am", created: 1 }, { kind: "trial", created: 2 }, { kind: "current", created: 3 }, { kind: "prev", created: 0 }]).map((p) => p.kind),
  ["current", "prev", "trial", "am"], "display order");

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("all passed");
