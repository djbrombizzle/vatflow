/**
 * ERAM Trainer application — scope UI + drill logic.
 */
import { mountVatflowNav } from "./vatflow-nav.js";
import {
  DEFAULT_SETTINGS,
  loadDefaultPack,
  importPackFile,
  exportPack,
  generateFleet,
  generateScenarios,
  snapshotVatsim,
  gradeCommand,
  scoreRound,
  aircraftMap,
  preparePack,
  persistLastPack,
  loadLastPack,
} from "./eram-trainer.js";
import { initSimAircraft, applyCommandToAircraft, tickSimulation } from "./eram-trainer-sim.js";
import { createEramTrainerMap } from "./eram-trainer-map.js";
import {
  initEramScopeUi,
  startZuluClock,
  setMcaFeedback,
  setResponseArea,
  renderBeaconList,
} from "./eram-trainer-scope.js";

mountVatflowNav(document.getElementById("vatflowAppNav"), "eram-trainer");
initEramScopeUi(document);

const $ = id => document.getElementById(id);

let source = "bundled";
let customPack = null;
let currentPack = null;
let scenarios = [];
let acMap = new Map();
let idx = 0;
let score = 0;
let streak = 0;
let mode = "practice";
let roundStart = 0;
let attempts = 0;
let hintUsed = false;
let sessionStart = 0;
let completed = 0;
let totalPoints = 0;
let eramMap = null;
let simRaf = null;
let lastSimTs = 0;
let zuluTimer = null;
let vecMin = 4;

function parseList(str) {
  return String(str || "").toUpperCase().split(/[\s,]+/).filter(Boolean);
}

function getMix() {
  return [...$("mixSelect").selectedOptions].map(o => o.value);
}

function readSettings() {
  return {
    ...DEFAULT_SETTINGS,
    aircraftCount: +$("genCount").value || 12,
    artcc: ($("genArtcc").value || "ZDC").toUpperCase(),
    depAirports: parseList($("genDep").value),
    arrAirports: parseList($("genArr").value),
    altMin: +$("genAltMin").value || 180,
    altMax: +$("genAltMax").value || 400,
    scenarioCount: +$("genScenarios").value || 25,
    scenarioMix: getMix(),
  };
}

function readSnapshotSettings() {
  return {
    ...DEFAULT_SETTINGS,
    artcc: ($("snapArtcc").value || "ZDC").toUpperCase(),
    aircraftCount: +$("snapCount").value || 12,
    depAirports: parseList($("snapDep").value),
    arrAirports: parseList($("snapArr").value),
    scenarioCount: +$("genScenarios").value || 25,
    scenarioMix: getMix(),
  };
}

$("sourceTabs").addEventListener("click", e => {
  const tab = e.target.closest(".setup-tab");
  if (!tab) return;
  source = tab.dataset.source;
  $("sourceTabs").querySelectorAll(".setup-tab").forEach(t => t.classList.toggle("active", t === tab));
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.classList.toggle("active", p.dataset.panel === source);
  });
});

const dropzone = $("dropzone");
dropzone.addEventListener("click", () => $("fileInput").click());
dropzone.addEventListener("dragover", e => e.preventDefault());
dropzone.addEventListener("drop", async e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) await handleFile(f);
});
$("fileInput").addEventListener("change", async () => {
  if ($("fileInput").files[0]) await handleFile($("fileInput").files[0]);
});

async function handleFile(file) {
  const res = await importPackFile(file);
  if (!res.ok) {
    $("customStatus").textContent = res.errors.join(" ");
    return;
  }
  customPack = res.pack;
  $("customStatus").textContent = `Loaded ${customPack.label || customPack.artcc}`;
  $("btnExport").disabled = false;
}

$("btnLoadLast").addEventListener("click", () => {
  const p = loadLastPack();
  if (!p) {
    $("setupStatus").textContent = "No saved pack.";
    return;
  }
  customPack = p;
  source = "custom";
  $("customStatus").textContent = `Restored ${p.label || p.artcc}`;
  $("btnExport").disabled = false;
});

$("btnExport").addEventListener("click", () => {
  if (currentPack) exportPack(currentPack);
});

