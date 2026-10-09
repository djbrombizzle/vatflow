/**
 * MIT Monitor — watch an Airport TMU program's arrival gates from the FCA Builder.
 *
 * Programs (AAR, MIT, per-gate rules, exclusions) come from the shared hub that
 * the Airport TMU page syncs to. The gate / MIT math mirrors the "MIT per gate"
 * card in vatflow-tbfm v2.html (arrivalGate, calcGateMit, programGateMitNm,
 * gateMitAction) so both pages give the same numbers.
 */

export const MIT_NOMINAL_KT = 360;     // 6 nm/min — typical descending arrival speed
export const GATE_MIT_STEP_NM = 5;
export const GATE_MIT_MAX_NM = 300;
export const GATE_PALETTE = ["#54b8e8", "#57d98a", "#f5a83d", "#c792ea", "#f07178", "#ffd166", "#4dd0c8", "#ff8fab"];
export const NO_GATE = "—";
const HORIZON_MS = 3600000;            // demand window: next 60 minutes
const SPACING_RANGE_NM = 300;          // only check in-trail spacing inside this range

const toRad = d => d * Math.PI / 180;
function gcNm(a, b, c, d) {
  const R = 3440.065;
  const dLat = toRad(c - a), dLon = toRad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* ---------------- programs from the hub ---------------- */

function normList(v, re) {
  const arr = Array.isArray(v) ? v : String(v || "").split(/[,\s]+/);
  return arr.map(x => String(x).trim().toUpperCase()).filter(x => re.test(x));
}
export function normRate(o) {
  o = o || {};
  return {
    aar: +o.aar || 0, trail: +o.trail || 0, mit: +o.mit || 0,
    gates: (Array.isArray(o.gates) ? o.gates : [])
      .filter(g => g && g.name)
      .map(g => ({ name: gateKey(g.name), trail: +g.trail || 0, mit: +g.mit || 0 })),
    expect: (Array.isArray(o.expect) ? o.expect : [])
      .filter(x => x && x.gate && +x.rate > 0)
      .map(x => ({ gate: gateKey(x.gate), rate: Math.min(200, Math.round(+x.rate)) })),
    excludeWake: normList(o.excludeWake, /^[LMHJ]$/),
    excludeTypes: normList(o.excludeTypes, /^[A-Z0-9]{2,4}$/),
    includeTypes: normList(o.includeTypes, /^[A-Z0-9]{2,4}$/),
    jetsOnly: !!o.jetsOnly,
    unknownInclude: o.unknownInclude !== false,
  };
}
/** Hub "rates" map → { ICAO: program } (programs with no AAR are dropped). */
export function normPrograms(wire) {
  const out = {};
  for (const k in (wire || {})) {
    const r = normRate(wire[k]);
    if (r.aar > 0) out[String(k).toUpperCase()] = r;
  }
  return out;
}

/* ---------------- aircraft filters (same as Airport TMU) ---------------- */

const AIRCRAFT_ENGINE = {
  A10:"jet",A124:"jet",A19N:"jet",A20N:"jet",A21N:"jet",A306:"jet",A310:"jet",A318:"jet",A319:"jet",A320:"jet",A321:"jet",A332:"jet",A333:"jet",A339:"jet",A343:"jet",A359:"jet",A388:"jet",
  AT43:"turboprop",AT45:"turboprop",AT46:"turboprop",AT72:"turboprop",AT75:"turboprop",AT76:"turboprop",
  B712:"jet",B722:"jet",B732:"jet",B733:"jet",B734:"jet",B735:"jet",B736:"jet",B737:"jet",B738:"jet",B739:"jet",
  B742:"jet",B744:"jet",B748:"jet",B752:"jet",B753:"jet",B762:"jet",B763:"jet",B764:"jet",B772:"jet",B773:"jet",B77L:"jet",B77W:"jet",B788:"jet",B789:"jet",B78X:"jet",
  BE20:"turboprop",BE36:"piston",BE58:"piston",BE99:"turboprop",C152:"piston",C172:"piston",C182:"piston",C208:"turboprop",C25A:"jet",C25B:"jet",C510:"jet",C550:"jet",C56X:"jet",C680:"jet",C700:"jet",C750:"jet",
  CL30:"jet",CL35:"jet",CL60:"jet",CRJ2:"jet",CRJ7:"jet",CRJ9:"jet",CRJX:"jet",
  DA20:"piston",DA40:"piston",DA42:"piston",DC10:"jet",DC93:"jet",DH8A:"turboprop",DH8B:"turboprop",DH8C:"turboprop",DH8D:"turboprop",
  E110:"turboprop",E120:"turboprop",E135:"jet",E145:"jet",E170:"jet",E175:"jet",E190:"jet",E195:"jet",E290:"jet",E295:"jet",E35L:"jet",E50P:"turboprop",E55P:"jet",E75L:"jet",E75S:"jet",
  F16:"jet",F18:"jet",FA7X:"jet",FA8X:"jet",GALX:"jet",GLF4:"jet",GLF5:"jet",GLF6:"jet",
  H25B:"jet",HDJT:"jet",IL76:"jet",LJ35:"jet",LJ45:"jet",LJ60:"jet",MD11:"jet",
  PA28:"piston",PA31:"turboprop",PA34:"piston",PA44:"piston",PA46:"piston",PC12:"turboprop",PC24:"jet",
  RJ85:"jet",SB20:"turboprop",SF34:"turboprop",SF50:"jet",SR22:"piston",TBM9:"turboprop",
};
/** Wake category from a VATSIM flight plan ("H/B744/L" style aircraft field). */
export function wakeFromFp(fp) {
  const w = (((fp && fp.aircraft) || "").split("/")[0] || "").toUpperCase();
  return /^[LMHJ]$/.test(w) ? w : "";
}
function baseType(type) { return String(type || "").split("/")[0].toUpperCase(); }
export function isExcludedFromProgram(f, rate) {
  if (!rate) return false;
  const type = baseType(f.type);
  if (f.wake && rate.excludeWake.includes(f.wake)) return true;
  if (rate.excludeTypes.length && rate.excludeTypes.includes(type)) return true;
  if (rate.includeTypes.length && !rate.includeTypes.includes(type)) return true;
  if (rate.jetsOnly) {
    const eng = AIRCRAFT_ENGINE[type] || null;
    if (eng === "piston") return true;
    if (!eng && f.wake === "L") return true;
    if (!eng && !rate.unknownInclude) return true;
  }
  return false;
}

/* ---------------- gates and MIT ---------------- */

/** Gate key: a STAR without its revision (OZZZI1 / OZZZI2 → OZZZI), else the fix as written. */
export function gateKey(name) {
  const s = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = s.match(/^([A-Z]{3,5})\d[A-Z]?$/);
  return m ? m[1] : s;
}

/** Arrival gate = last STAR (as its gate key) or fix in the filed route (same rule as Airport TMU). */
export function arrivalGate(route, arr) {
  if (!route) return NO_GATE;
  const toks = route.toUpperCase().split(/\s+/).map(t => t.split("/")[0].replace(/[^A-Z0-9]/g, ""));
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (!t || t === "DCT" || t === arr) continue;
    if (/^[A-Z]{5}$/.test(t)) return t;
    if (/^[A-Z]{3}$/.test(t)) return t;
    if (/^[A-Z]{3,5}\d[A-Z]?$/.test(t)) return gateKey(t);
  }
  return NO_GATE;
}

