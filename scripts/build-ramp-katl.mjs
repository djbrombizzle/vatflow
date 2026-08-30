#!/usr/bin/env node
/**
 * Generate the KATL ramp surface as a schematic.
 *
 * ATL's terminal complex is regular enough to draw from a table: seven parallel
 * north-south concourses (T, A, B, C, D, E, F) running west to east, gates on
 * the west and east face of each, with a ramp control alley between every pair.
 * That makes a clean computer-generated chart without tracing anyone's artwork
 * and without waiting on OSM coverage.
 *
 * Gate inventory, ramp areas, frequencies and hold spots are transcribed from
 * the published ATL ramp chart. Positions are schematic: correct in ordering,
 * side, spacing and ramp ownership, approximate in absolute metres. Run
 * build-ramp-airport.mjs over OSM when survey-accurate geometry matters.
 *
 * Usage: node scripts/build-ramp-katl.mjs
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { synthStandPoly } from "../shared/ramp-airport.js";
import { FIELDS } from "../shared/ramp-app-fields.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data", "ramp");

/* ---------------------------------------------------------------- layout --- */

const SPACING = 300;      // metres between concourse centrelines
const HALF_WIDTH = 18;    // concourse building half-width
const GATE_PITCH = 52;    // along-concourse spacing between gates

/**
 * Gates as they appear on the chart, north to south, per face.
 * Even numbers sit on the west face and odd on the east, with the exceptions
 * the chart actually shows (E14/E16/E18 east, the A-suffix stands).
 */
const CONCOURSES = {
  T: {
    x: -1500, length: 1000,
    west: ["T21", "T20", "T19", "T18", "T17", "T16", "T15", "T14", "T13", "T12", "T11", "T10",
           "T9", "T8", "T7", "T6", "T5", "T4", "T3", "T2", "T2A", "T1", "T1A"],
    east: [],
  },
  A: {
    x: -1200, length: 950,
    west: ["A34", "A32", "A30", "A28", "A26", "A24", "A20", "A18", "A16", "A12", "A10", "A6", "A4", "A2"],
    east: ["A33", "A31", "A29", "A27", "A25", "A21", "A19", "A17", "A15", "A11", "A9", "A7", "A5", "A3", "A1"],
  },
  B: {
    x: -900, length: 980,
    west: ["B36", "B34", "B32", "B30", "B28", "B26", "B24", "B22", "B20", "B18", "B16", "B14", "B12", "B10", "B6", "B4", "B2"],
    east: ["B33", "B31", "B29", "B27", "B25", "B23", "B21", "B19", "B17", "B15", "B13", "B11", "B9", "B7", "B5", "B3", "B1"],
  },
  C: {
    x: -600, length: 980,
    west: ["C52", "C50", "C46", "C42", "C40", "C36", "C34", "C30", "C22", "C20", "C16", "C14", "C12", "C10", "C6", "C4", "C2"],
    east: ["C55", "C49", "C47", "C43", "C41", "C37", "C35", "C33", "C21", "C17", "C15", "C13", "C9", "C7", "C5", "C3", "C1"],
  },
  D: {
    x: -300, length: 980,
    west: ["D46", "D44", "D42", "D40", "D40A", "D38", "D36", "D30", "D28", "D26",
           "D18", "D16", "D12", "D10", "D8A", "D8", "D6", "D4", "D2"],
    east: ["D41", "D39", "D35", "D33", "D31", "D25", "D23", "D21",
           "D17", "D15", "D9A", "D9", "D7", "D5", "D3", "D1", "D1A"],
  },
  E: {
    x: 0, length: 950,
    west: ["E36", "E34", "E32", "E30", "E28", "E26", "E12", "E10", "E8", "E6", "E4", "E2"],
    east: ["E37", "E35", "E33A", "E33", "E31", "E29", "E27A", "E27", "E14", "E16", "E18",
           "E15", "E17", "E11", "E9", "E7", "E5", "E3A", "E3", "E1"],
  },
  F: {
    x: 430, length: 620, yShift: -170,
    west: ["F14", "F12A", "F12", "F10", "F8", "F6", "F4", "F2"],
    east: ["F9", "F7", "F5", "F3A", "F3", "F1"],
  },
};

