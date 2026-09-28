/**
 * Dispatch Center: a quick fuel estimate for flights with no SimBrief OFP
 * (DOM-free, tested in scripts/test-aoc-core.mjs).
 *
 * Data: data/aoc/icao-fuel.json, built by scripts/build-icao-fuel.mjs from the
 * ICAO Carbon Emissions Calculator methodology (v13.1), Appendix C: fuel burned
 * (kg) by equivalent aircraft type at fixed distances from 125 to 8,500 nm,
 * from ICAO's fuel formula fitted to in-service data. Like EUROCONTROL's SET,
 * it is fuel as a function of type and distance, with straight lines between
 * the table's distances.
 *
 * Distance: the filed route's length when the route could be drawn; otherwise
 * the great-circle distance plus ICAO's allowance for routing, holding and
 * weather (+50 km under 550 km, +100 km to 5,500 km, +125 km beyond).
 *
 * The estimate is burn (the table's flight fuel), plus the alternate leg (same
 * table, great circle + allowance) and a 45-minute reserve at the type's cruise
 * burn, US domestic style. No contingency, no taxi beyond what the table holds.
 * An estimate for a dispatcher's sanity check, not a flight plan.
 */

export const KG_TO_LB = 2.20462;
export const RESERVE_MIN = 45;

const TURBOPROP = new Set(["AT4", "AT5", "AT7", "ATP", "ATR", "DH1", "DH2", "DH3", "DH4", "DH8", "SF3", "J31", "J32", "J41", "F50", "F27", "SH3", "SH6"]);
const REGIONAL = new Set(["CR1", "CR2", "CR7", "CR9", "CRK", "CRJ", "ER3", "ER4", "ERJ", "E70", "E75", "E90", "E95", "141", "142", "143", "146", "AR1", "AR7", "AR8", "ARJ", "F70", "100"]);

/** Cruise TAS (kt) used for the reserve: turboprops 280, regional jets 430, the rest 460. */
export function cruiseKt(eq) {
  return TURBOPROP.has(eq) ? 280 : REGIONAL.has(eq) ? 430 : 460;
}

/** ICAO's great-circle allowance, in nm. */
export function gcdAllowanceNm(gcNm) {
  const km = gcNm * 1.852;
  return (km < 550 ? 50 : km <= 5500 ? 100 : 125) / 1.852;
}

/** The table's equivalent code for an ICAO designator ("A20N" -> "32N"), or null. */
export function equivalentType(data, icaoType) {
  const t = String(icaoType || "").toUpperCase().split("/")[0];
  const eq = data && data.icaoTypes ? data.icaoTypes[t] : null;
  return eq && data.types[eq] ? eq : null;
}

/**
 * Fuel (kg) for `nm` from the type's row: straight lines between the table's
 * distances, the first segment's slope below 125 nm, the last one's beyond the
 * type's range (`beyond` set: past what the table lists for that type).
 */
export function tableFuelKg(data, eq, nm) {
  const row = data.types[eq];
  const D = data.distancesNm;
  if (!row || !row.length || !(nm > 0)) return null;
  const n = row.length;
  if (n === 1) return { kg: (row[0] * nm) / D[0], beyond: nm > D[0] };
  let i = 1;
  while (i < n - 1 && D[i] < nm) i++;
  const x0 = D[i - 1], x1 = D[i], y0 = row[i - 1], y1 = row[i];
  const kg = Math.max(0, y0 + ((y1 - y0) * (nm - x0)) / (x1 - x0));
  return { kg, beyond: nm > D[n - 1] };
}

/** kg per nm at a distance: the slope of the table segment it falls in (cruise burn). */
function slopeKgPerNm(data, eq, nm) {
  const row = data.types[eq], D = data.distancesNm;
  let i = 1;
  while (i < row.length - 1 && D[i] < nm) i++;
  return (row[i] - row[i - 1]) / (D[i] - D[i - 1]);
}

/**
 * The estimate for one flight, or {ok: false, reason}.
 * f: {type, gcNm (dep-arr great circle), routeNm (filed route length, if drawn), altnGcNm}
 * All masses in kg; `lb(x)` converts.
 */
export function estimateFuel(data, f) {
  if (!data || !data.types) return { ok: false, reason: "Fuel table not loaded." };
  const eq = equivalentType(data, f.type);
  if (!eq) return { ok: false, reason: `No ICAO fuel data for type ${f.type || "?"}.` };
  const routed = f.routeNm != null && f.routeNm > 0;
  const distNm = routed ? f.routeNm : f.gcNm != null ? f.gcNm + gcdAllowanceNm(f.gcNm) : null;
  if (!(distNm > 0)) return { ok: false, reason: "No distance for this flight (unknown airport)." };
  const trip = tableFuelKg(data, eq, distNm);
  let altn = null, altnNm = null;
  if (f.altnGcNm != null && f.altnGcNm > 0) {
    altnNm = f.altnGcNm + gcdAllowanceNm(f.altnGcNm);
    altn = tableFuelKg(data, eq, altnNm);
  }
  // Reserve: 45 min at the cruise burn the table implies for this stage length.
  const perHour = slopeKgPerNm(data, eq, Math.max(500, distNm)) * cruiseKt(eq);
  const reserveKg = (perHour * RESERVE_MIN) / 60;
  const tripKg = trip.kg, altnKg = altn ? altn.kg : 0;
  return {
    ok: true, eq, basis: routed ? "route" : "gcd", distNm, altnNm,
    tripKg, altnKg, reserveKg, totalKg: tripKg + altnKg + reserveKg, burnKgPerHour: perHour,
    beyond: trip.beyond,
  };
}

export function toUnits(kg, units) {
  return units === "KGS" ? kg : kg * KG_TO_LB;
}