/** MIT per gate that holds the airport to its AAR (max-min fair split of the AAR). */
export function calcGateMit(aar, gateDemand, unassignedDemand, kt) {
  const speed = kt || MIT_NOMINAL_KT;
  const demand = gateDemand.reduce((n, [, d]) => n + d, 0) + (unassignedDemand || 0);
  const over = demand > aar;
  let cap = Math.max(0, aar - (unassignedDemand || 0));
  const order = gateDemand.map(([gate, d]) => ({ gate, demand: d })).sort((x, y) => x.demand - y.demand);
  let left = order.length;
  for (const r of order) {
    const fair = cap / left;
    r.slice = Math.min(r.demand, fair);
    cap -= r.slice; left--;
  }
  const rows = gateDemand.map(([gate]) => {
    const r = order.find(x => x.gate === gate);
    const limited = over && r.demand > r.slice + 1e-9;
    let mit = 0;
    if (limited) {
      mit = r.slice > 0
        ? Math.ceil(speed / r.slice / GATE_MIT_STEP_NM) * GATE_MIT_STEP_NM
        : GATE_MIT_MAX_NM;
      mit = Math.min(GATE_MIT_MAX_NM, Math.max(GATE_MIT_STEP_NM, mit));
    }
    return { gate, demand: r.demand, share: demand ? r.demand / demand : 0, slice: r.slice, limited, mit };
  });
  return { demand, over, rows };
}

/**
 * Arrival demand as a rolling 60-minute window across a longer lookahead, so the
 * busiest hour drives the rate instead of just the next 60 minutes.
 *   flights   [{ eta, gate }] metered arrivals still inbound (gate NO_GATE when unknown)
 *   now       ms
 *   horizonMin  how far ahead to look (window end), default 180
 *   stepMin   how often a window starts, default 15
 *   windowMin window length, default 60
 *   expect    { gateKey: expected/hr } from the program; each gate takes the higher
 *             of its live count and this, per window
 * Returns { windows: [{ start, end, total, entries, unassigned, expected }], peak }
 * where entries is [[gate, n]] busiest first, expected lists gates the prediction
 * won, and peak is the index of the busiest window (earliest on a tie).
 */
