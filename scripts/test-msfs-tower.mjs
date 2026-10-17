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
for (const f of ["common/airport.js", "common/vatsim-feed.js", "common/draw.js", "common/airports/KDCA.js",
  "Dbrite/Dbrite.js", "TwrInfo/TwrInfo.js", "Asdex/Asdex.js"]) {
  vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), ctx, { filename: f });
}
const { VATFLOW_TWR: cfg, VatflowFeed, DbriteView, TwrInfoView, AsdexView, maps, VatflowDraw } = vm.runInContext(
  "({ VATFLOW_TWR, VatflowFeed, DbriteView, TwrInfoView, AsdexView, maps: VATFLOW_AIRPORTS.KDCA.maps, VatflowDraw })", ctx);

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

t("ASDE-X taxiway labels: named taxiways labelled on screen, spaced out, none piled up", () => {
  for (const f of ["common/airports/KATL.js"]) vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), ctx, { filename: f });
  const katl = vm.runInContext("VATFLOW_AIRPORTS.KATL", ctx);
  assert.ok(katl.maps.asdex.taxiways.filter((t) => t.ref).length > 100, "KATL's taxiway names are bundled");
  const c = JSON.parse(JSON.stringify(cfg));
  c.arp = katl.arp; c.elevFt = katl.elevFt;
  const v = new AsdexView({ width: 1024, height: 768, getContext: () => ({}) }, c, katl.maps);
  const spots = plain(v.labelSpots());
  const names = spots.map((s) => s.t);
  for (const n of ["A", "B", "L", "N"]) assert.ok(names.includes(n), n + " labelled");
  for (const s of spots) assert.ok(s.x >= 0 && s.x <= 1024 && s.y >= 0 && s.y <= 768, "on screen");
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
    const d = Math.abs(spots[i].x - spots[j].x) + Math.abs(spots[i].y - spots[j].y);
    assert.ok(d >= 30, "two labels on top of each other");
    if (spots[i].t === spots[j].t) assert.ok(d >= 230, spots[i].t + " twice close together");
  }
  // an ARTCC map shown instead keeps the OpenStreetMap names on top
  v.setMap({ vnas: true, land: [], polys: [] });
  assert.ok(plain(v.labelSpots()).some((s) => s.t === "B"), "names kept over an ARTCC map");
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

t("TWR INFO actual wind: 2-minute average, magnetic, gusts the ASOS way", () => {
  const now = 1_000_000;
  const steady = [];
  for (let i = 0; i < 120; i++) steady.push({ t: now - i * 1000, dir: 350 + (i % 2 ? 20 : 0), kt: 12 });
  steady.reverse();
  const w = plain(TwrInfoView.actualWind(steady, now, []));
  assert.equal(w.dir, 360);                      // 350 and 010 average to north, not 180
  assert.equal(w.kt, 12);
  assert.equal(w.gust, null);
  assert.equal(TwrInfoView.actualWind([{ t: now, dir: 90, kt: 2 }], now).calm, true);
  assert.equal(TwrInfoView.actualWind([{ t: now - 200000, dir: 90, kt: 9 }], now), null);  // too old for the average
  // wind 10 kt with a 6-second burst to 18 kt half a minute ago: 5-second peak 18, sustained ~10.4
  const run = (base, burst, burstAt) => {
    const out = [];
    for (let i = 119; i >= 0; i--) out.push({ t: now - i * 1000, dir: 270, kt: i >= burstAt && i < burstAt + 6 ? burst : base });
    return out;
  };
  const g = TwrInfoView.gustNow(run(10, 18, 30), now);
  assert.ok(g >= 17.9 && g <= 18, "5-second peak " + g);
  assert.equal(plain(TwrInfoView.actualWind(run(10, 18, 30), now, [])).gust, 18);
  // a 1-second spike is not a gust: the 5-second average stays low
  assert.equal(TwrInfoView.gustNow(run(10, 30, 30).map((s, k, a) => ({ ...s, kt: now - s.t === 30000 ? 30 : 10 })), now), null);
  // sustained under 9 kt: no gust, however strong the peak
  assert.equal(TwrInfoView.gustNow(run(6, 20, 30), now), null);
  // peak under 5 kt over: no gust
  assert.equal(TwrInfoView.gustNow(run(12, 16, 30), now), null);
  // peak older than a minute: not a new gust...
  assert.equal(TwrInfoView.gustNow(run(10, 18, 70), now), null);
  // ...but one recorded earlier is still reported for 10 minutes, and not after
  const gusts = [{ t: now - 9 * 60000, kt: 21 }];
  assert.equal(TwrInfoView.actualWind(steady, now, gusts).gust, 21);
  assert.equal(TwrInfoView.actualWind(steady, now + 2 * 60000, gusts), null, "no samples then");
  const later = steady.map((s) => ({ ...s, t: s.t + 2 * 60000 }));
  assert.equal(TwrInfoView.actualWind(later, now + 2 * 60000, gusts).gust, null, "older than 10 minutes");
});

t("TWR INFO windshear: 15 kt sudden gain / loss alerts, stays a minute, MUTE silences it", () => {
  const now = 2_000_000;
  const run = (base, burst, n) => {
    const out = [];
    for (let i = 119; i >= 0; i--) out.push({ t: now - i * 1000, dir: 270, kt: i < n ? burst : base });
    return out;
  };
  assert.equal(TwrInfoView.windshear(run(10, 12, 5), now), null, "steady wind");
  assert.equal(TwrInfoView.windshear(run(10, 32, 5), now), 21, "21 kt gain (the burst is in the 2-minute mean too)");
  assert.equal(TwrInfoView.windshear(run(30, 5, 5), now), -24, "24 kt loss");
  assert.equal(TwrInfoView.windshear(run(10, 24, 5), now), null, "14 kt: not yet");
  const young = run(10, 40, 5).slice(-30);
  assert.equal(TwrInfoView.windshear(young, now), null, "no alert in the first minute of wind history");
  // the screen: alert, keeps the biggest change, MUTE hides it, a minute of steady wind ends it
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, textContent: "", className: "", addEventListener(ev, fn) { this.fn = fn; } });
  const root = { querySelector: (q) => el(q.slice(1)) };
  const v = new TwrInfoView(root, Object.assign({}, cfg, { icao: "KATL" }));
  v.checkWindshear(22, now);
  assert.equal(els["ti-ws"].style.display, "flex");
  assert.equal(els["ti-wsText"].textContent, "WINDSHEAR ALERT");
  assert.equal(els["ti-wsKt"].textContent, "22 KT GAIN");
  v.checkWindshear(-35, now + 1000);
  assert.equal(els["ti-wsText"].textContent, "MICROBURST ALERT");
  assert.equal(els["ti-wsKt"].textContent, "35 KT LOSS");
  els["ti-wsMute"].fn();                                   // MUTE on the screen
  assert.equal(els["ti-ws"].style.display, "none");
  v.checkWindshear(20, now + 5000);
  assert.equal(els["ti-ws"].style.display, "none", "muted until this alert is over");
  v.checkWindshear(null, now + 30000);
  assert.equal(v.ws.active, true);
  v.checkWindshear(null, now + 66000);
  assert.equal(v.ws.active, false, "a minute steady: over");
  v.checkWindshear(18, now + 70000);
  assert.equal(els["ti-ws"].style.display, "flex", "a new alert shows again");
  assert.equal(els["ti-wsKt"].textContent, "18 KT GAIN");
});

t("RVR monitor: the FAA table for the cab's airport (TD / MP / RO, trends, lights)", () => {
  const g = vm.createContext({});
  vm.runInContext(readFileSync(new URL("Rvr/Rvr.js", BASE), "utf8"), g);
  const R = vm.runInContext("RvrView", g);
  assert.equal(R.faaId({ icao: "KATL", lid: "ATL" }), "ATL");
  assert.equal(R.faaId({ icao: "KMCO" }), "MCO");
  assert.ok(R.url({ icao: "KATL", lid: "ATL" }).startsWith("https://rvr.data.faa.gov/cgi-bin/rvr-details.pl?content=table&"));
  assert.ok(R.url({ icao: "KATL", lid: "ATL" }).endsWith("&airport=ATL"));
  const d = plain(R.parse("<head>\n<meta http-equiv=\"Refresh\" content=\"60; url=/cgi-bin/rvr-details.pl?content=table&airport=EUG&rrate=medium&layout=2x2&gifsize=large&fontsize=large&fs=lg&cache_this=ct1792161331\">\n<title>RVR Details</title>\n</head>\n<body>\n   <center>\n   <font size =\"+2\"><b>RVR DETAILS</b></font>\n   <br><br>\n   <strong>EUG &nbsp (MAHLON SWEET FIELD)</strong>\n   <br>\n   <strong><table><tr><th>14:35:22z</th><th>10/16/2026</th></tr></table></strong>\n   <br>\n   <a href=\"/cgi-bin/rvr-status.pl\"><font size=\"+0\" color=\"blue\">RVR Status Monitor</font></a> &nbsp; &nbsp; &nbsp; <a href=\"/cgi-bin/rvr-airports.pl\"><font size=\"+0\" color=\"blue\">Airport Name Lookup</font></a> &nbsp; &nbsp; &nbsp; <a href=\"/help.html\"><font size=\"+0\" color=\"blue\">Help</font></a>\n   <br><br>\n   <pre></pre>\n   <font size=6><table border>\n   <TR><TH>&nbsp;RWY&nbsp</TH> <TH>&nbsp;TD&nbsp;</TH> <TH>&nbsp;MP&nbsp</TH> <TH>&nbsp;RO&nbsp</TH> <TH>&nbsp;E&nbsp</TH><TH>&nbsp;C&nbsp</TH></TR>\n          <tr><th>16R</th>\n          <td align=\"center\">>6000 </td> \n          <td align=\"center\">1400&#9660;</td> \n          <td align=\"center\">1600&#9650;</td> \n          <td align=\"center\">5</td> \n          <td align=\"center\">5</td></tr>\n          <tr><th>34L</th>\n          <td align=\"center\">1600&#9650;</td> \n          <td align=\"center\">1400&#9660;</td> \n          <td align=\"center\">>6000 </td> \n          <td align=\"center\">5</td> \n          <td align=\"center\">5</td></tr>\n   </table></font>\n   <pre></pre>\n   <br><br>\n   <img src=\"/images/keysee.gif\"><br><br>\n   <strong>EUG&nbsp;&nbsp;16R\n</strong><br>\n   <img src=\"/cgi-bin/og.pl?pic=EUG-16R\n-l&cache_this=ct1792161331\"><br><pre></pre>\n   <strong>EUG&nbsp;&nbsp;34L\n</strong><br>\n   <img src=\"/cgi-bin/og.pl?pic=EUG-34L\n-l&cache_this=ct1792161331\"><br><pre></pre>\n   </center>\n</body>\n"));
  assert.equal(d.time, d.time.toUpperCase());
  assert.ok(/EUG/.test(d.name) || d.name.length > 3, "airport name");
  assert.deepEqual(d.rows[0], { rwy: "16R", td: ">6000", mp: "1400\u25BC", ro: "1600\u25B2", e: "5", c: "5" });
  assert.equal(d.rows.length, 2);
  assert.equal(R.level(">6000"), "");
  assert.equal(R.level("1400\u25BC"), "amber");
  assert.equal(R.level("0600"), "red");
  assert.equal(R.level("FFF"), "");
  assert.equal(R.parse(""), null, "no RVR at this airport: the FAA sends an empty page");
  // through the VATFLOW hub (the FAA page has no CORS header for the sim's screens)
  assert.equal(R.hubUrl({ icao: "KATL", lid: "ATL" }), "https://vatflow-hub-production.up.railway.app/hub/rvr?airport=ATL");
  const hub = plain(R.fromHub(JSON.stringify({ ok: true, airport: "EUG", name: d.name, time: d.time, rows: d.rows })));
  assert.deepEqual(hub, d, "the hub's JSON is the same table");
  assert.equal(R.fromHub('{"ok":true,"airport":"XYZ","rows":[]}'), null);
  assert.throws(() => R.fromHub('{"ok":false}'));
  assert.throws(() => R.fromHub("<html>"));
});

