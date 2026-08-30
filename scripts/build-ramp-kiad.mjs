#!/usr/bin/env node
/**
 * Generate the KIAD ramp surface as a schematic.
 *
 * Dulles is two long east-west midfield concourse buildings — B/A to the north,
 * D/C to the south — with the Main Terminal's Z gates above them and the R Ramp
 * hardstands below. Gates sit on the north and south face of each building.
 *
 * Gate inventory, ramp areas, frequencies and taxilane grouping are transcribed
 * from the published IAD ramp chart. Positions are schematic: correct in
 * ordering, face, spacing and ramp ownership, approximate in absolute metres.
 * Run build-ramp-airport.mjs over OSM when survey-accurate geometry matters.
 *
 * Usage: node scripts/build-ramp-kiad.mjs
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { synthStandPoly, fitStandBoxes } from "../shared/ramp-airport.js";
import { FIELDS } from "../shared/ramp-app-fields.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data", "ramp");

const HALF_HEIGHT = 16;   // concourse building half-depth
const GATE_PITCH = 48;

/**
 * Concourse buildings, west to east within each row.
 *
 * `north` and `south` are the gates on each face, listed west to east as the
 * chart prints them. The ramp that owns a face comes from the taxilane it sits
 * on, not from the concourse — see RAMPS below.
 */
const BUILDINGS = {
  Z: {
    label: "MAIN TERMINAL", y: 1050, x0: -520, x1: 520,
    north: [],
    south: ["Z14", "Z12", "Z10", "Z9", "Z7", "Z6"],
  },
  B: {
    label: "B CONCOURSE", y: 430, x0: -1480, x1: -190,
    north: ["B79", "B75", "B73", "B71", "B67", "B65", "B63", "B51", "B49", "B47", "B45", "B43", "B41", "B37"],
    south: ["B78", "B76", "B74", "B72", "B70", "B66", "B64", "B62", "B50", "B48", "B44", "B42", "B40", "B38"],
  },
  A: {
    label: "A CONCOURSE", y: 430, x0: -150, x1: 1320,
    north: ["A31", "A25", "A23", "A19", "A15",
            "A5D", "A5C", "A5B", "A5A", "A3C", "A3B", "A3A", "A1D", "A1C", "A1B", "A1A", "A1G"],
    south: ["A32", "A26", "A24", "A22", "A20", "A16", "A14",
            "A6C", "A6B", "A6E", "A6A", "A4F", "A4E", "A4C", "A4B", "A4A", "A2F", "A2E", "A2C", "A2B", "A2A", "A2G"],
  },
  D: {
    label: "D CONCOURSE", y: -320, x0: -1480, x1: -190,
    north: ["D29A", "D29", "D27", "D25", "D23", "D21", "D19", "D15", "D11A", "D11", "D9", "D7", "D5", "D3", "D1"],
    south: ["D32B", "D32A", "D32", "D30B", "D30A", "D30", "D26", "D24", "D20", "D18", "D16", "D14", "D12", "D10", "D8", "D6", "D4", "D2"],
  },
  C: {
    label: "C CONCOURSE", y: -320, x0: -150, x1: 1320,
    north: ["C27A", "C27", "C25", "C23", "C19", "C17", "C11W", "C11", "C9", "C7", "C5", "C3", "C1"],
    south: ["C28", "C26", "C24", "C22", "C20", "C18", "C14", "C12", "C10", "C8", "C6", "C4", "C2"],
  },
};

/** R Ramp hardstands, south of the midfield. Two rows, as the chart draws them. */
const R_RAMP = {
  north: ["R28", "R26", "R24", "R22", "R16", "R14", "R12"],
  south: ["R19", "R17", "R15", "R13", "R11", "R9", "R7", "R5", "R3"],
  yNorth: -1020,
  ySouth: -1240,
  x0: -1100,
  x1: 500,
};

/**
 * Ramp control areas, from the chart. Each owns the faces that sit on its
 * taxilanes, so the boundary runs down the alley rather than around a concourse
 * — the same pattern as ATL.
 */
const RAMPS = [
  {
    id: "RN", label: "North Area Ramp", freq: "119.12", lanes: "Taxilanes A & B",
    owns: [["Z", "south"], ["B", "north"], ["A", "north"]],
    labelAt: [-1000, 720],
  },
  {
    id: "RM", label: "Midfield Area Ramp", freq: "129.55", lanes: "Taxilanes C & D",
    owns: [["B", "south"], ["A", "south"], ["D", "north"], ["C", "north"]],
    labelAt: [-1000, 60],
  },
  {
    id: "RS", label: "South Area Ramp", freq: "130.55", lanes: "Taxilanes E & F",
    owns: [["D", "south"], ["C", "south"], ["R", "north"], ["R", "south"]],
    labelAt: [-1000, -700],
  },
];

/** Taxilanes, north to south, as lettered on the chart. */
const TAXILANES = [
  { ref: "A", y: 1320 }, { ref: "B", y: 760 },
  { ref: "C", y: 150 }, { ref: "D", y: -60 },
  { ref: "E", y: -700 }, { ref: "F", y: -1420 },
];

/** Widebody-capable faces. The international gates are on A and D. */
function sizeFor(concourse, id, index) {
  // The commuter gates are A1A..A6E — one digit then a letter. A14 and A31 are
  // mainline stands and must not be caught by the same test.
  if (/^A\d[A-Z]$/.test(id)) return "B";
  if (concourse === "A" || concourse === "D") return index % 3 === 0 ? "E" : "D";
  if (concourse === "C") return index % 4 === 0 ? "E" : "C";
  if (concourse === "R") return "D";
  if (concourse === "Z") return "C";
  return index % 4 === 1 ? "D" : "C";
}

/* ----------------------------------------------------------------- build --- */

