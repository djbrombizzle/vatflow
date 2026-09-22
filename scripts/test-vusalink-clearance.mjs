import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLNC_MAX,
  buildClearance,
  checkLength,
  createCdrStore,
  describeCdr,
  expectLevel,
  parseLevel,
  previewLines,
  stripRouteEnds,
} from "../shared/vusalink-clearance.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ---- level parsing -------------------------------------------------------
assert(parseLevel("350") === 350, "bare level");
assert(parseLevel("FL350") === 350, "FL-prefixed");
assert(parseLevel("35000") === 350, "feet");
assert(parseLevel("") === null, "empty");
assert(parseLevel("abc") === null, "garbage");
assert(expectLevel("350") === "350" && expectLevel("FL350") === "350" && expectLevel("35000") === "350",
  "expect level normalises to three digits");
assert(expectLevel("5000") === "050", "5000 ft renders as FL050");

// ---- route end stripping -------------------------------------------------
assert(
  stripRouteEnds("KATL GAIRY2 IRQ FISHO Q93 GIPPL Q85 LPERD SNFLD3 KMCO", "KATL", "KMCO")
    === "GAIRY2 IRQ FISHO Q93 GIPPL Q85 LPERD SNFLD3",
  "strips both ends",
);
assert(stripRouteEnds("GAIRY2 IRQ", "KATL", "KMCO") === "GAIRY2 IRQ", "leaves a clean route alone");
assert(stripRouteEnds("  katl  dct  kmco ", "KATL", "KMCO") === "DCT", "normalises case and spacing");
assert(stripRouteEnds("", "KATL", "KMCO") === "", "empty route");

// ---- clearance composition ----------------------------------------------
assert(buildClearance({}, {}) === null, "no destination means no clearance");

const full = buildClearance({
  dest: "KMCO",
  route: "GAIRY2.IRQ FISHO Q93 GIPPL Q85 LPERD SNFLD3",
  climb: "CLB VIA SID EXCEPT MAINTAIN 5000",
  expect: "350",
  depFreq: "125.25",
  squawk: "4517",
}, { loadLine: true });

assert(full.effects.type === "dcl" && full.effects.code === "4517", "carries route and beacon effects");
assert(full.elements.length === 7, `full clearance has 7 elements, got ${full.elements.length}`);
assert(full.msg.startsWith("CLEARED TO THE @KMCO@ ARPT"), "opens with the destination element");
assert(full.msg.endsWith("+LOAD NEW RTE TO KMCO+"), "load line last");

assert(previewLines(full.msg).join("\n") === [
  "CLEARED TO THE KMCO ARPT",
  "GAIRY2.IRQ FISHO Q93 GIPPL Q85 LPERD SNFLD3",
  "CLB VIA SID EXCEPT MAINTAIN 5000",
  "EXP 350 10 MIN AFT DP",
  "DPFRQ 125.25",
  "SQUAWK 4517",
  "+LOAD NEW RTE TO KMCO+",
].join("\n"), "preview strips markers and breaks on elements");

// Reproduces the PHNL DCDU screenshot this feature was modelled on.
const phnl = buildClearance(
  { dest: "PHNL", route: "SUMMR2.DINTY", climb: "CLB VIA SID", expect: "340" },
  { asFiled: true, loadLine: false },
);
assert(previewLines(phnl.msg).join("\n") === [
  "CLEARED TO THE PHNL ARPT",
  "SUMMR2.DINTY THEN AS FILED",
  "CLB VIA SID",
  "EXP 340 10 MIN AFT DP",
].join("\n"), "AS FILED variant matches the reference clearance");

const noRoute = buildClearance({ dest: "KMCO" }, { asFiled: true, loadLine: false });
assert(noRoute.elements[1] === "AS FILED", "AS FILED alone when no route given");

// ---- budget --------------------------------------------------------------
assert(checkLength("x".repeat(CLNC_MAX), {}).ok, "at the limit is fine");
const over = checkLength("x".repeat(CLNC_MAX + 21), { loadLine: true });
assert(!over.ok && over.over === 21, "reports the overage");
assert(over.hint.includes("+LOAD NEW RTE+"), "suggests dropping the load line when it is on");
assert(!checkLength("x".repeat(CLNC_MAX + 1), { loadLine: false }).hint.includes("+LOAD"),
  "no load-line hint when it is already off");

// ---- CDR store against the real shards -----------------------------------
const store = createCdrStore({
  base: join(ROOT, "data", "cdr") + "/",
  fetchImpl: async (p) => {
    try {
      return { ok: true, json: async () => JSON.parse(readFileSync(p, "utf8")) };
    } catch (e) {
      return { ok: false, json: async () => null };
    }
  },
});

const atlmcoga = await store.lookup("ATLMCOGA");
assert(atlmcoga, "ATLMCOGA resolves");
assert(atlmcoga.orig === "KATL" && atlmcoga.dest === "KMCO", "ATLMCOGA is KATL->KMCO");
assert(atlmcoga.route === "GAIRY2 IRQ FISHO Q93 GIPPL Q85 LPERD SNFLD3", "route matches");
assert(atlmcoga.depFix === "IRQ", "departure fix carried through");

assert(await store.lookup("ZZZZZZZZ") === null, "unknown code");
assert(await store.lookup("SHORT") === null, "malformed code");
assert(await store.lookup("") === null, "empty code");

const pair = await store.forPair("KATL", "KMCO");
assert(pair.length >= 3, `KATL->KMCO has CDRs, got ${pair.length}`);
assert(pair.some((c) => c.code === "ATLMCORP"), "the filed SMLTZ3 route is a CDR too");
assert((await store.forPair("KATL", "ZZZZ")).length === 0, "unknown pair is empty, not an error");

// A lookup must survive the data being unreachable.
const offline = createCdrStore({ base: "/nope/", fetchImpl: async () => { throw new Error("offline"); } });
assert(await offline.lookup("ATLMCOGA") === null, "offline lookup returns null rather than throwing");
assert((await offline.forPair("KATL", "KMCO")).length === 0, "offline pair lookup is empty");

// ---- describe ------------------------------------------------------------
const d = describeCdr({ orig: "KATL", dest: "KMCO", depFix: "IRQ", eq: "2", coordReq: "Y", play: "ATL NO CHPPR" });
assert(d.text.includes("KATL→KMCO") && d.text.includes("DEP FIX IRQ"), "describes the pair and fix");
assert(d.warn.includes("COORD REQ") && d.warn.includes("ATL NO CHPPR"), "separates warnings for styling");
assert(describeCdr(null).text === "", "null CDR describes as empty");

console.log("ok — clearance composition, budget and CDR lookup");