t("windshear alarm sound: sound.xml plays the cab's own .wav (WaveData) while L:VATFLOW_WS_ALERT is 1", () => {
  const dir = new URL("../msfs-tower/package/SimObjects/Airplanes/vatflow_tower_cab/common/sound/", import.meta.url);
  const xml = readFileSync(new URL("sound.xml", dir), "utf8");
  assert.ok(/<SimVarSounds>[\s\S]*WwiseData="False"[\s\S]*WwiseEvent="custom_warning_cockpit_sound_01"[\s\S]*FileName="vatflow_windshear"[\s\S]*LocalVar="VATFLOW_WS_ALERT"[\s\S]*Continuous="True"/.test(xml), "the alarm sound");
  assert.ok(!/<MainPackage/.test(xml) && !/<EngineSound/.test(xml), "nothing else plays (no packages, no engines)");
  const wav = readFileSync(new URL("vatflow_windshear.wav", dir));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt16LE(20), 1, "PCM");
  assert.equal(wav.readUInt16LE(34), 16, "16-bit");
  assert.equal(wav.readUInt32LE(24), 44100);
});

t("IDST: bundled VATFLOW engine lists metered DCA departures and issues / cancels a release", () => {
  const ictx = vm.createContext({ console,
    setTimeout: () => 0, setInterval: () => 0 });
  // MSFS's instrument browser has no globalThis (or Promise.finally): the bundle must not need them
  vm.runInContext("delete globalThis.globalThis; delete Promise.prototype.finally;", ictx);
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
  // a release issued and later cancelled elsewhere (web page): the next poll's server copy wins
  const program = (releases) => [{ id: "fca_t", data: JSON.parse(JSON.stringify(Object.assign({}, plain(view.fcas[0]), { releases }))) }];
  view.setFcaRows(program({ RPA1: { ctaMs: Date.now() + 9e5, edctMs: Date.now() + 3e5, transitSec: 600, assignedMs: Date.now() } }));
  view.render();
  assert.equal(view.rows[0].frozen, true, "release issued on the web shows up");
  view.setFcaRows(program({}));
  view.render();
  assert.equal(view.rows[0].frozen, false, "release cancelled on the web goes away");
  view.demo = false;                             // live: no CID -> nothing is written
  view.key(3);
  assert.match(view.msg, /CID/);
  assert.equal(view.fcas[0].releases.RPA1, undefined);
});

t("cab model: every panel.cfg screen has a matching $SCREEN material and IDST keys set the L: var", () => {
  const MODEL = new URL("../msfs-tower/package/SimObjects/Airplanes/vatflow_tower_cab/common/", import.meta.url);
  const panel = readFileSync(new URL("panel/panel.cfg", MODEL), "utf8");
  const screens = [...panel.matchAll(/^texture=(\$SCREEN_\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(screens, ["$SCREEN_DBRITE", "$SCREEN_TWRINFO", "$SCREEN_ASDEX", "$SCREEN_IDST", "$SCREEN_CLOCK", "$SCREEN_VSCS",
    "$SCREEN_APTDEMAND", "$SCREEN_APTLIST", "$SCREEN_CLOCK2", "$SCREEN_RAMP", "$SCREEN_VATSMART",
    "$SCREEN_RAMPMAP_ED", "$SCREEN_RAMPMAP_CB", "$SCREEN_RAMPMAP_AS",
    "$SCREEN_STRIPS_1", "$SCREEN_STRIPS_2", "$SCREEN_STRIPS_3", "$SCREEN_SIGN_1", "$SCREEN_SIGN_2", "$SCREEN_SIGN_3"]);
  for (const m of panel.matchAll(/^htmlgauge00=VatflowTower\/([\w/]+\.html)/gm)) {
    const page = readFileSync(new URL(m[1], BASE), "utf8");
    assert.ok(page.includes("common/dimmer.js"), m[1] + " loads the dimmer");
    for (const imp of page.matchAll(/(?:import-script|href)="\/Pages\/VCockpit\/Instruments\/VatflowTower\/([^"]+)"/g)) {
      assert.ok(readFileSync(new URL(imp[1], BASE), "utf8").length > 0, m[1] + " -> " + imp[1] + " exists");
    }
  }
  const build = readFileSync(new URL("../msfs-tower/blender/build_tower_cab.py", import.meta.url), "utf8");
  for (const sname of screens) assert.ok(build.includes('"' + sname + '"'), sname + " in the build script");
  const xml = readFileSync(new URL("model/tower_cab_interior.xml", MODEL), "utf8");
  for (const k of [1, 2, 3, 4]) {
    assert.ok(xml.includes(`Node="TowerCab_IdstKey_${k}"`) && xml.includes(`${k} (&gt;L:VATFLOW_IDST_KEY)`), "IDST key " + k);
  }
  for (const m of ["DBRITE", "ASDEX"]) {
    const cap = m === "DBRITE" ? "Dbrite" : "Asdex";
    const comp = (part) => (new RegExp(`Node="TowerCab_${cap}Mount${part}">([\\s\\S]*?)</Component>`).exec(xml) || [])[1] || "";
    assert.match(comp("_Lift"), new RegExp(`<POSITION_VAR>VATFLOW_${m}_TRACK_DEG</POSITION_VAR>`), m + " track drag on the post");
    assert.match(comp(""), new RegExp(`<POSITION_VAR>VATFLOW_${m}_TRACK_DEG</POSITION_VAR>`), m + " track drag on the trolley");
    for (const k of ["_SwivelL", "_SwivelR"]) assert.match(comp(k), new RegExp(`<POSITION_VAR>VATFLOW_${m}_TWIST</POSITION_VAR>`), m + k + " swivel");
    assert.ok(!xml.includes(`TowerCab_${cap}Mount_Screen`), m + ": no draggable yoke covering the screen");
    const disp = new RegExp(`Node="TowerCab_${cap}Mount_Display">([\\s\\S]*?)</Component>`).exec(xml);
    assert.ok(disp && !/Dragging/.test(disp[1]), m + " display: no drag, so clicks reach the page (MAPS, MENU)");
    assert.ok(xml.includes(`<ANIM_CODE>(L:VATFLOW_${m}_HEIGHT)</ANIM_CODE>`) && xml.includes(`<POSITION_VAR>VATFLOW_${m}_HEIGHT</POSITION_VAR>`), m + " height");
    assert.ok(xml.includes(`<ANIM_CODE>(L:VATFLOW_${m}_TWIST)</ANIM_CODE>`) && xml.includes(`<POSITION_VAR>VATFLOW_${m}_TWIST</POSITION_VAR>`), m + " swivel");
  }
  for (const g of ["ALL", "DBRITE", "ASDEX", "CONSOLE"]) {
    assert.ok(xml.includes(`Node="TowerCab_DimKnob_${g}"`) && xml.includes(`<POSITION_VAR>VATFLOW_DIM_${g}</POSITION_VAR>`), "knob " + g);
  }
});

t("screen brightness: knobs combine, never fully black, label only when a knob turns", () => {
  const dctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL("common/dimmer.js", BASE), "utf8"), dctx);
  const D = dctx.VatflowDimmer;
  assert.equal(D.level(0, 0), 1);
  assert.ok(Math.abs(D.level(50, 50) - 0.25) < 1e-9);
  assert.equal(D.level(90, 90), 0.05);
  assert.ok(Math.abs(D.level(-5, 500) - 0.1) < 1e-9);      // clamped to 0..90
  const made = [];
  const doc = { createElement: () => { const e = { style: {}, textContent: "" }; made.push(e); return e; } };
  const host = { style: {}, children: [], appendChild(e) { this.children.push(e); } };
  const update = D.attach(host, "CONSOLE", doc);
  const [shade, label] = made;
  // screens glow at twice normal (emissive 4000); the layer brings 100 % back to the old glow
  const op = (x) => Number(shade.style.opacity);
  update(0, 0);
  assert.ok(Math.abs(Math.pow(1 - op(), 2.2) * 2 - 1) < 0.01, "100 % = the old full glow");
  assert.notEqual(label.style.display, "block", "no label on the first frame");
  update(0, 60);
  assert.ok(Math.abs(Math.pow(1 - op(), 2.2) * 2 - Math.pow(0.4, 2.2)) < 0.01, "dimmed like before");
  assert.equal(label.style.display, "block");
  assert.equal(label.textContent, "BRT 40%");
  // BOOST (TOWER SETUP BRIGHTER past 100 %): up to 200 %, where the layer is gone
  assert.equal(update(0, 0, 150), 1.5);
  assert.equal(label.textContent, "BRT 150%");
  assert.ok(Math.abs(Math.pow(1 - op(), 2.2) * 2 - 1.5) < 0.01, "150 % = 1.5 x the light");
  assert.equal(update(0, 0, 200), 2);
  assert.equal(op(), 0);
  assert.equal(update(0, 0, 900), 2, "never past 200 %");
  assert.equal(update(0, 0, 0), 1, "not set yet = 100 %");
  // deepest dimming still keeps 8 % of the page, so dark colours do not round to one colour channel
  assert.equal(D.shadeFor(0.05), 0.08);
  assert.ok(D.shadeFor(0.5) > 0.08);
  // overhead monitor pose: set once per flight to as built (height 15, swivel 50)
  const vars = {};
  dctx.SimVar = { GetSimVarValue: (n) => vars[n] || 0, SetSimVarValue: (n, u, v) => { vars[n] = v; } };
  D.initMonitorPose("DBRITE");
  assert.equal(vars["L:VATFLOW_DBRITE_HEIGHT"], 15);
  assert.equal(vars["L:VATFLOW_DBRITE_TWIST"], 50);
  vars["L:VATFLOW_DBRITE_HEIGHT"] = 33;                    // you moved it; a screen reload keeps that
  D.initMonitorPose("DBRITE");
  assert.equal(vars["L:VATFLOW_DBRITE_HEIGHT"], 33);
});

