#!/usr/bin/env node
import {
  parseMcaCommand,
  buildMcaUplinkEntry,
} from "../shared/edst-mca-commands.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else console.log("ok:", msg);
}

const a = parseMcaCommand("QZ 340 AAL123 /U");
assert(a.ok && a.flid === "AAL123" && a.payload.fl === 340, "QZ 340 AAL123 /U");
const ae = buildMcaUplinkEntry(a, { alt: 300 });
assert(ae && /CLIMB TO AND MAINTAIN @FL340@/.test(ae.msg), "QZ builds climb FL340");

const b = parseMcaCommand("QZ 340 /U", { selectedCs: "DAL495" });
assert(b.ok && b.flid === "DAL495", "FLID from selection");

const c = parseMcaCommand("QZ 340 AAL123");
assert(!c.ok && c.error === "REQUIRE /U", "require /U");

const d = parseMcaCommand("QQ R110 JBU1 /U");
assert(d.ok && d.payload.fl === 110, "QQ interim R110");

const e = parseMcaCommand("QU ROBUC AAL123 /U");
assert(e.ok && e.payload.fix === "ROBUC", "QU direct");
const ee = buildMcaUplinkEntry(e);
assert(/PROCEED DIRECT TO @ROBUC@/.test(ee.msg), "QU message");

const f = parseMcaCommand("QS 090 AAL123 /U");
assert(f.ok && f.payload.hdg === 90, "QS heading");

const g = parseMcaCommand("QS /280 AAL123 /U");
assert(g.ok && g.payload.kt === 280, "QS speed");

const h = parseMcaCommand("QZ /PD 220 /U /TFC AAL123");
assert(h.ok && h.mods.has("PD") && h.mods.has("TFC"), "mods any order");
const he = buildMcaUplinkEntry(h, { alt: 300 });
assert(/AT PILOTS DISCRETION/.test(he.msg) && /DUE TO TRAFFIC/.test(he.msg), "PD+TFC in msg");

const i = parseMcaCommand("ZZ 1 AAL123 /U");
assert(!i.ok && i.error === "ILL CMD", "unknown verb");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
