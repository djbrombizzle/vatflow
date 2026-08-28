/**
 * ERAM Trainer — load/import packs, generate traffic, VATSIM snapshots, grade MCA commands.
 */
import {
  parseMcaCommand,
  buildMcaUplinkEntry,
  formatMcaAccept,
  formatMcaReject,
} from "./edst-mca-commands.js";
import { AIRPORT_ARTCC, primaryAirportArtcc } from "./artcc-access.js";
import { fetchArtccBoundaries, pointInArtcc } from "./artcc-scope.js";
import { fpFields, parseAlt } from "./fca-metering.js";

export const VATSIM_DATA_URL = "https://data.vatsim.net/v3/vatsim-data.json";
export const LS_LAST_PACK = "eramTrainer.lastPack.v1";

export const DEFAULT_SETTINGS = {
  aircraftCount: 12,
  artcc: "ZDC",
  depAirports: [],
  arrAirports: [],
  altMin: 180,
  altMax: 400,
  phaseEnroute: 70,
  phaseDep: 15,
  phaseArr: 15,
  routeStyle: "nav",
  scenarioMix: ["alt", "direct", "hdg", "spd"],
  scenarioCount: 25,
};

const AIRLINE_PREFIXES = ["AAL", "UAL", "DAL", "SWA", "JBU", "FFT", "NKS", "RPA", "ASH", "ENY", "AAY", "FDX", "UPS"];
const TYPES = ["B738", "B739", "A320", "A321", "B752", "E170", "E175", "CRJ7", "B763"];

const ZDC_FIXES = ["BAL", "TIMMY", "GANDY", "MERIT", "LURAY", "RBV", "FILPZ", "SCOOB", "TRSTN", "HYPER"];

