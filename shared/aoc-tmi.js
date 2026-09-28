/**
 * Dispatch Center: traffic management initiatives from VATUSA OIS (DOM-free,
 * tested in scripts/test-aoc-core.mjs).
 *
 * Two public (no-key) OIS reads, both fetched through the vUSAlink hub, which
 * caches them (OIS only allows its own origins from a browser):
 *   GET /api/v1/public/board             every active ground stop, GDP, NTML
 *                                        restriction and airport rate program
 *   GET /api/v1/public/flight/{callsign} everything affecting one flight: GDP
 *                                        slot (EDCT / CTA), ground stop, rate
 *                                        program delay, FCA crossings, the worst
 *                                        delay and the latest EDCT
 * OIS serializes its Rust structs as-is: snake_case keys, RFC 3339 times.
 *
 * The per-flight lookup runs OIS's full FCA metering, so the page asks for it
 * only for the selected flight and a capped handful of ground flights bound for
 * a metered airport (autoAdvisoryTargets).
 */

import { zulu } from "./aoc-core.js";

/** Only this many flights get an automatic advisory lookup at a time. */
export const AUTO_ADVISORY_MAX = 8;
/** An advisory older than this is refetched. */
export const ADVISORY_TTL_MS = 120000;

const ms = t => {
  const n = t ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The board as {byAirport: Map(icao -> {gdp, groundStop, program}), restrictions, asOf}. */
export function tmiIndex(board) {
  const byAirport = new Map();
  const at = icao => {
    const k = String(icao || "").toUpperCase();
    if (!byAirport.has(k)) byAirport.set(k, { gdp: null, groundStop: null, program: null });
    return byAirport.get(k);
  };
  for (const g of (board && board.gdps) || []) at(g.airport).gdp = g;
  for (const s of (board && board.ground_stops) || []) at(s.airport).groundStop = s;
  for (const p of (board && board.programs) || []) at(p.icao).program = p;
  return { byAirport, restrictions: (board && board.restrictions) || [], asOf: ms(board && board.as_of) };
}

/** US ICAO -> FAA id, for matching NTML text ("KDFW" is written "DFW"). */
function faa(icao) {
  return /^K[A-Z0-9]{3}$/.test(icao) ? icao.slice(1) : icao;
}

/** NTML restrictions whose text names this airport (ICAO or FAA id, as a whole word). */
export function restrictionsFor(index, icao) {
  if (!index || !icao) return [];
  const ids = [...new Set([icao, faa(icao)])];
  const re = new RegExp(`\\b(${ids.join("|")})\\b`);
  return index.restrictions.filter(r => re.test(String(r.restriction || "").toUpperCase()));
}

/** Is a ground flight still waiting to depart (no OFF yet)? */
function onGround(row) {
  return !row.off && ["SCHED", "AT GATE", "TAXI OUT"].includes(row.phase);
}

/**
 * Alerts for one board row from the OIS board and (if fetched) its advisory:
 * {key, level, text}. Keys start "tmi-" so the page can tell them apart.
 *   ground stop at the destination, flight not yet airborne     bad
 *   an EDCT from the advisory (key changes with the time)       warn
 *   destination under a GDP (no EDCT known yet)                 warn
 *   destination rate program over capacity                      warn
 */
export function tmiAlerts(index, row, adv) {
  const out = [];
  if (!index || !row) return out;
  const a = index.byAirport.get(String(row.arr || "").toUpperCase());
  if (a && a.groundStop && onGround(row)) {
    const s = a.groundStop;
    out.push({ key: `tmi-gs-${row.arr}`, level: "bad",
      text: `Ground stop ${row.arr}${s.until ? ` until ${s.until}Z` : ""}${String(s.scope || "").trim() ? ` (${s.scope.trim()})` : ""}` });
  }
  const edct = adv && adv.found ? ms(adv.edct) : null;
  if (edct && onGround(row)) {
    out.push({ key: `tmi-edct-${adv.edct}`, level: "warn",
      text: `EDCT ${zulu(edct)}${adv.total_delay_min ? ` (+${adv.total_delay_min} min)` : ""} · ${edctReason(adv)}` });
  } else if (a && a.gdp && onGround(row)) {
    out.push({ key: `tmi-gdp-${a.gdp.id}`, level: "warn",
      text: `GDP ${row.arr} ${a.gdp.start_time}-${a.gdp.end_time}Z, AAR ${a.gdp.aar}${a.gdp.avg_delay_min ? `, avg delay ${a.gdp.avg_delay_min} min` : ""}` });
  }
  if (a && a.program && a.program.over_capacity && !row.on) {
    out.push({ key: `tmi-aar-${row.arr}`, level: "warn",
      text: `${row.arr} over capacity: ${a.program.demand_60min} inbound next hour vs AAR ${a.program.aar}` });
  }
  return out;
}

/** What set the EDCT: the GDP, or the FCA(s) with an EDCT. */
export function edctReason(adv) {
  const bits = [];
  if (adv.gdp && adv.gdp.edct) bits.push(`GDP ${adv.gdp.airport}`);
  for (const f of adv.fcas || []) if (f.edct) bits.push(`FCA ${f.fca_name}`);
  if (!bits.length && adv.rate_program && adv.rate_program.cfr) bits.push(`${adv.rate_program.airport} metering`);
  return bits.join(", ") || "TMI";
}

/**
 * Ground flights worth an automatic advisory lookup: bound for an airport with a
 * GDP, ground stop or rate program, soonest STD first, at most AUTO_ADVISORY_MAX.
 */
export function autoAdvisoryTargets(index, rows, max = AUTO_ADVISORY_MAX) {
  if (!index) return [];
  return rows
    .filter(r => r.connected && onGround(r) && index.byAirport.has(String(r.arr || "").toUpperCase()))
    .sort((a, b) => (a.std ?? 9e15) - (b.std ?? 9e15))
    .slice(0, max)
    .map(r => r.callsign);
}

/**
 * The TMI telex for a flight, from its advisory (and the board for a ground stop).
 * Ground stop > EDCT > rate-program delay > "no TMI".
 */
export function composeTmiTelex(prefix, row, adv, index) {
  const a = index && index.byAirport.get(String(row.arr || "").toUpperCase());
  const gs = (adv && adv.ground_stop) || (a && a.groundStop);
  if (gs && (!row || !row.off)) {
    return `${prefix} GROUND STOP ${gs.airport}${gs.until ? ` UNTIL ${gs.until}Z` : ""}. HOLD AT GATE, EXPECT UPDATE.`;
  }
  const edct = adv && adv.found ? ms(adv.edct) : null;
  if (edct) {
    const cta = adv.gdp && ms(adv.gdp.cta);
    return `${prefix} EDCT ${zulu(edct)} (${edctReason(adv).toUpperCase()}${adv.total_delay_min ? ` +${adv.total_delay_min} MIN` : ""}).` +
      (cta ? ` CTA ${zulu(cta)}.` : "") + " PLAN PUSH ACCORDINGLY.";
  }
  const rp = adv && adv.rate_program;
  if (rp && rp.delay_min > 0) {
    return `${prefix} EXPECT ARRIVAL DELAY ${rp.airport} ~${rp.delay_min} MIN (AAR ${rp.aar}).` + (rp.sta ? ` STA ${zulu(ms(rp.sta))}.` : "");
  }
  return `${prefix} NO TMI AFFECTING ${row.callsign}.`;
}

/* ---------------- demo ---------------- */

const iso = t => new Date(t).toISOString();

/**
 * A board for demo mode, from the demo's own flights: a GDP at the busiest
 * destination, a ground stop at the second, a rate program at the third.
 */
export function demoBoard(rows, now = Date.now()) {
  const counts = new Map();
  for (const r of rows) if (r.arr) counts.set(r.arr, (counts.get(r.arr) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const hhmm = t => zulu(t).slice(0, 4);
  const board = { ground_stops: [], gdps: [], restrictions: [], programs: [], as_of: iso(now) };
  if (top[0]) {
    board.gdps.push({ id: "demo-gdp", airport: top[0], aar: 36, scope: "", start_time: hhmm(now - 36e5), end_time: hhmm(now + 3 * 36e5),
      max_enroute_min: null, exempt_airborne: true, controlled: 14, avg_delay_min: 22, max_delay_min: 48, demand_60min: 44, over_capacity: true });
    board.restrictions.push({ id: "demo-r1", requesting: "ZFW", providing: "ZME", restriction: `${faa(top[0])} VIA ALL 20MIT`, decoded: null, start_time: iso(now - 36e5), stop_time: null });
  }
  if (top[1]) board.ground_stops.push({ id: "demo-gs", airport: top[1], scope: "", until: hhmm(now + 45 * 60000) });
  if (top[2]) board.programs.push({ icao: top[2], aar: 30, trail: 0, mit: 0, gates: [], exclude_wake: [], exclude_types: [], jets_only: false,
    active_until: null, demand_60min: 38, over_capacity: true });
  return board;
}

/** A demo advisory for a flight, consistent with demoBoard. */
export function demoAdvisory(row, board, now = Date.now()) {
  if (!row) return { found: false };
  const adv = { callsign: row.callsign, found: true, dep: row.dep, arr: row.arr, aircraft_type: row.type,
    status: row.off && !row.on ? "airborne" : "ground", gdp: null, ground_stop: null, rate_program: null, fcas: [], total_delay_min: 0, edct: null };
  const gdp = (board.gdps || []).find(g => g.airport === row.arr);
  if (gdp && onGround(row)) {
    const delay = 10 + (row.callsign.charCodeAt(row.callsign.length - 1) % 30);
    const edct = Math.max(now + 5 * 60000, (row.std || now) + delay * 60000);
    adv.gdp = { airport: gdp.airport, aar: gdp.aar, start_time: gdp.start_time, end_time: gdp.end_time, controlled: true,
      edct: iso(edct), cta: iso(edct + ((row.eet || 90) * 60000)), delay_min: delay };
    adv.total_delay_min = delay;
    adv.edct = iso(edct);
  }
  const gs = (board.ground_stops || []).find(s => s.airport === row.arr);
  if (gs) adv.ground_stop = { airport: gs.airport, scope: gs.scope, until: gs.until };
  const prog = (board.programs || []).find(p => p.icao === row.arr);
  if (prog && !row.on) {
    const d = 6 + (row.callsign.length % 9);
    adv.rate_program = { airport: prog.icao, aar: prog.aar, delay_min: d, sta: row.eta ? iso(row.eta + d * 60000) : null, cfr: null };
    adv.total_delay_min = Math.max(adv.total_delay_min, d);
  }
  return adv;
}