/** Ramp control areas, with the faces each one owns. From the ATL ramp chart. */
const RAMPS = [
  { id: "R1", label: "Ramp 1", freq: "131.45",  owns: [["T", "west"], ["T", "east"], ["A", "west"]], alley: ["T", "A"] },
  { id: "R2", label: "Ramp 2", freq: "131.85",  owns: [["A", "east"], ["B", "west"]], alley: ["A", "B"] },
  { id: "R3", label: "Ramp 3", freq: "129.275", owns: [["B", "east"], ["C", "west"]], alley: ["B", "C"] },
  { id: "R4", label: "Ramp 4", freq: "130.075", owns: [["C", "east"], ["D", "west"]], alley: ["C", "D"] },
  { id: "R5", label: "Ramp 5", freq: "129.375", owns: [["D", "east"], ["E", "west"]], alley: ["D", "E"] },
  { id: "R6", label: "Ramp 6", freq: "131.375", owns: [["E", "east"]], alley: ["E", null],
    note: "International. 129.25 during deice operations." },
  { id: "R8", label: "Ramp 8", freq: "128.975", owns: [["F", "west"]], alley: [null, "F"] },
  { id: "R9", label: "Ramp 9", freq: "131.875", owns: [["F", "east"]], alley: ["F", null] },
];

/** Ramp hold spots, as the diamonds and boxed labels on the chart. */
const SPOTS = [
  ["1N", "T", "A", "N"], ["1S", "T", "A", "S"],
  ["2N", "A", "B", "N"], ["2S", "A", "B", "S"],
  ["3N", "B", "C", "N"], ["3S", "B", "C", "S"],
  ["4N", "C", "D", "N"], ["4S", "C", "D", "S"],
  ["5N", "D", "E", "N"], ["5S", "D", "E", "S"],
];

/** Which stands take a widebody. Concourse E and F are the international piers. */
function sizeFor(concourse, id) {
  if (concourse === "F") return "E";
  if (concourse === "E") return /^E(2[6-9]|3\d|1[46 8])/.test(id) ? "E" : "D";
  if (concourse === "D") return "C";
  return "C";
}

/* ------------------------------------------------------------ the field --- */

/**
 * The five parallel runways, two north of the terminal complex and three south.
 * Lengths are the published ones; positions are schematic but keep the real
 * spacing, stagger and the eastward offset of 10/28.
 */
const RUNWAYS = [
  { id: "08L/26R", cy: 1750,  x0: -2350, len: 2743, ends: ["08L", "26R"] },
  { id: "08R/26L", cy: 1080,  x0: -2500, len: 3048, ends: ["08R", "26L"] },
  { id: "09L/27R", cy: -1150, x0: -2750, len: 3776, ends: ["09L", "27R"] },
  { id: "09R/27L", cy: -1720, x0: -2350, len: 2743, ends: ["09R", "27L"] },
  { id: "10/28",   cy: -2500, x0: -1500, len: 2743, ends: ["10", "28"] },
].map(r => ({
  id: r.id,
  ends: r.ends,
  width: 46,
  line: [[r.x0, r.cy], [r.x0 + r.len, r.cy]],
}));

/** Parallel and connecting taxiways around the field. */
const FIELD_TAXIWAYS = [
  { ref: "N", line: [[-2400, 1560], [2400, 1560]], width: 30 },
  { ref: "M", line: [[-2450, 1330], [2450, 1330]], width: 30 },
  { ref: "D", line: [[-2500, 830], [2450, 830]], width: 30 },
  { ref: "S", line: [[-2700, -900], [2700, -900]], width: 30 },
  { ref: "R", line: [[-2700, -1400], [2700, -1400]], width: 30 },
  { ref: "V", line: [[-2300, -2000], [2300, -2000]], width: 30 },
  { ref: "W", line: [[-1450, -2280], [1250, -2280]], width: 30 },
];
// Cross-field connectors between the terminal complex and each runway pair.
for (const x of [-2200, -1700, -1150, -600, 0, 600, 1150]) {
  FIELD_TAXIWAYS.push({ ref: "", line: [[x, 1560], [x, 640]], width: 26 });
  FIELD_TAXIWAYS.push({ ref: "", line: [[x, -640], [x, -1400]], width: 26 });
}

