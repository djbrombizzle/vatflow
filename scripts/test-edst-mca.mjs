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
const ge = buildMcaUplinkEntry(g);
assert(ge.msg === "MAINTAIN @280KT@" && ge.effects.spd === 280, "QS speed message");

// QS Mach: /M.80, /M80 and M.80 all mean Mach .80
for (const form of ["/M.80", "/M80", "M.80"]) {
  const m = parseMcaCommand(`QS ${form} AAL123 /U`);
  assert(m.ok && m.flid === "AAL123" && m.payload.type === "spd" && m.payload.mach === "80", `QS Mach ${form}`);
  const me = m.ok && buildMcaUplinkEntry(m);
  assert(me && me.msg === "MAINTAIN @M.80@" && me.effects.type === "spd" && me.effects.spd === "M.80", `QS Mach ${form} message`);
}
const gm = parseMcaCommand("QS /M.82 DAL123 /IMM /U");
assert(gm.ok && buildMcaUplinkEntry(gm).msg === "MAINTAIN @M.82@, IMMEDIATELY", "QS Mach with reason");
assert(parseMcaCommand("QS /M.8 AAL123 /U").error === "ILL SPD", "QS one-digit Mach rejected");
assert(parseMcaCommand("QS /M.30 AAL123 /U").error === "ILL SPD", "QS Mach below .40 rejected");
assert(parseMcaCommand("QS /M.80 AAL123").error === "REQUIRE /U", "QS Mach needs /U");
assert(parseMcaCommand("QS /50 AAL123 /U").error === "ILL SPD", "QS knots out of range");
assert(parseMcaCommand("QS /M800 AAL123 /U").error === "ILL SPD", "mistyped QS Mach is ILL SPD, not ILL HDG");

const h = parseMcaCommand("QZ /PD 220 /U /TFC AAL123");
assert(h.ok && h.mods.has("PD") && h.mods.has("TFC"), "mods any order");
const he = buildMcaUplinkEntry(h, { alt: 300 });
assert(/AT PILOTS DISCRETION/.test(he.msg) && /DUE TO TRAFFIC/.test(he.msg), "PD+TFC in msg");

const i = parseMcaCommand("ZZ 1 AAL123 /U");
assert(!i.ok && i.error === "ILL CMD", "unknown verb");

// uplink reflects whether /U was typed (plain QZ = local amendment in the EDST)
assert(a.uplink === true, "uplink true with /U");
const j = parseMcaCommand("QZ 240 DAL123", { requireU: false });
assert(j.ok && j.uplink === false && j.payload.fl === 240 && j.flid === "DAL123", "plain QZ parses with uplink false");
const k = parseMcaCommand("QZ 240", { requireU: false, selectedCs: null });
assert(!k.ok && k.error === "NO FLID", "no FLID without selection");

// UC crossing restrictions (examples from the ERAM CPDLC reference)
const u1 = parseMcaCommand("UC VUH A100 AAL002");
assert(u1.ok && u1.uplink && u1.payload.fix === "VUH" && u1.payload.fl === 100 && u1.flid === "AAL002", "UC fix altitude");
const u1e = buildMcaUplinkEntry(u1);
assert(u1e.msg === "CROSS @VUH@ AT AND MAINTAIN @10,000ft@" && u1e.effects.type === "alt" && u1e.effects.alt === 100 && u1e.altimeterBelow180, "UC altitude message (feet below FL180)");
const u2 = parseMcaCommand("UC AUS030015 A60 N211PC");
assert(u2.ok && u2.payload.fix === "AUS030015" && u2.payload.fl === 60 && u2.flid === "N211PC", "UC FRD position");
const u3 = parseMcaCommand("UC FAY A240 /TFC AWE228");
assert(u3.ok && buildMcaUplinkEntry(u3).msg === "CROSS @FAY@ AT AND MAINTAIN @FL240@, DUE TO TRAFFIC", "UC FL with reason");
const u4 = parseMcaCommand("UC VUH S250 AAL002");
const u4e = buildMcaUplinkEntry(u4);
assert(u4.ok && u4e.msg === "CROSS @VUH@ AT @250KT@" && u4e.effects.type === "spd" && u4e.effects.spd === 250, "UC speed");
const u5 = buildMcaUplinkEntry(parseMcaCommand("UC APRIL M.80 NASA242"));
assert(u5.msg === "CROSS @APRIL@ AT @M.80@" && u5.effects.spd === "M.80", "UC Mach");
const u6 = parseMcaCommand("UC STV A100 AAL002/UAL262/AWE121");
assert(u6.ok && u6.flids.length === 3 && u6.flids[2] === "AWE121", "UC multiple FLIDs");
const u7 = parseMcaCommand("UC KA03 A100 AAL002");
assert(u7.ok && u7.payload.fix === "KA03" && u7.flid === "AAL002", "UC fix that looks like a callsign");
assert(!parseMcaCommand("UC VUH A100").ok, "UC without FLID rejected");
assert(parseMcaCommand("UC VUH X100 AAL002").error === "ILL CMD", "UC bad restriction");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