t("ramp list: bundled gates.html logic proposes gates for inbounds and lists ground departures", () => {
  const rctx = vm.createContext({ console });
  vm.runInContext("delete globalThis.globalThis;", rctx);    // as in MSFS
  for (const f of ["common/airport.js", "common/vatsim-feed.js", "common/vatflow-ramp.js", "common/ramp-kdca.js",
    "common/ramp-data.js", "Ramp/Ramp.js", "RampMap/RampMap.js"]) {
    vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), rctx, { filename: f });
  }
  const el = () => ({ textContent: "", innerHTML: "", className: "" });
  const els = {};
  const view = new rctx.RampView({ querySelector: (q) => (els[q] = els[q] || el()) }, rctx.VATFLOW_RAMP_LAYOUT);
  view.setPilots({ pilots: [
    pilot("SWA1", 38.95, -77.05, 6000, 220, 180, { departure: "KBNA", arrival: "KDCA", aircraft_short: "B737" }),
    pilot("AAL2", 38.8505, -77.0410, 15, 0, 90, { departure: "KDCA", arrival: "KCLT", aircraft_short: "A321", deptime: "2359" }),
  ] });
  view.setHub({ ok: true, state: rctx.VatflowRamp.emptyState("KDCA"), realGates: {} });
  view.render(Date.UTC(2026, 9, 15, 12, 0, 0));
  assert.match(els["#rp-in"].innerHTML, /SWA1[\s\S]*KBNA[\s\S]*class="c5 prop">A\d/, "Southwest gets a proposed A gate");
  assert.match(els["#rp-out"].innerHTML, /AAL2[\s\S]*KCLT/);
  assert.equal(els["#rp-inCount"].textContent, 1);
  assert.match(els["#rp-status"].textContent, /LIVE/);

  // ramp maps: each view draws its own ramps' stands (canvas stub records the gate labels)
  const drawn = { ED: [], CB: [], AS: [] };
  for (const id of Object.keys(drawn)) {
    const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : k === "fillText" || k === "strokeText"
      ? (t) => drawn[id].push(String(t)) : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
    const map = new rctx.RampMapView({ width: 1024, height: 768, getContext: () => ctx }, null, id, view.data);
    map.draw(Date.UTC(2026, 9, 15, 12, 0, 0));
  }
  assert.ok(drawn.ED.includes("E47") && drawn.ED.includes("D35"), "E / D gates");
  assert.ok(drawn.CB.includes("B15") && drawn.CB.includes("C26"), "C / B gates");
  assert.ok(drawn.AS.includes("A1") && drawn.AS.includes("A9"), "A gates");
  assert.ok(drawn.AS.includes("AAL2 A321") || drawn.CB.includes("AAL2 A321") || drawn.ED.includes("AAL2 A321") ||
    Object.values(drawn).flat().some((t) => t === "AAL2"), "the parked departure is on a map");

  // RAMP app: every airport on vatflow.io's ramp page, any mix of its ramps
  vm.runInContext(readFileSync(new URL("common/ramp-airports.js", BASE), "utf8"), rctx);
  const airports = plain(vm.runInContext("VATFLOW_RAMP_AIRPORTS", rctx));
  assert.ok(airports.length >= 12 && airports.some((a) => a.icao === "KDFW"), "airports from data/ramp/index.json");
  assert.ok(rctx.VatflowRampData.has("KIAD") && rctx.VatflowRampData.has("KATL") && !rctx.VatflowRampData.has("KBWI"));
  for (const a of airports) {
    const raw = JSON.parse(readFileSync(new URL("ramp/" + a.icao + ".json", BASE), "utf8"));
    const data = new rctx.VatflowRampData(raw);
    data.setPilots({ pilots: [] });
    data.setHub({ ok: true, state: rctx.VatflowRamp.emptyState(a.icao), realGates: {} });
    const views = plain(rctx.RampMapView.pickViews(raw)).map((v) => v.id);
    const sets = [[], [views[0]], views.slice(0, 2), views];
    for (const sel of sets) {
      const texts = [];
      const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : k === "fillText" ? (t) => texts.push(String(t)) : () => {}),
        set: (o, k, v) => { o[k] = v; return true; } });
      const map = new rctx.RampMapView({ width: 1024, height: 768, getContext: () => ctx }, null, sel, data);
      const panels = map.panels();
      assert.ok(panels.length >= 1, a.icao + " " + sel + ": something to draw");
      for (const p of panels) assert.ok(isFinite(p.box.w) && p.box.w > 0 && isFinite(p.box.h) && p.box.h > 0, a.icao + " crop box");
      map.draw(Date.UTC(2026, 9, 15, 12, 0, 0));
      assert.ok(texts.some((t) => t.startsWith("RAMP")), a.icao + " header");
      assert.ok(texts.length > 5, a.icao + " " + sel + ": gates labelled");
    }
    if (Object.keys(raw.charts).length > 1) {
      assert.equal(new rctx.RampMapView({ width: 1024, height: 768, getContext: () => ({}) }, null, [], data).panels().length,
        Object.keys(raw.charts).length, a.icao + ": the entire airport shows every chart side by side");
    }
  }
});

t("APT Dashboard flow: metered arrivals with ETA / STA, demand bins against the program AAR", () => {
  const actx = vm.createContext({ console, Date, Math, JSON });
  vm.runInContext("delete globalThis.globalThis;", actx);    // as in MSFS
  for (const f of ["common/vatsim-feed.js", "common/apt-flow.js"]) vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), actx, { filename: f });
  const F = vm.runInContext("VatflowAptFlow", actx);
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const apts = { KDCA: [38.8521, -77.0377], KBOS: [42.3656, -71.0096], KATL: [33.6367, -84.4281] };
  const pilots = [
    pilot("AAL1", 39.40, -77.00, 11000, 300, 180, { arrival: "KDCA", departure: "KBOS", aircraft_short: "A321", flight_rules: "I" }),
    pilot("DAL2", 33.64, -84.43, 1000, 0, 0, { arrival: "KDCA", departure: "KATL", aircraft_short: "B739", flight_rules: "I" }),
    pilot("UAL3", 41.0, -87.0, 35000, 450, 90, { arrival: "KORD", departure: "KDCA", aircraft_short: "A320" }),
  ];
  const flow = F.computeFlow({ feed: { pilots, prefiles: [] }, target: "KDCA", now, lookup: (c) => apts[c] || null,
    program: { aar: 32, jetsOnly: true, excludeWake: ["L"] }, edcts: {} });
  const cs = plain(flow.flights.map((f) => f.callsign || f.cs));
  assert.ok(cs.includes("AAL1") && cs.includes("DAL2") && !cs.includes("UAL3"), "KDCA arrivals only: " + cs);
  assert.equal(flow.hasProgram, true);
  const aal = flow.flights.find((f) => (f.callsign || f.cs) === "AAL1");
  assert.ok(aal.eta > now && aal.eta < now + 30 * 60000, "AAL1 ~40 nm out lands within 30 min");
  assert.ok(aal.sta >= aal.eta - 1000, "STA never before ETA (STA is whole seconds)");
  const bins = F.buildDemandBins(flow, 32);
  assert.equal(bins.binCap, 8, "AAR 32/hr = 8 per 15 min");
  assert.equal(bins.counts.length, F.DEMAND_BIN_COUNT);
  assert.ok(bins.counts.reduce((a, b) => a + b, 0) >= 1, "AAL1 counted in a bin");
  assert.equal(F.fmtZ(now), "1200");
});

t("VATSMART bundle: loads without globalThis and analyses the KDCA situation", () => {
  const sctx = vm.createContext({ console, Date, Math, JSON, setTimeout, clearTimeout });
  vm.runInContext("delete globalThis.globalThis; delete Promise.prototype.finally;", sctx);
  for (const f of ["common/compat.js", "common/airport.js", "common/vatflow-smart.js", "Vatsmart/Vatsmart.js"]) {
    vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), sctx, { filename: f });
  }
  assert.equal(vm.runInContext("typeof Promise.prototype.finally", sctx), "function", "compat polyfill");
  const S = vm.runInContext("VatflowSmart", sctx);
  for (const k of ["buildSituation", "normPrograms", "gridWindow", "loadNavData", "gateEtaFor"]) assert.equal(typeof S[k], "function", k);
  const el = () => ({ innerHTML: "", textContent: "" });
  const els = {};
  const root = { querySelector: (q) => (els[q] = els[q] || el()) };
  const stub = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ width: 10 })), set: (o, k, v) => { o[k] = v; return true; } });
  const view = new (vm.runInContext("VatsmartView", sctx))(root, { width: 996, height: 236, getContext: () => stub }, vm.runInContext("VATFLOW_TWR", sctx));
  view.st.hub = { rates: { KDCA: { aar: 32 } } };
  view.st.pilots = [pilot("AAL1", 39.40, -77.00, 11000, 300, 180, { arrival: "KDCA", departure: "KBOS", aircraft_short: "A321", flight_rules: "I" })];
  const sit = view.analyse(Date.UTC(2026, 9, 15, 12, 0, 0));
  assert.ok(sit && Array.isArray(sit.recs), "situation with recommendations");
});

t("window orientation: maps turn so the view out of the screen's window is up", () => {
  assert.equal(VatflowDraw.windowHeading(0), 121, "front window = the cab heading (airport.js fallback)");
  assert.equal(VatflowDraw.windowHeading(90), 31, "two faces left");
  assert.equal(VatflowDraw.windowHeading(180), 301);
  const stub = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  const a = new AsdexView({ width: 1024, height: 768, getContext: () => stub }, cfg, maps);
  a.setUp(76);
  const up = a.turn(Math.sin(76 * Math.PI / 180), Math.cos(76 * Math.PI / 180));
  assert.ok(Math.abs(up.x) < 1e-9 && Math.abs(up.y - 1) < 1e-9, "heading 076 points straight up");
  const p0 = a.px(0, 0), p1 = a.px(Math.sin(76 * Math.PI / 180) * 500, Math.cos(76 * Math.PI / 180) * 500);
  assert.ok(Math.abs(p1.x - p0.x) < 1e-6 && p1.y < p0.y, "on the canvas too");
});

// ---- generic airport, placement, screen host ----------------------------------------
const GEN = ["common/store.js", "common/airport.js", "common/airports/KDCA.js", "common/airports/KATL.js", "common/towers.js",
  "common/vatsim-feed.js", "common/draw.js", "common/osm-airport.js", "common/site.js", "common/placement.js"];
function genContext(extra) {
  const g = vm.createContext(Object.assign({ console, Date, Math, JSON, setTimeout, clearTimeout, setInterval, clearInterval }, extra || {}));
  for (const f of GEN) vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), g, { filename: f });
  return g;
}

