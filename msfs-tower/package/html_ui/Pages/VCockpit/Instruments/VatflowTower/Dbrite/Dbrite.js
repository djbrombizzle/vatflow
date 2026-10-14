/*
 * VATFLOW Tower Cab - DBRITE radar display (in-cab screen SCREEN_DBRITE).
 *
 * Draws live VATSIM traffic around the field, north up, with range rings,
 * runways and STARS-style data blocks. The feed only updates every ~15 s, so
 * targets are dead-reckoned from groundspeed/heading and repainted on a
 * 4.8 s "sweep" like a terminal radar, leaving history dots behind.
 *
 * DbriteView is plain canvas code (also used by preview/index.html); the
 * MSFS wrapper at the bottom only exists when BaseInstrument is defined.
 */
var DbriteView = (function () {
  var SWEEP_MS = 4800;

  function DbriteView(canvas, cfg) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cfg = cfg;
    this.targets = {};      // callsign -> { t: feed target, baseMs }
    this.history = {};      // callsign -> [{x,y}]
    this.lastSweep = 0;
    this.feedMs = 0;
    this.error = null;
    this.atis = null;
  }

  DbriteView.prototype.setData = function (summary) {
    var base = Date.parse(summary.updated);
    if (isNaN(base)) base = Date.now();
    var seen = {};
    for (var i = 0; i < summary.traffic.length; i++) {
      var t = summary.traffic[i];
      this.targets[t.callsign] = { t: t, baseMs: base };
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

  DbriteView.prototype.draw = function (nowMs, zuluSec) {
    this.sweep(nowMs);
    var ctx = this.ctx, cfg = this.cfg, W = this.canvas.width, H = this.canvas.height;
    var range = cfg.dbrite.rangeNm;
    var cx = W / 2, cy = H / 2 + 10;
    var scale = (Math.min(W, H) / 2 - 24) / range;
    function px(p) { return { x: cx + p.x * scale, y: cy - p.y * scale }; }

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    // range rings + compass
    ctx.strokeStyle = "#24402c";
    ctx.lineWidth = 1;
    for (var r = cfg.dbrite.ringNm; r <= range; r += cfg.dbrite.ringNm) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = "#3d6b49";
    ctx.font = "14px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var R = range * scale;
    for (var deg = 0; deg < 360; deg += 10) {
      var a = deg * Math.PI / 180;
      var len = deg % 30 === 0 ? 12 : 6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R);
      ctx.lineTo(cx + Math.sin(a) * (R - len), cy - Math.cos(a) * (R - len));
      ctx.stroke();
      if (deg % 30 === 0) {
        ctx.fillText(VatflowFeed.pad(deg === 0 ? 360 : deg, 3), cx + Math.sin(a) * (R - 26), cy - Math.cos(a) * (R - 26));
      }
    }

    // runways
    ctx.strokeStyle = "#9a9a9a";
    ctx.lineWidth = 3;
    for (var i = 0; i < cfg.runways.length; i++) {
      var rw = cfg.runways[i];
      var a1 = px(VatflowFeed.toNm(cfg.arp, rw.a[0], rw.a[1]));
      var b1 = px(VatflowFeed.toNm(cfg.arp, rw.b[0], rw.b[1]));
      ctx.beginPath();
      ctx.moveTo(a1.x, a1.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.stroke();
    }

    // traffic
    var alt = Math.floor(nowMs / 2000) % 2 === 0;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = "bold 17px monospace";
    var shown = 0;
    for (var cs in this.targets) {
      var e = this.targets[cs];
      if (!this.visible(e.t) || !e.shown) continue;
      shown++;
      var hist = this.history[cs] || [];
      for (var h = 0; h < hist.length - 1; h++) {
        var hp = px(hist[h]);
        ctx.fillStyle = "rgba(90,160,255," + (0.25 + 0.5 * h / hist.length) + ")";
        ctx.fillRect(hp.x - 2, hp.y - 2, 4, 4);
      }
      var p = px(e.shown);
      ctx.fillStyle = "#4dff88";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      // leader + data block
      ctx.strokeStyle = "#4dff88";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x + 4, p.y - 4);
      ctx.lineTo(p.x + 22, p.y - 22);
      ctx.stroke();
      var t = e.t;
      var line2 = alt
        ? VatflowFeed.pad(t.alt / 100, 3) + " " + VatflowFeed.pad(t.gs / 10, 2)
        : (t.type || "----") + " " + (t.arr === cfg.icao ? "ARR" : (t.dep === cfg.icao ? "DEP" : (t.arr || "").replace(/^K/, "")));
      ctx.fillStyle = "#ffffff";
      ctx.fillText(t.callsign, p.x + 25, p.y - 38);
      ctx.fillStyle = "#cfe8d6";
      ctx.fillText(line2, p.x + 25, p.y - 19);
    }

    // header / status
    ctx.font = "bold 18px monospace";
    ctx.fillStyle = "#7fd39a";
    ctx.textAlign = "left";
    ctx.fillText(cfg.icao.replace(/^K/, "") + " DBRITE  RNG " + range, 14, 26);
    var feedAge = this.feedMs ? Math.round((Date.now() - this.feedMs) / 1000) : null;
    ctx.fillText(this.error ? "VATSIM FEED: " + this.error.toUpperCase()
      : (feedAge === null ? "VATSIM FEED: WAITING" : "VATSIM " + feedAge + "S  TGTS " + shown), 14, H - 14);
    ctx.textAlign = "right";
    if (typeof zuluSec === "number" && !isNaN(zuluSec)) {
      var hh = Math.floor(zuluSec / 3600) % 24, mm = Math.floor(zuluSec / 60) % 60, ss = Math.floor(zuluSec) % 60;
      ctx.fillText(VatflowFeed.pad(hh, 2) + VatflowFeed.pad(mm, 2) + ":" + VatflowFeed.pad(ss, 2) + "Z", W - 14, 26);
    }
    if (this.atis && this.atis.code) ctx.fillText("ATIS " + this.atis.code, W - 14, 50);
  };

  return DbriteView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowDbrite extends BaseInstrument {
    get templateID() { return "VatflowDbrite"; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.view = new DbriteView(this.querySelector("#dbrite-canvas"), VATFLOW_TWR);
      this.lastDraw = 0;
      var view = this.view;
      VatflowFeed.poll(VATFLOW_TWR, function (d) { view.setData(d); }, function (e) { view.setError(e); });
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