export function rollingGateDemand({ flights = [], now = Date.now(), horizonMin = 180, stepMin = 15, windowMin = 60, expect = {} } = {}) {
  const winMs = windowMin * 60000;
  const lastStart = Math.max(0, horizonMin - windowMin);
  const windows = [];
  for (let off = 0; off <= lastStart; off += stepMin) {
    const start = now + off * 60000, end = start + winMs;
    const gates = {};
    let unassigned = 0;
    for (const f of flights) {
      if (!(f.eta < end) || (off > 0 && f.eta < start)) continue;   // the first window also takes anyone overdue
      if (!f.gate || f.gate === NO_GATE) unassigned++;
      else gates[f.gate] = (gates[f.gate] || 0) + 1;
    }
    const expected = [];
    for (const g in expect) if (expect[g] > (gates[g] || 0)) { gates[g] = expect[g]; expected.push(g); }
    const entries = Object.entries(gates).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    const total = entries.reduce((n, [, d]) => n + d, 0) + unassigned;
    windows.push({ start, end, offsetMin: off, total, entries, unassigned, expected });
  }
  let peak = 0;
  windows.forEach((w, i) => { if (w.total > windows[peak].total) peak = i; });
  return { windows, peak };
}

/**
 * MIT each gate needs in every rolling window, so a restriction can be passed to
 * the adjacent facility before it is needed.
 *   windows  rollingGateDemand(...).windows
 * Returns [{ gate, mits: [nm per window, 0 = none], first, peakMit, peakIdx }]
 * where first is the index of the first window needing MIT (-1 never). Sorted
 * soonest first, then by the tightest MIT.
 */
export function gateMitTimeline(windows, aar, kt) {
  const byGate = new Map();
  windows.forEach((w, i) => {
    const calc = calcGateMit(aar, w.entries, w.unassigned, kt);
    for (const r of calc.rows) {
      if (!byGate.has(r.gate)) byGate.set(r.gate, { gate: r.gate, mits: windows.map(() => 0), first: -1, peakMit: 0, peakIdx: -1 });
      const g = byGate.get(r.gate);
      g.mits[i] = r.limited ? r.mit : 0;
      if (r.limited && g.first < 0) g.first = i;
      if (r.limited && r.mit > g.peakMit) { g.peakMit = r.mit; g.peakIdx = i; }
    }
  });
  const rank = g => (g.first < 0 ? Infinity : g.first);
  return [...byGate.values()].sort((a, b) => rank(a) - rank(b) || b.peakMit - a.peakMit || a.gate.localeCompare(b.gate));
}

/** MIT (nm) the program holds a gate to now: its gate rule, else the airport-wide MIT/trail. */
export function programGateMitNm(prog, gate) {
  const rule = (prog.gates || []).find(x => x.name && gateKey(x.name) === gateKey(gate));
  const src = rule && (rule.mit > 0 || rule.trail > 0) ? rule : prog;
  if (src.mit > 0) return { nm: src.mit, gateRule: src === rule };
  if (src.trail > 0) return { nm: Math.round(src.trail * MIT_NOMINAL_KT / 60), gateRule: src === rule };
  return { nm: 0, gateRule: false };
}

/** Tighten / relax / hold, with a 5 nm dead band. */
export function gateMitAction(recNm, nowNm) {
  if (recNm === nowNm) return { kind: "hold", txt: "Hold" };
  if (!recNm) return { kind: "relax", txt: "Remove MIT" };
  if (recNm > nowNm) return { kind: "tighten", txt: "Tighten to " + recNm };
  if (nowNm - recNm >= GATE_MIT_STEP_NM) return { kind: "relax", txt: "Relax to " + recNm };
  return { kind: "hold", txt: "Hold" };
}

/* ---------------- the monitor ---------------- */

/**
 * Build the monitor view for one programmed airport.
 *   airport   ICAO
 *   aptLL     [lat, lon] of the airport
 *   prog      normalized program (normRate)
 *   pilots    connected aircraft { callsign, lat, lon, gs, alt, phase, dep, arr, type, wake, tas, route }
 *   prefiles  prefiled plans (same shape, no position)
 *   airportLL icao → [lat, lon] | null (for ground / prefile ETAs)
 */
