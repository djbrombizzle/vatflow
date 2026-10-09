#!/usr/bin/env node
/**
 * Regression tests for shared/gate-eta.js (VATSMART gate ETAs from the FCA engine).
 * Usage: node scripts/test-gate-eta.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { seedNavData } from "../shared/route-engine.js";
import { seedAirports } from "../shared/fca-metering.js";
import { seedWindStations } from "../shared/winds-aloft.js";
import { buildMitMonitor, normRate } from "../shared/mit-monitor.js";
import { gateEtaFor, gateFixFor, TERMINAL_KT } from "../shared/gate-eta.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };
const NOW = Date.UTC(2026, 9, 9, 23, 0);
const MIN = 60000;

t("no nav data: no engine ETA, so the caller keeps its estimate", () => {
  assert.equal(gateEtaFor({ dep: "KATL", arr: "KMCO", route: "GRNCH5" }, "GRNCH", NOW), null);
});

const nav = n => JSON.parse(fs.readFileSync(new URL("../data/nav/" + n + ".json", import.meta.url)));
seedNavData({ meta: nav("meta"), fixes: nav("fixes"), navaids: nav("navaids"), airways: nav("airways"), procedures: nav("procedures"), preferred: nav("preferred") });
seedAirports({ KATL: [33.6367, -84.4281], KMCO: [28.4294, -81.3090] });
const ATL = { callsign: "DAL1", dep: "KATL", arr: "KMCO", route: "POUNC2 POUNC GRGIA MGMRY DEEDA GRNCH5",
  tas: 450, fpAlt: 35000, deptime: "", lat: null, lon: null, alt: 0, gs: 0, hdg: 0, phase: "gnd" };

t("gate fix is the STAR's namesake fix when the route has it", () => {
  assert.deepEqual(gateFixFor([{ name: "A", ll: [1, 1], kind: "fix" }, { name: "B", ll: [2, 2], kind: "star" }, { name: "GRNCH", ll: [3, 3], kind: "star" }], "GRNCH"),
    { name: "GRNCH", ll: [3, 3], index: 2 });
  assert.equal(gateFixFor([{ name: "A", ll: [1, 1], kind: "fix" }, { name: "B", ll: [2, 2], kind: "star" }], "ZZZZZ").name, "B");
  assert.equal(gateFixFor([{ name: "A", ll: [1, 1], kind: "fix" }], "ZZZZZ"), null);
});

t("ground departure: gate ETA from the climb profile, landing after it", () => {
  const r = gateEtaFor(ATL, "GRNCH", NOW);
  assert.equal(r.gateFix, "GRNCH");
  const toGate = (r.gateEta - NOW) / MIN, gateToLand = (r.eta - r.gateEta) / MIN;
  assert.ok(toGate > 45 && toGate < 90, "ATL to GRNCH " + toGate.toFixed(1) + " min");
  assert.ok(gateToLand > 5 && gateToLand < 40, "GRNCH to KMCO " + gateToLand.toFixed(1) + " min at " + TERMINAL_KT + " kt");
});

t("a filed departure time in the next hours moves the gate ETA", () => {
  const dep = new Date(NOW + 90 * MIN), hhmm = String(dep.getUTCHours()).padStart(2, "0") + String(dep.getUTCMinutes()).padStart(2, "0");
  const now = gateEtaFor(ATL, "GRNCH", NOW), later = gateEtaFor({ ...ATL, deptime: hhmm }, "GRNCH", NOW);
  assert.ok(later.gateEta - now.gateEta > 80 * MIN, "deptime honoured");
});

t("winds aloft: a headwind on the route makes the gate later", () => {
  const still = gateEtaFor(ATL, "GRNCH", NOW);
  const levels = { 30000: { dir: 160, spd: 120 }, 34000: { dir: 160, spd: 120 }, 39000: { dir: 160, spd: 120 } };
  seedWindStations({ ATL: { lat: 33.64, lon: -84.43, levels }, MGM: { lat: 32.3, lon: -86.39, levels }, ORL: { lat: 28.54, lon: -81.33, levels } });
  const windy = gateEtaFor(ATL, "GRNCH", NOW);
  seedWindStations({ ATL: { lat: 33.64, lon: -84.43, levels: {} } });
  assert.ok(windy.gateEta > still.gateEta + 5 * MIN, `headwind ${((windy.gateEta - still.gateEta) / MIN).toFixed(1)} min later`);
});

t("airborne inside the gate: no gate ETA, lands off the rest of the route", () => {
  const p = { ...ATL, lat: 28.75, lon: -81.6, alt: 9000, gs: 250, hdg: 140, phase: "air" };
  const r = gateEtaFor(p, "GRNCH", NOW);
  assert.ok(r && r.gateEta === null);
  assert.ok(r.eta > NOW && r.eta < NOW + 20 * MIN);
});

t("the MIT monitor takes engine ETAs and keeps its own when there are none", () => {
  const prog = normRate({ aar: 40 });
  const pilots = [ATL, { ...ATL, callsign: "XX1", route: "DCT", dep: "KXXX" }];
  const m = buildMitMonitor({ airport: "KMCO", aptLL: [28.4294, -81.309], prog, pilots, now: NOW, etaFor: (p, g) => gateEtaFor(p, g, NOW) });
  const a = m.flights.find(f => f.callsign === "DAL1"), b = m.flights.find(f => f.callsign === "XX1");
  assert.equal(a.gateFix, "GRNCH"); assert.ok(a.gateEta < a.eta);
  assert.equal(b.gateEta, null); assert.ok(b.eta > NOW);
});

console.log(`\n${passed} passed`);
