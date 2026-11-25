#!/usr/bin/env node
// Tests for shared/edst-acl-route.js (ACL Route field). Run: node scripts/test-edst-acl-route.mjs
import { shortApt, aclRouteText, equipSuffix, fifrCheck, remarksOf, remarksKey, mergeTypedRoute, intendedRouteParts } from "../shared/edst-acl-route.js";

let failed = 0;
function eq(got, want, msg) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error("FAIL:", msg, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); }
  else console.log("ok:", msg);
}

eq(shortApt("KRDU"), "RDU", "K airport drops the K");
eq(shortApt("TNCC"), "TNCC", "non-US airport kept");
eq(aclRouteText({ dep: "KRDU", body: "ROA EKN IHD NEST03", arr: "KPIT" }), "RDU..ROA..EKN..IHD.NEST03.PIT", "dotted route with short airports");
eq(aclRouteText({ dep: "KIAD", body: "KIAD AML CSN J48 MOL KCLE", arr: "KCLE" }), "IAD..AML..CSN.J48.MOL..CLE", "airports in the body are not doubled");
eq(aclRouteText({ dep: "KRIC", body: "GVE V38 EKN", arr: "KCLE", direct: true }), "RIC./.GVE.V38.EKN..CLE", "direct shows ./.");
eq(aclRouteText({ dep: "KJFK", body: "N0450F350 DCT MERIT J60 PSB", arr: "" }), "JFK..MERIT.J60.PSB", "speed/level and DCT dropped");
eq(aclRouteText({ dep: "KJFK", body: "", arr: "KBOS" }), "JFK..BOS", "empty body");

eq(equipSuffix("B739/L"), "L", "suffix");
eq(equipSuffix("H/B744/L"), "L", "wake prefix and suffix");
eq(equipSuffix("H/B744"), "", "wake prefix only");
eq(equipSuffix("C172"), "", "none");

eq(fifrCheck("KIAD Q40 KATL", "B738/L"), null, "/L can fly Q");
eq(fifrCheck("KIAD Q40 KATL", "B738/A"), { qual: "A", need: "RNAV", airway: "Q40" }, "/A can't fly Q");
eq(fifrCheck("KIAD T207 KATL", "C172/I"), { qual: "I", need: "GNSS", airway: "T207" }, "/I can't fly T");
eq(fifrCheck("KIAD.J48.KATL", "B738"), null, "J airway any equipment");
eq(fifrCheck("KIAD Q40 KATL", "B738"), { qual: "-", need: "RNAV", airway: "Q40" }, "no qualifier shows a dash");

eq(remarksOf(""), { sts: "", rmk: "" }, "empty");
eq(remarksOf("PBN/A1B1C1D1 DOF/251125 REG/N123 RMK/TCAS SIMBRIEF /V/"), { sts: "", rmk: "" }, "noise only: no remarks");
eq(remarksOf("PBN/A1B1 STS/MEDEVAC RMK/HEART PATIENT /V/"), { sts: "MEDEVAC", rmk: "HEART PATIENT" }, "STS and RMK");
eq(remarksOf("/V/ STUDENT PILOT"), { sts: "", rmk: "STUDENT PILOT" }, "plain remarks");
eq(remarksOf("/V/ NEW PILOT PBN/A1 RMK/TCAS"), { sts: "", rmk: "NEW PILOT" }, "text before tags");
eq(remarksKey({ sts: "", rmk: "" }), "", "no key without remarks");

eq(mergeTypedRoute("ILM..FAK..LDN.J134.FLM", "ILM..FAK..LDN.J134.FLM"), "", "unchanged");
eq(mergeTypedRoute("ILM..XYZ..LDNILM..FAK..LDN.J134.FLM", "ILM..FAK..LDN.J134.FLM"), "ILM XYZ LDN J134 FLM", "typed in front joins at a fix");
eq(mergeTypedRoute("ABC..DEF ILM..FAK", "ILM..FAK"), "ABC DEF ILM FAK", "no join: in front of the route");
eq(mergeTypedRoute("ILM..FAK..QQQ", "ILM..FAK..LDN"), "ILM FAK QQQ", "edited inside: the whole field");
eq(intendedRouteParts("ILM FAK Q40 LDN", "B738/A").map((p) => p.sep + p.tok + (p.bad ? "!" : "")).join(""), "ILM..FAK.Q40!.LDN", "Q airway underlined for /A");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