t("site: VATSpy list parse, nearest airport, KATL gets its own METAR / ATC / DBRITE labels", () => {
  const g = genContext();
  const list = g.VatflowSite.parseVatspy("[Countries]\nUS|United States|\n[Airports]\nKATL|Hartsfield Jackson|33.6367|-84.4281|ATL|KZTL|0\n" +
    "KPDK|Dekalb Peachtree|33.8756|-84.3020|PDK|KZTL|0\nXXXX|Pseudo|33.64|-84.43||KZTL|1\n[FIRs]\nKZTL|Atlanta|ATL|KZTL\n");
  assert.deepEqual(plain(list.map((a) => a.icao)), ["KATL", "KPDK"], "pseudo airports and other sections skipped");
  assert.equal(g.VatflowSite.nearest(list, 33.64, -84.42, 15).icao, "KATL");
  assert.equal(g.VatflowSite.nearest(list, 40, -80, 15), null);
  const c = g.VATFLOW_TWR, b = g.VATFLOW_AIRPORTS.KATL;
  g.VatflowSite.apply(c, { icao: "KATL", name: b.name, lid: b.lid, arp: b.arp, elevFt: b.elevFt, data: b }, g.VATFLOW_TWR_OVERRIDES);
  assert.equal(c.icao, "KATL");
  assert.equal(c.elevFt, 1026);
  assert.equal(c.metarUrl, "https://metar.vatsim.net/metar.php?id=KATL");
  assert.ok(c.atcPatterns.some((r) => r.test("ATL_TWR")) && !c.atcPatterns.some((r) => r.test("DCA_TWR")));
  assert.equal(c.dbrite.towerLabel, "ATL TOWER");
  assert.deepEqual(plain(c.dbrite.altimeterStations), ["KATL"]);
  assert.equal(c.runways.length, 5, "KATL's five runways");
  assert.equal(c.dbrite.finals.length, 10, "a final on every runway end");
  assert.equal(c.magVarDeg, -5, "KATL override");
  const d = g.VATFLOW_AIRPORTS.KDCA;
  g.VatflowSite.apply(c, { icao: "KDCA", name: d.name, lid: d.lid, arp: d.arp, elevFt: d.elevFt, data: d }, g.VATFLOW_TWR_OVERRIDES);
  assert.equal(c.dbrite.towerLabel, "DCA TOWER");
  assert.equal(c.dbrite.finals.length, 2, "KDCA keeps its hand-tuned finals");
  assert.equal(c.magVarDeg, -10);
  assert.ok(c.atcPatterns.some((r) => r.test("PCT_APP")));
});

t("site: bundled KATL data has runways, the OSM tower and maps; KDCA maps match the DBRITE / ASDE-X format", () => {
  const g = genContext(), a = g.VATFLOW_AIRPORTS.KATL;
  assert.deepEqual(plain(a.runways.map((r) => r.ids.join("/"))).sort(), ["08L/26R", "08R/26L", "09L/27R", "09R/27L", "10/28"]);
  assert.match(a.tower.src, /Atlanta Tower/);
  assert.ok(a.tower.floorFtMsl > 1300 && a.tower.floorFtMsl < 1450, "cab floor near the top of a 121 m tower");
  assert.ok(a.maps.asdex.taxiways.length > 100 && a.maps.asdex.runways.length >= 5 && a.maps.dbrite.airports.length > 5);
  assert.ok(g.VATFLOW_AIRPORTS.KDCA.maps.asdex.land.length === 1);
});

t("OSM airport builder: runway ends named the right way round, tower floor from its height, maps", () => {
  const g = genContext();
  const arp = { lat: 40, lon: -80 };
  const k = 111320 * Math.cos(40 * Math.PI / 180);
  const at = (x, y) => ({ lat: 40 + y / 111320, lon: -80 + x / k });
  const osm = { elements: [
    { type: "way", tags: { aeroway: "runway", ref: "09/27", width: "45" }, geometry: [at(-1000, 0), at(1000, 0)] },
    { type: "way", tags: { aeroway: "runway", ref: "18/36" }, geometry: [at(0, -800), at(0, 800)] },   // drawn south -> north
    { type: "way", tags: { aeroway: "taxiway" }, geometry: [at(-500, 100), at(500, 100)] },
    { type: "way", tags: { aeroway: "apron" }, geometry: [at(0, 200), at(100, 200), at(100, 300), at(0, 200)] },
    { type: "way", tags: { man_made: "tower", "tower:type": "airport_control", height: "40", name: "Test Tower" },
      geometry: [at(200, 300), at(210, 300), at(210, 310), at(200, 310), at(200, 300)] },
    { type: "way", tags: { aeroway: "runway", ref: "05/23" }, geometry: [at(20000, 20000), at(21000, 21000)] }
  ] };
  const d = g.VatflowOsmAirport.build(osm, { icao: "KTST", name: "TEST", lid: "TST", arp, elevFt: 1000 }, [{ icao: "KNBR", lat: 40.1, lon: -80.1 }]);
  const r = plain(d.runways);
  assert.equal(r.length, 2, "only the field's runways");
  assert.deepEqual(r[0].ids, ["09", "27"]);
  assert.ok(r[0].a[1] < r[0].b[1], "09 threshold is the west end");
  assert.ok(r[1].a[0] > r[1].b[0], "18 threshold is the north end even though the way is drawn northbound");
  assert.equal(d.tower.floorFtMsl, Math.round(1000 + (40 - 6) * 3.28084));
  assert.match(d.tower.src, /Test Tower/);
  assert.ok(Math.abs(d.tower.headingTrue - 214) < 3, "front window looks at the field");
  assert.equal(d.maps.asdex.runways.length, 2);
  assert.equal(d.maps.asdex.taxiways.length, 1);
  assert.equal(d.maps.dbrite.runways.length, 3, "DBRITE shows runways around too");
  assert.equal(d.maps.dbrite.airports[0].id, "KNBR");
  assert.match(g.VatflowOsmAirport.query(40, -80), /out geom;$/);
});

t("placement: nudges are relative to the cab's heading; spot priority saved > list > OSM > centre", () => {
  const g = genContext(), P = g.VatflowPlace;
  const p = { lat: 33.64, lon: -84.42, floorFtMsl: 1400, headingTrue: 90 };
  const m = P.move(p, 10, 0, 4, 5);
  assert.ok(Math.abs(m.lat - p.lat) < 1e-7 && m.lon > p.lon, "forward = east when facing 090");
  assert.equal(m.floorFtMsl, 1404);
  assert.equal(m.headingTrue, 95);
  const e = P.error(p, m);
  assert.ok(Math.abs(e.fwd - 10) < 0.01 && Math.abs(e.right) < 0.01 && e.up === 4 && e.turn === 5);
  const site = { icao: "KATL", arp: { lat: 33.6367, lon: -84.4281 }, elevFt: 1026 };
  const data = g.VATFLOW_AIRPORTS.KATL;
  assert.equal(P.target("KATL", site, data).kind, "osm");
  assert.equal(P.target("KATL", site, null).kind, "centre");
  assert.equal(P.target("KDCA", { icao: "KDCA" }, g.VATFLOW_AIRPORTS.KDCA).kind, "list");
  assert.equal(P.target("KDCA", { icao: "KDCA" }, null).pos.floorFtMsl, 215);
  P.save("KATL", m);
  const sv = P.target("KATL", site, data);
  assert.equal(sv.kind, "saved");
  assert.equal(sv.pos.floorFtMsl, 1404);
  P.forget("KATL");
  assert.equal(P.target("KATL", site, data).kind, "osm");
});

t("VSCS: KDCA keeps its panel; other airports get their own lines, lit with the live frequency", () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("Vscs/Vscs.js", BASE), "utf8"), g);
  const grid = { innerHTML: "" };
  const c = Object.assign({}, g.VATFLOW_TWR, { icao: "KATL", lid: "ATL" });
  const v = new g.VscsView({ querySelector: () => grid }, c);
  v.setFeed({ controllers: [{ callsign: "ATL_N_TWR", frequency: "119.500" }, { callsign: "DCA_TWR", frequency: "119.100" }], atis: [] });
  assert.match(grid.innerHTML, /vs-key on">LC<br>119\.500/);
  assert.ok(!/119\.100/.test(grid.innerHTML));
  assert.equal(g.VscsView.keysFor(g.VATFLOW_TWR)[0][1], "119.100", "KDCA panel");
});

t("vNAS video maps: the ARTCC file gives the tower's ASDE-X map, the TRACON's STARS maps and runway configs", () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("common/vnas.js", BASE), "utf8"), g);
  const art = { id: "ZTL", videoMaps: [
    { id: "m1", name: "ATL CLASS B", tags: ["STARS"], starsId: 1, starsBrightnessCategory: "B" },
    { id: "m17", name: "TERMINAL ARRIVAL RADAR WEST", tags: ["STARS"], starsId: 17, starsBrightnessCategory: "A" },
    { id: "ax", name: "ATL ASDEX", tags: ["TOWER", "ASDEX"] },
    { id: "cab", name: "ATL Cab", tags: ["TOWER", "CAB"] },
    { id: "pdk", name: "PDK Cab", tags: ["CAB"] }],
    facility: { id: "ZTL", type: "Artcc", childFacilities: [{ id: "A80", type: "Tracon", starsConfiguration: { videoMapIds: ["m17", "m1"] },
      childFacilities: [{ id: "ATL", type: "Atct", childFacilities: [],
        towerCabConfiguration: { videoMapId: "cab", towerLocation: { lat: 33.6417, lon: -84.4217 } },
        asdexConfiguration: { videoMapId: "ax", defaultRotation: 0, runwayConfigurations: [{ name: "WEST" }, { name: "EAST" }] } }] }] } };
  const d = plain(g.VatflowVnas.describe(art, "ATL"));
  assert.equal(d.tracon, "A80");
  assert.deepEqual(d.stars.map((m) => m.stars), [1, 17], "STARS maps by number");
  assert.equal(d.asdexMap.name, "ATL ASDEX");
  assert.equal(d.cabMap.name, "ATL Cab");
  assert.deepEqual(d.cabMaps.map((m) => m.name), ["ATL Cab"], "only this airport's cab maps");
  assert.deepEqual(d.configs, ["WEST", "EAST"]);
  assert.equal(g.VatflowVnas.describe(art, "CLT"), null);
  const arp = { lat: 33.6367, lon: -84.4281 };
  const lines = plain(g.VatflowVnas.toLines({ features: [
    { properties: { color: "#ff0000", thickness: 2 }, geometry: { type: "LineString", coordinates: [[-84.4281, 33.6367], [-84.4281, 33.6534]] } },
    { properties: { text: ["SURFACE"] }, geometry: { type: "Point", coordinates: [-84.4281, 33.6367] } },
    { properties: {}, geometry: null }] }, arp));
  assert.equal(lines.lines.length, 1);
  assert.ok(Math.abs(lines.lines[0].p[3] - 1.002) < 0.01, "1 nm north");
  assert.equal(lines.lines[0].c, "#ff0000");
  assert.equal(lines.texts[0].t, "SURFACE");
  const ax = plain(g.VatflowVnas.toAsdex({ features: [
    { properties: { asdex: "structure", color: "#5d6060" }, geometry: { type: "Polygon", coordinates: [[[-84.43, 33.64], [-84.42, 33.64], [-84.42, 33.641], [-84.43, 33.64]]] } },
    { properties: { asdex: "runway" }, geometry: { type: "Polygon", coordinates: [[[-84.44, 33.63], [-84.41, 33.63], [-84.41, 33.631], [-84.44, 33.63]]] } }] }, arp));
  assert.ok(ax.vnas);
  assert.deepEqual(ax.polys.map((p) => p.k), ["runway", "structure"], "drawn runway first, buildings on top");
  assert.equal(ax.land.length, 1, "outline to fit the screen");
});

