/**
 * RampView — airport surface model.
 *
 * Holds the local projection (lat/lon <-> metres east/north about an airport
 * reference point), stand geometry helpers, and the merge of built OSM geometry
 * with the hand-authored override file.
 *
 * Runs unchanged in the browser and in node (build script + tests).
 */

const EARTH_R = 6378137;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** ICAO aerodrome reference codes, smallest to largest. */
export const SIZE_CODES = ["A", "B", "C", "D", "E", "F"];

/** Nominal stand box in metres [length, width] per ICAO code letter. */
const STAND_BOX = {
  A: [18, 18], B: [26, 24], C: [42, 38], D: [56, 54], E: [70, 66], F: [82, 82],
};

/** Wake category -> smallest stand code that can take it. */
const WAKE_MIN_CODE = { L: "B", M: "C", H: "E", J: "F" };

/**
 * Local east/north projection about a reference point. Equirectangular with
 * cos(lat) scaling — under 0.1 m of error across a 10 km field, which is well
 * inside the accuracy of anything we draw.
 * @param {number} refLat
 * @param {number} refLon
 */
export function makeProjection(refLat, refLon) {
  const cosLat = Math.cos(refLat * D2R);
  return {
    refLat, refLon,
    /** @returns {[number, number]} metres [east, north] */
    toXY(lat, lon) {
      return [
        (lon - refLon) * D2R * EARTH_R * cosLat,
        (lat - refLat) * D2R * EARTH_R,
      ];
    },
    /** @returns {[number, number]} [lat, lon] */
    toLL(x, y) {
      return [
        refLat + (y / EARTH_R) * R2D,
        refLon + (x / (EARTH_R * cosLat)) * R2D,
      ];
    },
  };
}

/** True bearing in degrees from [x1,y1] to [x2,y2] in local metres. */
export function bearingXY(x1, y1, x2, y2) {
  const b = Math.atan2(x2 - x1, y2 - y1) * R2D;
  return (b + 360) % 360;
}

export function distXY(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Ray-casting containment test. `poly` is [[x,y], ...]. */
export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest signed difference between two headings, in degrees. */
export function headingDelta(a, b) {
  let d = (((a - b) % 360) + 540) % 360 - 180;
  return d;
}

/**
 * Synthesise a stand polygon: a box of the stand's size class, oriented on the
 * stand heading, with the nose point at `point`. Stands mapped as a bare node
 * in OSM get their footprint from here rather than being drawn as a dot.
 * @param {[number, number]} point nose position, local metres
 * @param {number} hdg heading the aircraft faces when parked
 * @param {string} sizeCode ICAO A–F
 */
export function synthStandPoly(point, hdg, sizeCode) {
  const [len, wid] = STAND_BOX[sizeCode] || STAND_BOX.C;
  const th = hdg * D2R;
  const sin = Math.sin(th);
  const cos = Math.cos(th);
  // Local stand frame: +u along the nose heading, +v to the right.
  const corner = (u, v) => [
    point[0] + u * sin + v * cos,
    point[1] + u * cos - v * sin,
  ];
  const half = wid / 2;
  return [corner(6, -half), corner(6, half), corner(-len, half), corner(-len, -half)];
}

/** Smallest stand code that will take this wake category. */
export function minCodeForWake(wake) {
  return WAKE_MIN_CODE[String(wake || "M").toUpperCase()] || "C";
}

/** True when a stand of `standCode` can take an aircraft needing `needCode`. */
export function sizeFits(standCode, needCode) {
  const s = SIZE_CODES.indexOf(standCode);
  const n = SIZE_CODES.indexOf(needCode);
  if (s < 0 || n < 0) return true;
  return s >= n;
}

/** Axis-aligned bounds of every geometry in the model, in local metres. */
export function modelBounds(model) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = pts => {
    for (const p of pts || []) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  };
  for (const key of ["runways", "taxiways", "aprons", "buildings"]) {
    for (const f of model[key] || []) eat(f.line || f.poly);
  }
  for (const s of model.stands || []) eat(s.poly);
  if (!isFinite(minX)) return { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
  return { minX, minY, maxX, maxY };
}

/**
 * Merge the hand-authored override file over built geometry.
 *
 * Overrides never supply stand positions — those come from the build. They
 * supply what no machine-readable source publishes: ramp areas, concourse
 * grouping, airline blocks, closures and corrections.
 */
export function applyOverrides(model, overrides) {
  if (!overrides) return model;
  const out = { ...model };
  if (overrides.ramps) out.ramps = overrides.ramps;
  if (overrides.concourses) out.concourses = overrides.concourses;
  if (overrides.operatorBlocks) out.operatorBlocks = overrides.operatorBlocks;
  if (overrides.spots) out.spots = overrides.spots;
  if (overrides.areas) out.areas = overrides.areas;

  const byId = new Map(out.stands.map(s => [s.id, s]));
  for (const patch of overrides.standPatches || []) {
    const st = byId.get(patch.id);
    if (st) Object.assign(st, patch);
  }
  return stampRamps(out);
}

/**
 * Derive each stand's concourse (from its id prefix, when not already set) and
 * its ramp control area (from the concourse). Authored once per airport in the
 * override file's `ramps` list, never per stand.
 */
export function stampRamps(model) {
  const rampByConcourse = new Map();
  for (const r of model.ramps || []) {
    for (const c of r.concourses || []) rampByConcourse.set(String(c).toUpperCase(), r.id);
  }
  for (const s of model.stands || []) {
    if (!s.concourse) {
      const m = /^([A-Z]+)/.exec(s.id || "");
      if (m) s.concourse = m[1];
    }
    s.ramp = rampByConcourse.get(String(s.concourse || "").toUpperCase()) || null;
  }
  return model;
}

/** Coverage report for a built model — what the build did and did not resolve. */
export function coverage(model) {
  const stands = model.stands || [];
  const missing = k => stands.filter(s => !s[k] || (Array.isArray(s[k]) && !s[k].length)).length;
  return {
    stands: stands.length,
    runways: (model.runways || []).length,
    taxiways: (model.taxiways || []).length,
    noSize: missing("sizeCode"),
    noPoly: missing("poly"),
    noOperators: missing("operators"),
    noRamp: stands.filter(s => !s.ramp).length,
    noConcourse: stands.filter(s => !s.concourse).length,
  };
}
