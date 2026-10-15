/*
 * VATFLOW Tower Cab - the RAMP app: the map part of vatflow.io's ramp management page, for
 * any airport on that page and any of its ramps (one, several, or the whole airport). Picked
 * on a screen with RampPicker (below): MENU > RAMP, then the airport, then the ramps.
 * At KDCA the three RAMPMAP screens start on "E / D", "C / B" and "A / Hangars", each on the
 * console facing that part of the terminal.
 *
 * A canvas port of ramp.html's renderMap: aprons (a box round each ramp's stands), taxi
 * lanes, terminal buildings, ramp names, call spots, stands (lead-in line and stop bar
 * when empty, dashed aircraft when assigned or proposed, filled when occupied, coloured
 * by state), aircraft moving on the ramp, and label blocks (gate, callsign + type,
 * P-time) placed so they don't overlap, with leader lines. Same colours as the page.
 * One chart is turned so the top of the map is the view out of that screen's window (the
 * cab's heading from the sim, less the window's turn); several charts (an airport's cargo
 * ramps, say) sit side by side, north up. North arrow; text stays upright.
 * Live data: common/ramp-data.js (VATSIM feed + ramp hub state). View only.
 *
 * RampMapView is plain canvas code; the screen host (Screen/Screen.js) runs it as the
 * "rampmap" app.
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

  /**
   * views: the layout's view ids to show (a list, one id, or "ALL" / null / [] for the whole
   * airport). Each chart in it is cropped to its chosen ramps; several charts sit side by side.
   */
  function RampMapView(canvas, layoutRaw, views, data) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = data || new VatflowRampData(layoutRaw);
    this.L = this.data.L;
    this.setViews(views);
  }

  /** Views that name a chart (the ones you can pick; "All" is every one of them). */
  RampMapView.pickViews = function (L) {
    return ((L && L.views) || []).filter(function (v) { return v.chart; });
  };

  RampMapView.prototype.setViews = function (views) {
    if (typeof views === "string") views = views === "ALL" ? [] : [views];
    var pv = RampMapView.pickViews(this.L), want = views || [];
    this.sel = pv.filter(function (v) { return want.indexOf(v.id) >= 0; });
    if (!this.sel.length || this.sel.length === pv.length) this.sel = null;      // the whole airport
  };

  /** Header text: the chosen views, or ALL. */
  RampMapView.prototype.title = function () {
    if (!this.L) return "?";
    return this.sel ? this.sel.map(function (v) { return v.label; }).join(" + ").toUpperCase() : "ALL RAMPS";
  };

  /**
   * Content box of a chart (ramp.html cropBox): with `ramps`, those ramps' stands; else its
   * stands, spots and named buildings. Padded.
   */
  RampMapView.prototype.cropBox = function (chart, ramps) {
    var L = this.L, pts = [], pad = ramps ? 70 : 45;
    L.stands.forEach(function (s) { if (s.chart === chart && (!ramps || ramps.indexOf(s.ramp) >= 0)) pts.push([s.x, s.y]); });
    if (!ramps) {
      (L.callSpots || []).concat(L.deiceSpots || []).forEach(function (s) { if (s.chart === chart) pts.push([s.x, s.y]); });
      (L.buildings || []).forEach(function (b) {
        if (b.chart !== chart || !b.name) return;
        if (b.line) pts = pts.concat(b.line);
        else if (b.poly) pts = pts.concat(b.poly);
        else if (b.rect) pts.push([b.rect[0], b.rect[1]], [b.rect[0] + b.rect[2], b.rect[1] + b.rect[3]]);
      });
    }
    if (!pts.length) {
      var c = L.charts[chart] || {};
      return { x0: 0, y0: 0, w: c.width || 600, h: c.height || 600 };
    }
    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    var x0 = Math.max(0, Math.min.apply(null, xs) - pad), y0 = Math.max(0, Math.min.apply(null, ys) - pad);
    var x1 = Math.max.apply(null, xs) + pad, y1 = Math.max.apply(null, ys) + pad;
    return { x0: x0, y0: y0, w: x1 - x0, h: y1 - y0 };
  };

  /**
   * [{chart, dx, dy, box}]: the chosen views' charts side by side, each cropped to its chosen
   * ramps (ramp.html chartsForView). dx / dy move chart units into the joined picture.
   */
  RampMapView.prototype.panels = function () {
    var L = this.L, self = this, byChart = {}, order = Object.keys(L.charts || {});
    var chosen = this.sel || RampMapView.pickViews(L);
    chosen.forEach(function (v) {
      var ramps = v.ramps || null, cur = byChart[v.chart];
      if (cur === null) return;
      byChart[v.chart] = ramps ? (cur || []).concat(ramps) : null;     // no ramp list: the whole chart
    });
    if (!chosen.length) order.forEach(function (id) { byChart[id] = null; });
    var x = 0, out = [];
    order.forEach(function (id) {
      if (!(id in byChart)) return;
      var c = self.cropBox(id, byChart[id]);
      out.push({ chart: id, dx: x - c.x0, dy: -c.y0, box: c });
      x += c.w + 16;
    });
    return out;
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

  /**
   * Draws the map turned so `upHdg` (degrees true: the direction the screen's window
   * looks) is at the top. Shapes are drawn through a turned transform; all text is drawn
   * upright afterwards in screen pixels (labels are laid out there too).
   */
  RampMapView.prototype.draw = function (now) {
    now = now || Date.now();
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, L = this.L;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // header
    var bad = this.data.problem(), status = bad ? bad.toUpperCase() : (L ? L.icao + " LIVE" : "");
    ctx.textAlign = "right";
    ctx.font = "bold 24px sans-serif";
    ctx.fillStyle = "#d7e1ec";
    ctx.fillText(zulu(now), W - 14, 30);
    ctx.font = "15px sans-serif";
    ctx.fillStyle = bad ? "#f0b35a" : "#7f91a6";
    ctx.fillText(status, W - 110, 29);
    var room = W - 130 - status.length * 15 * 0.55;
    ctx.textAlign = "left";
    ctx.font = "bold 24px sans-serif";
    ctx.fillStyle = "#d7e1ec";
    ctx.fillText("RAMP", 14, 30);
    var t = (L ? L.icao + "  " : "") + this.title(), maxCh = Math.max(4, Math.floor((room - 100) / (24 * 0.6)));
    ctx.fillStyle = "#8cc4ff";
    ctx.fillText(t.length > maxCh ? t.slice(0, maxCh - 3) + "..." : t, 100, 30);
    ctx.fillStyle = "#223042";
    ctx.fillRect(0, HEAD - 2, W, 2);
    if (!L || !R) return;

    var S = R.STATES, panels = this.panels();
    if (!panels.length) return;
    // one chart turns so the window's view is at the top; several sit side by side, north up
    var up = panels.length === 1 ? ((this.upHdg || 0) % 360 + 360) % 360 : 0;
    var tw = 0, th = 0;
    panels.forEach(function (p) { tw = Math.max(tw, p.dx + p.box.x0 + p.box.w); th = Math.max(th, p.box.h); });
    var a = -up * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    var mcx = tw / 2, mcy = th / 2;
    var ex = 0, ey = 0;
    [[0, 0], [tw, 0], [0, th], [tw, th]].forEach(function (p) {
      var dx = p[0] - mcx, dy = p[1] - mcy;
      ex = Math.max(ex, Math.abs(dx * ca - dy * sa));
      ey = Math.max(ey, Math.abs(dx * sa + dy * ca));
    });
    var AW = W, AH = H - HEAD, acx = W / 2, acy = HEAD + AH / 2;
    var sc = Math.min(AW / (2 * ex), AH / (2 * ey));
    function turn(ux, uy) { return { x: ux * ca - uy * sa, y: ux * sa + uy * ca }; }
    function proj(p) {                                       // chart -> screen, for panel p
      return function (x, y) {
        var dx = x + p.dx - mcx, dy = y + p.dy - mcy;
        return { x: acx + sc * (dx * ca - dy * sa), y: acy + sc * (dx * sa + dy * ca) };
      };
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEAD, AW, AH);
    ctx.clip();
    ctx.fillStyle = C.chart;
    ctx.fillRect(0, HEAD, AW, AH);

    var rows = this.data.rows(now);
    var statuses = R.standStatuses(L, rows), conflicts = R.standConflicts(rows);
    var byStand = {};
    rows.forEach(function (r) { if (r.atStand) byStand[r.atStand] = r; });
    var labels = [], obstacles = [], texts = [], self = this, multi = panels.length > 1;

    panels.forEach(function (pn) {
      var chart = pn.chart, P = proj(pn), boxes = self.rampBoxes(chart);
      ctx.save();
      ctx.setTransform(sc * ca, sc * sa, -sc * sa, sc * ca, acx - sc * (mcx * ca - mcy * sa), acy - sc * (mcx * sa + mcy * ca));
      ctx.transform(1, 0, 0, 1, pn.dx, pn.dy);
      if (multi) { ctx.beginPath(); ctx.rect(pn.box.x0, pn.box.y0, pn.box.w, pn.box.h); ctx.clip(); }

      // aprons (else a box round each ramp's stands)
      var aprons = (L.aprons || []).filter(function (ap) { return ap.chart === chart; });
      ctx.fillStyle = C.pave;
      aprons.forEach(function (ap) { polyline(ctx, ap.pts); ctx.closePath(); ctx.fill(); });
      if (!aprons.length) boxes.forEach(function (b) { roundRect(ctx, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 10); ctx.fill(); });
      // taxi lanes, then their centre lines
      var lanes = (L.lanes || []).filter(function (l) { return l.chart === chart; });
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = C.lane; ctx.lineWidth = 20;
      lanes.forEach(function (l) { polyline(ctx, l.pts); ctx.stroke(); });
      ctx.strokeStyle = C.laneLine; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7;
      lanes.forEach(function (l) { polyline(ctx, l.pts); ctx.stroke(); });
      ctx.globalAlpha = 1;
      // buildings
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
      // call spot circles (their numbers are drawn upright below)
      var spots = (L.callSpots || []).filter(function (sp) { return sp.chart === chart; });
      spots.forEach(function (sp) {
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = "#05080c"; ctx.fill(); ctx.strokeStyle = "#e6edf5"; ctx.lineWidth = 1.5; ctx.stroke();
      });

      // stands and the aircraft on them (labels collected, placed later in screen space)
      var bx = pn.box;
      function inPanel(x, y) { return !multi || (x >= bx.x0 && x <= bx.x0 + bx.w && y >= bx.y0 && y <= bx.y0 + bx.h); }
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
        if (!inPanel(st.x, st.y)) return;
        var q = P(st.x, st.y);
        obstacles.push({ x: q.x, y: q.y, r: (occ || status ? 12 : 8) * sc, soft: !(occ || status) });
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
        var rad = rot * Math.PI / 180, u = turn(Math.sin(rad), -Math.cos(rad));
        var pri = cf ? 1 : due ? 2 : occ ? 3 : who ? 4 : 9;
        labels.push({ x: q.x, y: q.y, ux: u.x, uy: u.y, lines: lines, pri: pri, must: pri <= 1 || late });
      });
      // aircraft moving on this chart (not on a stand)
      rows.forEach(function (r) {
        if (r.chart !== chart || r.atStand || r.x == null) return;
        var color = stateColor(S, r.state) || C.taxi;
        plane(ctx, r.x, r.y, r.hdg || 0, color);
        if (!inPanel(r.x, r.y)) return;
        var q = P(r.x, r.y), u = turn(0.7, -0.7);
        obstacles.push({ x: q.x, y: q.y, r: 12 * sc });
        var lines = [{ t: r.callsign, fill: color, w: 750 }];
        if (r.unknownStand && r.ptime != null) lines.push({ t: "P" + zulu(r.ptime) + " " + R.ptimeCountdown(r.ptime, now), small: true, w: 700, fill: "#ffd27a" });
        labels.push({ x: q.x, y: q.y, ux: u.x, uy: u.y, lines: lines, must: true, pri: 2 });
      });
      ctx.restore();
      texts.push({ P: P, boxes: boxes, lanes: lanes, spots: spots, inPanel: inPanel, pn: pn });
    });

    // ---- text, upright, in screen pixels ----
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = "center";
    texts.forEach(function (tx) {
      var P = tx.P;
      ctx.font = "bold 15px sans-serif";
      ctx.fillStyle = "#c4d2e0";
      tx.boxes.forEach(function (b) {                        // ramp names above their stands
        if (!tx.inPanel((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)) return;
        var mid = P((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        var minY = Infinity;                                 // above the box on screen: its highest point
        [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].forEach(function (p) { minY = Math.min(minY, P(p[0], p[1]).y); });
        var y = Math.max(HEAD + 16, minY - 6), w = b.r.name.length * 15 * 0.6;
        ctx.fillText(b.r.name, mid.x, y);
        obstacles.push({ box: { x0: mid.x - w / 2, x1: mid.x + w / 2, y0: y - 16, y1: y + 3 } });
      });
      if (multi) {                                           // chart name under each of several charts
        var c = L.charts[tx.pn.chart] || {}, bb = tx.pn.box, bot = P(bb.x0 + bb.w / 2, bb.y0 + bb.h);
        ctx.font = "bold 13px sans-serif";
        ctx.fillStyle = "#7f91a6";
        ctx.fillText(String(c.name || tx.pn.chart).toUpperCase(), bot.x, Math.min(H - 6, bot.y - 4));
      }
      ctx.font = "10px sans-serif";
      ctx.fillStyle = C.lead; ctx.globalAlpha = 0.8;
      tx.lanes.forEach(function (l) {
        if (l.label === "") return;
        var p = l.pts[l.pts.length > 2 ? 1 : 0];
        if (!tx.inPanel(p[0], p[1])) return;
        var q = P(p[0], p[1]);
        ctx.fillText(l.label != null ? l.label : l.id, q.x + 10, q.y + 12);
      });
      ctx.globalAlpha = 1;
      ctx.font = "bold " + Math.max(9, Math.round(9.5 * sc)) + "px sans-serif";
      ctx.fillStyle = "#fff";
      tx.spots.forEach(function (sp) {
        if (!tx.inPanel(sp.x, sp.y)) return;
        var q = P(sp.x, sp.y);
        ctx.fillText(sp.id, q.x, q.y + 3.5 * Math.min(sc, 1.6));
        obstacles.push({ x: q.x, y: q.y, r: 11 * sc });
      });
    });
    placeLabels(ctx, labels, obstacles, 1, { x0: 0, y0: HEAD, x1: AW, y1: H });

    // north arrow (one chart is turned to the view out of the window)
    var n = turn(0, -1), nx = W - 40, ny = HEAD + 40;
    ctx.strokeStyle = "#c4d2e0"; ctx.fillStyle = "#c4d2e0"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(nx, ny, 22, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(nx + n.x * 18, ny + n.y * 18);
    ctx.lineTo(nx - n.x * 10 + n.y * 7, ny - n.y * 10 - n.x * 7);
    ctx.lineTo(nx - n.x * 10 - n.y * 7, ny - n.y * 10 + n.x * 7);
    ctx.closePath(); ctx.fill();
    ctx.font = "bold 14px sans-serif";
    ctx.fillText("N", nx + n.x * 32, ny + n.y * 32 + 5);
    ctx.restore();
  };

  return RampMapView;
})();


/**
 * The RAMP app's picker: a RAMPS tab on the map opens it (so does picking RAMP in MENU).
 * First the airport (the airports on vatflow.io's ramp page), then its ramps: tap ramps to
 * add or remove them, or ENTIRE AIRPORT, then SHOW.
 * opts: { current() -> {icao, views} | null, here: the cab's airport, onPick({icao, views}) }
 */
var RampPicker = (function () {
  var BTN = "box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;" +
    "border:2px solid #35506b;background:#1b2a3a;color:#e8f1fa;font-family:monospace;";
  var ON = "background:#7fc8ff;color:#0a0f16;border-color:#7fc8ff;";

  function RampPicker(host, opts) {
    this.host = host;
    this.o = opts;
    this.doc = host.ownerDocument || document;
    this.tab = this.el("div", "position:absolute;right:90px;bottom:0;width:86px;height:34px;background:#1b2a3a;" +
      "border:2px solid #35506b;color:#cfe0f0;font:bold 18px monospace;display:flex;align-items:center;" +
      "justify-content:center;z-index:900;opacity:0.85;", "RAMPS");
    this.panel = this.el("div", "position:absolute;left:0;top:0;right:0;bottom:0;background:rgba(6,10,15,0.97);" +
      "z-index:950;display:none;box-sizing:border-box;padding:16px 20px;font-family:monospace;color:#dfe7ef;");
    var self = this;
    this.on(this.tab, function () { self.open(); });
    this.token = 0;
  }

  RampPicker.prototype.el = function (tag, css, text, parent) {
    var e = this.doc.createElement(tag);
    e.style.cssText = css;
    if (text) e.textContent = text;
    (parent || this.host).appendChild(e);
    return e;
  };

  RampPicker.prototype.on = function (e, fn) {
    e.addEventListener("mouseup", function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); fn(); });
  };

  RampPicker.prototype.isOpen = function () { return this.panel.style.display !== "none"; };

  RampPicker.prototype.close = function () { this.token++; this.panel.style.display = "none"; };

  /** Opens on the airport list. */
  RampPicker.prototype.open = function () {
    this.panel.style.display = "block";
    this.airports();
  };

  RampPicker.prototype.head = function (right) {
    var p = this.panel, self = this;
    p.innerHTML = "";
    var h = this.el("div", "display:flex;align-items:center;font:bold 26px monospace;border-bottom:2px solid #23384d;" +
      "padding-bottom:8px;margin-bottom:12px;", null, p);
    this.el("span", "color:#f5a623;margin-right:18px;white-space:nowrap;", "RAMP MAP", h);
    this.el("span", "color:#7fc8ff;flex:1;white-space:nowrap;overflow:hidden;", right, h);
    var x = this.el("div", BTN + "width:110px;height:40px;font:bold 18px monospace;flex:none;", "CLOSE", h);
    this.on(x, function () { self.close(); });
  };

  RampPicker.prototype.note = function (text, color) {
    return this.el("div", "width:100%;color:" + (color || "#7f93a8") + ";font:17px monospace;margin:4px 0 12px;", text, this.panel);
  };

  /** Step 1: the airport. */
  RampPicker.prototype.airports = function () {
    var self = this, my = ++this.token, cur = this.o.current && this.o.current();
    this.head("PICK AN AIRPORT");
    var msg = this.note("AIRPORTS ON THE VATFLOW RAMP PAGE (VATFLOW.IO/RAMP)");
    var grid = this.el("div", "display:flex;flex-wrap:wrap;", null, this.panel);
    VatflowRampData.airports(function (list) {
      if (my !== self.token) return;
      if (!list.length) { msg.textContent = "NO RAMP AIRPORTS - VATFLOW.IO COULD NOT BE REACHED"; return; }
      list.forEach(function (a) {
        var on = cur && cur.icao === a.icao;
        var b = self.el("div", BTN + "width:308px;height:96px;margin:0 16px 16px 0;" + (on ? ON : ""), null, grid);
        self.el("div", "font:bold 30px monospace;", a.icao + (a.icao === self.o.here ? " *" : ""), b);
        self.el("div", "font:15px monospace;margin-top:4px;white-space:nowrap;overflow:hidden;max-width:290px;opacity:0.85;",
          String(a.name || "").toUpperCase(), b);
        self.on(b, function () { self.ramps(a.icao, a.name); });
      });
      if (self.o.here) msg.textContent += "   * = THIS TOWER";
    });
  };

  /** Step 2: the airport's ramps. */
  RampPicker.prototype.ramps = function (icao, name) {
    var self = this, my = ++this.token, cur = this.o.current && this.o.current();
    this.head(icao + "  " + String(name || "").toUpperCase());
    var bar = this.el("div", "display:flex;margin-bottom:6px;", null, this.panel);
    var back = this.el("div", BTN + "width:200px;height:44px;font:bold 18px monospace;", "< AIRPORTS", bar);
    this.on(back, function () { self.airports(); });
    var msg = this.note("LOADING " + icao + " RAMPS FROM VATFLOW.IO...");
    var grid = this.el("div", "display:flex;flex-wrap:wrap;", null, this.panel);
    VatflowRampData.layout(icao, function (raw) {
      if (my !== self.token) return;
      if (!raw) { msg.style.color = "#ffd166"; msg.textContent = "COULD NOT LOAD THE " + icao + " RAMP LAYOUT"; return; }
      var views = RampMapView.pickViews(raw);
      var chosen = cur && cur.icao === icao ? (cur.views || []).filter(function (id) {
        return views.some(function (v) { return v.id === id; });
      }) : [];
      msg.textContent = "TAP RAMPS TO ADD OR REMOVE THEM, OR ENTIRE AIRPORT. THEN SHOW.";
      var all = null, items = [];
      function paint() {
        var whole = !chosen.length;
        all.style.cssText = BTN + "width:640px;height:64px;margin:0 16px 16px 0;font:bold 24px monospace;" + (whole ? ON : "");
        items.forEach(function (it) {
          var on = !whole && chosen.indexOf(it.v.id) >= 0;
          it.b.style.cssText = BTN + "width:308px;height:80px;margin:0 16px 16px 0;font:bold 22px monospace;" + (on ? ON : "");
          it.b.textContent = (on ? "[X] " : "[ ] ") + String(it.v.label).toUpperCase();
        });
      }
      views.forEach(function (v) {
        var b = self.el("div", "", null, grid);
        items.push({ v: v, b: b });
        self.on(b, function () {
          var i = chosen.indexOf(v.id);
          if (i >= 0) chosen.splice(i, 1); else chosen.push(v.id);
          if (chosen.length === views.length) chosen = [];       // every ramp = the entire airport
          paint();
        });
      });
      var row = self.el("div", "display:flex;width:100%;margin-top:6px;", null, self.panel);
      all = self.el("div", "", "ENTIRE AIRPORT", row);
      self.on(all, function () { chosen = []; paint(); });
      var go = self.el("div", BTN + "width:308px;height:64px;font:bold 26px monospace;background:#14532d;border-color:#3ee07a;", "SHOW", row);
      self.on(go, function () { self.close(); self.o.onPick({ icao: icao, views: chosen.slice() }); });
      paint();
    });
  };

  return RampPicker;
})();

// In the sim these run inside the screen host (Screen/Screen.js).
