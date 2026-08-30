/**
 * RampView helpers with no browser dependencies, so node tests can import them
 * without pulling in IndexedDB, canvas or the polling loop.
 */

/** Explicit `GATE A12` / `STAND A12` in remarks only — a bare A12 is not a gate. */
export function declaredStand(target, model) {
  const m = /\b(?:GATE|STAND)[:\s]+([A-Z]{0,2}\d{1,3}[A-Z]?)\b/i.exec(target.route || "");
  if (!m) return null;
  const id = m[1].toUpperCase();
  return model.stands.some(s => s.id === id) ? id : null;
}

/** Phases in which an aircraft is still arriving. */
export const INBOUND_PHASES = new Set(["INBOUND", "LANDED", "TAXI_IN"]);

/**
 * The gate line of a data tag.
 *
 * The ramp prefix answers "whose aircraft is this?", which is only a live
 * question while the aircraft is inbound — so R3/C30 on an arrival, and the
 * bare C30 once it is on the stand or taxiing out, which is what gets read
 * back on frequency. A predicted stand carries a "?"; an observed one never
 * does.
 *
 * @param {{ phase: string, observed: boolean, gate: string|null, ramp: string|null, confidence?: string }} o
 * @returns {string|null}
 */
export function gateTag(o) {
  if (!o.gate) return null;
  const prefix = !o.observed && INBOUND_PHASES.has(o.phase) && o.ramp ? o.ramp + "/" : "";
  const q = !o.observed && o.confidence && o.confidence !== "high" ? " ?" : "";
  return prefix + o.gate + q;
}

/** HHMMZ for a timestamp. */
export function fmtEta(ms) {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + "Z";
}
