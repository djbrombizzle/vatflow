/**
 * RampView — X-Plane apt.dat startup locations.
 *
 * OSM knows where a stand is and usually what it is called. What it rarely
 * carries is the three things assignment actually needs: which way the aircraft
 * parks, how big a stand it is, and which airlines use it. apt.dat rows 1300 and
 * 1301 carry all three and are community-maintained for every major field.
 *
 * Parsing only — the file itself is never redistributed. Run the build over a
 * local copy and commit the derived fields.
 *
 *   1300  lat  lon  heading  type  aircraft-classes  name...
 *   1301  width-code  operation-type  airline-codes...
 */

import { distXY, minCodeForWake } from "./ramp-airport.js";

/** apt.dat operation types mapped to the ops types RampView uses. */
const OPS_TYPE = {
  none: "airline",
  general_aviation: "ga",
  airline: "airline",
  cargo: "cargo",
  military: "military",
};

/** Aircraft class list -> the smallest ICAO code letter that fits. */
function codeFromClasses(classes) {
  const c = String(classes || "").toLowerCase();
  if (c.includes("heavy")) return "E";
  if (c.includes("jets")) return "C";
  if (c.includes("turboprops")) return "B";
  if (c.includes("props") || c.includes("helos")) return "A";
  return null;
}

/** apt.dat width codes are the ICAO code letters already. */
function codeFromWidth(width) {
  const w = String(width || "").toUpperCase();
  return /^[A-F]$/.test(w) ? w : null;
}

/**
 * Parse the startup locations for one airport out of an apt.dat file.
 *
 * @param {string} text the file contents
 * @param {string} icao
 * @returns {Array<{name: string, lat: number, lon: number, hdg: number, type: string,
 *   sizeCode: string|null, opsType: string, operators: string[]}>}
 */
export function parseAptDat(text, icao) {
  const want = String(icao || "").toUpperCase();
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let inAirport = false;
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const code = parts[0];

    // 1, 16 and 17 all open a new airport/heliport/seaport record.
    if (code === "1" || code === "16" || code === "17") {
      if (current) { out.push(current); current = null; }
      inAirport = parts[4] === want;
      continue;
    }
    if (!inAirport) continue;

    if (code === "1300") {
      if (current) out.push(current);
      const lat = parseFloat(parts[1]);
      const lon = parseFloat(parts[2]);
      const hdg = parseFloat(parts[3]);
      if (!isFinite(lat) || !isFinite(lon)) { current = null; continue; }
      current = {
        name: parts.slice(6).join(" ").trim().toUpperCase().replace(/\s+/g, ""),
        lat, lon,
        hdg: isFinite(hdg) ? ((hdg % 360) + 360) % 360 : 0,
        type: parts[4] || "misc",
        sizeCode: codeFromClasses(parts[5]),
        opsType: "airline",
        operators: [],
      };
      continue;
    }

    if (code === "1301" && current) {
      const width = codeFromWidth(parts[1]);
      if (width) current.sizeCode = width;
      current.opsType = OPS_TYPE[String(parts[2] || "").toLowerCase()] || current.opsType;
      current.operators = parts.slice(3)
        .join(" ")
        .split(/[\s,]+/)
        .map(s => s.trim().toUpperCase())
        .filter(s => /^[A-Z]{3}$/.test(s));
      continue;
    }

    // Any other row ends the current startup location's block.
    if (code !== "1302" && current) { out.push(current); current = null; }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Merge apt.dat records into a surface model.
 *
 * Enrichment only: it never moves a stand and never renames one. A record is
 * matched to the stand of the same name, or failing that to the nearest stand
 * within `radius` metres, and then fills in only the fields the model is
 * missing. What OSM already states wins — apt.dat is the fallback, not the
 * authority, because its stand names drift from the real ones more often.
 *
 * @param {object} model
 * @param {Array} records from parseAptDat
 * @param {{ proj: object, radius?: number }} opts
 * @returns {{ matched: number, unmatched: number, filledHeading: number,
 *   filledSize: number, filledOperators: number, filledOpsType: number }}
 */
export function mergeAptDat(model, records, opts) {
  const proj = opts.proj;
  const radius = opts.radius == null ? 45 : opts.radius;
  const stands = model.stands || [];
  const byName = new Map(stands.map(s => [String(s.id).toUpperCase(), s]));
  const report = {
    matched: 0, unmatched: 0,
    filledHeading: 0, filledSize: 0, filledOperators: 0, filledOpsType: 0,
  };

  for (const rec of records) {
    const [x, y] = proj.toXY(rec.lat, rec.lon);
    let stand = rec.name ? byName.get(rec.name) : null;

    if (!stand) {
      let best = null;
      for (const s of stands) {
        if (!s.point) continue;
        const d = distXY(x, y, s.point[0], s.point[1]);
        if (d <= radius && (!best || d < best.d)) best = { s, d };
      }
      stand = best ? best.s : null;
    }
    if (!stand) { report.unmatched++; continue; }
    report.matched++;

    if (stand.hdgKnown === false && isFinite(rec.hdg)) {
      stand.hdg = Math.round(rec.hdg);
      stand.hdgKnown = true;
      report.filledHeading++;
    }
    if (!stand.sizeCode && rec.sizeCode) {
      stand.sizeCode = rec.sizeCode;
      report.filledSize++;
    }
    if ((!stand.operators || !stand.operators.length) && rec.operators.length) {
      stand.operators = rec.operators.slice();
      report.filledOperators++;
    }
    if ((!stand.opsType || stand.opsType === "airline") && rec.opsType !== "airline") {
      stand.opsType = rec.opsType;
      report.filledOpsType++;
    }
  }
  return report;
}

export { minCodeForWake };
