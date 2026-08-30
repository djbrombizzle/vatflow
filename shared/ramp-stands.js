/**
 * RampView — stand occupancy.
 *
 * Occupancy is observation, but observation of a 15-second feed with position
 * jitter. Every rule here exists so that one bad sample cannot flip a gate:
 * matching has a hard radius and a confidence grade, and every state edge has
 * hysteresis.
 */

import { pointInPoly, distXY, headingDelta } from "./ramp-airport.js";

export const IN_BLOCK_GS = 3;          // kt
export const IN_BLOCK_HOLD_MS = 30000;
export const PUSH_MOVE_M = 20;
export const VACATE_M = 40;
export const VACATE_HOLD_MS = 30000;
export const DISCONNECT_GRACE_MS = 60000;
export const RECONNECT_WINDOW_MS = 600000;
export const DORMANT_MS = 90 * 60000;

/**
 * Match a position to a stand.
 *  high   — inside exactly one stand polygon
 *  medium — nearest centre inside the radius, facing roughly the right way
 *  low    — two stands competing; nose-in stands sit ~25 m apart and jitter is
 *           the same order, so this is common and must be flagged, not hidden
 * @returns {{ stand: object, confidence: string }|null}
 */
export function matchStand(x, y, hdg, stands) {
  const hits = stands.filter(s => s.poly && pointInPoly(x, y, s.poly));
  if (hits.length === 1) {
    // Containment is strong evidence, but an aircraft sitting across the box at
    // 90 degrees to it is more likely crossing the alley than parked. Downgrade
    // rather than reject: the 30 s at under 3 kt still has to hold.
    const aligned = hdg == null || Math.abs(headingDelta(hdg, hits[0].hdg)) <= 60;
    return { stand: hits[0], confidence: aligned ? "high" : "low" };
  }
  if (hits.length > 1) {
    hits.sort((a, b) => distXY(x, y, a.point[0], a.point[1]) - distXY(x, y, b.point[0], b.point[1]));
    return { stand: hits[0], confidence: "low" };
  }
  let best = null;
  let second = null;
  for (const s of stands) {
    if (!s.point) continue;
    const d = distXY(x, y, s.point[0], s.point[1]);
    const radius = standRadius(s);
    if (d > radius) continue;
    if (hdg != null && Math.abs(headingDelta(hdg, s.hdg)) > 45) continue;
    if (!best || d < best.d) { second = best; best = { stand: s, d }; }
    else if (!second || d < second.d) second = { stand: s, d };
  }
  if (!best) return null;
  const close = second && second.d - best.d < 8;
  return { stand: best.stand, confidence: close ? "low" : "medium" };
}

/** Match radius for a stand — 0.6 x its box length. */
export function standRadius(stand) {
  const poly = stand.poly;
  if (!poly || poly.length < 3) return 25;
  let maxD = 0;
  for (const p of poly) maxD = Math.max(maxD, distXY(stand.point[0], stand.point[1], p[0], p[1]));
  return Math.max(18, maxD * 0.6);
}

/**
 * Tracks who is on which stand over time.
 *
 * Fed the current target list every poll; keeps per-callsign candidate state so
 * that occupancy only changes when a transition has actually held.
 */
export class StandOccupancy {
  constructor(stands) {
    this.setStands(stands || []);
    /** @type {Map<string, object>} callsign -> tracking record */
    this.tracks = new Map();
    /** @type {Map<string, object>} standId -> { callsign, sinceMs, confidence } */
    this.occupied = new Map();
    /** callsign -> { standId, sinceMs, atMs } — survives a short disconnect */
    this.recent = new Map();
  }

  setStands(stands) {
    this.stands = stands;
    this.byId = new Map(stands.map(s => [s.id, s]));
  }

  /** Stands made unusable by an in-use neighbour. */
  blockedStands() {
    const out = new Set();
    for (const standId of this.occupied.keys()) {
      const st = this.byId.get(standId);
      for (const other of (st && st.blocks) || []) out.add(other);
    }
    return out;
  }