t("MAPS picker: toggles maps, keeps the choice per airport, presets store and recall sets", () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("common/mappicker.js", BASE), "utf8"), g);
  const mk = () => { const e = { style: {}, children: [], textContent: "", innerHTML: "", ev: {} };
    e.appendChild = (c) => e.children.push(c); e.addEventListener = (n, f) => { e.ev[n] = f; }; return e; };
  const doc = { createElement: mk };
  const host = Object.assign(mk(), { ownerDocument: doc });
  const seen = [];
  const opts = { app: "dbrite", icao: "KATL", multi: true, items: [{ id: "a", label: "1 A" }, { id: "b", label: "2 B" }],
    defaults: [], presets: ["WEST", "EAST"], onChange: (ids) => seen.push(plain(ids)) };
  const p = new g.VatflowMapPicker(host, opts);
  p.toggle("a"); p.toggle("b"); p.toggle("a");
  assert.deepEqual(seen.at(-1), ["b"]);
  p.saveMode = true; p.preset("WEST");
  p.set([]); p.preset("WEST");
  assert.deepEqual(seen.at(-1), ["b"], "WEST recalled");
  const again = new g.VatflowMapPicker(Object.assign(mk(), { ownerDocument: doc }), opts);
  assert.deepEqual(plain(again.selected()), ["b"], "remembered for KATL");
  const single = new g.VatflowMapPicker(Object.assign(mk(), { ownerDocument: doc }), Object.assign({}, opts, { app: "asdex", multi: false, defaults: ["x"] }));
  assert.deepEqual(plain(single.selected()), ["x"], "default");
  single.toggle("y");
  assert.deepEqual(plain(single.selected()), ["y"], "one map at a time");
});

t("strip bays: departures print into the new-strips section, drop when airborne, deleted ones stay gone", () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("common/strips.js", BASE), "utf8"), g);
  const S = g.VatflowStrips, cfg = S.defaults(), st = S.normalize(S.emptyState(), cfg);
  const site = { icao: "KATL", arp: { lat: 33.6367, lon: -84.4281 }, elevFt: 1026 };
  const fp = (o) => Object.assign({ departure: "KATL", arrival: "KMDW", aircraft_faa: "B738/L", flight_rules: "I", altitude: "38000",
    deptime: "1550", route: "VARNM2 RESPE IIU", assigned_transponder: "6020", revision_id: 1, remarks: "PBN/A1 RMK/TCAS /V/" }, o);
  const p = (cs, lat, alt, gs, f) => ({ callsign: cs, cid: 1234567, latitude: lat, longitude: -84.43, altitude: alt, groundspeed: gs, flight_plan: f });
  const now = 1e12;
  const pilots = [p("SWA1", 33.64, 1026, 0, fp({})), p("N123", 33.641, 1026, 5, fp({ flight_rules: "V", altitude: "5500", aircraft_faa: "C172/G", route: "" })),
    p("DAL2", 33.70, 9000, 250, fp({})), p("AAL3", 33.64, 1026, 0, fp({ departure: "KCLT" }))];
  assert.equal(S.ingest(st, cfg, pilots, site, now), true);
  assert.deepEqual(plain(st.bays[1][0]), ["SWA1", "N123"], "GROUND / PROPOSED, airborne and other airports skipped");
  const s1 = plain(st.strips.SWA1);
  assert.deepEqual([s1.type, s1.cid, s1.bcn, s1.ptime, s1.alt, s1.dep, s1.dest, s1.rmk], ["B738/L", "567", "6020", "P1550", "380", "ATL", "MDW", "TCAS"]);
  assert.equal(st.strips.N123.alt, "VFR/055");
  assert.ok(st.strips.N123.vfr);
  // move SWA1 to LOCAL / RUNWAY, then it takes off: dropped
  S.place(st, "SWA1", 2, 1, 0);
  assert.deepEqual(plain(st.bays[2][1]), ["SWA1"]);
  pilots[0] = p("SWA1", 33.66, 3000, 180, fp({}));
  S.ingest(st, cfg, pilots, site, now + 20000);
  assert.equal(st.strips.SWA1, undefined, "auto drop once airborne");
  // deleted by the controller: not printed again until its plan is amended
  S.remove(st, "N123", true);
  S.ingest(st, cfg, pilots, site, now + 40000);
  assert.equal(st.strips.N123, undefined);
  pilots[1].flight_plan.revision_id = 2;
  S.ingest(st, cfg, pilots, site, now + 60000);
  assert.ok(st.strips.N123, "reprints after an amendment");
  // gone from the network for 3 minutes: dropped
  S.ingest(st, cfg, [], site, now + 60000 + 181000);
  assert.equal(Object.keys(st.strips).length, 0);
});

t("strip bays: three columns - separators spread over them, old default spots move, 3-column layout", () => {
  const g = genContext();
  for (const f of ["common/draw.js", "common/strips.js", "StripBay/StripBay.js"]) vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), g);
  const S = g.VatflowStrips;
  assert.deepEqual(plain(S.cols({ seps: ["A", "B", "C"] })), [0, 1, 2]);
  assert.deepEqual(plain(S.cols({ seps: ["A", "B"] })), [0, 1]);
  assert.deepEqual(plain(S.cols({ seps: ["A", "B", "C", "D", "E", "F"] })), [0, 0, 1, 1, 2, 2]);
  assert.deepEqual(plain(S.cols({ seps: ["A", "B"], cols: [2, 2] })), [2, 2], "the controller's choice");
  assert.equal(S.freeCol({ seps: ["A", "B"] }), 2, "a new separator goes to the emptiest column");
  // a layout saved with the one-column bays' default spots moves to the new spots; moved bays stay
  const store = {};
  g.VatflowStore = { get: (k, d) => (k in store ? JSON.parse(store[k]) : d), set: (k, v) => { store[k] = JSON.stringify(v); } };
  g.VatflowStore.set("STRIPCFG_KATL", { bays: [{ name: "TMU", face: 3, slide: 0.4, seps: [] }, { name: "GND", face: 6, slide: 0.2, seps: [] },
    { name: "LCL", face: 0, slide: 0.55, seps: [] }], newBay: 1, newSec: 0, autoDrop: true });
  const c = S.config("KATL"), d = S.defaults();
  assert.deepEqual([c.bays[0].face, c.bays[0].slide], [d.bays[0].face, d.bays[0].slide]);
  assert.deepEqual([c.bays[1].face, c.bays[1].slide], [6, 0.2]);
  assert.deepEqual([c.bays[2].face, c.bays[2].slide], [d.bays[2].face, d.bays[2].slide]);
  // drawing: each separator's section in its own column
  const cfg = S.defaults(), st = S.normalize(S.emptyState(), cfg);
  ["A", "B", "C"].forEach((id, i) => { st.strips[id] = { id, cs: id }; st.bays[2][i].push(id); });
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  const v = new g.StripBayView({ width: 1536, height: 896, getContext: () => ctx, addEventListener() {} }, 2);
  g.VatflowStore.set("STRIPCFG_KATL", cfg);
  g.VatflowStore.set("STRIPS_KATL", st);
  v.setAirport("KATL");
  const rows = plain(v.layout().rows).filter((r) => r.type === "strip");
  assert.deepEqual(rows.map((r) => [r.id, r.x0]), [["A", 0], ["B", 512], ["C", 1024]]);
  // tap B (column 2) then the empty part of column 3: B goes to the bottom of DEPARTED
  v.draw();
  v.click(600, rows[1].y0 + 5);
  assert.equal(v.st.held, "B");
  const end = plain(v.rows).find((r) => r.type === "end" && r.x0 === 1024);
  v.click(1100, end.y0 + 10);
  assert.deepEqual(plain(v.st.bays[2]), [["A"], [], ["C", "B"]]);
});

t("day / night: the sun's height at the cab dims the screens at night and switches the cab lights", () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("common/dimmer.js", BASE), "utf8"), g);
  const D = g.VatflowDimmer;
  // KATL (33.64 N, 84.43 W), 15 Oct: local noon ~17:30Z high sun, 04:00Z night, sunset ~23:10Z
  assert.ok(D.sunElevation(33.64, -84.43, Date.UTC(2026, 9, 15, 17, 30)) > 45);
  assert.ok(D.sunElevation(33.64, -84.43, Date.UTC(2026, 9, 16, 4, 0)) < -30);
  const dusk = D.sunElevation(33.64, -84.43, Date.UTC(2026, 9, 15, 23, 10));
  assert.ok(Math.abs(dusk) < 3, "sunset about 23:10Z, got " + dusk);
  assert.equal(D.nightFor(30), 0);
  assert.equal(D.nightFor(-20), 100);
  assert.equal(D.nightFor(0), 50);
  assert.equal(D.autoFactor(0), 1);
  assert.ok(Math.abs(D.autoFactor(100) - D.NIGHT_LEVEL) < 1e-9);
  // the master sets L:VATFLOW_NIGHT and toggles the light circuits to night (ceiling off, console on)
  const vars = { "PLANE LATITUDE": 33.64, "PLANE LONGITUDE": -84.43, "E:ZULU TIME": 4 * 3600, "E:ZULU DAY OF YEAR": 289,
    "E:ZULU YEAR": 2026, "CIRCUIT SWITCH ON:17": 1, "CIRCUIT SWITCH ON:18": 1, "CIRCUIT SWITCH ON:40": 0 };
  const toggled = [];
  g.SimVar = { GetSimVarValue: (n) => vars[n] || 0,
    SetSimVarValue: (n, u, v) => { if (n === "K:ELECTRICAL_CIRCUIT_TOGGLE") { toggled.push(v); vars["CIRCUIT SWITCH ON:" + v] = !vars["CIRCUIT SWITCH ON:" + v]; } else vars[n] = v; } };
  g.VatflowStore = { get: (k, d) => d, set() {} };
  D.master()();
  assert.equal(vars["L:VATFLOW_NIGHT"], 100);
  assert.deepEqual(toggled.sort((a, b) => a - b), [17, 18, 40]);
  // a screen at night: 40 % of its knob brightness
  const host = { style: {}, appendChild() {} };
  const doc = { createElement: () => ({ style: {}, textContent: "" }) };
  const upd = D.attach(host, "CONSOLE", doc);
  assert.ok(Math.abs(upd() - 0.4) < 1e-9);
  vars["L:VATFLOW_DIM_MANUAL"] = 1;
  assert.equal(upd(), 1, "AUTO off: knobs only");
});

