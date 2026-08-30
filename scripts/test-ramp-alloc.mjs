#!/usr/bin/env node
/**
 * RampView assignment: the draw is constrained, seeded and spread.
 * Usage: node scripts/test-ramp-alloc.mjs
 */
import { assignStand, resolveBlock, operatorOf, sizeCodeForType, mulberry32, seedFor } from "../shared/ramp-alloc.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}

const BLOCKS = {
  DAL: { concourses: ["T", "A", "B", "C", "D"], intl: ["E", "F"] },
  EDV: { inherits: "DAL", prefer: ["C", "D"] },
  SWA: { concourses: ["C"], gateRanges: ["C1-C22"] },
  AAL: { concourses: ["T"] },
  FDX: { opsType: "cargo" },
  "*": { concourses: ["T"] },
};

function stands() {
  const out = [];
  const push = (prefix, n, size, opts = {}) => {
    for (let i = 1; i <= n; i++) {
      out.push({ id: prefix + i, concourse: prefix, sizeCode: size, operators: [], opsType: "airline", ...opts });
    }
  };
  push("T", 12, "C");
  push("C", 30, "C");
  push("D", 20, "E");
  push("F", 8, "E", { intl: true });
  out.push({ id: "CARGO1", concourse: "CARGO", sizeCode: "E", operators: [], opsType: "cargo" });
  return out;
}

const baseCtx = () => ({
  operatorBlocks: BLOCKS,
  occupancy: new Set(),
  closures: new Set(),
  blocked: new Set(),
  reservations: new Map(),
  nowMs: Date.UTC(2026, 7, 30, 12, 0, 0),
});

/* operator parsing + block inheritance */
assert(operatorOf("DAL1438") === "DAL", "operator from callsign");
assert(operatorOf("N670DN") === "", "registration has no operator");
assert(resolveBlock("EDV", BLOCKS).concourses.includes("B"), "regional inherits mainline block");
assert(resolveBlock("EDV", BLOCKS).prefer.join() === "C,D", "regional keeps its own preference");
assert(resolveBlock("DAL", BLOCKS, { intl: true }).concourses.includes("F"), "intl adds the intl concourses");
assert(resolveBlock("XYZ", BLOCKS).concourses.join() === "T", "unlisted carrier falls back to the wildcard");

/* the draw stays inside the airline's block */
const swaPicks = new Set();
for (let i = 0; i < 200; i++) {
  const r = assignStand({ callsign: "SWA" + (1000 + i), sizeCode: "C" }, stands(), baseCtx());
  assert(r.standId && r.standId.startsWith("C"), "SWA drawn onto concourse C");
  assert(parseInt(r.standId.slice(1), 10) <= 22, "SWA stays inside C1-C22");
  swaPicks.add(r.standId);
}
assert(swaPicks.size >= 18, "the draw spreads across the block, not the first few stands (" + swaPicks.size + ")");

/* determinism */
const a = assignStand({ callsign: "DAL1438", sizeCode: "C" }, stands(), baseCtx());
const b = assignStand({ callsign: "DAL1438", sizeCode: "C" }, stands(), baseCtx());
assert(a.standId === b.standId, "same flight, same day, same stand");
const other = assignStand({ callsign: "DAL1439", sizeCode: "C" }, stands(), baseCtx());
assert(other.standId !== null, "a different flight still gets a stand");

/* occupancy and closure are respected */
const ctxFull = baseCtx();
ctxFull.occupancy = new Set(stands().filter(s => s.concourse === "T").map(s => s.id));
const aal = assignStand({ callsign: "AAL1567", sizeCode: "C" }, stands(), ctxFull);
assert(aal.standId === null || !aal.standId.startsWith("T"), "occupied stands are never drawn");
assert(aal.source !== "rule" || aal.standId === null, "a full block widens or goes unassigned");

/* never into another airline's block */
const ctxT = baseCtx();
ctxT.occupancy = new Set(stands().filter(s => s.concourse === "T").map(s => s.id));
let leaked = 0;
for (let i = 0; i < 50; i++) {
  const r = assignStand({ callsign: "AAL" + (100 + i), sizeCode: "C" }, stands(), ctxT);
  if (r.standId && !r.standId.startsWith("T")) leaked++;
}
assert(leaked === 0, "AAL with T full never lands on Southwest's or Delta's stands");

/* size compatibility */
const heavy = assignStand({ callsign: "DAL200", sizeCode: "E" }, stands(), baseCtx());
assert(heavy.standId === null || ["D", "F"].includes(heavy.standId[0]), "a heavy only takes a code-E stand");

/* cargo ops type */
const cargo = assignStand({ callsign: "FDX1234", sizeCode: "E" }, stands(), baseCtx());
assert(cargo.standId === "CARGO1", "cargo goes to a cargo stand");

/* size code mapping */
assert(sizeCodeForType("B738") === "C", "737 is code C");
assert(sizeCodeForType("B77W") === "E", "777 is code E");
assert(sizeCodeForType("CRJ9") === "B", "CRJ is code B");
assert(sizeCodeForType("A388") === "F", "A380 is code F");

/* the PRNG itself */
const rng = mulberry32(seedFor("DAL1438", Date.UTC(2026, 7, 30)));
const vals = Array.from({ length: 1000 }, () => rng());
assert(vals.every(v => v >= 0 && v < 1), "PRNG stays in range");
const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
assert(Math.abs(mean - 0.5) < 0.05, "PRNG is roughly uniform");

console.log(`ramp-alloc: ${passed} assertions passed`);

/* an airline with no block at all: a random open gate, not UNASSIGNED */
const NO_WILDCARD = { DAL: BLOCKS.DAL, SWA: BLOCKS.SWA, AAL: BLOCKS.AAL, FDX: BLOCKS.FDX };
const openCtx = () => ({ ...baseCtx(), operatorBlocks: NO_WILDCARD });
const spread = new Set();
for (let i = 0; i < 120; i++) {
  const r = assignStand({ callsign: "GLO" + (100 + i), sizeCode: "C" }, stands(), openCtx());
  assert(r.standId, "an unmapped airline still gets a gate");
  assert(r.source === "rule-any", "from the unlisted-carrier draw");
  spread.add(r.standId[0]);
}
assert(spread.size >= 2, "the unlisted draw is not pinned to one concourse");

/* but a mapped airline is still held to its block even when it is full */
const fullT = openCtx();
fullT.occupancy = new Set(stands().filter(s => s.concourse === "T").map(s => s.id));
for (let i = 0; i < 30; i++) {
  const r = assignStand({ callsign: "AAL" + (200 + i), sizeCode: "C" }, stands(), fullT);
  assert(!r.standId || r.standId.startsWith("T"), "a mapped airline never spills into another block");
}

/* an authored wildcard still wins over the unlisted-carrier draw */
const withWildcard = baseCtx();
const wild = assignStand({ callsign: "GLO500", sizeCode: "C" }, stands(), withWildcard);
assert(wild.standId.startsWith("T") && wild.source === "rule", "an authored wildcard block is honoured");

/* stands tagged for one airline are not handed to another */
const tagged = stands().map(s => (s.id === "C5" ? { ...s, operators: ["SWA"] } : s));
for (let i = 0; i < 60; i++) {
  const r = assignStand({ callsign: "GLO" + (700 + i), sizeCode: "C" }, tagged, openCtx());
  assert(r.standId !== "C5", "an unlisted carrier does not take a stand tagged for someone else");
}

console.log(`ramp-alloc unlisted-carrier rules: ${passed} assertions passed in total`);
