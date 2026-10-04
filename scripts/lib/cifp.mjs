/**
 * Minimal FAA CIFP (ARINC 424, FAACIFP18) reader for US enroute airways and
 * SID/STAR procedures. Columns below are 1-indexed per ARINC 424; the code
 * slices with 0-indexed offsets.
 *
 * Fix records with coordinates (lat 33-41, lon 42-51):
 *   EA  enroute waypoint   ident 14-18, ICAO 20-21
 *   D   VHF navaid         ident 14-17, ICAO 20-21 (DME-only: DME lat/lon 56-74)
 *   DB  enroute NDB        ident 14-17, ICAO 20-21
 *   PC  terminal waypoint  airport 7-10, ident 14-18, ICAO 20-21
 *   PN  terminal NDB       airport 7-10, ident 14-17, ICAO 20-21
 * Airway legs (ER): route 14-18, seq 26-29, fix 30-34, ICAO 35-36, sec 37, sub 38, cont 39
 * Procedure legs (PD SID / PE STAR): airport 7-10, subsection 13, proc 14-19,
 *   route type 20, transition 21-25, seq 27-29, fix 30-34, ICAO 35-36, sec 37, sub 38, cont 39
 */
import { readFileSync } from "node:fs";

const COORD_RE = /^([NS])(\d{2})(\d{2})(\d{2})(\d{2})([EW])(\d{3})(\d{2})(\d{2})(\d{2})$/;

function parseCoord(s) {
  const m = COORD_RE.exec(s);
  if (!m) return null;
  let lat = +m[2] + m[3] / 60 + m[4] / 3600 + m[5] / 360000;
  let lon = +m[7] + m[8] / 60 + m[9] / 3600 + m[10] / 360000;
  if (m[1] === "S") lat = -lat;
  if (m[6] === "W") lon = -lon;
  return [lat, lon];
}

const col = (line, from, to) => line.slice(from - 1, to).trim();
const isPrimary = c => c === "0" || c === "1";

export function readCifpLines(path) {
  return readFileSync(path, "latin1").split(/\r?\n/);
}

/** AIRAC cycle (e.g. "2610") from the HDR01 record, or null. */
export function cifpCycle(lines) {
  const hdr = lines.find(l => l.startsWith("HDR01"));
  const m = hdr && /(\d{4})\s+\d{2}-[A-Z]{3}-\d{4}/.exec(hdr);
  return m ? m[1] : null;
}

/**
 * Parse US-area (SUSA) airways and SID/STAR procedures.
 * Returns { airways: {id: [[fix, lat, lon], ...]}, procedures: {id: {type, apt, common, transitions}} }
 * with raw (unrounded, unfiltered) coordinates; legs without a fix (VA, CA, VM…) are dropped.
 * `lookup(ident)` supplies coordinates for points CIFP does not carry (e.g. Mexican navaids).
 */