  /**
   * @param {number} nowMs
   * @param {Array} targets [{ callsign, x, y, hdg, gs, onGround, hasPlan }]
   */
  update(nowMs, targets) {
    const seen = new Set();

    for (const t of targets) {
      seen.add(t.callsign);
      let tr = this.tracks.get(t.callsign);
      if (!tr) {
        tr = { callsign: t.callsign, standId: null, sinceMs: null, candId: null, candSinceMs: null, state: "MOVING", inBlockXY: null, dormant: false };
        // Re-attach a stand kept through a short disconnect, so the turn timer
        // survives the dropout rather than restarting.
        const prev = this.recent.get(t.callsign);
        if (prev && nowMs - prev.atMs < RECONNECT_WINDOW_MS) {
          const m = matchStand(t.x, t.y, t.hdg, this.stands);
          if (m && m.stand.id === prev.standId) {
            tr.standId = prev.standId;
            tr.sinceMs = prev.sinceMs;
            tr.state = "IN_BLOCK";
            tr.inBlockXY = [t.x, t.y];
          }
        }
        this.tracks.set(t.callsign, tr);
      }

      const slow = (t.gs || 0) < IN_BLOCK_GS;
      const match = t.onGround === false ? null : matchStand(t.x, t.y, t.hdg, this.stands);

      if (tr.state === "IN_BLOCK") {
        const st = this.byId.get(tr.standId);
        const moved = tr.inBlockXY ? distXY(t.x, t.y, tr.inBlockXY[0], tr.inBlockXY[1]) : 0;
        if (moved > PUSH_MOVE_M || (t.gs || 0) > IN_BLOCK_GS) {
          tr.state = "PUSHBACK";
          tr.vacatingSinceMs = nowMs;
        } else if (st) {
          tr.dormant = !t.hasPlan && nowMs - tr.sinceMs > DORMANT_MS;
        }
      } else if (tr.state === "PUSHBACK") {
        const st = this.byId.get(tr.standId);
        const clear = !st || distXY(t.x, t.y, st.point[0], st.point[1]) > standRadius(st) + VACATE_M;
        if (clear && nowMs - tr.vacatingSinceMs > VACATE_HOLD_MS) {
          this.release(tr, nowMs);
        }
      } else if (slow && match) {
        if (tr.candId === match.stand.id) {
          if (nowMs - tr.candSinceMs >= IN_BLOCK_HOLD_MS && !this.occupiedByOther(match.stand.id, t.callsign)) {
            tr.state = "IN_BLOCK";
            tr.standId = match.stand.id;
            tr.sinceMs = tr.candSinceMs;
            tr.confidence = match.confidence;
            tr.inBlockXY = [t.x, t.y];
          }
        } else {
          tr.candId = match.stand.id;
          tr.candSinceMs = nowMs;
        }
      } else {
        tr.candId = null;
        tr.candSinceMs = null;
      }

      if (tr.state === "IN_BLOCK" || tr.state === "PUSHBACK") {
        this.recent.set(t.callsign, { standId: tr.standId, sinceMs: tr.sinceMs, atMs: nowMs });
      }
    }

    // Targets that vanished. Hold the stand through the grace window — pilots
    // drop and reconnect constantly, and freeing a gate then re-occupying it
    // twenty seconds later is exactly the flicker that makes a scope unusable.
    for (const [callsign, tr] of this.tracks) {
      if (seen.has(callsign)) { tr.goneSinceMs = null; continue; }
      if (!tr.goneSinceMs) tr.goneSinceMs = nowMs;
      if (nowMs - tr.goneSinceMs > DISCONNECT_GRACE_MS) {
        this.release(tr, nowMs);
        this.tracks.delete(callsign);
      }
    }

    this.rebuild(nowMs);
    return this.occupied;
  }

  occupiedByOther(standId, callsign) {
    const o = this.occupied.get(standId);
    return !!o && o.callsign !== callsign;
  }

  release(tr, nowMs) {
    tr.state = "MOVING";
    tr.standId = null;
    tr.sinceMs = null;
    tr.dormant = false;
    tr.inBlockXY = null;
    if (nowMs) this.recent.set(tr.callsign, { standId: null, sinceMs: null, atMs: nowMs });
  }

  rebuild(nowMs) {
    this.occupied.clear();
    for (const tr of this.tracks.values()) {
      if (!tr.standId) continue;
      const vacating = tr.state === "PUSHBACK" || !!tr.goneSinceMs;
      const cur = this.occupied.get(tr.standId);
      if (cur) cur.conflict = true;
      else {
        this.occupied.set(tr.standId, {
          callsign: tr.callsign,
          sinceMs: tr.sinceMs,
          confidence: tr.confidence || "medium",
          dormant: tr.dormant,
          vacating,
          elapsedMs: nowMs - (tr.sinceMs || nowMs),
        });
      }
    }
  }

  /** Where one callsign currently is, or null. */
  standOf(callsign) {
    const tr = this.tracks.get(callsign);
    return tr && tr.standId ? tr.standId : null;
  }
}