function rand(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

function randInt(min, max) {
  return min + ((Math.random() * (max - min + 1)) | 0);
}

function airportsForArtcc(artcc) {
  const art = String(artcc || "ZDC").toUpperCase();
  const out = [];
  for (const [icao, owner] of Object.entries(AIRPORT_ARTCC)) {
    if (owner === art) out.push(icao);
  }
  return out.sort();
}

function normalizeCommand(str) {
  return String(str || "").toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * @param {unknown} json
 * @returns {{ ok: true, pack: object } | { ok: false, errors: string[] }}
 */
export function validatePack(json) {
  const errors = [];
  if (!json || typeof json !== "object") {
    return { ok: false, errors: ["Pack must be a JSON object."] };
  }
  if (!json.artcc) errors.push("Missing required field: artcc");
  if (!Array.isArray(json.aircraft) || !json.aircraft.length) {
    errors.push("Pack must include a non-empty aircraft array.");
  } else {
    json.aircraft.forEach((ac, i) => {
      if (!ac || !ac.cs) errors.push(`aircraft[${i}] missing callsign (cs).`);
    });
  }
  if (!Array.isArray(json.scenarios)) {
    errors.push("Pack must include a scenarios array (may be empty if auto-generated).");
  } else {
    json.scenarios.forEach((sc, i) => {
      if (!sc || !sc.instruction) errors.push(`scenarios[${i}] missing instruction.`);
      if (!sc || !sc.aircraft) errors.push(`scenarios[${i}] missing aircraft reference.`);
      if (!sc || !sc.expect) errors.push(`scenarios[${i}] missing expect block.`);
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, pack: json };
}

export async function loadTrainerPack(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load pack (${res.status})`);
  const json = await res.json();
  const v = validatePack(json);
  if (!v.ok) throw new Error(v.errors.join(" "));
  return v.pack;
}

export function importPackJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: ["Invalid JSON: " + (e.message || "parse error")] };
  }
  return validatePack(json);
}

export function readPackFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsText(file);
  });
}

export async function importPackFile(file) {
  const text = await readPackFile(file);
  const v = importPackJson(text);
  if (!v.ok) return v;
  return { ok: true, pack: v.pack };
}

export function exportPack(pack) {
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const name = `eram-trainer-${(pack.artcc || "pack").toLowerCase()}-${Date.now()}.json`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function randomCallsign() {
  return rand(AIRLINE_PREFIXES) + randInt(100, 9999);
}

function routeBetween(dep, arr, fixes, style) {
  if (style === "dct") return `${dep} DCT ${arr}`;
  const mid = fixes.length ? rand(fixes) : "DCT";
  return `${dep} ${mid} ${arr}`;
}

/**
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {{ fixes?: string[] }} [opts]
 */
export function generateFleet(settings = DEFAULT_SETTINGS, opts = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const artcc = String(s.artcc || "ZDC").toUpperCase();
  const artccAirports = airportsForArtcc(artcc);
  const depPool = (s.depAirports && s.depAirports.length)
    ? s.depAirports.map(a => String(a).toUpperCase())
    : artccAirports;
  const arrPool = (s.arrAirports && s.arrAirports.length)
    ? s.arrAirports.map(a => String(a).toUpperCase())
    : artccAirports.length ? artccAirports : depPool;
  const fixes = opts.fixes || ZDC_FIXES;
  const count = Math.max(1, Math.min(60, +s.aircraftCount || 12));
  const altMin = Math.max(10, +s.altMin || 180);
  const altMax = Math.max(altMin, +s.altMax || 400);
  const aircraft = [];
  const used = new Set();

  for (let i = 0; i < count; i++) {
    let cs;
    do { cs = randomCallsign(); } while (used.has(cs));
    used.add(cs);

    let dep = rand(depPool.length ? depPool : ["KDCA"]);
    let arr = rand(arrPool.length ? arrPool : ["KIAD"]);
    if (arr === dep && arrPool.length > 1) {
      do { arr = rand(arrPool); } while (arr === dep);
    }

    const phaseRoll = Math.random() * 100;
    const enroutePct = +s.phaseEnroute || 70;
    const depPct = +s.phaseDep || 15;
    let alt;
    if (phaseRoll < enroutePct) {
      alt = randInt(altMin, altMax);
    } else if (phaseRoll < enroutePct + depPct) {
      alt = randInt(Math.min(altMin, 50), Math.min(altMax, 150));
    } else {
      alt = randInt(Math.min(altMin, 100), altMax);
    }

    aircraft.push({
      cs,
      type: rand(TYPES),
      alt,
      hdg: randInt(1, 360),
      gs: randInt(360, 470),
      dep,
      arr,
      route: routeBetween(dep, arr, fixes, s.routeStyle),
    });
  }

  return {
    artcc,
    label: `${artcc} Generated`,
    version: 1,
    meta: { author: "ERAM Trainer", description: "Synthetic fleet", generatedAt: new Date().toISOString() },
    fixes: [...fixes],
    aircraft,
    scenarios: [],
  };
}

function fixesFromRoute(route, knownFixes) {
  const tokens = String(route || "").toUpperCase().split(/\s+/).filter(Boolean);
  const fixSet = new Set((knownFixes || []).map(f => f.toUpperCase()));
  return tokens.filter(t => fixSet.has(t) || (/^[A-Z]{3,5}$/.test(t) && !/^\d/.test(t)));
}

function pickScenarioType(mix) {
  const types = (mix && mix.length) ? mix : ["alt", "direct", "hdg", "spd"];
  return rand(types);
}

function altInstruction(verb, ac, targetFl) {
  if (verb === "QQ") return `Issue interim altitude FL${targetFl} for ${ac.cs}.`;
  const cur = ac.alt || 300;
  const action = targetFl > cur ? "Climb" : targetFl < cur ? "Descend" : "Maintain altitude for";
  return `${action} ${ac.cs} to ${targetFl >= 180 ? "FL" + targetFl : (targetFl * 100).toLocaleString("en-US") + " feet"}.`;
}

/**
 * @param {object} pack
 * @param {typeof DEFAULT_SETTINGS} [settings]
 */
export function generateScenarios(pack, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const mix = s.scenarioMix || DEFAULT_SETTINGS.scenarioMix;
  const count = Math.max(1, Math.min(100, +s.scenarioCount || 25));
  const fixes = pack.fixes || ZDC_FIXES;
  const scenarios = [];
  const aircraft = pack.aircraft || [];

  for (let i = 0; i < count; i++) {
    const ac = rand(aircraft);
    if (!ac) break;
    const type = pickScenarioType(mix);
    const id = `gen-${i + 1}-${type}`;

    if (type === "alt") {
      const verb = Math.random() < 0.15 ? "QQ" : "QZ";
      const delta = randInt(2, 8) * 10;
      let target = (ac.alt || 300) + (Math.random() < 0.5 ? delta : -delta);
      target = Math.max(+s.altMin || 180, Math.min(+s.altMax || 400, target));
      scenarios.push({
        id,
        type: "alt",
        instruction: altInstruction(verb, ac, target),
        aircraft: ac.cs,
        expect: { verb, alt: target },
        hint: verb === "QQ" ? "QQ for interim altitude." : "QZ for assigned altitude.",
      });
    } else if (type === "direct") {
      const routeFixes = fixesFromRoute(ac.route, fixes);
      const fix = routeFixes.length ? rand(routeFixes) : rand(fixes);
      scenarios.push({
        id,
        type: "direct",
        instruction: `Direct ${ac.cs} to ${fix}.`,
        aircraft: ac.cs,
        expect: { verb: "QU", fix },
        hint: "QU <fix> <callsign>",
      });
    } else if (type === "hdg") {
      const roll = Math.random();
      if (roll < 0.15) {
        scenarios.push({
          id,
          type: "hdg",
          instruction: `Fly present heading for ${ac.cs}.`,
          aircraft: ac.cs,
          expect: { verb: "QS", mode: "PH" },
          hint: "QS PH <callsign>",
        });
      } else {
        const hdg = randInt(1, 36) * 10 || 360;
        const mode = roll < 0.45 ? "LT" : roll < 0.75 ? "RH" : "NP";
        const instruction = mode === "LT"
          ? `Turn left heading ${hdg} for ${ac.cs}.`
          : mode === "RH"
            ? `Turn right heading ${hdg} for ${ac.cs}.`
            : `Fly heading ${hdg} for ${ac.cs}.`;
        scenarios.push({
          id,
          type: "hdg",
          instruction,
          aircraft: ac.cs,
          expect: { verb: "QS", hdg, mode },
          hint: mode === "LT" ? "QS LT <hdg>" : mode === "RH" ? "QS RT <hdg>" : "QS <hdg>",
        });
      }
    } else if (type === "spd") {
      const kt = randInt(24, 32) * 10;
      scenarios.push({
        id,
        type: "spd",
        instruction: `Maintain ${kt} knots for ${ac.cs}.`,
        aircraft: ac.cs,
        expect: { verb: "QS", kt },
        hint: "QS /280 <callsign>",
      });
    }
  }

  return scenarios;
}

function vatsimPilotToAircraft(p) {
  const fp = p.flight_plan;
  if (!fp || typeof p.latitude !== "number" || typeof p.longitude !== "number") return null;
  const f = fpFields(fp);
  const altFt = p.altitude || 0;
  const fl = altFt >= 18000 ? Math.round(altFt / 100) : Math.round(altFt / 100);
  return {
    cs: p.callsign,
    type: f.type || "B738",
    alt: fl || 300,
    hdg: p.heading || 0,
    gs: p.groundspeed || 0,
    lat: p.latitude,
    lon: p.longitude,
    dep: f.dep || "",
    arr: f.arr || "",
    route: [f.dep, f.route, f.arr].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
    source: "vatsim",
  };
}

/**
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {{ baseUrl?: string }} [opts]
 */
export async function snapshotVatsim(settings = DEFAULT_SETTINGS, opts = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const artcc = String(s.artcc || "ZDC").toUpperCase();
  await fetchArtccBoundaries(opts.baseUrl || "");

  const res = await fetch(VATSIM_DATA_URL);
  if (!res.ok) throw new Error(`VATSIM feed HTTP ${res.status}`);
  const data = await res.json();
  const depFilter = (s.depAirports || []).map(a => String(a).toUpperCase()).filter(Boolean);
  const arrFilter = (s.arrAirports || []).map(a => String(a).toUpperCase()).filter(Boolean);
  const max = Math.max(1, Math.min(60, +s.aircraftCount || 12));

  let pilots = (data.pilots || [])
    .map(vatsimPilotToAircraft)
    .filter(Boolean);

  pilots = pilots.filter(ac => {
    const depArt = primaryAirportArtcc(ac.dep);
    const arrArt = primaryAirportArtcc(ac.arr);
    const inArtcc = (ac.lat != null && pointInArtcc(artcc, ac.lat, ac.lon) === true)
      || depArt === artcc
      || arrArt === artcc;
    if (!inArtcc) return false;
    if (depFilter.length && !depFilter.includes(ac.dep)) return false;
    if (arrFilter.length && !arrFilter.includes(ac.arr)) return false;
    return (ac.gs || 0) > 60 || (ac.alt || 0) > 3;
  });

  if (!pilots.length) {
    return {
      ok: false,
      error: "No matching VATSIM traffic for the selected filters.",
      meta: { fetchedAt: new Date().toISOString(), artcc, count: 0 },
    };
  }

  if (pilots.length > max) {
    pilots = pilots.sort(() => Math.random() - 0.5).slice(0, max);
  }

  const pack = {
    artcc,
    label: `${artcc} VATSIM Snapshot`,
    version: 1,
    meta: {
      author: "ERAM Trainer",
      description: "Frozen VATSIM traffic snapshot",
      snapshotAt: new Date().toISOString(),
      pilotCount: pilots.length,
    },
    fixes: ZDC_FIXES,
    aircraft: pilots,
    scenarios: [],
  };

  pack.scenarios = generateScenarios(pack, s);
  return { ok: true, pack, meta: pack.meta };
}

/**
 * @param {string} input
 * @param {object} scenario
 * @param {object} aircraftByCs
 */
export function gradeCommand(input, scenario, aircraftByCs) {
  const csKey = (scenario.aircraft || "").toUpperCase();
  const ac = aircraftByCs instanceof Map
    ? aircraftByCs.get(csKey)
    : aircraftByCs[csKey];
  const selectedCs = ac ? ac.cs : scenario.aircraft;
  const parsed = parseMcaCommand(input, { selectedCs, requireU: false });
  const expect = scenario.expect || {};

  if (!parsed.ok) {
    return {
      ok: false,
      parsed,
      entry: null,
      feedback: formatMcaReject(parsed.error, parsed.flid || selectedCs),
      reason: parsed.error,
    };
  }

  if (parsed.verb !== expect.verb) {
    return {
      ok: false,
      parsed,
      entry: null,
      feedback: formatMcaReject("ILL CMD", `Expected ${expect.verb}`),
      reason: "WRONG VERB",
    };
  }

  if (expect.alt != null && parsed.payload && parsed.payload.fl !== expect.alt) {
    return {
      ok: false,
      parsed,
      entry: null,
      feedback: formatMcaReject("ILL ALT", `Expected FL${expect.alt}`),
      reason: "WRONG ALT",
    };
  }

  if (expect.fix && parsed.payload && parsed.payload.fix !== expect.fix) {
    return {
      ok: false,
      parsed,
      entry: null,
      feedback: formatMcaReject("NO FIX", `Expected ${expect.fix}`),
      reason: "WRONG FIX",
    };
  }

  if (expect.hdg != null && parsed.payload && parsed.payload.hdg !== expect.hdg) {
    return {
      ok: false,
      parsed,
      entry: null,
      feedback: formatMcaReject("ILL HDG", `Expected ${expect.hdg}`),
      reason: "WRONG HDG",
    };
  }

  if (expect.kt != null && parsed.payload && parsed.payload.kt !== expect.kt) {
    return {
      ok: false,
      parsed,
      entry: null,
      feedback: formatMcaReject("ILL SPD", `Expected ${expect.kt}`),
      reason: "WRONG SPD",
    };
  }

  if (expect.mode === "PH") {
    if (!parsed.payload || parsed.payload.type !== "hdg" || parsed.payload.mode !== "PH") {
      return {
        ok: false,
        parsed,
        entry: null,
        feedback: formatMcaReject("ILL HDG", "Expected present heading"),
        reason: "WRONG HDG MODE",
      };
    }
  } else if (expect.mode && parsed.payload && parsed.payload.type === "hdg" && expect.mode !== "PH") {
    const got = parsed.payload.mode;
    const want = expect.mode;
    if (got !== want && !(want === "RH" && got === "RH") && !(want === "LT" && got === "LT") && !(want === "NP" && got === "NP")) {
      return {
        ok: false,
        parsed,
        entry: null,
        feedback: formatMcaReject("ILL HDG", `Expected mode ${want}`),
        reason: "WRONG HDG MODE",
      };
    }
  }

  const flidOk = !parsed.flid
    || parsed.flid.toUpperCase() === String(selectedCs || "").toUpperCase();
  if (!flidOk) {
    return {
      ok: false,
      parsed,
      entry: null,
      feedback: formatMcaReject("NO FLID", `Expected ${selectedCs}`),
      reason: "WRONG FLID",
    };
  }

  const entry = buildMcaUplinkEntry(parsed, { alt: ac ? ac.alt : null });
  return {
    ok: true,
    parsed,
    entry,
    feedback: formatMcaAccept(parsed, entry),
    reason: null,
  };
}

export function buildFeedback(result) {
  if (!result) return [];
  return result.feedback || [];
}

/**
 * @param {{ elapsedMs: number, attempts: number, hintUsed?: boolean, streak?: number }} round
 */
export function scoreRound(round) {
  const { elapsedMs = 0, attempts = 1, hintUsed = false, streak = 0 } = round;
  if (attempts > 1) return { points: 0, breakdown: "retry" };
  let points = 100;
  if (hintUsed) points -= 25;
  if (elapsedMs < 8000) points += 20;
  else if (elapsedMs < 15000) points += 10;
  if (streak >= 3) points += Math.min(30, streak * 5);
  return { points, breakdown: { base: 100, hintUsed, speedBonus: points - 100 } };
}

/**
 * @param {object[]} scenarios
 * @param {"tutorial"|"practice"|"speed"} mode
 */
export function shuffleScenarios(scenarios, mode) {
  const list = [...(scenarios || [])];
  if (mode === "tutorial") {
    const order = { alt: 0, direct: 1, hdg: 2, spd: 3 };
    return list.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  }
  for (let i = list.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export function aircraftMap(pack) {
  const m = new Map();
  for (const ac of pack.aircraft || []) {
    m.set((ac.cs || "").toUpperCase(), ac);
  }
  return m;
}

export function preparePack(pack, settings, mode = "practice") {
  const p = { ...pack };
  if (!p.scenarios || !p.scenarios.length) {
    p.scenarios = generateScenarios(p, settings);
  }
  p.scenarios = shuffleScenarios(p.scenarios, mode);
  if (mode === "speed") {
    const n = Math.min(p.scenarios.length, +settings.scenarioCount || 10);
    p.scenarios = p.scenarios.slice(0, n);
  }
  return p;
}

export async function loadDefaultPack(baseUrl = "") {
  const root = (baseUrl || "") + "data/eram-trainer/";
  const idx = await fetch(root + "index.json").then(r => r.json());
  const key = idx.defaultPack || "ZDC";
  const file = (idx.packs && idx.packs[key]) || "zdc.json";
  return loadTrainerPack(root + file);
}

export function persistLastPack(pack) {
  try {
    localStorage.setItem(LS_LAST_PACK, JSON.stringify(pack));
  } catch (_) { /* quota */ }
}

export function loadLastPack() {
  try {
    const raw = localStorage.getItem(LS_LAST_PACK);
    if (!raw) return null;
    const v = importPackJson(raw);
    return v.ok ? v.pack : null;
  } catch (_) {
    return null;
  }
}

export { normalizeCommand, airportsForArtcc };