async function resolvePack() {
  mode = $("modeSelect").value;
  if (source === "bundled") return loadDefaultPack("");
  if (source === "custom") {
    if (!customPack) throw new Error("Import a custom JSON pack first.");
    return customPack;
  }
  if (source === "generate") {
    const s = readSettings();
    const pack = generateFleet(s);
    pack.scenarios = generateScenarios(pack, s);
    return pack;
  }
  if (source === "snapshot") {
    const snap = await snapshotVatsim(readSnapshotSettings(), { baseUrl: "" });
    if (!snap.ok) throw new Error(snap.error);
    return snap.pack;
  }
  throw new Error("Unknown source");
}

function currentScenarioCs() {
  const sc = scenarios[idx];
  return sc ? (sc.aircraft || "").toUpperCase() : null;
}

function refreshMap() {
  if (!eramMap || !currentPack) return;
  for (const ac of currentPack.aircraft || []) {
    ac.vecMin = vecMin;
  }
  eramMap.update(currentPack.aircraft, { selectedCs: currentScenarioCs() });
  renderBeaconList($("beaconList"), currentPack.aircraft, currentScenarioCs());
}

function startSimLoop() {
  lastSimTs = performance.now();
  const step = ts => {
    const dt = Math.min(100, ts - lastSimTs);
    lastSimTs = ts;
    if (currentPack && currentPack.aircraft) {
      tickSimulation(currentPack.aircraft, dt);
      refreshMap();
    }
    simRaf = requestAnimationFrame(step);
  };
  simRaf = requestAnimationFrame(step);
}

function stopSimLoop() {
  if (simRaf) cancelAnimationFrame(simRaf);
  simRaf = null;
}

function showScenario() {
  const sc = scenarios[idx];
  if (!sc) return endSession();

  $("instruction").textContent = sc.instruction;
  const hintEl = $("hintBox");
  hintEl.textContent = sc.hint || "";
  hintEl.classList.toggle("show", mode === "tutorial" || hintUsed);

  setMcaFeedback($("mcaFeedback"), null);
  setResponseArea($("raBody"), {
    instruction: sc.instruction,
    hint: (mode === "tutorial" || hintUsed) ? sc.hint : "",
    extra: `Target: ${sc.aircraft} · Type command in MCA Preview Area`,
  });

  const ac = acMap.get((sc.aircraft || "").toUpperCase());
  const ph = ac ? `QZ 340 ${ac.cs}` : "QZ 340 AAL123";
  $("mcaInput").value = "";
  $("mcaInput").placeholder = ph.replace(/QZ 340 [A-Z0-9]+/, "QZ ___ " + (sc.aircraft || "ACID"));
  $("mcaInput").focus();

  roundStart = Date.now();
  attempts = 0;
  hintUsed = mode === "tutorial";
  $("statProgress").textContent = `${idx + 1}/${scenarios.length}`;
  refreshMap();
}

function submitCommand() {
  const sc = scenarios[idx];
  if (!sc) return;
  attempts++;

  const result = gradeCommand($("mcaInput").value, sc, acMap);

  if (result.ok) {
    setMcaFeedback($("mcaFeedback"), result.feedback, "ok");
    const cpdlc = result.entry ? result.entry.msg.replace(/@/g, "") : "";
    setResponseArea($("raBody"), {
      instruction: sc.instruction,
      cpdlc,
      extra: "ACCEPT — command applied to target",
    });
    const ac = acMap.get((sc.aircraft || "").toUpperCase());
    if (ac && result.parsed) applyCommandToAircraft(ac, result.parsed);
    refreshMap();

    const round = scoreRound({ elapsedMs: Date.now() - roundStart, attempts, hintUsed, streak });
    score += round.points;
    totalPoints += round.points;
    streak++;
    completed++;
    $("statScore").textContent = String(score);
    $("statStreak").textContent = String(streak);
    setTimeout(() => { idx++; showScenario(); }, mode === "speed" ? 700 : 1000);
  } else {
    setMcaFeedback($("mcaFeedback"), result.feedback, "err");
    setResponseArea($("raBody"), {
      instruction: sc.instruction,
      extra: `REJECT — ${result.reason || "retry"}`,
    });
    streak = 0;
    $("statStreak").textContent = "0";
    if (attempts >= 3) {
      setTimeout(() => { idx++; showScenario(); }, 1400);
    }
  }
}

