/**
 * Which controller positions may use CPDLC, and how much of the ACL they get.
 *
 *   _CTR / _FSS                 → full access: every Sort... list filter
 *   _DEL / _GND / _TWR / _APP   → CPDLC for aircraft on the ground only, so the
 *   (and _DEP, the other TRACON   Sort menu is locked to SHOW GROUND A/C
 *    half of an approach control)
 *   anything else (_ATIS, _OBS,
 *   _SUP, observers, no position) → no CPDLC
 *
 * The hub decides whether a CID may sign in at all; this module decides what the
 * signed-in position is allowed to see, and keeps both pages saying the same thing.
 */

/** Full ACL access — every Sort... filter. */
export const ROLE_FULL = "full";
/** CPDLC to aircraft on the ground only — Sort... locked to GROUND. */
export const ROLE_GROUND = "ground";
/** Not a CPDLC position. */
export const ROLE_NONE = "none";

const FULL_SUFFIXES = ["CTR", "FSS"];
const GROUND_SUFFIXES = ["DEL", "GND", "TWR", "APP", "DEP"];

/** Trailing position suffix of a controller callsign ("ZTL_12_CTR" → "CTR"). */
export function positionSuffix(callsign) {
  const cs = String(callsign || "").toUpperCase().trim();
  const i = cs.lastIndexOf("_");
  if (i < 0 || i === cs.length - 1) return "";
  return cs.slice(i + 1).replace(/[^A-Z]/g, "");
}

/** @returns {'full'|'ground'|'none'} */
export function positionRole(callsign) {
  const sfx = positionSuffix(callsign);
  if (!sfx) return ROLE_NONE;
  if (FULL_SUFFIXES.includes(sfx)) return ROLE_FULL;
  if (GROUND_SUFFIXES.includes(sfx)) return ROLE_GROUND;
  return ROLE_NONE;
}

/** May this position sign in to CPDLC at all? */
export function canUseCpdlc(callsign) {
  return positionRole(callsign) !== ROLE_NONE;
}

/** ACL Sort... modes this position may choose, in menu order. */
export function allowedAclModes(callsign) {
  const role = positionRole(callsign);
  if (role === ROLE_FULL) return ["all", "cpdlc", "freq", "ground"];
  if (role === ROLE_GROUND) return ["ground"];
  return [];
}

/**
 * Hold a position to the filters it is allowed.
 * An unknown position (no callsign yet — the hub has not reported one) is left
 * alone: the hub owns the sign-in gate, and guessing here would flip a verified
 * center controller's list mid-session.
 */
export function clampAclMode(mode, callsign) {
  const cs = String(callsign || "").trim();
  if (!cs) return mode;
  const allowed = allowedAclModes(cs);
  if (!allowed.length) return mode;
  return allowed.includes(mode) ? mode : allowed[0];
}

/** True when this position is held to ground traffic (drives the locked Sort menu). */
export function isGroundOnly(callsign) {
  return !!String(callsign || "").trim() && positionRole(callsign) === ROLE_GROUND;
}

/** Find our own controller session in a VATSIM v3 controllers[] list. */
export function findMyPosition(controllers, cid) {
  const id = String(cid || "").trim();
  if (!id) return null;
  return (controllers || []).find((c) => c && String(c.cid) === id) || null;
}

/**
 * The field a ground-only position works, when its callsign names one:
 * KATL_TWR/KATL_GND/ATL_DEL → the airport. An approach/departure position is a
 * TRACON id (A80, NCT), not an airport, so it gets no field and falls back to
 * the ARTCC. Centers get none — they are not tied to one field.
 */
export function positionField(callsign) {
  const cs = String(callsign || "").toUpperCase().trim();
  const sfx = positionSuffix(cs);
  if (!["DEL", "GND", "TWR"].includes(sfx)) return "";
  const prefix = cs.slice(0, cs.length - sfx.length - 1).replace(/_\d+$/, "");
  const field = prefix.split("_")[0].replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{3,4}$/.test(field) ? field : "";
}

/** Short reason text for the UI. */
export function roleLabel(callsign) {
  const role = positionRole(callsign);
  if (role === ROLE_FULL) return "center position — all list filters";
  if (role === ROLE_GROUND) return "tower/TRACON position — ground aircraft only";
  return "not a CPDLC position";
}
