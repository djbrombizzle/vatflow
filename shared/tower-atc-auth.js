/**
 * Tower Departures — VATSIM CID verification for _TWR / _GND positions.
 */

const TWR_GND_SUFFIX = /_(TWR|GND)$/i;

export function isTowerGroundPosition(callsign) {
  return TWR_GND_SUFFIX.test(callsign || "");
}

/** Extract field ICAO from position callsign (e.g. KATL_TWR → KATL). */
export function fieldIcaoFromCallsign(callsign) {
  if (!callsign) return null;
  const m = ("" + callsign).toUpperCase().match(/^(.+?)_(?:TWR|GND)$/);
  if (!m) return null;
  const field = m[1].replace(/[^A-Z0-9]/g, "");
  if (field.length < 3 || field.length > 4) return null;
  return field;
}

export function findAtcSession(controllers, cid) {
  if (!cid) return null;
  const id = String(cid).trim();
  return (controllers || []).find(c =>
    String(c.cid) === id && isTowerGroundPosition(c.callsign)
  ) || null;
}

/**
 * @returns {{ verified: boolean, callsign: string|null, fieldIcao: string|null, reason: string|null }}
 */
export function verifyTowerAtc(controllers, cid) {
  if (!cid || !String(cid).trim()) {
    return { verified: false, callsign: null, fieldIcao: null, reason: "no_cid" };
  }
  const session = findAtcSession(controllers, cid);
  if (!session) {
    return { verified: false, callsign: null, fieldIcao: null, reason: "not_on_position" };
  }
  return {
    verified: true,
    callsign: session.callsign,
    fieldIcao: fieldIcaoFromCallsign(session.callsign),
    reason: null,
  };
}
