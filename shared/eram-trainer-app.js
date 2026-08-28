/**
 * ERAM Trainer — interactive MCA command quiz
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

mountVatflowNav(document.getElementById("vatflowAppNav"), "eram-trainer");

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
let completed = 0;
let totalPoints = 0;

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function setMcaFeedback(el, lines, type) {
  if (!el) return;
  if (!lines || !lines.length) {
    el.innerHTML = "";
    return;
  }
  const mark = type === "ok"
    ? '<span class="mca-mark ok">✓ </span>'
    : type === "err"
      ? '<span class="mca-mark err">✗ </span>'
      : "";
  const body = lines.filter(Boolean).map((ln, i) => {
    if (i === 0) return mark + escapeHtml(ln);
    return escapeHtml(ln);
  }).join("<br>");
  el.innerHTML = body;
}

function setCpdlcOut(text, type) {
  const el = $("cpdlcOut");
  if (!el) return;
  el.textContent = text || "";
  el.className = "cpdlc-out" + (type ? ` ${type}` : "");
}

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

function showPanel(name) {
  $("setupPanel").classList.toggle("hidden", name !== "setup");
  $("quizPanel").classList.toggle("hidden", name !== "quiz");
  $("summaryPanel").classList.toggle("hidden", name !== "summary");
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

function showScenario() {
  const sc = scenarios[idx];
  if (!sc) return endSession();

  $("instruction").textContent = sc.instruction;
  $("targetCs").textContent = sc.aircraft || "—";
  const hintEl = $("hintBox");
  hintEl.textContent = sc.hint || "";
  hintEl.classList.toggle("show", mode === "tutorial" || hintUsed);

  setMcaFeedback($("mcaFeedback"), null);
  setCpdlcOut("");
  $("mcaInput").value = "";
  $("mcaInput").placeholder = " ";
  $("mcaInput").focus();

  roundStart = Date.now();
  attempts = 0;
  hintUsed = mode === "tutorial";
  $("statProgress").textContent = `${idx + 1}/${scenarios.length}`;
}

function submitCommand() {
  const sc = scenarios[idx];
  if (!sc) return;
  attempts++;

  const result = gradeCommand($("mcaInput").value, sc, acMap);

  if (result.ok) {
    setMcaFeedback($("mcaFeedback"), result.feedback, "ok");
    const cpdlc = result.entry ? result.entry.msg.replace(/@/g, "") : "";
    setCpdlcOut(cpdlc ? `CPDLC: ${cpdlc}` : "ACCEPT", "accept");

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
    setCpdlcOut(`REJECT — ${result.reason || "retry"}`, "reject");
    streak = 0;
    $("statStreak").textContent = "0";
    if (attempts >= 3) {
      setTimeout(() => { idx++; showScenario(); }, 1400);
    }
  }
}

function endSession() {
  $("finalScore").textContent = String(score);
  $("finalStats").textContent = `Completed ${completed} of ${scenarios.length} · ${totalPoints} points`;
  showPanel("summary");
}

async function startSession() {
  $("setupStatus").textContent = "Loading…";
  $("btnStart").disabled = true;
  try {
    let pack = await resolvePack();
    const settings = readSettings();
    pack = preparePack(pack, settings, mode);
    currentPack = pack;
    if (source === "custom") persistLastPack(pack);

    scenarios = pack.scenarios || [];
    acMap = aircraftMap(pack);
    idx = 0;
    score = 0;
    streak = 0;
    completed = 0;
    totalPoints = 0;

    $("statMode").textContent = mode.toUpperCase();
    $("statScore").textContent = "0";
    $("statStreak").textContent = "0";
    $("btnExport").disabled = false;

    showPanel("quiz");
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
    setCpdlcOut("");
  }
});

$("btnHint").addEventListener("click", () => {
  hintUsed = true;
  const sc = scenarios[idx];
  if (sc) {
    $("hintBox").textContent = sc.hint || "";
    $("hintBox").classList.add("show");
  }
});

$("btnSkip").addEventListener("click", () => { streak = 0; idx++; showScenario(); });
$("btnEnd").addEventListener("click", endSession);
$("btnSetup").addEventListener("click", () => showPanel("setup"));
$("btnRestart").addEventListener("click", () => showPanel("setup"));

const packUrl = new URLSearchParams(location.search).get("pack");
if (packUrl) {
  fetch(packUrl).then(r => r.json()).then(json => {
    customPack = json;
    source = "custom";
    $("customStatus").textContent = `Loaded: ${packUrl}`;
  }).catch(() => {});
}