const stands = [];
const rampOf = new Map();
for (const r of RAMPS) for (const [b, face] of r.owns) rampOf.set(b + "|" + face, r.id);

function addRow(code, list, y, face, x0, x1) {
  if (!list || !list.length) return;
  const span = Math.min(x1 - x0, (list.length - 1) * GATE_PITCH);
  const start = (x0 + x1) / 2 - span / 2;
  list.forEach((id, i) => {
    const x = list.length === 1 ? start : start + (span / (list.length - 1)) * i;
    // Nose at the building edge; the aircraft faces the concourse.
    const hdg = face === "north" ? 180 : 0;
    const sizeCode = sizeFor(code, id, i);
    stands.push({
      id,
      point: [Math.round(x * 10) / 10, y],
      hdg,
      sizeCode,
      poly: synthStandPoly([x, y], hdg, sizeCode),
      operators: [],
      opsType: code === "R" ? "remote" : "airline",
      concourse: code,
      face: face === "north" ? "N" : "S",
      ramp: rampOf.get(code + "|" + face) || null,
      intl: code === "A" || code === "D",
      remote: code === "R" || undefined,
    });
  });
}

for (const [code, b] of Object.entries(BUILDINGS)) {
  addRow(code, b.north, b.y + HALF_HEIGHT, "north", b.x0, b.x1);
  addRow(code, b.south, b.y - HALF_HEIGHT, "south", b.x0, b.x1);
}
addRow("R", R_RAMP.north, R_RAMP.yNorth, "north", R_RAMP.x0, R_RAMP.x1);
addRow("R", R_RAMP.south, R_RAMP.ySouth, "south", R_RAMP.x0, R_RAMP.x1);

fitStandBoxes(stands);
stands.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

const buildings = Object.entries(BUILDINGS).map(([code, b]) => ({
  kind: "terminal",
  label: b.label,
  labelAt: [(b.x0 + b.x1) / 2, b.y],
  poly: [
    [b.x0, b.y + HALF_HEIGHT], [b.x1, b.y + HALF_HEIGHT],
    [b.x1, b.y - HALF_HEIGHT], [b.x0, b.y - HALF_HEIGHT],
  ],
}));

const aprons = [
  { poly: [[-1600, 1250], [1450, 1250], [1450, -800], [-1600, -800]], label: "MIDFIELD RAMPS" },
  { poly: [[-1200, -900], [700, -900], [700, -1350], [-1200, -1350]], label: "R RAMP" },
];

const taxiways = TAXILANES.map(t => ({ ref: t.ref, line: [[-1700, t.y], [1500, t.y]], width: 26 }));
// Cross links between the lanes, west and east of each building.
for (const x of [-1600, -180, 1400]) {
  taxiways.push({ ref: "", line: [[x, 1320], [x, -1420]], width: 24 });
}

/**
 * Runways. IAD's three north-south parallels plus the diagonal. Positions are
 * schematic; the designators are not.
 */
const runways = [
  { id: "01L/19R", ends: ["01L", "19R"], line: [[-2900, -1900], [-2900, 1600]], width: 46 },
  { id: "01C/19C", ends: ["01C", "19C"], line: [[2450, -1900], [2450, 1600]], width: 46 },
  { id: "01R/19L", ends: ["01R", "19L"], line: [[3300, -1900], [3300, 1600]], width: 46 },
  // 12/30 sits in the northwest corner, clear of the terminal complex.
  { id: "12/30", ends: ["12", "30"], line: [[-2500, 3300], [-800, 2100]], width: 46 },
];

const areas = RAMPS.map(r => ({
  id: r.id,
  kind: "ramp",
  label: `${r.label}  ${r.freq}`,
  labelAt: r.labelAt,
  poly: null,
})).map(a => ({ ...a, poly: undefined }));

const overridePath = join(OUT_DIR, "overrides", "KIAD.json");
const overrides = existsSync(overridePath) ? JSON.parse(readFileSync(overridePath, "utf8")) : {};

const model = {
  icao: "KIAD",
  name: FIELDS.KIAD.name,
  ref: FIELDS.KIAD.ref,
  elevFt: FIELDS.KIAD.elevFt,
  builtAt: new Date().toISOString(),
  source: "schematic",
  attribution: "Schematic layout generated from the published IAD ramp chart — not survey accurate",
  runways,
  taxiways,
  aprons,
  buildings,
  stands,
  ramps: RAMPS.map(r => ({ id: r.id, label: r.label, freq: r.freq, lanes: r.lanes, concourses: [] })),
  concourses: overrides.concourses || {},
  operatorBlocks: overrides.operatorBlocks || {},
  spots: [],
  areas: areas.filter(a => a.label),
};

model.coverage = {
  stands: stands.length,
  runways: runways.length,
  taxiways: taxiways.length,
  noSize: 0,
  noPoly: 0,
  noOperators: stands.length,
  noRamp: stands.filter(s => !s.ramp).length,
  noConcourse: stands.filter(s => !s.concourse).length,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "KIAD.json"), JSON.stringify(model));

console.log(`KIAD schematic: ${stands.length} stands, ${taxiways.length} taxiways, ${runways.length} runways`);
for (const r of RAMPS) {
  const n = stands.filter(s => s.ramp === r.id).length;
  console.log(`  ${r.id.padEnd(3)} ${r.label.padEnd(20)} ${r.freq.padEnd(8)} ${String(n).padStart(3)} stands  (${r.lanes})`);
}
for (const c of Object.keys(BUILDINGS).concat("R")) {
  console.log(`  concourse ${c.padEnd(2)} ${stands.filter(s => s.concourse === c).length} stands`);
}
if (model.coverage.noRamp) console.warn(`  ${model.coverage.noRamp} stands with no ramp`);
