/**
 * RampView — canvas surface scope.
 *
 * Draws the airport surface, stands and live targets in a local metres frame,
 * with pan / zoom / rotate. Canvas rather than Leaflet: the scope needs
 * metre-accurate stand polygons on a black non-geographic ground, thousands of
 * label draws a second, and declutter rules that change with zoom.
 */

import { modelBounds, pointInPoly } from "./ramp-airport.js";

const COLORS = {
  bg: "#05070a",
  apron: "#1b2129",
  building: "#2b333d",
  taxiway: "#3d4752",
  taxiLabel: "#6d7d8b",
  runway: "#59636e",
  runwayEdge: "#828c96",
  free: "#2f9e5b",
  occupied: "#c8382c",
  timer: "#c98a1b",
  closed: "#4a545e",
  blocked: "#6b4a1f",
  dim: 0.28,
  inbound: "#48c7e0",
  outbound: "#5fd67d",
  holding: "#e0b23c",
  alert: "#e0574a",
  manual: "#dd6fd0",
  text: "#d7e2ea",
  leader: "#5b6a76",
  nonmove: "#8a97a3",
  spot: "#9aa9b5",
  buildingLabel: "#9fb0bd",
  rampFill: "rgba(72, 199, 224, 0.035)",
  rampMine: "rgba(232, 168, 56, 0.075)",
  rampLabel: "#7d94a3",
  rampLabelMine: "#e8a838",
};
const PHASE_COLOR = {
  INBOUND: COLORS.inbound,
  LANDED: COLORS.inbound,
  TAXI_IN: COLORS.inbound,
  IN_BLOCK: COLORS.occupied,
  TURN: COLORS.timer,
  PUSHBACK: COLORS.holding,
  TAXI_OUT: COLORS.outbound,
  HOLDING: COLORS.holding,
  DEPARTED: COLORS.outbound,
};

