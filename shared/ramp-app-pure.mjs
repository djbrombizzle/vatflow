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

/** HHMMZ for a timestamp. */
export function fmtEta(ms) {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + "Z";
}