t("tower spot: the FAA obstacle data gives the airport's control tower (tallest within 2.5 nm)", () => {
  const g = genContext();
  for (const f of ["common/faa-towers.js", "common/placement.js"]) vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), g);
  const P = g.VatflowPlace;
  const m = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));
  // KDCA: matches the hand-tuned spot in the tower list within 10 m and 10 ft
  const dca = P.faaTower({ icao: "KDCA", arp: { lat: 38.8521, lon: -77.0377 } });
  assert.equal(dca.kind, "faa");
  assert.ok(m(dca.pos, { lat: 38.8545923, lon: -77.0437097 }) < 10, "KDCA position");
  assert.ok(Math.abs(dca.pos.floorFtMsl - 215) <= 10, "KDCA floor " + dca.pos.floorFtMsl);
  // KATL's 395 ft tower, KMCO's 345 ft tower, KLAX's new 282 ft tower (not the old 183 ft one)
  assert.match(P.faaTower({ arp: { lat: 33.6367, lon: -84.4281 } }).src, /395 FT/);
  assert.match(P.faaTower({ arp: { lat: 28.4294, lon: -81.3090 } }).src, /345 FT/);
  assert.match(P.faaTower({ arp: { lat: 33.9425, lon: -118.4081 } }).src, /282 FT/);
  // the front window faces the airport: KATL's tower is north-east of the centre -> faces south-west
  const atl = P.faaTower({ arp: { lat: 33.6367, lon: -84.4281 } }).pos.headingTrue;
  assert.ok(atl > 180 && atl < 270, "KATL heading " + atl);
  assert.equal(P.faaTower({ arp: { lat: 51.47, lon: -0.4543 } }), null, "outside the US: none (OpenStreetMap then)");
  // order: saved spot > tower list > FAA > OpenStreetMap
  g.VatflowStore = { get: () => null };
  assert.equal(P.target("KMCO", { icao: "KMCO", arp: { lat: 28.4294, lon: -81.3090 } }, { tower: { lat: 1, lon: 1 } }).kind, "faa");
});

t("zoom / pan: the view scales about the screen centre and pans a share of the screen", () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("common/viewctl.js", BASE), "utf8"), g);
  const store = {};
  g.VatflowStore = { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } };
  const v = new g.VatflowViewCtl("VIEW_x", 1024, 768);
  assert.deepEqual(plain(v.apply(2, 512, 384)), { scale: 2, cx: 512, cy: 384 });
  v.zoomBy(1);
  const a = plain(v.apply(2, 512, 384));
  assert.ok(Math.abs(a.scale - 2.8) < 1e-9 && a.cx === 512 && a.cy === 384, "zoom about the centre");
  v.pan(1, 0);
  assert.ok(v.apply(2, 512, 384).cx < 512, "pan right: the picture moves left");
  assert.equal(store.VIEW_x.zoom, v.zoom, "kept");
  v.reset();
  assert.ok(v.isHome());
});

t("strip bays: moving within a section, fewer separators merge sections, bay poses", () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("common/strips.js", BASE), "utf8"), g);
  const S = g.VatflowStrips, cfg = S.defaults(), st = S.normalize(S.emptyState(), cfg);
  ["A", "B", "C"].forEach((id) => { st.strips[id] = { id }; st.bays[1][0].push(id); });
  S.place(st, "A", 1, 0, 3);          // to the bottom of its own section
  assert.deepEqual(plain(st.bays[1][0]), ["B", "C", "A"]);
  S.place(st, "A", 1, 0, 1);          // in front of C
  assert.deepEqual(plain(st.bays[1][0]), ["B", "A", "C"]);
  S.place(st, "C", 1, 2, 0);          // into TAXI
  cfg.bays[1].seps = ["PROPOSED"];    // TAXI and CLEARED removed: their strips join the last section left
  S.normalize(st, cfg);
  assert.deepEqual(plain(st.bays[1]), [["B", "A", "C"]]);
  assert.deepEqual(plain(S.poseVars({ face: 7, slide: -0.5 })), { deg: 315, slide: 70 });
  assert.deepEqual(plain(S.poseVars({ face: 3, slide: 5 })), { deg: 135, slide: 240 }, "slide limited to the console");
  assert.deepEqual(plain(S.poseVars({ face: 0, slide: 0.8 })), { deg: 0, slide: 200 }, "LOCAL's spot is where the model rests");
});

// async tests (fake sim + timers)
const tests = [];
const ta = (name, fn) => tests.push([name, fn]);

/** A tiny sim: position, freeze, slew axes; directAllowed decides if pages may set the position. */
function fakeSim(start, directAllowed) {
  const st = Object.assign({ slew: false, frozen: false, axes: {}, L: {}, sets: 0, simT: 0, cam: 2, paused: false }, start);
  const SimVar = {
    GetSimVarValue(name) {
      if (name.startsWith("L:")) return st.L[name.slice(2)] || 0;
      return { "PLANE LATITUDE": st.lat, "PLANE LONGITUDE": st.lon, "PLANE ALTITUDE": st.alt, "PLANE HEADING DEGREES TRUE": st.hdg,
        "PLANE HEADING DEGREES MAGNETIC": st.hdg + 5, "IS LATITUDE LONGITUDE FREEZE ON": st.frozen ? 1 : 0,
        "GROUND ALTITUDE": 1026, "SIM ON GROUND": 1, "E:SIMULATION TIME": st.simT, "CAMERA STATE": st.cam }[name];
    },
    SetSimVarValue(name, unit, v) {
      if (name.startsWith("L:")) st.L[name.slice(2)] = v;
      else if (name === "K:SLEW_ON") st.slew = true;
      else if (name === "K:SLEW_OFF") st.slew = false;
      else if (name.startsWith("K:AXIS_SLEW_")) st.axes[name.slice(12)] = v;
      else if (name === "K:FREEZE_LATITUDE_LONGITUDE_SET") st.frozen = !!v;
      else if (name.startsWith("A:PLANE") && directAllowed) {
        st.sets++;
        const k = { "A:PLANE LATITUDE": "lat", "A:PLANE LONGITUDE": "lon", "A:PLANE ALTITUDE": "alt", "A:PLANE HEADING DEGREES TRUE": "hdg" }[name];
        if (k) st[k] = v;
      }
      return Promise.resolve();
    }
  };
  // slew physics: full axis = 40 m/s, 60 ft/s, 30 deg/s; ahead / alt axes are negative = forward / up
  function step(dt) {
    if (!st.paused) st.simT += dt;
    if (!st.slew || st.paused) return;
    const a = (k) => (st.axes[k] || 0) / 16383;
    const fwd = -a("AHEAD_SET") * 40 * dt, right = a("SIDEWAYS_SET") * 40 * dt, h = st.hdg * Math.PI / 180;
    st.lat += (fwd * Math.cos(h) - right * Math.sin(h)) / 111320;
    st.lon += (fwd * Math.sin(h) + right * Math.cos(h)) / (111320 * Math.cos(st.lat * Math.PI / 180));
    st.alt += -a("ALT_SET") * 60 * dt;
    st.hdg = ((st.hdg + a("HEADING_SET") * 30 * dt) % 360 + 360) % 360;
  }
  return { st, SimVar, step };
}

/** Runs the context's timers on a fake clock, stepping the sim between them. */
function fakeClock(sim) {
  let now = 1e12, q = [], seq = 0;
  class FDate extends Date { static now() { return now; } }
  const api = {
    Date: FDate,
    setTimeout: (fn, ms) => { q.push({ at: now + (ms || 0), fn, id: ++seq }); return seq; },
    clearTimeout: (id) => { q = q.filter((x) => x.id !== id); },
    run(maxMs, until) {
      const end = now + maxMs;
      while (q.length && now < end) {
        q.sort((a, b) => a.at - b.at);
        const x = q.shift();
        const dt = Math.max(0, x.at - now) / 1000;
        if (sim) sim.step(dt);
        now = Math.max(now, x.at);
        x.fn();
        if (until && until()) return true;
      }
      return until ? until() : true;
    }
  };
  return api;
}