export class RampScope {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onCursor?: Function, onPick?: Function }} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts;
    this.model = null;
    this.scale = 0.08;          // pixels per metre
    this.cx = 0;                // view centre, local metres
    this.cy = 0;
    this.rot = 0;               // radians, clockwise from north-up
    this.layers = { taxiways: true, taxiLabels: true, stands: true, standBoxes: true,
                    tags: true, trails: true, areas: true, spots: true };
    this.state = { targets: [], occupancy: new Map(), assignments: new Map(), nowMs: Date.now(), myRamp: null };
    this.hover = null;
    this.selected = null;
    this._labelBoxes = [];
    this._bindEvents();
    this.resize();
  }

  setModel(model) {
    this.model = model;
    this.fit();
  }

  setState(state) {
    Object.assign(this.state, state);
  }

  /** Fit the whole field in view. */
  fit() {
    if (!this.model) return;
    const b = modelBounds(this.model);
    const w = this.canvas.clientWidth || 1200;
    const h = this.canvas.clientHeight || 800;
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
    this.scale = Math.min(w / (b.maxX - b.minX + 400), h / (b.maxY - b.minY + 400));
  }

  /** Centre on a point in local metres, optionally zooming in. */
  goTo(x, y, scale) {
    this.cx = x;
    this.cy = y;
    if (scale) this.scale = scale;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 1200;
    const h = this.canvas.clientHeight || 800;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
  }

  /** World metres -> screen pixels. */
  toScreen(x, y) {
    const dx = (x - this.cx) * this.scale;
    const dy = (y - this.cy) * this.scale;
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    return [
      this.canvas.clientWidth / 2 + dx * c - dy * s,
      this.canvas.clientHeight / 2 - (dx * s + dy * c),
    ];
  }

  /** Screen pixels -> world metres. */
  toWorld(px, py) {
    const dx = px - this.canvas.clientWidth / 2;
    const dy = this.canvas.clientHeight / 2 - py;
    const c = Math.cos(-this.rot);
    const s = Math.sin(-this.rot);
    const wx = dx * c - dy * s;
    const wy = dx * s + dy * c;
    return [this.cx + wx / this.scale, this.cy + wy / this.scale];
  }

  _bindEvents() {
    const cv = this.canvas;
    let dragging = false;
    let last = null;

    cv.addEventListener("pointerdown", e => {
      dragging = true;
      last = [e.offsetX, e.offsetY];
      cv.setPointerCapture(e.pointerId);
      cv.style.cursor = "grabbing";
    });
    cv.addEventListener("pointermove", e => {
      const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
      if (this.opts.onCursor) this.opts.onCursor(wx, wy);
      if (dragging && last) {
        // Work in world space so panning stays correct under rotation.
        const [wx0, wy0] = this.toWorld(last[0], last[1]);
        const [wx1, wy1] = this.toWorld(e.offsetX, e.offsetY);
        this.cx -= wx1 - wx0;
        this.cy -= wy1 - wy0;
        last = [e.offsetX, e.offsetY];
      } else {
        this.hover = this.pick(e.offsetX, e.offsetY);
        cv.style.cursor = this.hover ? "pointer" : "grab";
      }
    });
    const stop = e => {
      dragging = false;
      last = null;
      cv.style.cursor = "grab";
      if (e && cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    };
    cv.addEventListener("pointerup", stop);
    cv.addEventListener("pointercancel", stop);
    cv.addEventListener("pointerleave", () => { this.hover = null; });

    cv.addEventListener("wheel", e => {
      e.preventDefault();
      const [bx, by] = this.toWorld(e.offsetX, e.offsetY);
      const k = Math.exp(-e.deltaY * 0.0016);
      this.scale = Math.max(0.01, Math.min(6, this.scale * k));
      const [ax, ay] = this.toWorld(e.offsetX, e.offsetY);
      this.cx += bx - ax;
      this.cy += by - ay;
    }, { passive: false });

    cv.addEventListener("click", e => {
      const hit = this.pick(e.offsetX, e.offsetY);
      this.selected = hit;
      if (this.opts.onPick) this.opts.onPick(hit);
    });
  }

  /** What is under the cursor — a target first, then a stand. */
  pick(px, py) {
    const [wx, wy] = this.toWorld(px, py);
    let best = null;
    for (const t of this.state.targets) {
      const d = Math.hypot(t.dispX - wx, t.dispY - wy);
      if (d < 30 / this.scale && (!best || d < best.d)) best = { kind: "target", target: t, d };
    }
    if (best) return best;
    for (const s of (this.model && this.model.stands) || []) {
      if (s.poly && pointInPoly(wx, wy, s.poly)) return { kind: "stand", stand: s };
    }
    return null;
  }

  standStatus(stand) {
    const st = this.state;
    if (st.closures && st.closures.has(stand.id)) return "closed";
    const occ = st.occupancy.get(stand.id);
    if (occ) return occ.conflict ? "conflict" : (occ.vacating ? "vacating" : "occupied");
    if (st.blocked && st.blocked.has(stand.id)) return "blocked";
    for (const a of st.assignments.values()) if (a.standId === stand.id) return "assigned";
    return "free";
  }

  statusColor(status) {
    switch (status) {
      case "occupied": return COLORS.occupied;
      case "conflict": return COLORS.alert;
      case "vacating": return COLORS.timer;
      case "assigned": return COLORS.timer;
      case "closed": return COLORS.closed;
      case "blocked": return COLORS.blocked;
      default: return COLORS.free;
    }
  }

  /** Dim anything outside the ramp the controller is working. */
  rampAlpha(ramp) {
    const my = this.state.myRamp;
    if (!my || !ramp) return 1;
    return ramp === my ? 1 : COLORS.dim;
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    this._labelBoxes = [];

    if (this.model) {
      this._drawPolys(this.model.aprons, COLORS.apron);
      this._drawPolys(this.model.buildings, COLORS.building);
      if (this.layers.areas) this._drawAreas();
      if (this.layers.taxiways) this._drawLines(this.model.taxiways, COLORS.taxiway, 23);
      this._drawLines(this.model.runways, COLORS.runway, 45, COLORS.runwayEdge);
      if (this.layers.taxiLabels && this.scale > 0.25) this._drawTaxiLabels();
      this._drawBuildingLabels();
      if (this.layers.stands) this._drawStands();
      if (this.layers.spots) this._drawSpots();
      if (this.layers.areas) this._drawAreaLabels();
    }
    if (this.layers.trails) this._drawTrails();
    this._drawTargets();
    if (this.layers.tags) this._drawTags();

    ctx.restore();
  }

  _drawPolys(list, fill) {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    for (const f of list || []) {
      const poly = f.poly;
      if (!poly || poly.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const [px, py] = this.toScreen(poly[i][0], poly[i][1]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  _drawLines(list, color, defWidth, edge) {
    const ctx = this.ctx;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const f of list || []) {
      const line = f.line;
      if (!line || line.length < 2) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, (f.width || defWidth) * this.scale);
      ctx.beginPath();
      for (let i = 0; i < line.length; i++) {
        const [px, py] = this.toScreen(line[i][0], line[i][1]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (edge && this.scale > 0.06) {
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  /**
   * Ramp control areas and the non-movement boundary. The ramp label carries
   * its frequency, as it does on the paper chart — it is the first thing a
   * controller checks when they sit down.
   */
  _drawAreas() {
    const ctx = this.ctx;
    for (const a of this.model.areas || []) {
      if (!a.poly || a.poly.length < 3) continue;
      ctx.beginPath();
      for (let i = 0; i < a.poly.length; i++) {
        const [px, py] = this.toScreen(a.poly[i][0], a.poly[i][1]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      if (a.kind === "nonmovement") {
        ctx.strokeStyle = COLORS.nonmove;
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      ctx.closePath();
      const mine = this.state.myRamp && a.id === this.state.myRamp;
      ctx.fillStyle = mine ? COLORS.rampMine : COLORS.rampFill;
      ctx.fill();
    }

  }

  /**
   * Ramp names and frequencies, drawn last so stands cannot cover them. The
   * frequency belongs on the chart: it is the first thing a controller checks.
   */
  _drawAreaLabels() {
    if (this.scale < 0.12) return;
    const ctx = this.ctx;
    ctx.textAlign = "center";
    ctx.font = "600 12px ui-monospace, Menlo, monospace";
    for (const a of this.model.areas || []) {
      if (!a.label || !a.labelAt) continue;
      const [px, py] = this.toScreen(a.labelAt[0], a.labelAt[1]);
      const mine = this.state.myRamp && a.id === this.state.myRamp;
      // Set along the alley, like the concourse names: the alley centre is the
      // one strip of the ramp with no aircraft parked on it.
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-Math.PI / 2 + this.rot);
      const w = ctx.measureText(a.label).width + 14;
      ctx.fillStyle = "rgba(5,7,10,0.85)";
      ctx.fillRect(-w / 2, -9, w, 16);
      ctx.fillStyle = mine ? COLORS.rampLabelMine : COLORS.rampLabel;
      ctx.fillText(a.label, 0, 3);
      ctx.restore();
    }
  }

  /** Concourse names, set along the building like the chart. */
  _drawBuildingLabels() {
    if (this.scale < 0.14) return;
    const ctx = this.ctx;
    ctx.textAlign = "center";
    ctx.font = "600 11px ui-monospace, Menlo, monospace";
    ctx.fillStyle = COLORS.buildingLabel;
    for (const b of this.model.buildings || []) {
      if (!b.label || !b.labelAt) continue;
      const [px, py] = this.toScreen(b.labelAt[0], b.labelAt[1]);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-Math.PI / 2 + this.rot);
      ctx.fillText(b.label, 0, 4);
      ctx.restore();
    }
  }

  /** Ramp hold spots — the boxed 1N / 4S markers on the chart. */
  _drawSpots() {
    if (this.scale < 0.2) return;
    const ctx = this.ctx;
    ctx.font = "9px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    for (const sp of this.model.spots || []) {
      if (!sp.point) continue;
      const [px, py] = this.toScreen(sp.point[0], sp.point[1]);
      ctx.strokeStyle = COLORS.spot;
      ctx.lineWidth = 1;
      ctx.strokeRect(px - 11, py - 7, 22, 14);
      ctx.fillStyle = COLORS.spot;
      ctx.fillText(sp.id, px, py + 3);
    }
  }

  _drawTaxiLabels() {
    const ctx = this.ctx;
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillStyle = COLORS.taxiLabel;
    ctx.textAlign = "center";
    for (const t of this.model.taxiways || []) {
      if (!t.ref || !t.line || t.line.length < 2) continue;
      const mid = t.line[Math.floor(t.line.length / 2)];
      const [px, py] = this.toScreen(mid[0], mid[1]);
      if (px < -20 || py < -20 || px > this.canvas.clientWidth + 20 || py > this.canvas.clientHeight + 20) continue;
      ctx.fillText(t.ref, px, py + 3);
    }
  }

  _drawStands() {
    const ctx = this.ctx;
    const showLabels = this.scale > 0.35;
    for (const s of this.model.stands || []) {
      if (!s.poly) continue;
      const status = this.standStatus(s);
      const color = this.statusColor(status);
      const occ = this.state.occupancy.get(s.id);
      const assigned = status === "assigned";
      ctx.globalAlpha = this.rampAlpha(s.ramp) * (occ && occ.dormant ? 0.5 : 1);

      ctx.beginPath();
      for (let i = 0; i < s.poly.length; i++) {
        const [px, py] = this.toScreen(s.poly[i][0], s.poly[i][1]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      // A prediction must never render like an observation: assigned stands
      // are outlined, occupied ones are filled.
      if (assigned) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha *= status === "free" ? 0.30 : 0.62;
        ctx.fill();
        ctx.globalAlpha = this.rampAlpha(s.ramp);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (showLabels) {
        // Print the id outboard along the stand, away from the building: the
        // west and east faces of a concourse are only ~35 m apart and their
        // labels would otherwise land on top of each other.
        const th = (s.hdg || 0) * Math.PI / 180;
        const [px, py] = this.toScreen(
          s.point[0] - Math.sin(th) * 26,
          s.point[1] - Math.cos(th) * 26
        );
        ctx.fillStyle = COLORS.text;
        ctx.font = "9px ui-monospace, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.fillText(s.id, px, py + 3);
      }
      ctx.globalAlpha = 1;
    }

    if (this.layers.standBoxes && this.scale > 0.5) this._drawStandBoxes();
  }

  /** The `D32 / DAL1438 / 08:14 Occupied` boxes from the reference display. */
  _drawStandBoxes() {
    const ctx = this.ctx;
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    for (const s of this.model.stands || []) {
      const occ = this.state.occupancy.get(s.id);
      let lines = null;
      let color = null;
      if (occ) {
        color = this.statusColor(occ.conflict ? "conflict" : "occupied");
        lines = [s.id, occ.callsign, fmtClock(occ.elapsedMs) + (occ.dormant ? " DORMANT" : " Occupied")];
      } else {
        for (const [cs, a] of this.state.assignments) {
          if (a.standId !== s.id) continue;
          color = COLORS.timer;
          lines = [s.id, cs + (a.confidence === "medium" || a.confidence === "low" ? " ?" : ""), a.etaText || "INBOUND"];
          break;
        }
      }
      if (!lines) continue;
      ctx.globalAlpha = this.rampAlpha(s.ramp);
      const [px, py] = this.toScreen(s.point[0], s.point[1]);
      const wBox = 74;
      const hBox = 12 * lines.length + 6;
      const bx = px + 10;
      const by = py - hBox / 2;
      ctx.fillStyle = "rgba(5,8,12,0.86)";
      ctx.fillRect(bx, by, wBox, hBox);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, wBox, hBox);
      ctx.fillStyle = color;
      lines.forEach((ln, i) => ctx.fillText(ln, bx + 4, by + 12 + i * 12 - 2));
      ctx.globalAlpha = 1;
    }
  }

  _drawTrails() {
    const ctx = this.ctx;
    ctx.fillStyle = "#33424e";
    for (const t of this.state.targets) {
      if (!t.trail || t.trail.length < 2) continue;
      for (let i = Math.max(0, t.trail.length - 8); i < t.trail.length - 1; i++) {
        const [px, py] = this.toScreen(t.trail[i][0], t.trail[i][1]);
        ctx.fillRect(px - 1, py - 1, 2, 2);
      }
    }
  }

  _drawTargets() {
    const ctx = this.ctx;
    for (const t of this.state.targets) {
      const [px, py] = this.toScreen(t.dispX, t.dispY);
      if (px < -60 || py < -60 || px > this.canvas.clientWidth + 60 || py > this.canvas.clientHeight + 60) continue;
      const color = t.manual ? COLORS.manual : (PHASE_COLOR[t.phase] || COLORS.inbound);
      const assign = this.state.assignments.get(t.callsign);
      ctx.globalAlpha = this.rampAlpha(assign ? assign.ramp : null);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((t.hdg || 0) * Math.PI / 180 + this.rot);
      const size = Math.max(4, Math.min(26, (sizeMetres(t.sizeCode) * this.scale) / 2));
      ctx.fillStyle = color;
      ctx.beginPath();
      // Plan-view silhouette: nose, wings, tail.
      ctx.moveTo(0, -size);
      ctx.lineTo(size * 0.32, -size * 0.15);
      ctx.lineTo(size * 0.95, size * 0.12);
      ctx.lineTo(size * 0.2, size * 0.3);
      ctx.lineTo(size * 0.45, size);
      ctx.lineTo(0, size * 0.72);
      ctx.lineTo(-size * 0.45, size);
      ctx.lineTo(-size * 0.2, size * 0.3);
      ctx.lineTo(-size * 0.95, size * 0.12);
      ctx.lineTo(-size * 0.32, -size * 0.15);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  _drawTags() {
    const ctx = this.ctx;
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    const targets = [...this.state.targets].sort((a, b) => (b.gs || 0) - (a.gs || 0));
    for (const t of targets) {
      const [px, py] = this.toScreen(t.dispX, t.dispY);
      if (px < 0 || py < 0 || px > this.canvas.clientWidth || py > this.canvas.clientHeight) continue;
      const lines = this.tagLines(t);
      if (!lines.length) continue;
      const wBox = Math.max(...lines.map(l => l.length)) * 6 + 6;
      const hBox = lines.length * 11;
      const spot = this._placeLabel(px, py, wBox, hBox);
      if (!spot) continue;
      const color = t.manual ? COLORS.manual : (PHASE_COLOR[t.phase] || COLORS.inbound);
      ctx.strokeStyle = COLORS.leader;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(spot.x, spot.y + 4);
      ctx.stroke();
      ctx.fillStyle = color;
      lines.forEach((ln, i) => ctx.fillText(ln, spot.x, spot.y + 9 + i * 11));
    }
  }

  /** Callsign, then ramp/gate, then the phase-relevant third line. */
  tagLines(t) {
    const a = this.state.assignments.get(t.callsign);
    const occStand = t.standId;
    const lines = [t.callsign];
    const gate = occStand || (a && a.standId);
    if (gate) {
      const st = this.model && this.model.stands.find(s => s.id === gate);
      const ramp = st && st.ramp ? st.ramp + "/" : "";
      const q = !occStand && a && a.confidence !== "high" ? " ?" : "";
      lines.push(ramp + gate + q);
    } else if (a && a.source === "unassigned") {
      lines.push("UNASSIGNED");
    }
    if (this.scale > 0.3) {
      if (t.phase === "TAXI_OUT" || t.phase === "HOLDING" || t.phase === "PUSHBACK") {
        if (t.sid) lines.push(t.sid);
      } else if (a && a.etaText) {
        lines.push(a.etaText);
      }
    }
    return lines;
  }

  /** Simple collision-avoiding label placement — four offsets, then give up. */
  _placeLabel(px, py, w, h) {
    const offsets = [[12, -6], [-w - 12, -6], [12, 10], [-w - 12, 10], [12, -22]];
    for (const [dx, dy] of offsets) {
      const box = { x: px + dx, y: py + dy, w, h };
      if (!this._labelBoxes.some(b => overlaps(b, box))) {
        this._labelBoxes.push(box);
        return box;
      }
    }
    return null;
  }
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function sizeMetres(code) {
  return { A: 15, B: 24, C: 36, D: 52, E: 64, F: 80 }[code] || 36;
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}
