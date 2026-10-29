#!/usr/bin/env node
/**
 * Regression: reading the departure runways out of an ATIS for the IDST
 * taxi config. Usage: node scripts/test-taxi-atis.mjs
 */
import {
  atisRunways, ensureDatis, resetAtis, runwaysFromStations, seedAtis, setVatsimAtis, vatsimAtisFor,
} from "../shared/taxi-atis.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}
const IAD = ["01L", "19R", "01C", "19C", "01R", "19L", "12", "30"];
const ATL = ["08L", "26R", "08R", "26L", "09L", "27R", "09R", "27L", "10", "28"];

/* ---------- VATSIM feed shape ---------- */
{
  resetAtis();
  setVatsimAtis([
    { callsign: "KIAD_ATIS", atis_code: "G", text_atis: ["IAD ATIS INFO G 1853Z.", "LNDG RWY 01C, DEPG RWY 30."] },
    { callsign: "KDCA_ATIS", atis_code: "B", text_atis: ["DCA ATIS INFO B."] },
    { callsign: "KIAD_TWR", text_atis: ["not an atis station"] },
    { callsign: "KBWI_ATIS", atis_code: "C", text_atis: null },
  ]);

  const iad = vatsimAtisFor("KIAD");
  assert(iad.length === 1 && iad[0].kind === "both", "combined ATIS station found, tower ignored");
  assert(iad[0].text.includes("DEPG RWY 30"), "text_atis lines joined");
  assert(vatsimAtisFor("KBWI").length === 0, "a station with no text is dropped");
  assert(vatsimAtisFor("").length === 0, "no field, no stations");

  const r = atisRunways("KIAD", IAD);
  assert(r.source === "vatsim", "VATSIM ATIS is preferred");
  assert(r.dep.join() === "30", "departure runway read from the ATIS");
  assert(r.arr.join() === "01C", "arrival runway read too");
  assert(r.code === "G", "info letter reported");
}

/* ---------- split departure / arrival ATIS ---------- */
{
  resetAtis();
  setVatsimAtis([
    { callsign: "KATL_D_ATIS", atis_code: "M", text_atis: ["ATL DEP ATIS INFO M. DEPG RWY 08R, RWY 09L."] },
    { callsign: "KATL_A_ATIS", atis_code: "N", text_atis: ["ATL ARR ATIS INFO N. ILS RWY 08L APCH, ILS RWY 09R APCH IN USE."] },
  ]);
  const r = atisRunways("KATL", ATL);
  assert(r.dep.join() === "08R,09L", "departures come only from the departure ATIS");
  assert(r.arr.join() === "08L,09R", "arrivals come only from the arrival ATIS");
  assert(r.code.includes("M") && r.code.includes("N"), "both info letters reported");

  /* A departure ATIS must never contribute arrival runways. */
  const depOnly = runwaysFromStations(
    [{ kind: "dep", text: "ILS RWY 27L APCH IN USE. DEPG RWY 26R." }], ATL);
  assert(depOnly.dep.join() === "26R", "departure station gives departures");
  assert(depOnly.arr.length === 0, "departure station contributes no arrivals");
}

/* ---------- the FAA fallback ---------- */
{
  resetAtis();
  /* VATSIM ATIS online but naming no runway at all. */
  setVatsimAtis([{ callsign: "KIAD_ATIS", atis_code: "H", text_atis: ["IAD ATIS INFO H 1853Z. 31015KT 10SM BKN050 A2998."] }]);
  seedAtis({ faa: { KIAD: [{ callsign: "FAA D-ATIS", code: "J", kind: "both",
    text: "IAD ATIS INFO J 1853Z. 31015KT. ILS RWY 01C APCH IN USE. DEPG RWY 30." }] } });

  const r = atisRunways("KIAD", IAD);
  assert(r.source === "faa", "falls through to the real-world D-ATIS");
  assert(r.dep.join() === "30", "departure runway from D-ATIS");
  assert(r.code === "J", "D-ATIS letter reported");

  /* A VATSIM ATIS that does name runways wins over the FAA one. */
  setVatsimAtis([{ callsign: "KIAD_ATIS", atis_code: "H", text_atis: ["IAD ATIS INFO H. DEPG RWY 01R."] }]);
  const live = atisRunways("KIAD", IAD);
  assert(live.source === "vatsim" && live.dep.join() === "01R",
    "a usable VATSIM ATIS beats the real-world one");
}

/* ---------- nothing to read ---------- */
{
  resetAtis();
  const none = atisRunways("KIAD", IAD);
  assert(none.source === "none" && none.dep.length === 0, "no ATIS yields no runways");
  assert(none.label === "no ATIS", "says why");

  setVatsimAtis([{ callsign: "KIAD_ATIS", atis_code: "P", text_atis: ["IAD ATIS INFO P. 31015KT 10SM. TWY J CLSD."] }]);
  const quiet = atisRunways("KIAD", IAD);
  assert(quiet.source === "none" && quiet.dep.length === 0, "an ATIS with no runway phrase yields none");
  assert(quiet.label === "ATIS has no runways", "distinguishes 'no ATIS' from 'ATIS says nothing'");
}

