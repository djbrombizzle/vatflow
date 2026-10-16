/*
 * VATFLOW Tower Cab - ASDE-X surface display (in-cab overhead screen $SCREEN_ASDEX).
 *
 * Map of the field in ASDE-X colours (teal water, grey field, dark movement area, black
 * runways, light-grey terminals), turned so its top is the view out of the window the
 * monitor hangs in front of (it follows the monitor round the ceiling track and its
 * swivel), with a north arrow. Live VATSIM traffic on
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
    this.upHdg = 0;          // degrees true at the top of the screen
    this.view = null;        // zoom / pan (VatflowViewCtl), set by the screen host
    this.fit();
  }

  /** Zoom / pan control (VatflowViewCtl) applied on top of the fit. */
  AsdexView.prototype.setView = function (v) { this.view = v; this.fit(); };

  AsdexView.colors = C;
  // vNAS ASDE-X map colours when a polygon has none
  var VC = { bg: "#141a1c", runway: "#4d4d4d", taxiway: "#424242", apron: "#4d4d4d", structure: "#5d6060" };

  /** Swaps the map (maps.asdex: built-in / OpenStreetMap, or an ARTCC ASDE-X map from VatflowVnas.toAsdex). */
  AsdexView.prototype.setMap = function (asdex) {
    this.map = asdex || null;
    this.fit();
  };

  /** Turns the map so heading h (degrees true) is at the top; refits when it changes. */
  AsdexView.prototype.setUp = function (h) {
    h = ((h % 360) + 360) % 360;
    if (Math.abs(h - this.upHdg) < 0.5) return;
    this.upHdg = h;
    this.fit();
  };

  /** Meters (x east, y north) turned so upHdg points up (still x right, y up). */
  AsdexView.prototype.turn = function (x, y) {
    var a = this.upHdg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: x * c - y * s, y: x * s + y * c };
  };

  /** Scale/offset so the (turned) field outline fills the canvas. */
  AsdexView.prototype.fit = function () {
    var W = this.canvas.width, H = this.canvas.height, m = this.cfg.asdex.marginPx;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var rings = this.map && this.map.land.length ? this.map.land : null;
    if (rings) {
      for (var r = 0; r < rings.length; r++) {
        for (var i = 0; i < rings[r].length; i += 2) {
          var q = this.turn(rings[r][i], rings[r][i + 1]);
          minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
          minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
        }
      }
    } else {
      minX = minY = -2000; maxX = maxY = 2000;
    }
    this.scale = Math.min((W - 2 * m) / (maxX - minX), (H - 2 * m - 40) / (maxY - minY));
    this.cx = W / 2 - this.scale * (minX + maxX) / 2;
    this.cy = H / 2 + 20 + this.scale * (minY + maxY) / 2;
    if (this.view) {
      var v = this.view.apply(this.scale, this.cx, this.cy);
      this.scale = v.scale; this.cx = v.cx; this.cy = v.cy;
    }
  };

  /** Meters (x east, y north from the ARP) -> canvas pixels. */
  AsdexView.prototype.px = function (x, y) {
    var q = this.turn(x, y);
    return { x: this.cx + q.x * this.scale, y: this.cy - q.y * this.scale };
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
    this.source = summary.source || "VATSIM";
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
    ctx.fillStyle = m && m.vnas ? VC.bg : C.water;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!m) return;
    if (m.vnas) {          // ARTCC ASDE-X map: filled polygons in the facility's colours
      for (i = 0; i < m.polys.length; i++) {
        var pg = m.polys[i];
        ctx.fillStyle = pg.c || VC[pg.k] || VC.apron;
        VatflowDraw.path(ctx, pg.p, proj, true);
        ctx.fill();
      }
      return;
    }
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
      arrow(ctx, q.x, q.y, t.hdg - this.upHdg, 11);
      ctx.fillStyle = air ? C.blockAir : C.block;
      mono(ctx, t.callsign, q.x + 14, q.y - 6, CW);
      mono(ctx, (t.type || "") + (air ? " " + VatflowFeed.pad(t.alt / 100, 3) : ""), q.x + 14, q.y + 14, CW);
    }

    // north arrow
    var nv = this.turn(0, 1), nx = W - 44, ny = 70;
    ctx.strokeStyle = C.text; ctx.fillStyle = C.text; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(nx, ny, 22, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(nx + nv.x * 18, ny - nv.y * 18);
    ctx.lineTo(nx - nv.x * 10 - nv.y * 7, ny + nv.y * 10 - nv.x * 7);
    ctx.lineTo(nx - nv.x * 10 + nv.y * 7, ny + nv.y * 10 + nv.x * 7);
    ctx.closePath(); ctx.fill();
    mono(ctx, "N", nx + nv.x * 33 - CW / 2, ny - nv.y * 33 + 6, CW);

    ctx.fillStyle = C.text;
    mono(ctx, "GROUND RADAR " + cfg.icao + (this.view && !this.view.isHome() ? "  ZOOM X" + this.view.zoom.toFixed(1) : ""), 14, 26, CW);
    if (typeof zuluSec === "number" && !isNaN(zuluSec)) {
      var z = VatflowDraw.zulu(zuluSec);
      var s = z.hh + z.mm + ":" + z.ss + "Z";
      mono(ctx, s, W - 14 - s.length * CW, 26, CW);
    }
    var age = this.feedMs ? Math.round((Date.now() - this.feedMs) / 1000) : null;
    var src = typeof VatflowTraffic !== "undefined" ? VatflowTraffic.source() : (this.source || "VATSIM");
    mono(ctx, this.error ? src + " " + this.error.toUpperCase() : (age === null ? src + " WAIT" : src + " " + age + "S TGT " + n), 14, H - 14, CW);
  };

  return AsdexView;
})();
// In the sim this view runs inside the screen host (Screen/Screen.js).
