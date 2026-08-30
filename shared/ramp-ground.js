/**
 * RampView — the ground controller's view of the ramp.
 *
 * Ground works the movement area and hands aircraft to a ramp. To do that they
 * need one answer per inbound: which ramp is this going to, where does it enter,
 * and what frequency do I send them to. That answer only exists once a stand has
 * been drawn, which is why the whole-field view and the assignment engine are
 * the same tool.
 */

import { distXY } from "./ramp-airport.js";

/** A distinct hue per ramp, so a glance at the field shows the flow. */
export const RAMP_COLORS = {
  R1: "#5ac8e0", R2: "#6fd67d", R3: "#e0b23c", R4: "#e08a4a",
  R5: "#c98ce0", R6: "#4ad2b8", R8: "#e0698c", R9: "#8fa2e0",
};

export function rampColor(rampId) {
  return RAMP_COLORS[rampId] || "#8fa2b0";
}

/**
 * The spot an aircraft should enter its ramp through: the ramp's own spot
 * closest to where the aircraft actually is. An arrival rolling out to the
 * south enters at the south end; the same stand off a north runway enters at
 * the north end, and the choice corrects itself as the aircraft taxis.
 *
 * @param {{x: number, y: number}} pos current position, local metres
 * @param {string} rampId
 * @param {Array} spots model.spots
 */
export function entrySpot(pos, rampId, spots) {
  let best = null;
  for (const sp of spots || []) {
    if (sp.ramp !== rampId || !sp.point) continue;
    const d = distXY(pos.x, pos.y, sp.point[0], sp.point[1]);
    if (!best || d < best.distM) best = { spot: sp, distM: d };
  }
  return best;
}

/**
 * One row per inbound that ground has to place, nearest first.
 *
 * Includes aircraft still airborne on short final so ground can plan the
 * handoff before the aircraft is even off the runway, which is the point.
 *
 * @param {object} o { targets, assignments, model, occupancy, nowMs }
 */
export function groundInbounds(o) {
  const { targets, assignments, model } = o;
  const standById = new Map((model.stands || []).map(s => [s.id, s]));
  const rampById = new Map((model.ramps || []).map(r => [r.id, r]));
  const rows = [];

  for (const t of targets) {
    if (t.arr !== model.icao) continue;
    if (t.standId) continue;                       // already in block
    if (!GROUND_PHASES.has(t.phase)) continue;

    const a = assignments.get(t.callsign);
    const stand = a && a.standId ? standById.get(a.standId) : null;
    const rampId = stand ? stand.ramp : null;
    const ramp = rampId ? rampById.get(rampId) : null;
    const entry = rampId ? entrySpot({ x: t.dispX, y: t.dispY }, rampId, model.spots) : null;

    rows.push({
      callsign: t.callsign,
      type: t.type,
      phase: t.phase,
      gate: stand ? stand.id : null,
      ramp: rampId,
      rampLabel: ramp ? ramp.label : null,
      freq: ramp ? ramp.freq : null,
      spot: entry ? entry.spot.id : null,
      spotDistM: entry ? Math.round(entry.distM) : null,
      color: rampColor(rampId),
      onSurface: t.phase === "TAXI_IN" || t.phase === "LANDED",
      unassigned: !stand,
    });
  }

  // Aircraft already taxiing come first — they need the instruction now.
  rows.sort((a, b) => {
    if (a.onSurface !== b.onSurface) return a.onSurface ? -1 : 1;
    return (a.spotDistM ?? 1e9) - (b.spotDistM ?? 1e9);
  });
  return rows;
}

/** Phases where ground still has to route the aircraft to a ramp. */
export const GROUND_PHASES = new Set(["INBOUND", "LANDED", "TAXI_IN"]);