/* ---------- closures are not runways in use ---------- */
{
  resetAtis();
  setVatsimAtis([{ callsign: "KIAD_ATIS", atis_code: "Q",
    text_atis: ["IAD ATIS INFO Q. DEPG RWY 30. NOTAMS... RWY 01L CLSD. RWY 12 CLSD."] }]);
  const r = atisRunways("KIAD", IAD);
  assert(r.dep.join() === "30", "a closed runway is never read as in use");
}

/* ---------- a runway the field does not have is ignored ---------- */
{
  resetAtis();
  setVatsimAtis([{ callsign: "KIAD_ATIS", atis_code: "R",
    text_atis: ["IAD ATIS INFO R 1853Z. ALTIMETER 2998. DEPG RWY 30."] }]);
  const r = atisRunways("KIAD", IAD);
  assert(!r.dep.includes("29"), "an altimeter is not a runway");
  assert(r.dep.join() === "30", "only real ends survive");
}

/* ---------- the FAA fallback is not reached for free ---------- */
{
  resetAtis();
  setVatsimAtis([{ callsign: "KIAD_ATIS", atis_code: "G", text_atis: ["IAD ATIS INFO G. DEPG RWY 30."] }]);

  /* A usable VATSIM ATIS means no cross-origin fetch at all. */
  assert(await ensureDatis("KIAD", IAD) === false, "no D-ATIS fetch when VATSIM ATIS names runways");

  /* Runway ends arrive asynchronously. Until they do nothing can be validated,
     so the ATIS reads as empty — fetching then would hammer the D-ATIS sources
     on every feed tick for a field whose ATIS is perfectly fine. */
  assert(await ensureDatis("KIAD", []) === false, "no D-ATIS fetch before the runway ends load");
  assert(await ensureDatis("KIAD", null) === false, "missing runway ends are handled");
  assert(await ensureDatis("", IAD) === false, "no field, no fetch");
}

/* ---------- the store resolves runways from the ATIS ---------- */
{
  /* taxi-config-store touches localStorage and the hub; neither exists here. */
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  globalThis.fetch = () => Promise.reject(new Error("offline"));

  const store = await import("../shared/taxi-config-store.js");

  resetAtis();
  setVatsimAtis([{ callsign: "KIAD_ATIS", atis_code: "G",
    text_atis: ["IAD ATIS INFO G. ILS RWY 01C APCH IN USE. DEPG RWY 30."] }]);

  /* A field nobody has configured follows its ATIS by default. */
  const fresh = store.loadTaxiConfig("KIAD");
  assert(fresh.rwyMode === "atis", "a new field follows the ATIS by default");

  let eff = store.effectiveTaxiConfig("KIAD", IAD);
  assert(eff.activeRunways.join() === "30", "departing runway comes from the ATIS");
  assert(eff.rwySource === "vatsim", "source reported");
  assert(eff.atisArr.join() === "01C", "landing runways reported alongside");

  /* A hand-set list is kept but ignored while following the ATIS. */
  await store.saveTaxiConfig("KIAD", { activeRunways: ["01R"] });
  eff = store.effectiveTaxiConfig("KIAD", IAD);
  assert(eff.activeRunways.join() === "30", "the ATIS still wins over a stored list");
  assert(store.loadTaxiConfig("KIAD").activeRunways.join() === "01R",
    "the stored list is untouched — an ATIS reading is never written back as a pin");

  /* MANUAL pins it. */
  await store.setRunwayMode("KIAD", "manual");
  eff = store.effectiveTaxiConfig("KIAD", IAD);
  assert(eff.activeRunways.join() === "01R", "MANUAL uses the hand-set list");
  assert(eff.rwySource === "manual", "source says so");

  /* Back to ATIS. */
  await store.setRunwayMode("KIAD", "atis");
  assert(store.effectiveTaxiConfig("KIAD", IAD).activeRunways.join() === "30", "switching back follows the ATIS again");

  /* An ATIS that names no departure runway falls back to the stored list
     rather than leaving the field with nothing. */
  setVatsimAtis([{ callsign: "KIAD_ATIS", atis_code: "H", text_atis: ["IAD ATIS INFO H. 31015KT A2998."] }]);
  eff = store.effectiveTaxiConfig("KIAD", IAD);
  assert(eff.activeRunways.join() === "01R", "falls back to the hand-set list");
  assert(eff.rwySource === "manual-fallback", "and says it fell back");

  /* With neither, the estimator is left to guess from geometry. */
  await store.saveTaxiConfig("KDCA", {});
  resetAtis();
  const bare = store.effectiveTaxiConfig("KDCA", ["01", "19", "04", "22", "15", "33"]);
  assert(bare.activeRunways.length === 0 && bare.rwySource === "none",
    "no ATIS and no stored list leaves the runway unset");
}

console.log(`OK ${passed} assertions`);
