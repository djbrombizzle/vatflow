/*
 * VATFLOW Tower Cab - ASDE-X surface display (in-cab overhead screen $SCREEN_ASDEX).
 *
 * North-up map of the field in ASDE-X colours: teal water, grey field, dark
 * movement area, black runways, light-grey terminals. Live VATSIM traffic on
 * and near the airport (ground movements plus arrivals/departures below
 * cfg.asdex.maxAglFt) as heading-oriented targets with callsign/type blocks.
 *
 * AsdexView is plain canvas code (also used by preview/index.html); the MSFS
 * wrapper at the bottom only exists when BaseInstrument is defined.
 */
var AsdexView = (function () {
  var NM = 1852;
  var C = {
    water: "#005a72",
    land: "#4d4d4d",
    apron: "#3a3a3a",
    taxiway: "#2b2b2b",
    runway: "#060606",
    building: "#6a6a6a",
    target: "#ffffff",
    airborne: "#5fd4ff",
    block: "#ffffff",
    blockAir: "#5fd4ff",
    text: "#d8f0ff"
  };

  function AsdexView(canvas, cfg, maps) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cfg = cfg;
    this.map = maps && maps.asdex;
    this.targets = {};
    this.feedMs = 0;
    this.error = null;
    this.fit();
  }

  AsdexView.colors = C;

  /** Scale/offset so the field outline fills the canvas (north up). */
  AsdexView.prototype.fit = function () {
    var W = this.canvas.width, H = this.canvas.height, m = this.cfg.asdex.marginPx;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var rings = this.map && this.map.land.length ? this.map.land : null;
    if (rings) {
      for (var r = 0; r < rings.length; r++) {
        for (var i = 0; i < rings[r].length; i += 2) {
          minX = Math.min(minX, rings[r][i]); maxX = Math.max(maxX, rings[r][i]);
          minY = Math.min(minY, rings[r][i + 1]); maxY = Math.max(maxY, rings[r][i + 1]);
        }
      }
    } else {
      minX = minY = -2000; maxX = maxY = 2000;
    }
    this.scale = Math.min((W - 2 * m) / (maxX - minX), (H - 2 * m - 40) / (maxY - minY));
    this.cx = W / 2 - this.scale * (minX + maxX) / 2;
    this.cy = H / 2 + 20 + this.scale * (minY + maxY) / 2;
  };

  /** Meters (x east, y north from the ARP) -> canvas pixels. */
  AsdexView.prototype.px = function (x, y) {
    return { x: this.cx + x * this.scale, y: this.cy - y * this.scale };
  };

  AsdexView.prototype.setData = function (summary) {
    var base = Date.parse(summary.updated);
    if (isNaN(base)) base = Date.now();
    this.targets = {};
    for (var i = 0; i < summary.traffic.length; i++) {
      var t = summary.traffic[i];
      if (this.visible(t)) this.targets[t.callsign] = { t: t, baseMs: base };
    }
    this.feedMs = base;
    this.error = null;
  };

  AsdexView.prototype.setError = function (err) {
    this.error = String(err && err.message ? err.message : err);
  };

  AsdexView.prototype.visible = function (t) {
    var a = this.cfg.asdex;
    return t.distNm <= a.maxDistNm && t.alt - this.cfg.elevFt <= a.maxAglFt;
  };

  /** Dead-reckoned position in meters (capped at 20 s; ground targets barely move). */
  AsdexView.prototype.positionAt = function (e, nowMs) {
    var t = e.t;
    var dt = Math.min(20, Math.max(0, (nowMs - e.baseMs) / 1000));
    var d = (t.gs >= 3 ? t.gs : 0) * dt / 3600 * NM;
    var h = t.hdg * Math.PI / 180;
    return { x: t.x * NM + d * Math.sin(h), y: t.y * NM + d * Math.cos(h) };
  };

  AsdexView.prototype.drawMap = function (ctx) {
    var self = this, m = this.map, i;
    var proj = function (x, y) { return self.px(x, y); };
    ctx.fillStyle = C.water;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!m) return;
    ctx.fillStyle = C.land;
    for (i = 0; i < m.land.length; i++) { VatflowDraw.path(ctx, m.land[i], proj, true); ctx.fill(); }
    ctx.fillStyle = C.apron;
    for (i = 0; i < m.aprons.length; i++) { VatflowDraw.path(ctx, m.aprons[i], proj, true); ctx.fill(); }
    ctx.strokeStyle = C.taxiway;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (i = 0; i < m.taxiways.length; i++) {
      ctx.lineWidth = Math.max(2, m.taxiways[i].w * this.scale);
      VatflowDraw.path(ctx, m.taxiways[i].p, proj, false);
      ctx.stroke();
    }
    ctx.strokeStyle = C.runway;
    ctx.fillStyle = C.runway;
    ctx.lineCap = "butt";
    for (i = 0; i < m.runways.length; i++) {
      var rw = m.runways[i];
      if (rw.c) {  // closed outline (stopway/runway area): fill it
        VatflowDraw.path(ctx, rw.p, proj, true);
        ctx.fill();
      } else {     // centerline: stroke at the runway's real width
        ctx.lineWidth = Math.max(4, rw.w * this.scale);
        VatflowDraw.path(ctx, rw.p, proj, false);
        ctx.stroke();
      }
    }
    ctx.fillStyle = C.building;
    for (i = 0; i < m.buildings.length; i++) { VatflowDraw.path(ctx, m.buildings[i], proj, true); ctx.fill(); }
  };

  /** Aircraft-shaped arrow pointing along heading. */
  function arrow(ctx, x, y, hdg, size) {
    var a = hdg * Math.PI / 180;
    var s = Math.sin(a), c = Math.cos(a);
    function pt(fx, fy) { return { x: x + fx * c - fy * s, y: y + fx * s + fy * c }; }
    // local frame: forward = -y (up) before rotation
    var pts = [pt(0, -size), pt(size * 0.6, size * 0.7), pt(0, size * 0.35), pt(-size * 0.6, size * 0.7)];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
  }

  AsdexView.prototype.draw = function (nowMs, zuluSec) {
    var ctx = this.ctx, cfg = this.cfg, W = this.canvas.width, H = this.canvas.height;
    var CW = 12, mono = VatflowDraw.mono;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    this.drawMap(ctx);

    ctx.font = "18px monospace";
    ctx.textBaseline = "alphabetic";
    var n = 0;
    for (var cs in this.targets) {
      var e = this.targets[cs], t = e.t;
      var p = this.positionAt(e, nowMs);
      var q = this.px(p.x, p.y);
      if (q.x < -40 || q.y < -40 || q.x > W + 40 || q.y > H + 40) continue;
      n++;
      var air = t.alt - cfg.elevFt > 150 && t.gs > 50;
      ctx.fillStyle = air ? C.airborne : C.target;
      arrow(ctx, q.x, q.y, t.hdg, 11);
      ctx.fillStyle = air ? C.blockAir : C.block;
      mono(ctx, t.callsign, q.x + 14, q.y - 6, CW);
      mono(ctx, (t.type || "") + (air ? " " + VatflowFeed.pad(t.alt / 100, 3) : ""), q.x + 14, q.y + 14, CW);
    }

    ctx.fillStyle = C.text;
    mono(ctx, "ASDE-X " + cfg.icao, 14, 26, CW);
    if (typeof zuluSec === "number" && !isNaN(zuluSec)) {
      var z = VatflowDraw.zulu(zuluSec);
      var s = z.hh + z.mm + ":" + z.ss + "Z";
      mono(ctx, s, W - 14 - s.length * CW, 26, CW);
    }
    var age = this.feedMs ? Math.round((Date.now() - this.feedMs) / 1000) : null;
    mono(ctx, this.error ? "VATSIM " + this.error.toUpperCase() : (age === null ? "VATSIM WAIT" : "VATSIM " + age + "S TGT " + n), 14, H - 14, CW);
  };

  return AsdexView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowAsdex extends BaseInstrument {
    get templateID() { return "VatflowAsdex"; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "ASDEX");
      VatflowDimmer.initMonitorPose("ASDEX");
      this.view = new AsdexView(this.querySelector("#asdex-canvas"), VATFLOW_TWR,
        typeof VATFLOW_MAPS !== "undefined" ? VATFLOW_MAPS : null);
      this.tick = VatflowDraw.loop(this.view, 1000);
      var view = this.view;
      VatflowFeed.poll(VATFLOW_TWR, function (d) { view.setData(d); }, function (e) { view.setError(e); });
    }
    Update() {
      super.Update();
      this.dim();
      this.tick(false);
    }
  }
  registerInstrument("vatflow-asdex", VatflowAsdex);
}
