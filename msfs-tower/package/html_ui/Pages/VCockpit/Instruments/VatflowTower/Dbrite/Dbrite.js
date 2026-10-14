/*
 * VATFLOW Tower Cab - DBRITE radar display (in-cab screen $SCREEN_DBRITE).
 *
 * STARS-style tower display: black background, olive video map (runways of
 * every airport in range, airport/navaid symbols, extended finals), grey range rings,
 * green lists and data blocks. Live VATSIM traffic; the feed only updates
 * every ~15 s, so targets are dead-reckoned and repainted on a 4.8 s sweep,
 * leaving history trails.
 *
 * DbriteView is plain canvas code (also used by preview/index.html); the
 * MSFS wrapper at the bottom only exists when BaseInstrument is defined.
 */
var DbriteView = (function () {
  var SWEEP_MS = 4800;
  var C = {
    bg: "#000000",
    ring: "#4a4a4a",
    map: "#a6a61e",
    list: "#3ccc3c",
    listHi: "#e0d23c",
    tab: "#38b8e0",
    target: "#3c8cff",
    history: ["#1e3c78", "#24488c", "#2c56a4", "#3464bc", "#3c72d4"],
    block: "#3ccc3c"
  };

  function DbriteView(canvas, cfg, maps) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cfg = cfg;
    this.maps = maps || null;
    this.targets = {};      // callsign -> { t: feed target, baseMs, shown }
    this.history = {};      // callsign -> [{x,y}]
    this.lastSweep = 0;
    this.feedMs = 0;
    this.error = null;
    this.atis = null;
    this.metars = {};
  }

  DbriteView.colors = C;

  DbriteView.prototype.setData = function (summary) {
    var base = Date.parse(summary.updated);
    if (isNaN(base)) base = Date.now();
    var seen = {};
    for (var i = 0; i < summary.traffic.length; i++) {
      var t = summary.traffic[i];
      var prev = this.targets[t.callsign];
      this.targets[t.callsign] = { t: t, baseMs: base, shown: prev ? prev.shown : null };
      seen[t.callsign] = true;
    }
    for (var cs in this.targets) {
      if (!seen[cs]) { delete this.targets[cs]; delete this.history[cs]; }
    }
    this.feedMs = base;
    this.atis = summary.atis;
    this.error = null;
    this.lastSweep = 0;  // paint new targets on the next frame
  };

  DbriteView.prototype.setError = function (err) {
    this.error = String(err && err.message ? err.message : err);
  };

  DbriteView.prototype.setMetars = function (byIcao) { this.metars = byIcao || {}; };

  /** Position (nm from center) dead-reckoned to time nowMs, capped at 30 s. */
  DbriteView.prototype.positionAt = function (entry, nowMs) {
    var t = entry.t;
    var dt = Math.min(30, Math.max(0, (nowMs - entry.baseMs) / 1000));
    var d = t.gs * dt / 3600;
    var h = t.hdg * Math.PI / 180;
    return { x: t.x + d * Math.sin(h), y: t.y + d * Math.cos(h) };
  };

  DbriteView.prototype.visible = function (t) {
    var c = this.cfg.dbrite;
    return t.gs >= c.minGroundspeedKt && t.alt <= c.maxAltFt && t.distNm <= c.rangeNm * 1.05;
  };

  /** Advance the sweep if due; returns true when positions changed. */
  DbriteView.prototype.sweep = function (nowMs) {
    if (nowMs - this.lastSweep < SWEEP_MS) return false;
    this.lastSweep = nowMs;
    for (var cs in this.targets) {
      var e = this.targets[cs];
      var p = this.positionAt(e, nowMs);
      e.shown = p;
      var h = this.history[cs] || (this.history[cs] = []);
      h.push(p);
      while (h.length > this.cfg.dbrite.historyDots + 1) h.shift();
    }
    return true;
  };

  DbriteView.prototype.drawMap = function (ctx, px, scale) {
    var m = this.maps && this.maps.dbrite;
    ctx.strokeStyle = C.map;
    ctx.fillStyle = C.map;
    ctx.lineWidth = 1.5;
    var i, p, a, b;
    if (m) {
      for (i = 0; i < m.runways.length; i++) {
        var r = m.runways[i];
        a = px({ x: r[0], y: r[1] });
        b = px({ x: r[2], y: r[3] });
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      for (i = 0; i < m.navaids.length; i++) {
        var n = m.navaids[i];
        p = px(n);
        if (n.t === "NDB") { ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke(); dot(ctx, p.x, p.y, 1.5); }
        else hexagon(ctx, p.x, p.y, 9);
      }
      for (i = 0; i < m.airports.length; i++) {
        var ap = m.airports[i];
        if (ap.id === this.cfg.icao) continue;
        p = px(ap);
        ctx.beginPath(); ctx.arc(p.x, p.y, ap.t === "small_airport" ? 7 : 11, 0, Math.PI * 2); ctx.stroke();
      }
    } else {
      // fallback: just this airport's runways
      for (i = 0; i < this.cfg.runways.length; i++) {
        var rw = this.cfg.runways[i];
        a = px(VatflowFeed.toNm(this.cfg.arp, rw.a[0], rw.a[1]));
        b = px(VatflowFeed.toNm(this.cfg.arp, rw.b[0], rw.b[1]));
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
  };

  function hexagon(ctx, x, y, r) {
    ctx.beginPath();
    for (var k = 0; k < 6; k++) {
      var a = k * Math.PI / 3;
      if (k === 0) ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
      else ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    ctx.closePath();
    ctx.stroke();
    dot(ctx, x, y, 1.5);
  }

  function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

  /**
   * Extended final for cfg.dbrite.finals entry f, in nm from the ARP:
   * { a: threshold, b: far end, ticks: [{x,y,len}] } or null if the runway is unknown.
   * The line runs outward from the landing threshold, opposite the inbound course.
   */
  DbriteView.finalLine = function (cfg, f) {
    for (var i = 0; i < cfg.runways.length; i++) {
      var rw = cfg.runways[i], k = rw.ids.indexOf(f.rwy);
      if (k < 0) continue;
      var thr = k === 0 ? rw.a : rw.b, far = k === 0 ? rw.b : rw.a;
      var a = VatflowFeed.toNm(cfg.arp, thr[0], thr[1]);
      var e = VatflowFeed.toNm(cfg.arp, far[0], far[1]);
      var inbound = typeof f.courseMag === "number"
        ? (f.courseMag + cfg.magVarDeg) * Math.PI / 180            // magnetic -> true
        : Math.atan2(e.x - a.x, e.y - a.y);                          // along the runway
      var ux = -Math.sin(inbound), uy = -Math.cos(inbound);         // outward unit vector
      var len = f.lengthNm || 10, ticks = [];
      for (var d = 1; d <= len; d++) ticks.push({ x: a.x + ux * d, y: a.y + uy * d, len: d % 5 === 0 ? 0.35 : 0.18 });
      return { a: a, b: { x: a.x + ux * len, y: a.y + uy * len }, ticks: ticks, ux: ux, uy: uy };
    }
    return null;
  };

  DbriteView.prototype.drawFinals = function (ctx, px, scale) {
    var finals = this.cfg.dbrite.finals || [];
    ctx.strokeStyle = C.map;
    ctx.lineWidth = 1.5;
    for (var i = 0; i < finals.length; i++) {
      var L = DbriteView.finalLine(this.cfg, finals[i]);
      if (!L) continue;
      var a = px(L.a), b = px(L.b);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      for (var j = 0; j < L.ticks.length; j++) {   // perpendicular tick every nm, longer every 5 nm
        var t = L.ticks[j], h = t.len / 2;
        var p1 = px({ x: t.x - L.uy * h, y: t.y + L.ux * h }), p2 = px({ x: t.x + L.uy * h, y: t.y - L.ux * h });
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      }
    }
  };

  /** Lines of the top-left preview area. */
  DbriteView.prototype.listLines = function (zuluSec) {
    var cfg = this.cfg, pad = VatflowFeed.pad, lines = [];
    var home = this.metars[cfg.icao];
    if (typeof zuluSec === "number" && !isNaN(zuluSec)) {
      var z = VatflowDraw.zulu(zuluSec);
      lines.push({ s: z.hh + z.mm + "/" + z.ss + " " + (home && home.altim ? home.altim : "--.--"), c: C.list });
    }
    lines.push({ s: "RNG " + cfg.dbrite.rangeNm + "NM" + (this.atis && this.atis.code ? "  ATIS " + this.atis.code : ""), c: C.list });
    var st = cfg.dbrite.altimeterStations || [];
    for (var i = 0; i < st.length; i++) {
      var m = this.metars[st[i]];
      lines.push({ s: st[i].replace(/^K/, "") + " " + (m && m.altim ? m.altim : "--.--") + " " + (m && m.windRaw ? m.windRaw : "-----"), c: C.list });
    }
    return lines;
  };

  DbriteView.prototype.draw = function (nowMs, zuluSec) {
    this.sweep(nowMs);
    var ctx = this.ctx, cfg = this.cfg, W = this.canvas.width, H = this.canvas.height;
    var range = cfg.dbrite.rangeNm;
    var cx = W / 2, cy = H / 2;
    var scale = (Math.min(W, H) / 2 - 8) / range;
    function px(p) { return { x: cx + p.x * scale, y: cy - p.y * scale }; }
    var CW = 13;               // character cell width (px) for 20px text
    var mono = VatflowDraw.mono;

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // range rings
    ctx.strokeStyle = C.ring;
    ctx.lineWidth = 1.5;
    for (var r = cfg.dbrite.ringNm; r <= range * 1.6; r += cfg.dbrite.ringNm) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    this.drawMap(ctx, px, scale);
    this.drawFinals(ctx, px, scale);

    // traffic
    var alt = Math.floor(nowMs / 2000) % 2 === 0;
    ctx.font = "20px monospace";
    ctx.textBaseline = "alphabetic";
    var shown = 0;
    for (var cs in this.targets) {
      var e = this.targets[cs];
      if (!this.visible(e.t) || !e.shown) continue;
      shown++;
      var hist = this.history[cs] || [];
      for (var h = 0; h < hist.length - 1; h++) {
        var hp = px(hist[h]);
        ctx.fillStyle = C.history[Math.min(C.history.length - 1, h)];
        ctx.fillRect(hp.x - 3, hp.y - 3, 6, 6);
      }
      var p = px(e.shown);
      ctx.fillStyle = C.target;
      ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
      ctx.strokeStyle = C.block;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x + 6, p.y - 6);
      ctx.lineTo(p.x + 26, p.y - 26);
      ctx.stroke();
      var t = e.t;
      var line2 = alt
        ? VatflowFeed.pad(t.alt / 100, 3) + " " + VatflowFeed.pad(t.gs / 10, 2)
        : (t.type || "----") + " " + (t.arr === cfg.icao ? "ARR" : (t.dep === cfg.icao ? "DEP" : (t.arr || "").replace(/^K/, "")));
      ctx.fillStyle = C.block;
      mono(ctx, t.callsign, p.x + 30, p.y - 46, CW);
      mono(ctx, line2, p.x + 30, p.y - 24, CW);
    }

    // lists
    var lines = this.listLines(zuluSec);
    for (var i = 0; i < lines.length; i++) {
      ctx.fillStyle = lines[i].c;
      mono(ctx, lines[i].s, 16, 30 + i * 24, CW);
    }
    ctx.fillStyle = C.list;
    mono(ctx, cfg.dbrite.towerLabel || cfg.icao, 16, H - 46, CW);
    var feedAge = this.feedMs ? Math.round((Date.now() - this.feedMs) / 1000) : null;
    ctx.fillStyle = this.error ? C.listHi : C.list;
    mono(ctx, this.error ? "VATSIM " + this.error.toUpperCase()
      : (feedAge === null ? "VATSIM WAIT" : "VATSIM " + feedAge + "S TGT " + shown), 16, H - 20, CW);
  };

  return DbriteView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowDbrite extends BaseInstrument {
    get templateID() { return "VatflowDbrite"; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.view = new DbriteView(this.querySelector("#dbrite-canvas"), VATFLOW_TWR,
        typeof VATFLOW_MAPS !== "undefined" ? VATFLOW_MAPS : null);
      this.lastDraw = 0;
      var view = this.view;
      VatflowFeed.poll(VATFLOW_TWR, function (d) { view.setData(d); }, function (e) { view.setError(e); });
      VatflowFeed.pollMetars(VATFLOW_TWR.dbrite.altimeterStations, function (m) { view.setMetars(m); });
    }
    Update() {
      super.Update();
      var now = Date.now();
      if (now - this.lastDraw < 250) return;
      this.lastDraw = now;
      this.view.draw(now, SimVar.GetSimVarValue("E:ZULU TIME", "seconds"));
    }
  }
  registerInstrument("vatflow-dbrite", VatflowDbrite);
}
