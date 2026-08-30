/**
 * RampView — SID parsing and the north/south side map.
 *
 * A departure leaves its ramp through the end that faces its SID: a PENCL off
 * C30 goes out 3N, a GAIRY off the same gate goes out 3S. The datafeed gives us
 * the filed route, so the SID is readable; which way each SID faces is local
 * knowledge, so it is configuration a controller sets, not something we guess.
 *
 * Revision numbers are ignored throughout — PENCL2 and PENCL3 are the same
 * departure and must not need configuring twice.
 */

export const SIDE_NORTH = "NORTH";
export const SIDE_SOUTH = "SOUTH";

/**
 * Strip a SID token down to its name: PENCL2 -> PENCL, GAIRY2.RMG -> GAIRY,
 * SMKEY1A -> SMKEY. Returns "" for anything that is not a procedure token.
 */
export function sidBase(token) {
  const raw = String(token || "").toUpperCase().trim().split(".")[0];
  const m = /^([A-Z]{3,6})(\d)([A-Z])?$/.exec(raw);
  return m ? m[1] : "";
}

/**
 * The SID from a filed route. Pilots file it as the first token, sometimes
 * after the departure airport, sometimes with a transition on a dot.
 * @returns {{ token: string, base: string }|null}
 */
export function parseSid(route, departure) {
  const tokens = String(route || "").toUpperCase().trim().split(/[\s]+/).filter(Boolean);
  const dep = String(departure || "").toUpperCase();
  for (const t of tokens.slice(0, 3)) {
    if (t === dep || t === dep.replace(/^K/, "")) continue;
    const base = sidBase(t);
    if (base) return { token: t.split(".")[0], base };
  }
  return null;
}

/**
 * Normalise either form to the key the side map uses: PENCL2 and PENCL both
 * give PENCL. Unlike sidBase this accepts a bare name, because that is what a
 * controller types into the configuration panel. It is deliberately NOT used
 * for route parsing — there a revision digit is what tells a SID apart from an
 * airport or a fix, and KATL must never look like a procedure.
 */
export function sidKey(nameOrToken) {
  const raw = String(nameOrToken || "").toUpperCase().trim().split(".")[0];
  const m = /^([A-Z]{3,6})(\d[A-Z]?)?$/.exec(raw);
  return m ? m[1] : "";
}

/**
 * Which side of the ramp a SID leaves through.
 * @param {string} sidOrBase either PENCL2 or PENCL
 * @param {Record<string, string>} map base -> "NORTH" | "SOUTH"
 * @returns {string|null} null when nobody has configured this SID yet
 */
export function sideForSid(sidOrBase, map) {
  const base = sidKey(sidOrBase);
  if (!base) return null;
  const v = (map || {})[base];
  if (!v) return null;
  const s = String(v).toUpperCase();
  return s === SIDE_NORTH || s === SIDE_SOUTH ? s : null;
}

/**
 * The spot a departure uses: its ramp's spot on the side its SID faces.
 *
 * Falls back to the ramp's only spot when it has none on that side — Ramp 9 at
 * ATL has just 9S, and sending everyone there is correct rather than a guess.
 *
 * @param {string} rampId
 * @param {string|null} side SIDE_NORTH | SIDE_SOUTH | null
 * @param {Array} spots model.spots
 */
export function departureSpot(rampId, side, spots) {
  const mine = (spots || []).filter(s => s.ramp === rampId);
  if (!mine.length) return null;
  if (side) {
    const want = side === SIDE_NORTH ? "north" : "south";
    const hit = mine.find(s => s.side === want);
    if (hit) return { spot: hit, exact: true };
  }
  if (mine.length === 1) return { spot: mine[0], exact: false };
  return side ? null : null;
}

/**
 * What a departure's tag should say, and why.
 *
 * Three different unknowns used to collapse into "SID?", which sent the
 * controller to configure a SID that was already configured. They are separate
 * questions and get separate answers:
 *
 *   spot  — ramp and side both known: the instruction, e.g. "PENCL2 3N"
 *   side  — the SID's side is known but the aircraft has no gate, so no ramp
 *           and no spot. Still useful: it is a north departure. "PENCL2 N"
 *   unset — nobody has given this SID a side yet. "PENCL2 SID?"
 *
 * @param {{ sid?: string, side?: string|null, spot?: string|null }} o
 * @returns {{ kind: string, text: string }}
 */
export function departureLabel(o = {}) {
  const sid = o.sid || "";
  if (o.spot) return { kind: "spot", text: sid ? `${sid} ${o.spot}` : `SPOT ${o.spot}` };
  if (o.side) {
    const initial = String(o.side).toUpperCase()[0];
    return { kind: "side", text: sid ? `${sid} ${initial}` : initial };
  }
  if (sid) return { kind: "unset", text: `${sid} SID?` };
  return { kind: "none", text: "" };
}

/** Every SID name the map knows, sorted. */
export function knownSids(map) {
  return Object.keys(map || {}).sort();
}

/**
 * Merge a shipped default map with a controller's local overrides.
 * The controller always wins — this is their airport.
 */
export function mergeSidSides(shipped, local) {
  const out = {};
  for (const [k, v] of Object.entries(shipped || {})) {
    const key = sidKey(k);
    const side = String(v || "").toUpperCase();
    if (key && (side === SIDE_NORTH || side === SIDE_SOUTH)) out[key] = side;
  }
  for (const [k, v] of Object.entries(local || {})) {
    const key = sidKey(k);
    if (!key) continue;
    if (v === null) delete out[key];
    else {
      const side = String(v).toUpperCase();
      if (side === SIDE_NORTH || side === SIDE_SOUTH) out[key] = side;
    }
  }
  return out;
}