export function buildMitMonitor({ airport, aptLL, prog, pilots = [], prefiles = [], airportLL = () => null, now = Date.now() }) {
  const flights = [];
  const seen = new Set();
  const add = (p, connected) => {
    if ((p.arr || "").toUpperCase() !== airport || seen.has(p.callsign)) return;
    seen.add(p.callsign);
    const gate = arrivalGate(p.route, airport);
    const excluded = isExcludedFromProgram(p, prog);
    let status, dist = null, eta = null;
    const hasPos = connected && p.lat != null && p.lon != null;
    if (hasPos && aptLL) dist = gcNm(p.lat, p.lon, aptLL[0], aptLL[1]);
    const airborne = hasPos && p.phase !== "gnd" && (p.gs || 0) > 60;
    if (hasPos && !airborne && dist != null && dist < 5) {
      status = "ARRIVED";
    } else if (airborne && dist != null) {
      const gs = Math.max(p.gs || 0, 120);
      const pad = dist > 40 ? 4 : dist > 15 ? 2 : 0;
      eta = now + (dist / gs) * 3600000 + pad * 60000;
      status = "AIRBORNE";
    } else {
      const depLL = airportLL(p.dep);
      const routeNm = depLL && aptLL ? gcNm(depLL[0], depLL[1], aptLL[0], aptLL[1]) * 1.12 : 300;
      const tas = p.tas > 80 ? p.tas : 420;
      eta = now + (routeNm / tas) * 3600000 + 14 * 60000;    // assume departs now
      status = connected ? "GROUND" : "PREFILE";
    }
    flights.push({ callsign: p.callsign, type: baseType(p.type), dep: p.dep, gate, excluded, status, dist, eta,
      lat: hasPos ? p.lat : null, lon: hasPos ? p.lon : null, alt: p.alt || 0, gs: p.gs || 0, hdg: p.hdg || 0 });
  };
  pilots.forEach(p => add(p, true));
  prefiles.forEach(p => add(p, false));

  const horizon = now + HORIZON_MS;
  const counts = {};
  let unassigned = 0;
  for (const f of flights) {
    if (f.status === "ARRIVED" || f.excluded || f.eta == null || f.eta >= horizon) continue;
    if (f.gate === NO_GATE) unassigned++;
    else counts[f.gate] = (counts[f.gate] || 0) + 1;
  }
  // the program's expected demand (a controller's event prediction) wins where it is higher
  const demand = { ...counts };
  const expected = new Set();
  for (const x of prog.expect || []) {
    if (x.rate > (demand[x.gate] || 0)) { demand[x.gate] = x.rate; expected.add(x.gate); }
  }
  const entries = Object.entries(demand).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const calc = calcGateMit(prog.aar, entries, unassigned, MIT_NOMINAL_KT);

  // every gate with an inbound (not only next-hour demand) plus gates the program names
  const gateNames = new Set(flights.filter(f => f.gate !== NO_GATE && f.status !== "ARRIVED").map(f => f.gate));
  (prog.gates || []).forEach(g => gateNames.add(g.name));
  expected.forEach(g => gateNames.add(g));
  const order = [...gateNames].sort((a, b) => (demand[b] || 0) - (demand[a] || 0) || a.localeCompare(b));

  const gates = order.map((name, i) => {
    const row = calc.rows.find(r => r.gate === name);
    const req = programGateMitNm(prog, name);
    const recNm = row && row.limited ? row.mit : 0;
    const inbound = flights.filter(f => f.gate === name && f.status !== "ARRIVED");
    const spacing = gateSpacing(inbound.filter(f => !f.excluded), req.nm || recNm);
    return {
      name,
      color: GATE_PALETTE[i % GATE_PALETTE.length],
      demand60: counts[name] || 0,
      expected: expected.has(name) ? demand[name] : 0,
      slice: row ? row.slice : 0,
      limited: !!(row && row.limited),
      recMit: recNm,
      reqMit: req.nm,
      reqGateRule: req.gateRule,
      ratePerHrAtReq: req.nm ? MIT_NOMINAL_KT / req.nm : null,
      action: gateMitAction(recNm, req.nm),
      inbound: inbound.length,
      airborne: inbound.filter(f => f.status === "AIRBORNE").length,
      spacing,
      tight: spacing.filter(s => s.tight).length,
    };
  });
  const colors = {};
  gates.forEach(g => { colors[g.name] = g.color; });
  return { airport, prog, flights, gates, colors, demand: calc.demand, over: calc.over, unassigned, now };
}

/**
 * In-trail spacing on one gate: airborne inbounds within range, sorted by
 * distance to the airport; gap = difference in distance-to-go from the
 * aircraft ahead. tight = gap below the MIT in force (or recommended).
 */
export function gateSpacing(inbound, mitNm) {
  const air = inbound
    .filter(f => f.status === "AIRBORNE" && f.dist != null && f.dist <= SPACING_RANGE_NM)
    .sort((a, b) => a.dist - b.dist);
  return air.map((f, i) => {
    const ahead = i ? air[i - 1] : null;
    const gap = ahead ? f.dist - ahead.dist : null;
    return { callsign: f.callsign, ahead: ahead ? ahead.callsign : null, dist: f.dist, gap,
      tight: !!(mitNm && gap != null && gap < mitNm - 0.5) };
  });
}
