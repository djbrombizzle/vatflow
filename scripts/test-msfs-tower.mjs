#!/usr/bin/env node
/**
 * Tests for the MSFS tower cab displays (msfs-tower/package/html_ui/...):
 * the shared VATSIM feed summary, DBRITE dead reckoning / filtering and the
 * TWR INFO METAR parse. The gauge files are plain browser scripts, so they
 * are loaded into a vm context the way MSFS loads them.
 * Usage: node scripts/test-msfs-tower.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const BASE = new URL("../msfs-tower/package/html_ui/Pages/VCockpit/Instruments/VatflowTower/", import.meta.url);
const timers = [];
const ctx = vm.createContext({ Date, Math, JSON, String, parseInt, isNaN, setInterval: (fn, ms) => timers.push({ fn, ms }) });
for (const f of ["common/airport.js", "common/vatsim-feed.js", "common/draw.js", "common/maps-kdca.js",
  "Dbrite/Dbrite.js", "TwrInfo/TwrInfo.js", "Asdex/Asdex.js"]) {
  vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), ctx, { filename: f });
}
const { VATFLOW_TWR: cfg, VatflowFeed, DbriteView, TwrInfoView, AsdexView, VATFLOW_MAPS: maps, VatflowDraw } = vm.runInContext(
  "({ VATFLOW_TWR, VatflowFeed, DbriteView, TwrInfoView, AsdexView, VATFLOW_MAPS, VatflowDraw })", ctx);

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };
const plain = (x) => JSON.parse(JSON.stringify(x));  // vm-realm arrays/objects -> this realm

const pilot = (callsign, lat, lon, altitude, groundspeed, heading, fp = {}) =>
  ({ callsign, latitude: lat, longitude: lon, altitude, groundspeed, heading, transponder: "1200", flight_plan: fp });
const feed = {
  general: { update_timestamp: "2026-10-14T12:00:00Z" },
  pilots: [
    pilot("AAL1", 38.93, -77.06, 2400, 160, 175, { arrival: "KDCA", departure: "KBOS", aircraft_short: "A321" }),
    pilot("UAL2", 38.853, -77.042, 15, 5, 10, { departure: "KDCA", arrival: "KORD" }),
    pilot("FAR1", 40.6, -73.8, 30000, 450, 90, { arrival: "KDCA" }),
    pilot("NOFP", 38.80, -77.0, 3000, 120, 0, null)
  ],
  controllers: [
    { callsign: "DCA_TWR", frequency: "119.100" }, { callsign: "PCT_APP", frequency: "124.200" },
    { callsign: "DC_N_CTR", frequency: "133.700" }, { callsign: "IAD_TWR", frequency: "120.100" },
    { callsign: "DC_OBS", frequency: "199.998" }
  ],
  atis: [{ callsign: "KDCA_ATIS", atis_code: "K", text_atis: ["INFO", "K"] }]
};

t("toNm: 1 deg lat = 60 nm, lon scaled by cos(lat)", () => {
  const p = VatflowFeed.toNm(cfg.arp, cfg.arp.lat + 1, cfg.arp.lon + 1);
  assert.ok(Math.abs(p.y - 60) < 1e-9);
  assert.ok(Math.abs(p.x - 60 * Math.cos(cfg.arp.lat * Math.PI / 180)) < 1e-9);
});

t("pad: zero-pads rounded values, never negative", () => {
  assert.equal(VatflowFeed.pad(24, 3), "024");
  assert.equal(VatflowFeed.pad(-3, 3), "000");
  assert.equal(VatflowFeed.pad(16.4, 2), "16");
});

t("summarize: nearby traffic, counts, DCA/PCT/ZDC controllers, ATIS", () => {
  const s = VatflowFeed.summarize(feed, cfg);
  assert.deepEqual(plain(s.traffic.map((x) => x.callsign).sort()), ["AAL1", "NOFP", "UAL2"]);
  assert.equal(s.arrivals, 1);      // AAL1 airborne inside 50 nm; FAR1 is too far
  assert.equal(s.departures, 1);    // UAL2 on the ground at DCA
  assert.deepEqual(plain(s.controllers.map((c) => c.callsign)), ["DCA_TWR", "DC_N_CTR", "PCT_APP"]);
  assert.equal(s.atis.code, "K");
});

t("DBRITE: hides slow/ground traffic and dead-reckons along heading", () => {
  const s = VatflowFeed.summarize(feed, cfg);
  const fakeCanvas = { width: 1024, height: 768, getContext: () => ({}) };
  const v = new DbriteView(fakeCanvas, cfg);
  v.setData(s);
  const aal = v.targets.AAL1, ual = v.targets.UAL2;
  assert.equal(v.visible(aal.t), true);
  assert.equal(v.visible(ual.t), false);
  const base = Date.parse("2026-10-14T12:00:00Z");
  const p = v.positionAt(aal, base + 18000);       // 18 s at 160 kt = 0.8 nm, heading 175
  const moved = Math.hypot(p.x - aal.t.x, p.y - aal.t.y);
  assert.ok(Math.abs(moved - 0.8) < 1e-9);
  assert.ok(p.y < aal.t.y);                         // southbound
  const capped = v.positionAt(aal, base + 600000);  // stale feed: capped at 30 s
  assert.ok(Math.abs(Math.hypot(capped.x - aal.t.x, capped.y - aal.t.y) - 160 * 30 / 3600) < 1e-9);
});

t("DBRITE: targets that leave the feed are dropped with their history", () => {
  const v = new DbriteView({ width: 1, height: 1, getContext: () => ({}) }, cfg);
  v.setData(VatflowFeed.summarize(feed, cfg));
  v.sweep(Date.now());
  assert.ok(v.history.AAL1);
  v.setData(VatflowFeed.summarize({ ...feed, pilots: [] }, cfg));
  assert.equal(v.targets.AAL1, undefined);
  assert.equal(v.history.AAL1, undefined);
});

t("METAR parse: wind, gusts, variable, altimeter", () => {
  const a = TwrInfoView.parseMetar("KDCA 141152Z 19007KT 10SM SCT100 19/18 A2995 RMK AO2");
  assert.deepEqual(plain(a.wind), { dir: "190", kt: 7, gust: null });
  assert.equal(a.altim, "29.95");
  const g = TwrInfoView.parseMetar("KDCA 141252Z 31015G25KT 10SM A3012");
  assert.equal(g.wind.gust, 25);
  assert.equal(TwrInfoView.parseMetar("KDCA 141352Z VRB03KT 10SM A2990").wind.dir, "VRB");
  assert.equal(TwrInfoView.parseMetar("").wind, null);
});

t("maps: KDCA field outline, runways and nearby airports are present", () => {
  const a = maps.asdex, d = maps.dbrite;
  assert.equal(a.land.length, 1);
  assert.ok(a.land[0].length / 2 > 50, "field outline should not be simplified away");
  assert.ok(a.taxiways.length > 50 && a.runways.length >= 3 && a.buildings.length >= 3);
  const ids = d.airports.map((x) => x.id);
  for (const id of ["KDCA", "KADW", "KDAA"]) assert.ok(ids.includes(id), id);
  // DCA's runway 01/19 is ~7169 ft: check one OSM centerline length in meters
  const r = a.runways.find((x) => x.ref === "01/19");
  const len = Math.hypot(r.p[0] - r.p[r.p.length - 2], r.p[1] - r.p[r.p.length - 1]);
  assert.ok(Math.abs(len - 7169 * 0.3048) < 60, "01/19 length " + len);
});

t("ASDE-X: fits the field in the canvas and filters to the surface area", () => {
  const v = new AsdexView({ width: 768, height: 1024, getContext: () => ({}) }, cfg, maps);
  const ring = maps.asdex.land[0];
  for (let i = 0; i < ring.length; i += 2) {
    const p = v.px(ring[i], ring[i + 1]);
    assert.ok(p.x >= 0 && p.x <= 768 && p.y >= 0 && p.y <= 1024, "outline point off screen");
  }
  const north = v.px(0, 1000), south = v.px(0, -1000);
  assert.ok(north.y < south.y, "north is up");
  const s = VatflowFeed.summarize(feed, cfg);
  v.setData(s);
  assert.deepEqual(plain(Object.keys(v.targets)), ["UAL2"]);   // AAL1 is 2400 ft / 5 nm out, NOFP 3000 ft
});

t("DBRITE list: time/altimeter line and one line per altimeter station", () => {
  const v = new DbriteView({ width: 1, height: 1, getContext: () => ({}) }, cfg, maps);
  v.setMetars({ KDCA: VatflowFeed.parseMetar("KDCA 141152Z 19007KT 10SM A2995"),
    KADW: VatflowFeed.parseMetar("KADW 141155Z 22007G15KT 10SM A2993") });
  const lines = plain(v.listLines(12 * 3600 + 52 * 60 + 3)).map((l) => l.s);
  assert.equal(lines[0], "1252/03 29.95");
  assert.ok(lines.includes("DCA 29.95 19007"));
  assert.ok(lines.includes("ADW 29.93 22007G15"));
  assert.ok(lines.includes("DAA --.-- -----"));
});

t("DBRITE finals: 01 extends south along the runway, 19 offset outward on 147 mag (137 true)", () => {
  const f01 = DbriteView.finalLine(cfg, { rwy: "01", lengthNm: 10 });
  assert.ok(f01.b.y < f01.a.y - 9.9, "01 final runs south from the 01 threshold");
  assert.ok(Math.abs(f01.b.x - f01.a.x) < 1, "01 final follows the runway (356 true)");
  assert.equal(f01.ticks.length, 10);
  const f19 = DbriteView.finalLine(cfg, { rwy: "19", courseMag: 147, lengthNm: 10 });
  const out = (Math.atan2(f19.b.x - f19.a.x, f19.b.y - f19.a.y) * 180 / Math.PI + 360) % 360;
  assert.ok(Math.abs(out - 317) < 0.01, "19 final outward bearing " + out);   // 137 true inbound
  assert.ok(f19.a.y > 0.4, "starts at the north (19) threshold");
  assert.equal(DbriteView.finalLine(cfg, { rwy: "36" }), null);
});

t("draw loop: an error is shown on screen and the next frame still draws; watchdog redraws", () => {
  const calls = [];
  const fakeCtx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  const texts = [];
  fakeCtx.fillText = (s) => texts.push(String(s));
  let fail = true;
  const view = { ctx: fakeCtx, canvas: { height: 768, style: {} }, draw: () => { calls.push(1); if (fail) throw new Error("boom"); } };
  timers.length = 0;
  const tick = VatflowDraw.loop(view, 1000);
  tick(false);
  assert.equal(calls.length, 1);
  assert.ok(texts.some((x) => x === "ERR boom"), "error drawn on the screen");
  fail = false;
  tick(true);                                   // next frame runs normally
  assert.equal(calls.length, 2);
  const o1 = view.canvas.style.opacity;
  tick(true);
  assert.notEqual(view.canvas.style.opacity, o1, "each frame changes the DOM so MSFS repaints");
  calls.pop();
  assert.equal(timers.length, 1);               // watchdog installed
  tick(false);                                  // throttled: too soon
  assert.equal(calls.length, 2);
});

t("radar screens draw without errors against a stub canvas for every target in a busy feed", () => {
  const stub = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  const canvas = { width: 1024, height: 768, getContext: () => stub };
  const pilots = [];
  for (let i = 0; i < 200; i++) {
    pilots.push(pilot("T" + i, 38.85 + Math.sin(i) * 0.1, -77.04 + Math.cos(i) * 0.1, i % 3 ? i * 50 : -20,
      i % 5 ? i : 0, (i * 37) % 360, i % 7 ? { aircraft_short: null, arrival: "KDCA" } : null));
  }
  pilots.push({ callsign: "WEIRD", latitude: 38.85, longitude: -77.04 });   // missing fields
  const s = VatflowFeed.summarize({ general: {}, pilots, controllers: [], atis: [] }, cfg);
  const d = new DbriteView(canvas, cfg, maps), a = new AsdexView({ width: 768, height: 1024, getContext: () => stub }, cfg, maps);
  d.setData(s); a.setData(s);
  for (let k = 0; k < 20; k++) { d.draw(Date.now() + k * 5000, 3600 * 19 + k); a.draw(Date.now() + k * 5000, 3600 * 19 + k); }
});

t("TWR INFO actual wind: 2-minute vector average, magnetic, gusts only 10 kt over the average", () => {
  const now = 1_000_000;
  const steady = [];
  for (let i = 0; i < 120; i++) steady.push({ t: now - i * 1000, dir: 350 + (i % 2 ? 20 : 0), kt: 12 });
  const w = plain(TwrInfoView.actualWind(steady, now));
  assert.equal(w.dir, 360);                      // 350 and 010 average to north, not 180
  assert.ok(w.kt >= 11 && w.kt <= 12);
  assert.equal(w.gust, null);
  const gusty = steady.concat([{ t: now - 300000, dir: 0, kt: 25 }]);
  assert.equal(TwrInfoView.actualWind(gusty, now).gust, 25);
  assert.equal(TwrInfoView.actualWind([{ t: now, dir: 90, kt: 2 }], now).calm, true);
  assert.equal(TwrInfoView.actualWind([{ t: now - 200000, dir: 90, kt: 9 }], now), null);  // too old for the average
});

t("IDST: bundled VATFLOW engine lists metered DCA departures and issues / cancels a release", () => {
  const ictx = vm.createContext({ Date, Math, JSON, String, Number, Object, Array, Promise, Map, Set, parseInt, parseFloat, isNaN, isFinite, console,
    setTimeout: () => 0, setInterval: () => 0, globalThis: undefined });
  ictx.globalThis = ictx;
  for (const f of ["common/airport.js", "common/vatsim-feed.js", "common/vatflow-metering.js", "Idst/Idst.js"]) {
    vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), ictx, { filename: f });
  }
  const M = ictx.VatflowMetering;
  M.seedAirports({ KDCA: [38.8521, -77.0377], KLGA: [40.7772, -73.8726], KATL: [33.6367, -84.4281] });
  const el = () => ({ textContent: "", innerHTML: "", className: "", style: {}, addEventListener() {} });
  const els = {};
  const root = { querySelector: (sel) => (els[sel] = els[sel] || el()) };
  const view = new ictx.IdstView(root, ictx.VATFLOW_TWR);
  view.demo = true;
  view.setFeed({ pilots: [
    pilot("RPA1", 38.8545, -77.04, 15, 0, 175, { departure: "KDCA", arrival: "KLGA", aircraft_short: "E175", altitude: "25000", cruise_tas: "440" }),
    pilot("DAL2", 38.8440, -77.037, 15, 0, 0, { departure: "KDCA", arrival: "KATL", aircraft_short: "B712", altitude: "33000", cruise_tas: "450" }),
  ], controllers: [] });
  view.setFcaRows([{ id: "fca_t", data: { id: "fca_t", name: "NE", enabled: true, mode: "mit", mit: 10, rate: 30, dir: "any",
    dests: ["KLGA"], origins: [], scope: [], fixes: [], minFL: 0, maxFL: 600, order: [], excluded: [], releases: {},
    points: [[39.6, -77.4], [39.6, -75.6]] } }]);
  view.render();
  assert.deepEqual(plain(view.rows.map((r) => r.callsign)), ["RPA1"], "only the departure crossing the program line");
  assert.equal(view.rows[0].frozen, false);
  view.key(2);                                   // select first row
  assert.equal(view.sel, "RPA1");
  view.key(3);                                   // issue
  const rel = plain(view.fcas[0].releases.RPA1);
  assert.ok(rel.edctMs >= Date.now() && rel.ctaMs > rel.edctMs && rel.assignedMs, "release frozen with EDCT + CTA");
  view.render();
  assert.equal(view.rows[0].frozen, true);
  assert.match(els["#id-list"].innerHTML, /RPA1[\s\S]*\d{4}Z/);
  view.key(4);                                   // cancel
  assert.equal(view.fcas[0].releases.RPA1, undefined);
  view.demo = false;                             // live: no CID -> nothing is written
  view.key(3);
  assert.match(view.msg, /CID/);
  assert.equal(view.fcas[0].releases.RPA1, undefined);
});

t("cab model: every panel.cfg screen has a matching $SCREEN material and IDST keys set the L: var", () => {
  const MODEL = new URL("../msfs-tower/package/SimObjects/Airplanes/vatflow_tower_cab/common/", import.meta.url);
  const panel = readFileSync(new URL("panel/panel.cfg", MODEL), "utf8");
  const screens = [...panel.matchAll(/^texture=(\$SCREEN_\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(screens, ["$SCREEN_DBRITE", "$SCREEN_TWRINFO", "$SCREEN_ASDEX", "$SCREEN_IDST", "$SCREEN_CLOCK", "$SCREEN_VSCS"]);
  for (const m of panel.matchAll(/^htmlgauge00=VatflowTower\/([\w/]+\.html)/gm)) {
    assert.ok(readFileSync(new URL(m[1], BASE), "utf8").includes("import-script"), m[1]);
  }
  const build = readFileSync(new URL("../msfs-tower/blender/build_tower_cab.py", import.meta.url), "utf8");
  for (const sname of screens) assert.ok(build.includes('"' + sname + '"'), sname + " in the build script");
  const xml = readFileSync(new URL("model/tower_cab_interior.xml", MODEL), "utf8");
  for (const k of [1, 2, 3, 4]) {
    assert.ok(xml.includes(`Node="TowerCab_IdstKey_${k}"`) && xml.includes(`${k} (&gt;L:VATFLOW_IDST_KEY)`), "IDST key " + k);
  }
});

console.log(`\n${passed} passed`);