/** Cargo, maintenance and general aviation aprons around the perimeter. */
const FIELD_APRONS = [
  { poly: [[-2500, 1500], [-1750, 1500], [-1750, 900], [-2500, 900]], label: "NORTH CARGO" },
  { poly: [[1250, 1450], [2100, 1450], [2100, 800], [1250, 800]], label: "MAINTENANCE" },
  { poly: [[-2600, -950], [-1800, -950], [-1800, -1350], [-2600, -1350]], label: "SOUTH CARGO" },
  { poly: [[900, -950], [1900, -950], [1900, -1350], [900, -1350]], label: "SOUTH CARGO EAST" },
  { poly: [[-1500, -2050], [-800, -2050], [-800, -2400], [-1500, -2400]], label: "GA / FBO" },
];

/* ----------------------------------------------------------------- build --- */

const stands = [];
const rampOf = new Map();
for (const r of RAMPS) {
  for (const [c, face] of r.owns) rampOf.set(c + "|" + face, r.id);
}

for (const [code, def] of Object.entries(CONCOURSES)) {
  const yShift = def.yShift || 0;
  for (const face of ["west", "east"]) {
    const list = def[face];
    if (!list || !list.length) continue;
    const span = Math.min(def.length, (list.length - 1) * GATE_PITCH);
    const top = yShift + span / 2;
    list.forEach((id, i) => {
      const y = top - (list.length === 1 ? 0 : (span / (list.length - 1)) * i);
      // Nose sits at the building edge; the aircraft faces the concourse.
      const x = face === "west" ? def.x - HALF_WIDTH : def.x + HALF_WIDTH;
      const hdg = face === "west" ? 90 : 270;
      const sizeCode = sizeFor(code, id);
      stands.push({
        id,
        point: [x, Math.round(y * 10) / 10],
        hdg,
        sizeCode,
        poly: synthStandPoly([x, y], hdg, sizeCode).map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
        operators: [],
        opsType: "airline",
        concourse: code,
        face: face === "west" ? "W" : "E",
        ramp: rampOf.get(code + "|" + face) || null,
        intl: code === "E" || code === "F",
      });
    });
  }
}

/** Concourse buildings, drawn as terminal polygons. */
const buildings = Object.entries(CONCOURSES).map(([code, def]) => {
  const yShift = def.yShift || 0;
  const half = def.length / 2;
  return {
    kind: "terminal",
    label: code === "E" ? "INTERNATIONAL CONCOURSE E" : "CONCOURSE " + code,
    labelAt: [def.x, yShift],
    poly: [
      [def.x - HALF_WIDTH, yShift + half],
      [def.x + HALF_WIDTH, yShift + half],
      [def.x + HALF_WIDTH, yShift - half],
      [def.x - HALF_WIDTH, yShift - half],
    ],
  };
});

/** Apron fill under the whole complex. */
const aprons = [
  { poly: [[-1700, 640], [700, 640], [700, -640], [-1700, -640]], label: "TERMINAL RAMP" },
  ...FIELD_APRONS,
];