function enterScope() {
  document.body.classList.add("scope-active");
  $("setupOverlay").style.display = "none";
  $("eramScope").classList.add("active");
  if (zuluTimer) clearInterval(zuluTimer);
  zuluTimer = startZuluClock($("zuluTime"));
}

function exitScope() {
  document.body.classList.remove("scope-active");
  $("eramScope").classList.remove("active");
  $("setupOverlay").style.display = "";
  if (zuluTimer) clearInterval(zuluTimer);
  zuluTimer = null;
  stopSimLoop();
}

function endSession() {
  stopSimLoop();
  $("summaryOverlay").classList.add("active");
  $("finalScore").textContent = String(score);
  $("finalStats").textContent = `Completed ${completed} of ${scenarios.length} · ${totalPoints} pts`;
}

async function startSession() {
  $("setupStatus").textContent = "Loading…";
  $("btnStart").disabled = true;
  try {
    let pack = await resolvePack();
    const settings = readSettings();
    pack = preparePack(pack, settings, mode);
    currentPack = pack;
    await initSimAircraft(currentPack.aircraft, { baseUrl: "" });
    if (source === "custom") persistLastPack(pack);

    scenarios = pack.scenarios || [];
    acMap = aircraftMap(pack);
    idx = 0;
    score = 0;
    streak = 0;
    completed = 0;
    totalPoints = 0;
    sessionStart = Date.now();

    $("scopeTag").textContent = `${pack.artcc || "ZDC"} · TRAINER`;
    $("statMode").textContent = mode.toUpperCase();
    $("statScore").textContent = "0";
    $("statStreak").textContent = "0";
    $("btnExport").disabled = false;

    enterScope();

    if (!eramMap) {
      eramMap = await createEramTrainerMap($("eramMap"), {
        onSelect(cs) {
          const sc = scenarios[idx];
          if (sc && (sc.aircraft || "").toUpperCase() === cs) {
            $("mcaInput").focus();
          }
        },
      });
    }
    eramMap.setArtcc(pack.artcc || "ZDC");
    eramMap.update(currentPack.aircraft, { selectedCs: currentScenarioCs(), refit: true });
    setTimeout(() => eramMap.invalidateSize(), 100);
    startSimLoop();
    showScenario();
    $("setupStatus").textContent = "";
  } catch (err) {
    $("setupStatus").textContent = err.message || String(err);
  } finally {
    $("btnStart").disabled = false;
  }
}

$("btnStart").addEventListener("click", startSession);
$("mcaInput").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); submitCommand(); }
  if (e.key === "Escape") {
    $("mcaInput").value = "";
    setMcaFeedback($("mcaFeedback"), null);
  }
});

$("tbHint").addEventListener("click", () => {
  hintUsed = true;
  const sc = scenarios[idx];
  if (sc) {
    $("hintBox").textContent = sc.hint || "";
    $("hintBox").classList.add("show");
    setResponseArea($("raBody"), {
      instruction: sc.instruction,
      hint: sc.hint,
    });
  }
});
$("tbSkip").addEventListener("click", () => { streak = 0; idx++; showScenario(); });
$("tbEnd").addEventListener("click", endSession);
$("btnRestart").addEventListener("click", () => {
  $("summaryOverlay").classList.remove("active");
  exitScope();
});

$("tbViews").addEventListener("click", () => {
  $("beaconView").classList.toggle("hidden");
});
$("tbVector").addEventListener("click", () => {
  const opts = [0, 1, 2, 4, 8];
  const i = opts.indexOf(vecMin);
  vecMin = opts[(i + 1) % opts.length];
  $("tbVector").textContent = vecMin ? `VEC ${vecMin}` : "VEC 0";
  refreshMap();
});

const packUrl = new URLSearchParams(location.search).get("pack");
if (packUrl) {
  fetch(packUrl).then(r => r.json()).then(json => {
    customPack = json;
    source = "custom";
    $("customStatus").textContent = `Loaded: ${packUrl}`;
  }).catch(() => {});
}
