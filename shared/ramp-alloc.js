/**
 * RampView — stand assignment.
 *
 * A constrained, seeded random draw: filter to the stands that airline actually
 * uses and that are open, free and size-compatible, then draw one with a
 * generator seeded on the callsign. Same flight, same day, same stand — on every
 * client, across reloads, and in playback. Never Math.random().
 */

import { sizeFits, minCodeForWake, SIZE_CODES } from "./ramp-airport.js";

/** FNV-1a, 32-bit. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, well-distributed seeded PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable seed for one flight on one day. */
export function seedFor(callsign, nowMs) {
  const day = new Date(nowMs || Date.now()).toISOString().slice(0, 10);
  return hashString(String(callsign).toUpperCase() + "|" + day);
}

/** ICAO airline code from a callsign, or "" for a registration. */
export function operatorOf(callsign) {
  const m = /^([A-Z]{3})\d/.exec(String(callsign || "").toUpperCase());
  return m ? m[1] : "";
}

/**
 * Resolve an operator's block, following `inherits` (regionals sit in their
 * mainline's block) and falling back to the wildcard entries.
 * @returns {{concourses: string[], prefer: string[], opsType: string|null, gateRanges: string[]}}
 */
export function resolveBlock(operator, blocks, opts = {}) {
  const table = blocks || {};
  const wildcard = opts.intl ? (table["*_INTL"] || table["*"]) : table["*"];
  let entry = table[operator] || wildcard || null;
  const prefer = [];
  const seen = new Set();
  while (entry && entry.inherits && !seen.has(entry.inherits)) {
    seen.add(entry.inherits);
    if (entry.prefer) prefer.push(...entry.prefer);
    entry = table[entry.inherits];
  }
  if (!entry) return { concourses: [], prefer, opsType: null, gateRanges: [] };
  if (entry.prefer) prefer.push(...entry.prefer);
  const concourses = [
    ...(entry.concourses || []),
    ...(opts.intl ? entry.intl || [] : []),
  ].map(c => String(c).toUpperCase());
  return {
    concourses,
    prefer: prefer.map(c => String(c).toUpperCase()),
    opsType: entry.opsType || null,
    gateRanges: entry.gateRanges || [],
  };
}

/** "C1-C22" -> predicate over stand ids. */
function inGateRanges(standId, ranges) {
  if (!ranges || !ranges.length) return true;
  const m = /^([A-Z]+)(\d+)/.exec(standId);
  if (!m) return false;
  const [, prefix, numRaw] = m;
  const num = parseInt(numRaw, 10);
  return ranges.some(r => {
    const rm = /^([A-Z]+)(\d+)\s*-\s*([A-Z]+)?(\d+)$/.exec(String(r).toUpperCase());
    if (!rm) return String(r).toUpperCase() === standId;
    return rm[1] === prefix && num >= parseInt(rm[2], 10) && num <= parseInt(rm[4], 10);
  });
}

/**
 * Hard constraints. A stand is a candidate only when every one holds.
 * @param {object} stand
 * @param {object} flight { callsign, sizeCode, intl, opsType }
 * @param {object} ctx { block, occupancy, closures, reservations, nowMs, etaMs, turnMs }
 */
export function isCandidate(stand, flight, ctx) {
  if (ctx.closures && ctx.closures.has(stand.id)) return false;
  if (ctx.occupancy && ctx.occupancy.has(stand.id)) return false;
  if (ctx.blocked && ctx.blocked.has(stand.id)) return false;

  const resv = ctx.reservations && ctx.reservations.get(stand.id);
  if (resv && resv.callsign !== flight.callsign) return false;

  if (!sizeFits(stand.sizeCode, flight.sizeCode)) return false;
  if (flight.intl && stand.intl === false) return false;

  const block = ctx.block || { concourses: [], gateRanges: [], opsType: null };
  if (block.opsType) {
    if ((stand.opsType || "airline") !== block.opsType) return false;
    return true;
  }
  if (block.anyStand) return true;

  // Cargo pads, remote hardstands and GA parking are not ordinary gates: they
  // are only drawn when a block asks for that ops type by name.
  if ((stand.opsType || "airline") !== "airline") return false;

  const op = operatorOf(flight.callsign);
  if (stand.operators && stand.operators.length) {
    // A stand tagged for particular airlines belongs to them.
    if (!op || !stand.operators.includes(op)) return false;
    return true;
  }
  const c = String(stand.concourse || "").toUpperCase();
  if (block.concourses.length && !block.concourses.includes(c)) return false;
  if (!inGateRanges(stand.id, block.gateRanges)) return false;
  return true;
}

/**
 * Draw weight. Randomness is the point — this only stops the silly outcomes
 * (an E175 taking a widebody stand while narrowbody stands sit open) and lets
 * learned priors nudge the odds. It never collapses the draw to one answer.
 */
