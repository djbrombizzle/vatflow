/**
 * Departure clearance (DCL) composition and FAA Coded Departure Route lookup
 * for vUSAlink.
 *
 * DOM-free on purpose: the classic board and the EDST render these very
 * differently, so this module returns plain data and the caller does the markup.
 *
 * The clearance goes out as ONE multi-element CPDLC uplink (RA=WU) rather than
 * a queue of elements, joined with the ' @_@ ' separator that clients render as
 * a line break on the DCDU. That keeps a full clearance clear of the 5-element
 * uplink queue cap and lets the pilot answer WILCO/UNABLE as for any clearance.
 */

/** Hoppie packet budget. Matches the maxlength on the free-text reply inputs. */
export const CLNC_MAX = 220;

/** Element separator; clients render it as a line break. */
export const ELEMENT_SEP = " @_@ ";

/** Characters the +LOAD NEW RTE TO XXXX+ element costs, for budget hints. */
export const LOAD_LINE_COST = "+LOAD NEW RTE TO KMCO+".length + ELEMENT_SEP.length;

function pad3(n) {
  return ("000" + Math.round(Math.abs(n))).slice(-3);
}

function norm(s) {
  return (s || "").trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Parse a controller-typed altitude into a flight level.
 * Accepts 350, FL350 and 35000. Returns null when it cannot be read.
 */
export function parseLevel(s) {
  const t = (s || "").replace(/[,\s]/g, "").toUpperCase();
  if (!t) return null;
  if (t.startsWith("FL")) {
    const fl = parseInt(t.slice(2), 10) || 0;
    return fl ? fl : null;
  }
  const n = parseInt(t, 10) || 0;
  if (!n) return null;
  if (n >= 1000) return Math.round(n / 100);
  if (n <= 600) return n;
  return null;
}

/** Three-digit level for the EXP element: 350, FL350 and 35000 all give "350". */
export function expectLevel(s) {
  const fl = parseLevel(s);
  return fl == null ? norm(s) : pad3(fl);
}

/**
 * Drop the implied origin and destination from a filed route string, leaving
 * the portion that belongs in a clearance.
 */
export function stripRouteEnds(route, dep, arr) {
  const t = norm(route).split(" ").filter(Boolean);
  if (dep && t[0] === dep.toUpperCase()) t.shift();
  if (arr && t[t.length - 1] === arr.toUpperCase()) t.pop();
  return t.join(" ");
}

/**
 * Compose a departure clearance.
 *
 * fields: {dest, route, climb, expect, depFreq, squawk}
 * opts:   {asFiled, loadLine}
 *
 * Returns {label, msg, effects, elements} or null when there is no destination.
 */
export function buildClearance(fields, opts) {
  const f = fields || {};
  const o = opts || {};
  const dest = norm(f.dest);
  if (!dest) return null;

  const route = norm(f.route);
  const climb = norm(f.climb);
  const expect = norm(f.expect);
  const depFreq = norm(f.depFreq);
  const squawk = norm(f.squawk);

  const elements = [`CLEARED TO THE @${dest}@ ARPT`];
  if (route) elements.push(`@${route}@` + (o.asFiled ? " THEN AS FILED" : ""));
  else if (o.asFiled) elements.push("AS FILED");
  if (climb) elements.push(climb);
  if (expect) elements.push(`EXP @${expectLevel(expect)}@ 10 MIN AFT DP`);
  if (depFreq) elements.push(`DPFRQ @${depFreq}@`);
  if (squawk) elements.push(`SQUAWK @${squawk}@`);
  if (o.loadLine) elements.push(`+LOAD NEW RTE TO ${dest}+`);

  return {
    label: "CLNC",
    msg: elements.join(ELEMENT_SEP),
    // One uplink carries both a route and a beacon code.
    effects: { type: "dcl", code: squawk },
    elements,
  };
}

/** The message as the DCDU shows it: markers stripped, one element per line. */
export function previewLines(msg) {
  return (msg || "").split(ELEMENT_SEP).map((s) => s.replace(/@/g, ""));
}

/**
 * Budget check for a composed clearance.
 * Returns {ok, length, over, hint}.
 */
export function checkLength(msg, opts) {
  const length = (msg || "").length;
  const over = length - CLNC_MAX;
  if (over <= 0) return { ok: true, length, over: 0, hint: "" };
  const hint = (opts && opts.loadLine)
    ? `turn off +LOAD NEW RTE+ (frees ${LOAD_LINE_COST}) or shorten the route`
    : "shorten the route";
  return { ok: false, length, over, hint };
}

/**
 * Lazy loader for the sharded CDR database in data/cdr.
 *
 * base:  directory URL, e.g. '../data/cdr/'
 * fetchImpl: injectable for tests.
 */
export function createCdrStore({ base, fetchImpl } = {}) {
  const dir = base || "../data/cdr/";
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let index = null;
  const shards = new Map(); // origin ICAO -> shard | null

  async function loadIndex() {
    if (index) return index;
    try {
      const r = await doFetch(dir + "index.json");
      if (r.ok) index = await r.json();
    } catch (e) { /* offline: CDR lookup just stays unavailable */ }
    return index;
  }

  async function loadOrigin(orig) {
    const key = (orig || "").trim().toUpperCase();
    if (!key) return null;
    if (shards.has(key)) return shards.get(key);
    let shard = null;
    try {
      const r = await doFetch(dir + key + ".json");
      if (r.ok) shard = await r.json();
    } catch (e) { /* leave null */ }
    shards.set(key, shard);
    return shard;
  }

  function row(orig, dest, r) {
    return { code: r[0], orig, dest, depFix: r[1], route: r[2], eq: r[3], coordReq: r[4], play: r[5] };
  }

  /**
   * Resolve an 8-character RCode. The prefix maps 1:1 to an origin, but the
   * last two characters repeat across destinations within that origin, so the
   * shard is scanned for the full code.
   */
  async function lookup(code) {
    const c = (code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(c)) return null;
    const idx = await loadIndex();
    if (!idx || !idx.prefix) return null;
    const orig = idx.prefix[c.slice(0, 3)];
    if (!orig) return null;
    const shard = await loadOrigin(orig);
    if (!shard) return null;
    for (const dest of Object.keys(shard)) {
      const hit = shard[dest].find((r) => r[0] === c);
      if (hit) return row(orig, dest, hit);
    }
    return null;
  }

  async function forPair(orig, dest) {
    const o = (orig || "").trim().toUpperCase();
    const d = (dest || "").trim().toUpperCase();
    const shard = await loadOrigin(o);
    if (!shard || !d || !shard[d]) return [];
    return shard[d].map((r) => row(o, d, r));
  }

  return { loadIndex, loadOrigin, lookup, forPair };
}

/**
 * Human-readable summary of a CDR, split so the caller can style the warnings.
 * Returns {text, warn}.
 */
export function describeCdr(c) {
  if (!c) return { text: "", warn: "" };
  const bits = [`${c.orig}→${c.dest}`];
  if (c.depFix) bits.push("DEP FIX " + c.depFix);
  if (c.eq) bits.push("NAV EQP " + c.eq);
  const warn = [];
  if ((c.coordReq || "").toUpperCase() === "Y") warn.push("COORD REQ");
  if (c.play) warn.push(c.play);
  return { text: bits.join(" · "), warn: warn.join(" · ") };
}