for (const direct of [true, false]) {
  ta("placement in the sim: " + (direct ? "sets the position directly" : "steers by slew when the page can't set it") + ", then freezes", async () => {
    const sim = fakeSim({ lat: 33.6400, lon: -84.4300, alt: 1026, hdg: 90 }, direct);
    const clk = fakeClock(sim);
    const g = genContext({ SimVar: sim.SimVar, Date: clk.Date, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
    const target = { lat: 33.6417086, lon: -84.4216904, floorFtMsl: 1403, headingTrue: 227 };
    const states = [];
    g.VatflowPlace.onState((s) => states.push(s));
    g.VatflowPlace.place(target);
    const ok = clk.run(400000, () => sim.st.L.VATFLOW_PLACED === 1);
    assert.ok(ok, "placed (" + states.join(",") + ")");
    assert.equal(sim.st.L.VATFLOW_PLACE_METHOD, direct ? 1 : 2);
    const e = g.VatflowPlace.error({ lat: sim.st.lat, lon: sim.st.lon, floorFtMsl: sim.st.alt, headingTrue: sim.st.hdg }, target);
    assert.ok(e.distM < 1 && Math.abs(e.up) < 1.5 && Math.abs(e.turn) < 0.6, "on the spot: " + JSON.stringify(plain(e)));
    assert.ok(sim.st.frozen && !sim.st.slew, "frozen, slew off");
    if (!direct) assert.equal(sim.st.sets, 0);
    // a nudge afterwards: 2 m forward
    const before = { lat: sim.st.lat, lon: sim.st.lon, floorFtMsl: sim.st.alt, headingTrue: sim.st.hdg };
    sim.st.L.VATFLOW_PLACED = 0;
    g.VatflowPlace.place(g.VatflowPlace.move(before, 2, 0, 0, 0), true);
    assert.ok(clk.run(120000, () => sim.st.L.VATFLOW_PLACED === 1), "nudged");
    const n = g.VatflowPlace.error(before, { lat: sim.st.lat, lon: sim.st.lon, floorFtMsl: sim.st.alt, headingTrue: sim.st.hdg });
    assert.ok(Math.abs(n.fwd - 2) < 0.6 && Math.abs(n.right) < 0.6, "moved 2 m forward: " + JSON.stringify(plain(n)));
  });
}

ta("placement waits while the flight is still loading, and never moves the cab then", async () => {
  const sim = fakeSim({ lat: 33.6400, lon: -84.4300, alt: 1026, hdg: 90, cam: 11, paused: true }, false);
  const clk = fakeClock(sim);
  const g = genContext({ SimVar: sim.SimVar, Date: clk.Date, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  const target = { lat: 33.6417086, lon: -84.4216904, floorFtMsl: 1403, headingTrue: 227 };
  g.VatflowPlace.place(target);
  clk.run(60000, () => false);
  assert.equal(sim.st.lat, 33.64, "not moved during loading");
  assert.ok(!sim.st.slew, "no slew during loading");
  sim.st.cam = 2; sim.st.paused = false;                 // the flight starts
  assert.ok(clk.run(400000, () => sim.st.L.VATFLOW_PLACED === 1), "placed once the flight runs");
  const e = g.VatflowPlace.error({ lat: sim.st.lat, lon: sim.st.lon, floorFtMsl: sim.st.alt, headingTrue: sim.st.hdg }, target);
  assert.ok(e.distM < 1, "on the spot");
});

ta("slew steering stops by itself if the cab moves away from the spot", async () => {
  const sim = fakeSim({ lat: 33.6400, lon: -84.4300, alt: 1026, hdg: 90 }, false);
  const realStep = sim.step;
  let pushes = 0;
  sim.step = (dt) => { realStep(dt); if (sim.st.slew && ++pushes > 60) sim.st.lat -= 0.0005; };   // something drags it away
  const clk = fakeClock(sim);
  const g = genContext({ SimVar: sim.SimVar, Date: clk.Date, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  const msgs = [];
  g.VatflowPlace.onState((st, m) => msgs.push(st + ":" + m));
  g.VatflowPlace.place({ lat: 33.6417086, lon: -84.4216904, floorFtMsl: 1403, headingTrue: 227 });
  clk.run(400000, () => msgs.some((m) => m.startsWith("error:")));
  assert.ok(msgs.some((m) => /MOVING AWAY/.test(m)), msgs.join(" | "));
  assert.ok(!sim.st.slew && sim.st.frozen, "slew off, frozen where it stopped");
  assert.notEqual(sim.st.L.VATFLOW_PLACED, 1);
});

ta("site in the sim: the cab's position picks the bundled airport (KATL), magnetic variation from the sim", async () => {
  const sim = fakeSim({ lat: 33.641, lon: -84.43, alt: 1026, hdg: 100 }, true);
  const g = genContext({ SimVar: sim.SimVar });
  const s = await new Promise((res) => g.VatflowSite.resolve(res));
  assert.equal(s.icao, "KATL");
  assert.equal(g.VATFLOW_TWR.icao, "KATL");
  assert.equal(g.VATFLOW_TWR.magVarDeg, -5, "override wins over the sim's -5");
  assert.equal(g.VATFLOW_MAPS, g.VATFLOW_AIRPORTS.KATL.maps);
});

ta("screen host: an app's timers stop when another app is picked", async () => {
  const h = vm.createContext({ console, Date, Math, JSON, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(readFileSync(new URL("Screen/Screen.js", BASE), "utf8"), h);
  const owner = { dead: false };
  let ticks = 0, chained = 0;
  h.VatflowOwner.run(owner, () => {
    vm.runInContext("setInterval", h)(() => ticks++, 5);
    const st = vm.runInContext("setTimeout", h);
    (function loop() { chained++; st(loop, 5); })();
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(ticks > 2 && chained > 2);
  owner.dead = true;
  await new Promise((r) => setTimeout(r, 15));
  const t0 = ticks, c0 = chained;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ticks, t0, "interval stopped");
  assert.equal(chained, c0, "setTimeout chain stopped");
  assert.deepEqual(plain(Object.keys(h.VatflowApps.APPS)).sort(), ["aptdemand", "aptlist", "asdex", "dbrite", "idst", "ramp", "rampmap",
    "rvr", "setup", "stripsetup", "vatsmart"]);
  assert.ok(!plain(h.VatflowApps.list({ icao: "KATL" })).includes("ramp"), "KDCA ramp list only at KDCA");
  assert.ok(plain(h.VatflowApps.list({ icao: "KATL" })).includes("rampmap"), "RAMP in every airport's MENU");
  assert.ok(plain(h.VatflowApps.list({ icao: "KMCO" })).includes("rvr"), "RVR in every airport's MENU");
  // a ramp map screen opens on its map where vatflow.io has the airport's ramps, else its alt
  h.VatflowRampData = { has: (icao) => icao === "KDCA" || icao === "KIAD" || icao === "KATL" };
  const scr = { id: "RAMPMAP_CB", def: "rampmap", alt: "asdex", ramp: "CB" };
  assert.equal(h.VatflowApps.initial(scr, { icao: "KDCA" }, null), "rampmap");
  assert.equal(h.VatflowApps.initial(scr, { icao: "KIAD" }, null), "rampmap");
  assert.equal(h.VatflowApps.initial(scr, { icao: "KATL" }, null), "rampmap");
  assert.equal(h.VatflowApps.initial(scr, { icao: "KBWI" }, null), "asdex", "no ramp layout: its alt");
  assert.equal(h.VatflowApps.initial(scr, { icao: "KBWI" }, "rampmap"), "rampmap", "picked in MENU: kept");
  assert.equal(h.VatflowApps.initial(scr, { icao: "KDCA" }, "rampED"), "rampmap", "old saved choice");
});


ta("STRIP SYNC: two cabs share strips through a hub room (moves, held, delete, bay names, reconnect)", async () => {
  // a stand-in for the hub's cab-sync rooms (vatflow-hub cab-sync.js): ordered changes to everyone
  const rooms = {};
  class FakeWS {
    constructor() { this.readyState = 0; this.room = null; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 1); }
    deliver(m) { if (this.readyState === 1) setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(m) }), 1); }
    send(text) {
      const m = JSON.parse(text);
      if (m.type === "cab-join") {
        const r = rooms[m.room] || (rooms[m.room] = { seq: 0, kv: {}, clients: new Set() });
        this.room = m.room; this.cid = m.cid; r.clients.add(this);
        this.deliver({ type: "cab-snap", room: m.room, seq: r.seq, kv: JSON.parse(JSON.stringify(r.kv)) });
        for (const c of r.clients) c.deliver({ type: "cab-peers", room: m.room, peers: [...r.clients].map((x) => ({ cid: x.cid })) });
      } else if (m.type === "cab-set") {
        const r = rooms[this.room];
        for (const k in m.set) { if (m.set[k] === null) delete r.kv[k]; else r.kv[k] = m.set[k]; }
        r.seq++;
        for (const c of r.clients) c.deliver({ type: "cab-set", room: this.room, seq: r.seq, set: m.set, by: this.cid, op: m.op });
      } else if (m.type === "cab-leave") this.leave();
    }
    leave() {
      const r = this.room && rooms[this.room];
      if (!r) return;
      r.clients.delete(this);
      for (const c of r.clients) c.deliver({ type: "cab-peers", room: this.room, peers: [...r.clients].map((x) => ({ cid: x.cid })) });
      this.room = null;
    }
    close() { this.leave(); this.readyState = 3; setTimeout(() => this.onclose && this.onclose(), 1); }
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function cab(cid) {
    const g = vm.createContext({ console, JSON, Math, Date, setTimeout, clearTimeout, setInterval, clearInterval });
    for (const f of ["common/store.js", "common/strips.js", "common/strip-sync.js"]) vm.runInContext(readFileSync(new URL(f, BASE), "utf8"), g, { filename: f });
    const r = (code) => vm.runInContext(code, g);
    r(`VatflowStore.set("CID", "${cid}")`);
    const c = new g.VatflowStripSync.Client({ icao: "KATL", WebSocket: FakeWS });
    return { g, r, c,
      act: (fn) => { g.fn = fn; r(`VatflowStrips.update("KATL", fn)`); },
      st: () => JSON.parse(r(`JSON.stringify(VatflowStrips.state("KATL"))`)),
      cfg: () => JSON.parse(r(`JSON.stringify(VatflowStrips.config("KATL"))`)),
      status: () => JSON.parse(r(`JSON.stringify(VatflowStore.get("STRIPSYNC_STATUS", null))`)),
      on: (code, on = true) => r(`VatflowStore.set("STRIPSYNC", { on: ${on}, code: "${code}" })`) };
  }
  const run = async (cabs, ms) => { for (let t = 0; t < ms; t += 10) { cabs.forEach((x) => x.c.tick()); await wait(10); } };
  const strip = (cs) => ({ id: cs, cs, type: "B738", dep: "ATL", dest: "MCO", route: "DCT", rev: 1, seen: Date.now() });
  const A = cab("1111111"), B = cab("2222222"), both = [A, B];
  A.act((st) => { st.strips.DAL1 = strip("DAL1"); st.strips.DAL2 = strip("DAL2"); st.bays[1][0].push("DAL1", "DAL2"); });
  A.on("482913"); await run(both, 60);
  assert.equal(A.status().state, "ok");
  // B had a strip of its own: joining a room in use replaces it with the room's
  B.act((st) => { st.strips.UAL9 = strip("UAL9"); st.bays[0][0].push("UAL9"); });
  B.on("482913"); await run(both, 80);
  assert.deepEqual(B.st().bays[1][0], ["DAL1", "DAL2"], "B gets A's strips");
  assert.ok(!B.st().strips.UAL9, "the room's strips replace B's own");
  assert.deepEqual(plain(B.status().peers).sort(), ["1111111", "2222222"]);
  // a move on B shows on A; moves of different strips at once both stay
  B.act((st) => B.g.VatflowStrips.place(st, "DAL2", 2, 1, -1));
  await run(both, 60);
  assert.deepEqual(A.st().bays[2][1], ["DAL2"]);
  A.act((st) => A.g.VatflowStrips.place(st, "DAL1", 0, 0, -1));
  B.act((st) => B.g.VatflowStrips.place(st, "DAL2", 2, 0, -1));
  await run(both, 80);
  assert.deepEqual(A.st().bays, B.st().bays, "both cabs agree");
  assert.deepEqual(A.st().bays[0][0], ["DAL1"]);
  assert.deepEqual(A.st().bays[2][0], ["DAL2"]);
  // reorder inside a section changes one position key
  A.act((st) => { st.strips.DAL3 = strip("DAL3"); st.bays[0][0].push("DAL3"); });
  await run(both, 60);
  const before = A.c.opN;
  A.act((st) => A.g.VatflowStrips.place(st, "DAL3", 0, 0, 0));
  await run(both, 60);
  assert.equal(A.c.opN, before + 1);
  assert.deepEqual(B.st().bays[0][0], ["DAL3", "DAL1"]);
  // holding is your own; delete, bay names shared; bay spots stay your own
  A.act((st) => { st.held = "DAL1"; });
  await run(both, 40);
  assert.equal(B.st().held, null);
  A.act((st) => { A.g.VatflowStrips.remove(st, "DAL1", true); });
  A.r(`(function () { var c = VatflowStrips.config("KATL"); c.bays[2].name = "LOCAL EAST"; c.bays[2].face = 6; VatflowStrips.saveConfig("KATL", c); })()`);
  await run(both, 80);
  assert.ok(!B.st().strips.DAL1);
  assert.equal(B.st().dismissed.DAL1, 1, "a deleted strip doesn't print again on B either");
  assert.equal(B.cfg().bays[2].name, "LOCAL EAST");
  assert.equal(B.cfg().bays[2].face, 0, "where the bay sits stays B's");
  // idle: nothing sent, nothing rewritten
  const nA = A.c.opN, nB = B.c.opN, rB = B.r("VatflowStrips.rev()");
  await run(both, 100);
  assert.equal(A.c.opN, nA); assert.equal(B.c.opN, nB); assert.equal(B.r("VatflowStrips.rev()"), rB);
  // B drops off, changes something meanwhile, comes back: both sides' changes kept
  B.c.ws.close(); await run([A], 20);
  B.act((st) => B.g.VatflowStrips.cock(st, "DAL2"));
  A.act((st) => A.g.VatflowStrips.place(st, "DAL3", 1, 0, -1));
  B.c.retryAt = 0;
  await run(both, 120);
  assert.equal(B.status().state, "ok");
  assert.equal(A.st().strips.DAL2.cocked, true, "B's change while away reached A");
  assert.deepEqual(B.st().bays[1][0], ["DAL3"], "A's change reached B");
  assert.deepEqual(A.st().bays, B.st().bays);
  // off: B leaves the room, keeps its strips
  B.on("482913", false); await run(both, 40);
  assert.equal(B.status().state, "off");
  assert.equal(plain(A.status().peers).length, 1);
  assert.ok(B.st().strips.DAL2);
  // order numbers: moving one strip keeps the others' numbers
  const S = A.g.VatflowStripSync;
  const kv = { "p:a": { b: 0, s: 0, o: 1 }, "p:b": { b: 0, s: 0, o: 2 }, "p:c": { b: 0, s: 0, o: 3 } };
  assert.deepEqual(plain(S.ordsFor(["c", "a", "b"], 0, 0, kv)), [0, 1, 2], "c moved to the top");
  assert.deepEqual(plain(S.ordsFor(["a", "c", "b"], 0, 0, kv)), [1, 1.5, 2]);
  assert.deepEqual(plain(S.ordsFor(["a", "b", "x"], 0, 0, kv)), [1, 2, 3], "a new strip at the end");
});


ta("TRAFFIC: radars from the sim's traffic (tags from VATSIM when it matches), switchable while running", async () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("common/traffic.js", BASE), "utf8"), g);
  const T = g.VatflowTraffic;
  // matching: a sim aircraft where a VATSIM pilot is gets that pilot's callsign and plan
  const vat = [{ callsign: "DAL123", latitude: 33.64, longitude: -84.43, altitude: 1500, transponder: "4521",
    flight_plan: { aircraft_short: "B739", departure: "KATL", arrival: "KMCO" } }];
  const st = {}, t0 = 1_000_000;
  let p = plain(T.toPilots([{ uId: 7, lat: 33.6402, lon: -84.4301, alt: 1520 / 3.28084, heading: 90 },
    { uId: 9001, lat: 33.70, lon: -84.40, alt: 300, heading: 270, name: "N123AB" },
    { uId: 4242, lat: 33.65, lon: -84.45, alt: 0, heading: 10 }], vat, st, t0));
  assert.equal(p[0].callsign, "DAL123");
  assert.equal(p[0].flight_plan.arrival, "KMCO");
  assert.equal(p[0].transponder, "4521");
  assert.equal(Math.round(p[0].altitude / 10), 152, "meters to feet");
  assert.equal(p[1].callsign, "N123AB", "the sim's ATC id when it has one");
  assert.equal(p[2].callsign, "TFC242", "else TFC + a number");
  // ground speed from how far it moved in a second (0.05 nm/s = 180 kt)
  p = plain(T.toPilots([{ uId: 7, lat: 33.6402 + 0.05 / 60, lon: -84.4301, alt: 1520 / 3.28084, heading: 0 }], vat, st, t0 + 1000));
  assert.ok(Math.abs(p[0].groundspeed - 180) < 2, "gs " + p[0].groundspeed);
  assert.equal(p[0].callsign, "DAL123", "the match is kept");
  // airborne: VATSIM's position is 15 s old (250 kt = about a mile back); moved on to now it matches
  const air = [{ callsign: "AAL77", latitude: 33.60, longitude: -84.30, altitude: 5000, groundspeed: 250, heading: 90,
    last_updated: new Date(t0 - 15000).toISOString(), flight_plan: { aircraft_short: "A321" } }];
  const ahead = 250 * 15 / 3600 / (60 * Math.cos(33.6 * Math.PI / 180));        // 1.04 nm east, in degrees
  p = plain(T.toPilots([{ uId: 88, lat: 33.60, lon: -84.30 + ahead, alt: 5000 / 3.28084, heading: 90 }], air, {}, t0));
  assert.equal(p[0].callsign, "AAL77", "airborne VATSIM traffic gets its callsign");
  // same place, opposite heading: not the same aircraft
  p = plain(T.toPilots([{ uId: 89, lat: 33.60, lon: -84.30 + ahead, alt: 5000 / 3.28084, heading: 270 }], air, {}, t0));
  assert.equal(p[0].callsign, "TFC89");
  // a VATSIM pilot far away doesn't tag a sim aircraft
  p = plain(T.toPilots([{ uId: 55, lat: 34.5, lon: -84.43, alt: 1500 / 3.28084, heading: 0 }], vat, {}, t0));
  assert.equal(p[0].callsign, "TFC55");
  // the poller: SIM -> the sim's list every second, summary.source "SIM"; VATSIM -> the feed
  const store = {};
  g.VatflowStore = { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } };
  const feedJson = JSON.stringify({ general: { update_timestamp: "2026-10-16T19:00:00Z" }, pilots: vat, controllers: [], atis: [] });
  g.VatflowFeed.httpGet = (url, cb) => setTimeout(() => cb(null, feedJson), 1);
  // the sim answers GET_AIR_TRAFFIC only after the page registers JS_LISTENER_TRAFFIC
  let calls = 0, registered = false;
  g.RegisterViewListener = (name, ready) => { if (name === "JS_LISTENER_TRAFFIC") registered = true; setTimeout(ready, 50); return {}; };
  g.Coherent = { call: (name) => { calls++; assert.equal(name, "GET_AIR_TRAFFIC");
    if (!registered) return Promise.reject(new Error("NoSuchMethod: GET_AIR_TRAFFIC not bound. Call Engine.TriggerEvent('Ready')"));
    return Promise.resolve([{ uId: 7, lat: 33.6402, lon: -84.4301, alt: 457, heading: 90 }]); } };
  const cfg = vm.runInContext("VATFLOW_TWR", g);
  cfg.arp = { lat: 33.6367, lon: -84.4281 };            // KATL
  const got = [];
  T.setSource("SIM");
  const errs = [];
  const stop = T.poll(cfg, (d) => got.push(d), (e) => errs.push(String(e.message)));
  await new Promise((r) => setTimeout(r, 2300));
  assert.ok(calls >= 2, "read every second");
  const last = got[got.length - 1];
  assert.equal(last.source, "SIM");
  assert.equal(last.traffic[0].callsign, "DAL123", "tagged from the VATSIM feed");
  assert.ok(registered, "the traffic listener is registered first");
  assert.ok(errs.every((m) => m.length <= 40), "short errors only: " + errs.join(" | "));
  T.setSource("VATSIM");
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(got[got.length - 1].source, "VATSIM", "switched while running");
  assert.ok(got.some((d) => d.source === "VATSIM" && d.traffic.length === 0), "the sim's targets are cleared at the switch");
  stop();
});


ta("TRAFFIC: when GET_AIR_TRAFFIC isn't bound the first way, the other ways are tried and the one that works kept", async () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("common/traffic.js", BASE), "utf8"), g);
  const store = { TRAFFIC_SRC: "SIM" };
  g.VatflowStore = { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } };
  g.VatflowFeed.httpGet = (url, cb) => setTimeout(() => cb(new Error("offline")), 1);
  const names = [];
  let mapsCalls = 0;
  // only the maps listener's own call answers; Coherent.call is never bound
  g.RegisterViewListener = (name, ready) => {
    names.push(name);
    setTimeout(ready, 20);
    return name === "JS_LISTENER_MAPS" ? { call: () => { mapsCalls++; return Promise.resolve([{ uId: 1, lat: 38.85, lon: -77.04, alt: 5, heading: 0 }]); } } : {};
  };
  g.Coherent = { call: () => Promise.reject(new Error("NoSuchMethod: GET_AIR_TRAFFIC not bound. Call Engine.TriggerEvent('Ready')")) };
  const cfg = vm.runInContext("VATFLOW_TWR", g);
  const got = [], errs = [];
  const stop = g.VatflowTraffic.poll(cfg, (d) => got.push(d), (e) => errs.push(String(e.message)));
  await new Promise((r) => setTimeout(r, 6000));
  stop();
  assert.deepEqual(plain(names).sort(), ["JS_LISTENER_MAPS", "JS_LISTENER_TRAFFIC"]);
  assert.ok(errs.some((m) => /TRYING 1\/4 TRAFFIC - NOT BOUND/.test(m)), errs.join(" | "));
  const sim = got.filter((d) => d.source === "SIM" && d.simCount === 1);
  assert.ok(sim.length >= 1, "the maps listener's answer came through");
  assert.equal(sim[sim.length - 1].traffic.length, 1);
  assert.ok(mapsCalls >= 2, "and that way is kept");
});


ta("field elevation: from the ground under the cab (up in the tower too), else the FAA tower data", async () => {
  const g = genContext();
  vm.runInContext(readFileSync(new URL("common/faa-towers.js", BASE), "utf8"), g);
  const S = g.VatflowSite;
  // KTUS (Tucson, about 2,643 ft): the FAA tower's top minus its height
  const tus = S.faaElevFt({ lat: 32.1161, lon: -110.9410 });
  assert.ok(Math.abs(tus - 2643) < 60, "KTUS " + tus);
  assert.equal(S.faaElevFt({ lat: 51.47, lon: -0.45 }), null, "no FAA data outside the US");
  // apply(): a site with no elevation gets the FAA one, so the Ground Radar doesn't hide everything
  const cfg = JSON.parse(JSON.stringify(vm.runInContext("VATFLOW_TWR", g)));
  S.apply(cfg, { icao: "KTUS", name: "Tucson", lid: "TUS", arp: { lat: 32.1161, lon: -110.9410 }, elevFt: 0, data: null });
  assert.ok(Math.abs(cfg.elevFt - 2643) < 60, "cfg " + cfg.elevFt);
});

for (const [name, fn] of tests) { await fn(); passed++; console.log("ok  " + name); }

console.log(`\n${passed} passed`);