export function weightFor(stand, flight, ctx) {
  let w = 1;
  const need = SIZE_CODES.indexOf(flight.sizeCode);
  const have = SIZE_CODES.indexOf(stand.sizeCode);
  if (need >= 0 && have >= 0) w *= 1 / (1 + Math.max(0, have - need));
  if (stand.operators && stand.operators.includes(operatorOf(flight.callsign))) w *= 3;
  const block = ctx.block;
  if (block && block.prefer && block.prefer.includes(String(stand.concourse || "").toUpperCase())) w *= 2;
  const prior = ctx.priors && ctx.priors[stand.id];
  if (prior && prior.n >= 20) w *= 1 + 2 * prior.p;
  return w;
}

/** Weighted draw from `items` using `rng` in [0,1). */
export function weightedDraw(items, weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!items.length || total <= 0) return null;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Assign a stand to one inbound.
 *
 * Widening order when the airline's own block is full: their other listed
 * concourses, then common-use stands of the right size, then UNASSIGNED.
 * Never into another airline's block.
 *
 * @returns {{ standId: string|null, source: string, confidence: string }}
 */
export function assignStand(flight, stands, ctx) {
  const operator = operatorOf(flight.callsign);
  const block = resolveBlock(operator, ctx.operatorBlocks, { intl: flight.intl });
  const rng = mulberry32(seedFor(flight.callsign, ctx.nowMs));

  // Widening must never reach into another airline's block, so "common use"
  // means a concourse no other operator claims — not "anywhere with a gap".
  const common = commonConcourses(ctx.operatorBlocks, operator);
  // An airline nobody has mapped gets a random open gate rather than nothing:
  // for a first version a plausible gate beats UNASSIGNED, and the ramp still
  // follows from wherever the draw lands. Airlines that DO have a block keep
  // the strict behaviour — their traffic never wanders into someone else's.
  const known = !!(ctx.operatorBlocks && ctx.operatorBlocks[operator]);
  if (!known && !block.concourses.length && !block.opsType) {
    const anyCtx = { ...ctx, block: { concourses: [], prefer: [], opsType: null, gateRanges: [] } };
    const open = stands.filter(s => isCandidate(s, flight, anyCtx));
    const pick = weightedDraw(open, open.map(s => weightFor(s, flight, anyCtx)), rng);
    return pick
      ? { standId: pick.id, source: "rule-any", confidence: "low" }
      : { standId: null, source: "unassigned", confidence: "none" };
  }

  const tiers = [
    { block, source: "rule" },
    { block: { ...block, gateRanges: [] }, source: "rule-widened" },
  ];
  // Only offer the common-use tier when common-use stands actually exist. An
  // empty concourse list means "unconstrained" elsewhere, which is right for a
  // field with no block map at all but would be a leak here.
  if (common.length) {
    tiers.push({
      block: { concourses: common, prefer: block.prefer, opsType: block.opsType, gateRanges: [] },
      source: "rule-common",
    });
  }

  for (const tier of tiers) {
    const tctx = { ...ctx, block: tier.block };
    const cands = stands.filter(s => isCandidate(s, flight, tctx));
    if (!cands.length) continue;
    const weights = cands.map(s => weightFor(s, flight, tctx));
    const pick = weightedDraw(cands, weights, rng);
    if (pick) {
      return {
        standId: pick.id,
        source: tier.source,
        confidence: tier.source === "rule" ? "medium" : "low",
      };
    }
  }
  return { standId: null, source: "unassigned", confidence: "none" };
}

/**
 * Concourses that no operator other than `operator` claims. These are the only
 * stands the draw may widen onto once an airline's own block is full.
 */
export function commonConcourses(blocks, operator) {
  const claimed = new Set();
  for (const [code, entry] of Object.entries(blocks || {})) {
    if (code === operator || code.startsWith("*")) continue;
    for (const c of entry.concourses || []) claimed.add(String(c).toUpperCase());
    for (const c of entry.intl || []) claimed.add(String(c).toUpperCase());
  }
  const all = new Set();
  for (const entry of Object.values(blocks || {})) {
    for (const c of entry.concourses || []) all.add(String(c).toUpperCase());
    for (const c of entry.intl || []) all.add(String(c).toUpperCase());
  }
  return [...all].filter(c => !claimed.has(c));
}

/** ICAO code letter an aircraft type needs, from the type code or wake. */
export function sizeCodeForType(type, wake) {
  const t = String(type || "").toUpperCase();
  if (/^(A388|B748|B744|A124|A225)/.test(t)) return "F";
  if (/^(B77|B78|A33|A34|A35|B76|MD11|B74|A30)/.test(t)) return "E";
  if (/^(B75|A32|A31|B73|B738|B739|MD8|MD9|E19|A20N|A21N|BCS)/.test(t)) return "C";
  if (/^(CRJ|E17|E14|E13|DH8|AT7|SF3|E75)/.test(t)) return "B";
  return minCodeForWake(wake);
}
