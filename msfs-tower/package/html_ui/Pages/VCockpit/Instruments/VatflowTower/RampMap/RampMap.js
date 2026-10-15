/*
 * VATFLOW Tower Cab - ramp map screens ($SCREEN_RAMPMAP_ED / _CB / _AS): the map part of
 * vatflow.io's ramp management page for one view of the KDCA layout ("E / D", "C / B",
 * "A / Hangars"), each on the console facing that part of the terminal.
 *
 * A canvas port of ramp.html's renderMap: aprons (a box round each ramp's stands), taxi
 * lanes, terminal buildings, ramp names, call spots, stands (lead-in line and stop bar
 * when empty, dashed aircraft when assigned or proposed, filled when occupied, coloured
 * by state), aircraft moving on the ramp, and label blocks (gate, callsign + type,
 * P-time) placed so they don't overlap, with leader lines. Same colours as the page.
 * Live data: common/ramp-data.js (VATSIM feed + ramp hub state). View only.
 *
 * RampMapView is plain canvas code (also used by preview/index.html); the MSFS wrapper is
 * registered per screen by RampMapED.js / RampMapCB.js / RampMapAS.js.
 */
var RampMapView = (function () {
  var R = typeof VatflowRamp !== "undefined" ? VatflowRamp : null;
  var HEAD = 44;
  var C = {
    bg: "#0b0f14", chart: "#0c131c", pave: "#1a2330", lane: "#232e3c", laneLine: "#b9952a", bldg: "#0b1016",
    bldgEdge: "#2b3a4c", empty: "#e6edf5", assigned: "#3aa0ff", proposed: "#8fb8e0", occupied: "#3fcf6a",
    pushreq: "#f5b31c", pushheld: "#ef4d4d", pushappr: "#36d0d0", taxi: "#b58cff", lead: "#d8b64a"
  };
  var PLANE = [[0, -11], [1.6, -8], [1.6, -3], [10, 2], [10, 4], [1.6, 1.5], [1.2, 7], [4, 9.5], [4, 11], [0, 10],
    [-4, 11], [-4, 9.5], [-1.2, 7], [-1.6, 1.5], [-10, 4], [-10, 2], [-1.6, -3], [-1.6, -8]];
  // label text size on the screen, in pixels (the page uses 11 / 9.5 on a desktop monitor;
  // the cab screen is small, so a little bigger)
  var BIG = 15, SMALL = 13;

  function stateColor(S, st) {
    var m = {};
    m[S.INBOUND] = C.assigned; m[S.TAXI_IN] = C.taxi; m[S.PARKED] = C.occupied; m[S.PUSH_REQ] = C.pushreq;
    m[S.PUSH_HELD] = C.pushheld; m[S.PUSH_APPR] = C.pushappr; m[S.PUSHING] = C.pushappr; m[S.TAXI_OUT] = C.taxi;
    return m[st];
  }

  function zulu(t) {
    var d = new Date(t), pad = VatflowFeed.pad;
    return pad(d.getUTCHours(), 2) + pad(d.getUTCMinutes(), 2) + "Z";
  }

  function RampMapView(canvas, layoutRaw, viewId, data) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = data || new VatflowRampData(layoutRaw);
    this.L = this.data.L;
    this.view = null;
    var views = (this.L && this.L.views) || [];
    for (var i = 0; i < views.length; i++) if (views[i].id === viewId) this.view = views[i];
  }

  /** Content box of the view's ramps on its chart, padded (ramp.html cropBox with ramps). */
  RampMapView.prototype.cropBox = function () {
    var v = this.view, L = this.L;
    var st = L.stands.filter(function (s) { return s.chart === v.chart && v.ramps.indexOf(s.ramp) >= 0; });
    var xs = st.map(function (s) { return s.x; }), ys = st.map(function (s) { return s.y; });
    var x0 = Math.max(0, Math.min.apply(null, xs) - 70), y0 = Math.max(0, Math.min.apply(null, ys) - 70);
    var x1 = Math.max.apply(null, xs) + 70, y1 = Math.max.apply(null, ys) + 70;
    return { x0: x0, y0: y0, w: x1 - x0, h: y1 - y0 };
  };

  /** A padded box round each ramp's stands on the chart (ramp.html rampBoxes). */
  RampMapView.prototype.rampBoxes = function (chart) {
    var L = this.L, out = [];
    L.ramps.filter(function (r) { return r.chart === chart; }).forEach(function (r) {
      var st = L.stands.filter(function (s) { return s.ramp === r.id; });
      if (!st.length) return;
      var xs = st.map(function (s) { return s.x; }), ys = st.map(function (s) { return s.y; });
      out.push({ r: r, x0: Math.min.apply(null, xs) - 26, y0: Math.min.apply(null, ys) - 24,
        x1: Math.max.apply(null, xs) + 26, y1: Math.max.apply(null, ys) + 24 });
    });
    return out;
  };

  function polyline(ctx, pts) {
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
      else ctx.lineTo(pts[i][0], pts[i][1]);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function plane(ctx, x, y, rotDeg, fill, stroke, dashed) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotDeg * Math.PI / 180);
    polyline(ctx, PLANE);
    ctx.closePath();
    if (dashed) {
      ctx.setLineDash([2.5, 1.5]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = stroke;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "#05080c";
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Label blocks, laid out as ramp.html placeLabels: in priority order, each goes to the
   * first spot round its aircraft (out along the nose, then turned, then further out)
   * that hits no placed block, aircraft or ramp title; blocks that must show take the
   * least crowded spot, the others are dropped. k = chart units per screen pixel.
   */
  function placeLabels(ctx, labels, obstacles, k, view) {
    var F = BIG * k, f = SMALL * k, pad = 1.5 * k, placed = [], dropped = 0;
    function hitBox(a, b) { return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1; }
    function hitCirc(b, o) {
      var cx = Math.max(b.x0, Math.min(o.x, b.x1)), cy = Math.max(b.y0, Math.min(o.y, b.y1));
      return (cx - o.x) * (cx - o.x) + (cy - o.y) * (cy - o.y) < o.r * o.r;
    }
    labels.sort(function (a, b) { return a.pri - b.pri; });
    var draws = [];
    labels.forEach(function (L0) {
      if (L0.x < view.x0 || L0.x > view.x1 || L0.y < view.y0 || L0.y > view.y1) return;
      var sizes = L0.lines.map(function (l) { return l.small ? f : F; });
      var w = Math.max.apply(null, L0.lines.map(function (l, i) { return String(l.t).length * sizes[i] * 0.6; })) + pad * 2;
      var hgt = sizes.reduce(function (a, b) { return a + b * 1.12; }, 0) + pad;
      var cands = [], gap = 14;
      var rings = L0.must ? [0, 1, 2, 3, 4] : [0, 1, 2];
      rings.forEach(function (ring) {
        [0, 35, -35, 70, -70, 110, -110, 180].forEach(function (turn) {
          var a = Math.atan2(L0.uy, L0.ux) + turn * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a);
          var reach = Math.abs(ux) * w / 2 + Math.abs(uy) * hgt / 2;
          var d = gap + reach + ring * (hgt + 4 * k);
          cands.push({ cx: L0.x + ux * d, cy: L0.y + uy * d, ring: ring, turn: turn });
        });
      });
      var best = null, bestScore = Infinity;
      for (var ci = 0; ci < cands.length; ci++) {
        var c = cands[ci];
        var b = { x0: c.cx - w / 2, x1: c.cx + w / 2, y0: c.cy - hgt / 2, y1: c.cy + hgt / 2 };
        var score = 0;
        if (b.x0 < view.x0 || b.x1 > view.x1 || b.y0 < view.y0 || b.y1 > view.y1) score += 20;
        for (var pi = 0; pi < placed.length; pi++) if (hitBox(b, placed[pi])) score += 10;
        for (var oi = 0; oi < obstacles.length; oi++) {
          var o = obstacles[oi];
          if (o.box ? hitBox(b, o.box) : hitCirc(b, o)) score += o.soft ? 0.6 : o.box ? 2 : 3;
        }
        score += c.ring * 0.5 + Math.abs(c.turn) / 400;
        if (score < bestScore) { bestScore = score; best = { cx: c.cx, cy: c.cy, ring: c.ring, turn: c.turn, b: b }; }
        if (score < 1) break;
      }
      if (bestScore >= 3 && !L0.must) { if (L0.pri < 9) dropped++; return; }
      placed.push(best.b);
      draws.push({ L0: L0, best: best, sizes: sizes });
    });
    // leaders first, then text on top
    draws.forEach(function (d) {
      var best = d.best, L0 = d.L0;
      if (best.ring > 0 || Math.abs(best.turn) > 70) {
        var ex = Math.max(best.b.x0, Math.min(L0.x, best.b.x1)), ey = Math.max(best.b.y0, Math.min(L0.y, best.b.y1));
        var dd = Math.sqrt((ex - L0.x) * (ex - L0.x) + (ey - L0.y) * (ey - L0.y)) || 1;
        var sx = L0.x + (ex - L0.x) / dd * 9, sy = L0.y + (ey - L0.y) / dd * 9;
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = "#c9d6e3";
        ctx.lineWidth = 1.1 * k;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#c9d6e3";
        ctx.beginPath(); ctx.arc(sx, sy, 1.8 * k, 0, Math.PI * 2); ctx.fill();
      }
    });
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    draws.forEach(function (d) {
      var y = d.best.b.y0 + pad / 2;
      for (var i = 0; i < d.L0.lines.length; i++) {
        var l = d.L0.lines[i], size = d.sizes[i];
        y += size;
        ctx.font = (l.w >= 700 ? "bold " : "") + size.toFixed(2) + "px sans-serif";
        ctx.lineWidth = size * 0.3;
        ctx.strokeStyle = "#0a0f15";
        ctx.strokeText(l.t, d.best.cx, y - size * 0.18);
        ctx.fillStyle = l.fill;
        ctx.fillText(l.t, d.best.cx, y - size * 0.18);
        y += size * 0.12;
      }
    });
    return dropped;
  }

  RampMapView.prototype.draw = function (now) {
    now = now || Date.now();
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, L = this.L;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // header
    ctx.textAlign = "left";
    ctx.font = "bold 24px sans-serif";
    ctx.fillStyle = "#d7e1ec";
    ctx.fillText("RAMP", 14, 30);
    ctx.fillStyle = "#8cc4ff";
    ctx.fillText(this.view ? this.view.label.toUpperCase() : "?", 90, 30);
    ctx.textAlign = "right";
    ctx.fillStyle = "#d7e1ec";
    ctx.fillText(zulu(now), W - 14, 30);
    var bad = this.data.problem();
    ctx.font = "15px sans-serif";
    ctx.fillStyle = bad ? "#f0b35a" : "#7f91a6";
    ctx.fillText(bad ? bad.toUpperCase() : (L ? L.icao + " LIVE" : ""), W - 110, 29);
    ctx.fillStyle = "#223042";
    ctx.fillRect(0, HEAD - 2, W, 2);
    if (!L || !this.view || !R) return;

    var S = R.STATES, v = this.view, chart = v.chart, c = this.cropBox();
    var s = Math.min(W / c.w, (H - HEAD) / c.h), k = 1 / s;
    var ox = (W - c.w * s) / 2 - c.x0 * s, oy = HEAD + ((H - HEAD) - c.h * s) / 2 - c.y0 * s;
    ctx.save();
    ctx.setTransform(s, 0, 0, s, ox, oy);
    ctx.beginPath();
    ctx.rect(c.x0, c.y0, c.w, c.h);
    ctx.clip();
    ctx.fillStyle = C.chart;
    ctx.fillRect(c.x0, c.y0, c.w, c.h);

    var rows = this.data.rows(now);
    var statuses = R.standStatuses(L, rows), conflicts = R.standConflicts(rows);
    var byStand = {};
    rows.forEach(function (r) { if (r.atStand) byStand[r.atStand] = r; });
    var boxes = this.rampBoxes(chart);

    // aprons: a box round each ramp's stands (KDCA has no mapped aprons)
    var aprons = (L.aprons || []).filter(function (a) { return a.chart === chart; });
    ctx.fillStyle = C.pave;
    aprons.forEach(function (a) { polyline(ctx, a.pts); ctx.closePath(); ctx.fill(); });
    if (!aprons.length) boxes.forEach(function (b) { roundRect(ctx, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 10); ctx.fill(); });
    // taxi lanes, then their centre lines
    var lanes = L.lanes.filter(function (l) { return l.chart === chart; });
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = C.lane; ctx.lineWidth = 20;
    lanes.forEach(function (l) { polyline(ctx, l.pts); ctx.stroke(); });
    ctx.strokeStyle = C.laneLine; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7;
    lanes.forEach(function (l) { polyline(ctx, l.pts); ctx.stroke(); });
    ctx.globalAlpha = 1;
    // buildings
    ctx.textAlign = "center";
    (L.buildings || []).filter(function (b) { return b.chart === chart; }).forEach(function (b) {
      if (b.line) {
        ctx.strokeStyle = C.bldgEdge; ctx.lineWidth = (b.w || 12) + 2;
        polyline(ctx, b.line); ctx.stroke();
        ctx.strokeStyle = C.bldg; ctx.lineWidth = b.w || 12;
        polyline(ctx, b.line); ctx.stroke();
      } else if (b.poly) {
        polyline(ctx, b.poly); ctx.closePath();
        ctx.fillStyle = C.bldg; ctx.fill(); ctx.strokeStyle = C.bldgEdge; ctx.lineWidth = 1; ctx.stroke();
      } else if (b.rect) {
        roundRect(ctx, b.rect[0], b.rect[1], b.rect[2], b.rect[3], 3);
        ctx.fillStyle = C.bldg; ctx.fill(); ctx.strokeStyle = C.bldgEdge; ctx.lineWidth = 1; ctx.stroke();
      }
    });
    // ramp names over their boxes
    ctx.font = "bold " + (14 * k).toFixed(2) + "px sans-serif";
    ctx.fillStyle = "#c4d2e0";
    var obstacles = [];
    boxes.forEach(function (b) {
      ctx.fillText(b.r.name, (b.x0 + b.x1) / 2, b.y0 - 6 * k);
      var tw = b.r.name.length * 14 * k * 0.6;
      obstacles.push({ box: { x0: (b.x0 + b.x1) / 2 - tw / 2, x1: (b.x0 + b.x1) / 2 + tw / 2, y0: b.y0 - 22 * k, y1: b.y0 - 2 * k } });
    });
    // lane names
    ctx.textAlign = "left";
    ctx.font = (10 * k).toFixed(2) + "px sans-serif";
    ctx.fillStyle = C.lead; ctx.globalAlpha = 0.8;
    lanes.forEach(function (l) {
      if (l.label === "") return;
      var p = l.pts[l.pts.length > 2 ? 1 : 0];
      ctx.fillText(l.label != null ? l.label : l.id, p[0] + 6, p[1] + 14);
    });
    ctx.globalAlpha = 1;
    // call spots
    ctx.textAlign = "center";
    (L.callSpots || []).filter(function (sp) { return sp.chart === chart; }).forEach(function (sp) {
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = "#05080c"; ctx.fill(); ctx.strokeStyle = "#e6edf5"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = "bold 9.5px sans-serif"; ctx.fillStyle = "#fff"; ctx.fillText(sp.id, sp.x, sp.y + 3.5);
      obstacles.push({ x: sp.x, y: sp.y, r: 11 });
    });

    // stands and the aircraft on them
    var labels = [];
    L.stands.filter(function (st) { return st.chart === chart; }).forEach(function (st) {
      var status = statuses.get(st.id), occ = byStand[st.id];
      var color = occ ? (stateColor(S, occ.state) || C.occupied) : status ? C[status.key] : C.empty;
      var rot = st.noseHdg != null ? st.noseHdg : 0;
      var cf = conflicts.get(st.id);
      if (cf) {
        ctx.beginPath(); ctx.arc(st.x, st.y, 20, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(239,77,77,.18)"; ctx.fill(); ctx.strokeStyle = "#ef4d4d"; ctx.lineWidth = 2.5; ctx.stroke();
      }
      if (occ) plane(ctx, st.x, st.y, rot, color);
      else if (status) plane(ctx, st.x, st.y, rot, null, color, true);
      else {
        ctx.save(); ctx.translate(st.x, st.y); ctx.rotate(rot * Math.PI / 180);
        ctx.strokeStyle = C.lead; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(0, 22); ctx.stroke();
        ctx.globalAlpha = 0.9; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(-4, -13); ctx.lineTo(4, -13); ctx.stroke();
        ctx.restore(); ctx.globalAlpha = 1;
      }
      obstacles.push({ x: st.x, y: st.y, r: occ || status ? 12 : 8, soft: !(occ || status) });
      var who = occ;
      if (!who && status && (status.key === "assigned" || status.key === "proposed")) {
        for (var i = 0; i < rows.length; i++) if (rows[i].callsign === status.callsign) who = rows[i];
      }
      var lines = [];
      if (cf) lines.push({ t: "! " + cf.occupant, fill: "#ff8080", w: 800 });
      lines.push({ t: st.label || st.id, fill: "#e6edf5", w: 650 });
      if (who) lines.push({ t: [who.callsign, who.type].filter(Boolean).join(" "), small: true, w: 500,
        fill: occ ? "#c3d0dd" : status && status.key === "proposed" ? "#a9c8e8" : "#8ec8ff" });
      var due = false, late = false;
      if (occ && occ.ptime != null) {
        var cd = R.ptimeCountdown(occ.ptime, now);
        late = cd.charAt(0) === "+";
        due = late || Number(cd) <= 10;
        lines.push({ t: "P" + zulu(occ.ptime) + " " + cd, small: true, w: 700, fill: late ? "#ff9b9b" : "#ffd27a" });
      }
      var rad = rot * Math.PI / 180;
      var pri = cf ? 1 : due ? 2 : occ ? 3 : who ? 4 : 9;
      labels.push({ x: st.x, y: st.y, ux: Math.sin(rad), uy: -Math.cos(rad), lines: lines, pri: pri, must: pri <= 1 || late });
    });
    // aircraft moving on this chart (not on a stand)
    rows.forEach(function (r) {
      if (r.chart !== chart || r.atStand || r.x == null) return;
      var color = stateColor(S, r.state) || C.taxi;
      plane(ctx, r.x, r.y, r.hdg || 0, color);
      obstacles.push({ x: r.x, y: r.y, r: 12 });
      var lines = [{ t: r.callsign, fill: color, w: 750 }];
      if (r.unknownStand && r.ptime != null) lines.push({ t: "P" + zulu(r.ptime) + " " + R.ptimeCountdown(r.ptime, now), small: true, w: 700, fill: "#ffd27a" });
      labels.push({ x: r.x, y: r.y, ux: 0.7, uy: -0.7, lines: lines, must: true, pri: 2 });
    });
    placeLabels(ctx, labels, obstacles, k, { x0: c.x0, y0: c.y0, x1: c.x0 + c.w, y1: c.y0 + c.h });
    ctx.restore();
  };

  return RampMapView;
})();

/** MSFS wrapper for one ramp map screen; RampMapED.js etc. each register theirs. */
function vatflowRegisterRampMap(viewId, tag, templateId) {
  if (typeof BaseInstrument === "undefined") return;
  class VatflowRampMap extends BaseInstrument {
    get templateID() { return templateId; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      var data = new VatflowRampData(typeof VATFLOW_RAMP_LAYOUT !== "undefined" ? VATFLOW_RAMP_LAYOUT : null);
      this.view = new RampMapView(this.querySelector("canvas"), null, viewId, data);
      data.start(VATFLOW_TWR.feedUrl);
      this.tick = VatflowDraw.loop(this.view, 2000);
    }
    Update() {
      super.Update();
      this.dim();
      this.tick(false);
    }
  }
  registerInstrument(tag, VatflowRampMap);
}
