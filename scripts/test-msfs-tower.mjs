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
const ctx = vm.createContext({ Date, Math, JSON, String, parseInt, isNaN });
for (const f of ["common/airport.js", "common/vatsim-feed.js", "common/draw.js", "common/maps-kdca.js",
  "Dbrite/Dbrite.js", "TwrInfo/TwrInfo.js", "Asdex/Asdex.js"]) {
  vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), ctx, { filename: f });
}
const { VATFLOW_TWR: cfg, VatflowFeed, DbriteView, TwrInfoView, AsdexView, VATFLOW_MAPS: maps } = vm.runInContext(
  "({ VATFLOW_TWR, VatflowFeed, DbriteView, TwrInfoView, AsdexView, VATFLOW_MAPS })", ctx);

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

console.log(`\n${passed} passed`);