/** Taxiways E and F north of the complex, L to the south, plus the alley lanes. */
const taxiways = [
  { ref: "E", line: [[-1750, 600], [780, 600]], width: 30 },
  { ref: "F", line: [[-1750, 520], [780, 520]], width: 30 },
  { ref: "L", line: [[-1750, -580], [780, -580]], width: 30 },
];
const alleyLanes = [];
for (const r of RAMPS) {
  const [a, b] = r.alley;
  if (!a || !b) continue;
  const cxa = CONCOURSES[a].x;
  const cxb = CONCOURSES[b].x;
  const mid = (cxa + cxb) / 2;
  for (const [dx, side] of [[-40, "WEST"], [40, "EAST"]]) {
    alleyLanes.push({ ref: side, line: [[mid + dx, 520], [mid + dx, -580]], width: 23 });
  }
}
taxiways.push(...alleyLanes, ...FIELD_TAXIWAYS);

/** Ramp areas — one polygon per alley, for the ramp label and the my-ramp dim. */
const areas = RAMPS.filter(r => r.alley[0] && r.alley[1]).map(r => {
  const cxa = CONCOURSES[r.alley[0]].x;
  const cxb = CONCOURSES[r.alley[1]].x;
  return {
    id: r.id,
    kind: "ramp",
    label: `${r.label}  ${r.freq}`,
    labelAt: [(cxa + cxb) / 2, 0],
    poly: [[cxa + HALF_WIDTH, 500], [cxb - HALF_WIDTH, 500], [cxb - HALF_WIDTH, -520], [cxa + HALF_WIDTH, -520]],
  };
});

/** The non-movement boundary east of the international concourse. */
areas.push({
  id: "NONMOVEMENT",
  kind: "nonmovement",
  poly: [[190, 470], [260, 300], [260, -420], [190, -560]],
});

/** Hold spots at each end of every alley. */
const spots = SPOTS.map(([id, a, b, end]) => {
  const mid = (CONCOURSES[a].x + CONCOURSES[b].x) / 2;
  const y = end === "N" ? 470 : -520;
  return { id, point: [mid, y], side: end === "N" ? "north" : "south" };
});
spots.push(
  { id: "6N", point: [150, 250], side: "north" },
  { id: "6E", point: [150, -60], side: "east" },
  { id: "6S", point: [150, -400], side: "south" },
  { id: "8W", point: [300, -330], side: "west" },
  { id: "8S", point: [300, -520], side: "south" },
  { id: "9S", point: [560, -520], side: "south" },
);

/* --------------------------------------------------------------- assemble --- */

const overridePath = join(OUT_DIR, "overrides", "KATL.json");
const overrides = existsSync(overridePath) ? JSON.parse(readFileSync(overridePath, "utf8")) : {};

const model = {
  icao: "KATL",
  name: FIELDS.KATL.name,
  ref: FIELDS.KATL.ref,
  elevFt: FIELDS.KATL.elevFt,
  builtAt: new Date().toISOString(),
  source: "schematic",
  attribution: "Schematic layout generated from the published ATL ramp chart — not survey accurate",
  runways: RUNWAYS,
  taxiways,
  aprons,
  buildings,
  stands,
  ramps: RAMPS.map(r => ({ id: r.id, label: r.label, freq: r.freq, note: r.note || null, concourses: [] })),
  concourses: overrides.concourses || {},
  operatorBlocks: overrides.operatorBlocks || {},
  spots,
  areas,
};

model.coverage = {
  stands: stands.length,
  runways: model.runways.length,
  taxiways: taxiways.length,
  noSize: 0,
  noPoly: 0,
  noOperators: stands.length,
  noRamp: stands.filter(s => !s.ramp).length,
  noConcourse: stands.filter(s => !s.concourse).length,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "KATL.json"), JSON.stringify(model));

console.log(`KATL schematic: ${stands.length} stands, ${taxiways.length} taxiways, ` +
  `${model.runways.length} runways, ${spots.length} hold spots`);
for (const r of RAMPS) {
  const n = stands.filter(s => s.ramp === r.id).length;
  console.log(`  ${r.id.padEnd(3)} ${r.label.padEnd(8)} ${String(r.freq).padEnd(8)} ${n} stands`);
}
if (model.coverage.noRamp) console.warn(`  ${model.coverage.noRamp} stands with no ramp`);