export function parseCifp(lines, lookup = () => null) {
  const fixIndex = new Map();   // "EA|ID|K7", "PC|KATL|ID|K7", … -> [lat, lon]
  const byIdent = new Map();    // ID -> first [lat, lon] seen (fallback)
  const putFix = (key, ident, ll) => {
    if (!ll) return;
    if (!fixIndex.has(key)) fixIndex.set(key, ll);
    if (!byIdent.has(ident)) byIdent.set(ident, ll);
  };

  for (const l of lines) {
    if (!l.startsWith("SUSA") || l.length < 51) continue;
    const sec = l[4], sub = l[5];
    if (sec === "E" && sub === "A") {
      if (!isPrimary(l[21])) continue;
      const id = col(l, 14, 18), icao = col(l, 20, 21);
      putFix(`EA|${id}|${icao}`, id, parseCoord(col(l, 33, 51)));
    } else if (sec === "D") {
      if (!isPrimary(l[21])) continue;
      const id = col(l, 14, 17), icao = col(l, 20, 21);
      const ll = parseCoord(col(l, 33, 51)) || parseCoord(col(l, 56, 74));
      putFix(`D${sub.trim()}|${id}|${icao}`, id, ll);
    } else if (sec === "P" && (l[12] === "C" || l[12] === "N")) {
      if (!isPrimary(l[21])) continue;
      const apt = col(l, 7, 10), icao = col(l, 20, 21);
      const id = l[12] === "C" ? col(l, 14, 18) : col(l, 14, 17);
      const ll = parseCoord(col(l, 33, 51)) || (l[12] === "N" ? parseCoord(col(l, 56, 74)) : null);
      putFix(`P${l[12]}|${apt}|${id}|${icao}`, id, ll);
    }
  }

  const resolve = (apt, id, icao, sec, sub) => {
    const s = sub.trim();
    const key = sec === "P" ? `P${s}|${apt}|${id}|${icao}`
      : sec === "E" ? `E${s}|${id}|${icao}`
      : `D${s}|${id}|${icao}`;
    return fixIndex.get(key) || byIdent.get(id) || lookup(id) || null;
  };

  // Airways
  const awyLegs = new Map();
  for (const l of lines) {
    if (!l.startsWith("SUSAER") || l.length < 39 || !isPrimary(l[38])) continue;
    const route = col(l, 14, 18), fix = col(l, 30, 34);
    if (!route || !fix) continue;
    const ll = resolve("", fix, col(l, 35, 36), l[36], l[37]);
    if (!awyLegs.has(route)) awyLegs.set(route, []);
    awyLegs.get(route).push({ seq: +col(l, 26, 29), fix, ll });
  }
  const airways = {};
  for (const [route, legs] of awyLegs) {
    legs.sort((a, b) => a.seq - b.seq);
    const w = [];
    for (const g of legs) {
      if (!g.ll || (w.length && w[w.length - 1][0] === g.fix)) continue;
      w.push([g.fix, g.ll[0], g.ll[1]]);
    }
    if (w.length >= 2) airways[route] = w;
  }

  // SIDs (PD) and STARs (PE): group legs by procedure, airport, transition
  const procLegs = new Map();   // proc -> { type, apts: Map(apt -> Map(trans -> legs)) }
  for (const l of lines) {
    if (!l.startsWith("SUSAP") || l.length < 39) continue;
    const subsec = l[12];
    if (subsec !== "D" && subsec !== "E") continue;
    if (!isPrimary(l[38])) continue;
    const apt = col(l, 7, 10);
    const proc = col(l, 14, 19).replace(/[^A-Z0-9]/g, "");
    const trans = col(l, 21, 25) || "ALL";
    const fix = col(l, 30, 34);
    if (!proc || !fix) continue;
    const sec = l[36];
    if (sec === "P" && l[37] === "G") continue;   // runway threshold, not a route point
    const ll = resolve(apt, fix, col(l, 35, 36), sec, l[37]);
    if (!ll) continue;
    if (!procLegs.has(proc)) procLegs.set(proc, { type: subsec === "D" ? "SID" : "STAR", apts: new Map() });
    const apts = procLegs.get(proc).apts;
    if (!apts.has(apt)) apts.set(apt, new Map());
    const tr = apts.get(apt);
    if (!tr.has(trans)) tr.set(trans, []);
    tr.get(trans).push({ seq: +col(l, 27, 29), fix, ll });
  }

  const procedures = {};
  for (const [proc, { type, apts }] of procLegs) {
    const entry = { type, apt: [], common: [], transitions: {} };
    for (const [apt, trs] of apts) {
      entry.apt.push(apt);
      for (const [trans, legs] of trs) {
        legs.sort((a, b) => a.seq - b.seq);
        // Repeated fixes (holds, single-fix conventional SIDs) are kept, as in the @squawk build
        const seq = legs.map(g => [g.fix, g.ll[0], g.ll[1]]);
        if (trans === "ALL") {
          if (!entry.common.length) entry.common = seq;
        } else if (!entry.transitions[trans]) {
          entry.transitions[trans] = seq;
        }
      }
    }
    procedures[proc] = entry;
  }
  return { airways, procedures };
}
