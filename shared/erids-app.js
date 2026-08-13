/**
 * VATFLOW ERIDS — view router, Back stack, ARTCC select, shortcuts, renderers.
 */
import { ARTCC_LIST } from "./artcc-constants.js";
import {
  fetchMetar,
  fetchArtccNotams,
  fetchArtccSigmets,
  formatNotamEntry,
  formatSigmetEntry,
  formatUtcClock,
  formatUpdatedStamp,
  normalizeIcao,
} from "./erids-data.js";
import {
  fetchHubEridsConfig,
  saveHubEridsConfig,
  deleteHubEridsConfig,
  chartfoxUrl,
  shouldOpenInViewer,
  isChartfoxUrl,
  looksLikePdfUrl,
  fetchProxiedDocument,
  isPdfContentType,
} from "./erids-store.js";
import {
  initVatflowAuth,
  isSignedIn,
  canEditArtcc,
  login,
} from "./vatflow-auth.js";
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

const SHORTCUTS_KEY = "vatflow.erids.shortcuts.v1";
const ARTCC_KEY = "vatflow.erids.artcc.v2";
const MAX_HISTORY = 40;
const MAX_METARS = 8;
const CHART_SECTIONS = new Set(["approaches", "sids", "stars", "runways", "charts"]);
const DOC_SECTIONS = new Set(["docs", "sops", "sop", "home"]);

const PRIMARY_TABS = [
  { id: "facilities", label: "Facilities" },
  { id: "approaches", label: "Approaches" },
  { id: "comm", label: "Comm." },
  { id: "remarks", label: "Remarks" },
  { id: "towerData", label: "Tower Data" },
  { id: "facilityNotams", label: "NOTAMs" },
];

const APPROACH_SUBTABS = [
  { id: "plates", label: "Approach Plates", key: "approaches" },
  { id: "sids", label: "SIDs", key: "sids" },
  { id: "stars", label: "STARs", key: "stars" },
  { id: "runways", label: "Runways", key: "runways" },
];

const ICON_VIEWS = new Set([
  "home",
  "messages",
  "wx",
  "docs",
  "charts",
  "search",
  "help",
  "shortcuts",
  "contractions",
  "admin",
]);

/** @type {any} */
const state = {
  artcc: "ZJX",
  index: null,
  config: null,
  configSource: "static",
  configUpdatedAt: null,
  bundledConfig: null,
  adminFacilityId: null,
  adminStatus: "",
  adminStatusKind: "",
  facilityId: null,
  primaryTab: "facilities",
  approachSub: "plates",
  view: "home",
  history: [],
  defineMode: false,
  showShortcuts: false,
  metars: [],
  notams: null,
  sigmets: null,
  searchQ: "",
  wxIcao: "KJAX",
  loadingLive: false,
  viewerOpen: false,
  viewerUrl: "",
  viewerTitle: "",
  viewerMode: "web", // web | pdf | chart
  pdfDoc: null,
  pdfPage: 1,
  pdfScale: 1.15,
  viewerBlobUrl: null,
};

const el = {
  artcc: document.getElementById("eridsArtcc"),
  clock: document.getElementById("eridsClock"),
  primary: document.getElementById("eridsPrimaryTabs"),
  secondary: document.getElementById("eridsSecondaryTabs"),
  main: document.getElementById("eridsMain"),
  back: document.getElementById("eridsBack"),
  define: document.getElementById("eridsDefineShortcuts"),
  showSc: document.getElementById("eridsShowShortcuts"),
  contractions: document.getElementById("eridsContractions"),
  facilityQuick: document.getElementById("eridsFacilityQuick"),
  adminBtn: document.getElementById("eridsAdminBtn"),
  viewer: document.getElementById("eridsViewer"),
  viewerFrame: document.getElementById("eridsViewerFrame"),
  viewerTitle: document.getElementById("eridsViewerTitle"),
  viewerOpen: document.getElementById("eridsViewerOpen"),
  viewerClose: document.getElementById("eridsViewerClose"),
  viewerLogin: document.getElementById("eridsViewerLogin"),
  viewerNote: document.getElementById("eridsViewerNote"),
  viewerLoading: document.getElementById("eridsViewerLoading"),
  pdfTools: document.getElementById("eridsViewerPdfTools"),
  pdfPane: document.getElementById("eridsPdfPane"),
  pdfCanvas: document.getElementById("eridsPdfCanvas"),
  pdfPrev: document.getElementById("eridsPdfPrev"),
  pdfNext: document.getElementById("eridsPdfNext"),
  pdfPageLabel: document.getElementById("eridsPdfPage"),
  pdfZoomIn: document.getElementById("eridsPdfZoomIn"),
  pdfZoomOut: document.getElementById("eridsPdfZoomOut"),
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function snapshot() {
  return {
    view: state.view,
    facilityId: state.facilityId,
    primaryTab: state.primaryTab,
    approachSub: state.approachSub,
    showShortcuts: state.showShortcuts,
  };
}

function applySnapshot(snap) {
  if (!snap) return;
  state.view = snap.view || "home";
  state.facilityId = snap.facilityId || null;
  state.primaryTab = snap.primaryTab || "facilities";
  state.approachSub = snap.approachSub || "plates";
  state.showShortcuts = !!snap.showShortcuts;
}

function pushHistory() {
  const cur = snapshot();
  const last = state.history[state.history.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(cur)) return;
  state.history.push(cur);
  if (state.history.length > MAX_HISTORY) state.history.shift();
}

function goBack() {
  if (!state.history.length) {
    navigate({ view: "home", facilityId: null, push: false });
    return;
  }
  const prev = state.history.pop();
  applySnapshot(prev);
  state.defineMode = false;
  document.body.classList.toggle("erids-define-mode", false);
  render();
}

/**
 * @param {{ view?: string, facilityId?: string|null, primaryTab?: string, approachSub?: string, push?: boolean, showShortcuts?: boolean }} opts
 */
function navigate(opts = {}) {
  const push = opts.push !== false;
  if (push) pushHistory();
  if (opts.view != null) state.view = opts.view;
  if ("facilityId" in opts) state.facilityId = opts.facilityId;
  if (opts.primaryTab != null) state.primaryTab = opts.primaryTab;
  if (opts.approachSub != null) state.approachSub = opts.approachSub;
  if ("showShortcuts" in opts) state.showShortcuts = !!opts.showShortcuts;
  if (state.view !== "shortcuts") state.showShortcuts = false;
  render();
}

function currentFacility() {
  const list = (state.config && state.config.facilities) || [];
  if (!state.facilityId) return null;
  return list.find((f) => f.id === state.facilityId) || null;
}

function loadShortcuts() {
  try {
    const raw = localStorage.getItem(SHORTCUTS_KEY);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function saveShortcuts(list) {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(list.slice(0, 24)));
}

function addShortcut(item) {
  const list = loadShortcuts().filter((s) => s.id !== item.id);
  list.unshift(item);
  saveShortcuts(list);
}

function maybeCaptureShortcut(item) {
  if (!state.defineMode) return false;
  addShortcut(item);
  state.defineMode = false;
  document.body.classList.remove("erids-define-mode");
  el.define.classList.remove("is-active");
  navigate({ view: "shortcuts", showShortcuts: true });
  return true;
}

async function loadIndex() {
  const res = await fetch("data/erids/index.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load ERIDS index");
  state.index = await res.json();
}

async function loadBundledConfig(artcc) {
  const map = (state.index && state.index.artccs) || {};
  const file = map[artcc];
  if (!file) {
    return {
      artcc,
      label: artcc,
      facilities: [],
      homeButtons: [],
      tmMessages: [],
      contractions: [],
    };
  }
  const res = await fetch("data/erids/" + file, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load " + file);
  return res.json();
}

async function loadConfig(artcc) {
  const bundled = await loadBundledConfig(artcc);
  state.bundledConfig = structuredClone
    ? structuredClone(bundled)
    : JSON.parse(JSON.stringify(bundled));

  try {
    const hub = await fetchHubEridsConfig(artcc);
    if (hub && hub.ok && hub.config) {
      state.config = hub.config;
      state.configSource = "hub";
      state.configUpdatedAt = hub.updatedAt || null;
      return;
    }
  } catch (err) {
    console.warn("ERIDS hub config unavailable:", err);
  }

  state.config = bundled;
  state.configSource = "static";
  state.configUpdatedAt = null;
}

function revokeViewerBlob() {
  if (state.viewerBlobUrl) {
    try {
      URL.revokeObjectURL(state.viewerBlobUrl);
    } catch (_) {}
    state.viewerBlobUrl = null;
  }
}

function setViewerLoading(on) {
  if (el.viewerLoading) el.viewerLoading.hidden = !on;
}

function setViewerNote(html) {
  if (!el.viewerNote) return;
  el.viewerNote.innerHTML = html || "";
  el.viewerNote.hidden = !html;
}

function showWebFrame(url) {
  if (el.pdfTools) el.pdfTools.hidden = true;
  if (el.pdfPane) el.pdfPane.hidden = true;
  if (el.viewerFrame) {
    el.viewerFrame.hidden = false;
    el.viewerFrame.src = url;
  }
}

async function renderPdfPage() {
  if (!state.pdfDoc || !el.pdfCanvas) return;
  const page = await state.pdfDoc.getPage(state.pdfPage);
  const viewport = page.getViewport({ scale: state.pdfScale });
  const canvas = el.pdfCanvas;
  const ctx = canvas.getContext("2d");
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  await page.render({ canvasContext: ctx, viewport }).promise;
  if (el.pdfPageLabel) {
    el.pdfPageLabel.textContent = state.pdfPage + " / " + state.pdfDoc.numPages;
  }
}

async function showPdfFromData(data) {
  state.viewerMode = "pdf";
  if (el.viewerFrame) {
    el.viewerFrame.hidden = true;
    el.viewerFrame.src = "about:blank";
  }
  if (el.pdfPane) el.pdfPane.hidden = false;
  if (el.pdfTools) el.pdfTools.hidden = false;
  state.pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  state.pdfPage = 1;
  state.pdfScale = 1.15;
  await renderPdfPage();
}

async function openDocViewer(url, title, opts = {}) {
  const section = opts.section || "";
  state.viewerOpen = true;
  state.viewerUrl = url;
  state.viewerTitle = title || "Document";
  state.pdfDoc = null;
  revokeViewerBlob();

  if (el.viewerTitle) el.viewerTitle.textContent = state.viewerTitle;
  if (el.viewerOpen) {
    el.viewerOpen.href = url;
    el.viewerOpen.textContent = "Open Externally";
  }
  if (el.viewer) el.viewer.hidden = false;

  const chartMode = isChartfoxUrl(url) || CHART_SECTIONS.has(section);
  if (el.viewerLogin) el.viewerLogin.hidden = !chartMode;

  setViewerLoading(true);
  setViewerNote("");

  // Prefer PDF.js via hub proxy for SOP/docs / explicit PDFs.
  const preferPdf =
    looksLikePdfUrl(url) || DOC_SECTIONS.has(section) || section === "sops";

  if (preferPdf && isSignedIn()) {
    try {
      const proxied = await fetchProxiedDocument(url);
      if (isPdfContentType(proxied.contentType) || looksLikePdfUrl(url)) {
        const ab = await proxied.blob.arrayBuffer();
        // PDF magic
        const head = new Uint8Array(ab.slice(0, 5));
        const isPdfMagic =
          head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF
        if (isPdfMagic || isPdfContentType(proxied.contentType)) {
          setViewerNote("Embedded PDF viewer · use Open Externally for print/download.");
          await showPdfFromData(new Uint8Array(ab));
          setViewerLoading(false);
          return;
        }
        // HTML or other — show in iframe via blob if text/html, else original URL
        if (proxied.contentType.includes("html")) {
          setViewerNote(
            "This link is a web page (not a direct PDF). Embedding may be blank if the site blocks iframes — use <b>Open Externally</b>. Prefer a direct <code>.pdf</code> URL in Admin for best results."
          );
          showWebFrame(url);
          setViewerLoading(false);
          return;
        }
      }
    } catch (err) {
      console.warn("ERIDS doc proxy failed:", err);
      setViewerNote(
        "Could not proxy document (" +
          esc((err && err.message) || "error") +
          "). Trying direct embed — use <b>Open Externally</b> if blank. Sign-in required for PDF proxy."
      );
    }
  } else if (preferPdf && !isSignedIn()) {
    setViewerNote(
      "Sign in with VATSIM for in-page PDF embedding. Trying direct view — use <b>Open Externally</b> if blank."
    );
  }

  if (chartMode) {
    state.viewerMode = "chart";
    setViewerNote(
      "Charts open in ChartFox. ChartFox blocks embedding on many browsers — use <b>Open Externally</b> / ChartFox Login if the frame is blank."
    );
    if (el.viewerOpen) el.viewerOpen.textContent = "Open ChartFox";
  } else if (!el.viewerNote || !el.viewerNote.innerHTML) {
    setViewerNote("Embedded document view. If blank, the site blocks framing — use <b>Open Externally</b>.");
  }

  showWebFrame(url);
  setViewerLoading(false);
}

function closeDocViewer() {
  state.viewerOpen = false;
  state.pdfDoc = null;
  revokeViewerBlob();
  if (el.viewerFrame) el.viewerFrame.src = "about:blank";
  if (el.pdfPane) el.pdfPane.hidden = true;
  if (el.pdfTools) el.pdfTools.hidden = true;
  if (el.viewer) el.viewer.hidden = true;
  setViewerLoading(false);
}

/** @deprecated */
function openChartViewer(url, title) {
  return openDocViewer(url, title, { section: "charts" });
}
function closeChartViewer() {
  return closeDocViewer();
}

function defaultChartUrlForFacility(facId) {
  return chartfoxUrl(facId || state.facilityId || "KJAX");
}

async function refreshLive() {
  state.loadingLive = true;
  renderChrome();
  try {
    const [notams, sigmets] = await Promise.all([
      fetchArtccNotams(state.artcc),
      fetchArtccSigmets(state.artcc),
    ]);
    state.notams = notams;
    state.sigmets = sigmets;
  } finally {
    state.loadingLive = false;
    if (state.view === "messages" || state.view === "wx" || state.view === "facilityNotams") {
      render();
    } else {
      renderChrome();
    }
  }
}

function fillArtccSelect() {
  const preferred =
    localStorage.getItem(ARTCC_KEY) ||
    (state.index && state.index.defaultArtcc) ||
    "ZJX";
  state.artcc = ARTCC_LIST.includes(preferred) ? preferred : "ZJX";
  el.artcc.innerHTML = ARTCC_LIST.map(
    (a) =>
      `<option value="${esc(a)}"${a === state.artcc ? " selected" : ""}>${esc(a)}</option>`
  ).join("");
}

function renderChrome() {
  const fac = currentFacility();

  el.primary.innerHTML = PRIMARY_TABS.map((t) => {
    const active =
      state.view === "facility" && state.primaryTab === t.id
        ? " is-active"
        : "";
    const disabled = !fac ? ' aria-disabled="true"' : "";
    return `<button type="button" class="erids-tab${active}" data-primary="${esc(t.id)}"${disabled}>${esc(t.label)}</button>`;
  }).join("");

  const showSub =
    state.view === "facility" && state.primaryTab === "approaches" && !!fac;
  el.secondary.classList.toggle("is-visible", showSub);
  if (showSub) {
    el.secondary.innerHTML = APPROACH_SUBTABS.map((t) => {
      const active = state.approachSub === t.id ? " is-active" : "";
      return `<button type="button" class="erids-subtab${active}" data-sub="${esc(t.id)}">${esc(t.label)}</button>`;
    }).join("");
  } else {
    el.secondary.innerHTML = "";
  }

  document.querySelectorAll(".erids-icon-btn").forEach((btn) => {
    const nav = btn.getAttribute("data-nav");
    btn.classList.toggle("is-active", nav === state.view);
  });

  el.define.classList.toggle("is-active", state.defineMode);
  el.showSc.classList.toggle("is-hot", state.view === "shortcuts" || state.showShortcuts);
  document.body.classList.toggle("erids-define-mode", state.defineMode);

  if (fac) {
    el.facilityQuick.hidden = false;
    el.facilityQuick.textContent = fac.label + " Approach";
  } else {
    el.facilityQuick.hidden = true;
  }

  if (el.adminBtn) {
    el.adminBtn.hidden = false;
    el.adminBtn.textContent = canEditArtcc(state.artcc) ? "Admin" : "Admin";
    el.adminBtn.classList.toggle("is-active", state.view === "admin");
  }
}

function linkButton(btn, extra = {}) {
  const label = btn.label || "Link";
  const section = extra.section || "";
  let url = btn.url || "";
  if (CHART_SECTIONS.has(section) && !url) {
    url = defaultChartUrlForFacility(extra.facilityId || state.facilityId);
  }
  const id =
    extra.id ||
    "btn:" + state.artcc + ":" + (state.facilityId || "home") + ":" + label;
  const useViewer = shouldOpenInViewer(url, { section });
  const attrs = url
    ? useViewer
      ? `href="${esc(url)}" data-doc-viewer="1" data-doc-section="${esc(section)}" data-doc-title="${esc(label)}"`
      : `href="${esc(url)}" target="_blank" rel="noopener noreferrer"`
    : `href="#" aria-disabled="true"`;
  const cls = "erids-btn" + (extra.lg ? " erids-btn-lg" : "");
  return `<a class="${cls}" data-shortcut-id="${esc(id)}" data-shortcut-label="${esc(label)}" data-shortcut-url="${esc(url)}" data-shortcut-view="${esc(extra.view || "")}" ${attrs}>${esc(label)}</a>`;
}

function renderButtonGroups(groups, section = "") {
  if (!groups || !groups.length) {
    return `<div class="erids-empty">No items configured for this section. <span class="erids-badge">${esc(state.configSource)}</span></div>`;
  }
  return groups
    .map((g) => {
      const buttons = g.buttons || [];
      return (
        `<div class="erids-section-bar">${esc(g.group || "Links")}</div>` +
        `<div class="erids-btn-row">${buttons.map((b) => linkButton(b, { section })).join("") || `<span class="erids-empty">Empty group</span>`}</div>`
      );
    })
    .join("");
}

function renderApproaches(fac) {
  const sub = APPROACH_SUBTABS.find((s) => s.id === state.approachSub) || APPROACH_SUBTABS[0];
  const key = sub.key;
  const data = (fac.tabs && fac.tabs[key]) || [];
  const fox = chartfoxUrl(fac.id);

  if (key === "approaches") {
    if (!data.length) {
      return (
        `<div class="erids-form-row"><button type="button" class="erids-btn erids-btn-lg" data-doc-viewer="1" data-doc-section="charts" data-doc-url="${esc(fox)}" data-doc-title="${esc(fac.label + " Charts")}">Open ChartFox — ${esc(fac.label)}</button></div>` +
        `<div class="erids-empty">No approach plate buttons configured. <span class="erids-badge">${esc(state.configSource)}</span></div>`
      );
    }
    return (
      `<div class="erids-form-row"><button type="button" class="erids-btn" data-doc-viewer="1" data-doc-section="charts" data-doc-url="${esc(fox)}" data-doc-title="${esc(fac.label + " Charts")}">ChartFox — ${esc(fac.id)}</button></div>` +
      data
        .map((row) => {
          const buttons = row.buttons || [];
          return (
            `<div class="erids-runway-block">` +
            `<span class="erids-runway-label">${esc(row.runway)}</span>` +
            `<div class="erids-btn-row">${buttons
              .map((b) =>
                linkButton(
                  { label: b.label, url: b.url || fox },
                  { section: "approaches", facilityId: fac.id }
                )
              )
              .join("")}</div>` +
            `</div>`
          );
        })
        .join("")
    );
  }

  if (Array.isArray(data) && data[0] && data[0].buttons && !data[0].runway) {
    return renderButtonGroups(data, key);
  }
  return renderButtonGroups(data, key);
}

function renderFacilityTab() {
  const fac = currentFacility();
  if (!fac) {
    return `<p class="erids-empty">Select a facility from Home.</p>`;
  }
  const tab = state.primaryTab;
  let body = "";
  let title = fac.label;

  if (tab === "facilities") {
    title = fac.name ? `${fac.label} — ${fac.name}` : fac.label;
    body =
      `<div class="erids-btn-row" style="margin-bottom:14px">` +
      `<button type="button" class="erids-btn erids-btn-lg" data-goto-tab="approaches">Approaches</button>` +
      `<button type="button" class="erids-btn erids-btn-lg" data-goto-tab="comm">Comm.</button>` +
      `<button type="button" class="erids-btn erids-btn-lg" data-goto-tab="remarks">Remarks</button>` +
      `<button type="button" class="erids-btn erids-btn-lg" data-goto-tab="towerData">Tower Data</button>` +
      `<button type="button" class="erids-btn erids-btn-lg" data-goto-view="docs">ATC Docs</button>` +
      `<button type="button" class="erids-btn erids-btn-lg" data-goto-view="charts">Charts</button>` +
      `</div>` +
      `<p class="erids-meta">${esc(fac.id)} · ${esc(state.artcc)}</p>`;
  } else if (tab === "approaches") {
    title = `Approach Plate Information (by runway) — ${fac.label}`;
    body =
      `<span class="erids-badge">${esc(state.configSource)}</span>` +
      renderApproaches(fac);
  } else if (tab === "comm") {
    title = `Communications — ${fac.label}`;
    body =
      `<span class="erids-badge">${esc(state.configSource)}</span>` +
      renderButtonGroups((fac.tabs && fac.tabs.comm) || [], "comm");
  } else if (tab === "remarks") {
    title = `Remarks — ${fac.label}`;
    body =
      `<span class="erids-badge">${esc(state.configSource)}</span>` +
      renderButtonGroups((fac.tabs && fac.tabs.remarks) || [], "remarks");
  } else if (tab === "towerData") {
    title = `Tower Data — ${fac.label}`;
    body =
      `<span class="erids-badge">${esc(state.configSource)}</span>` +
      renderButtonGroups((fac.tabs && fac.tabs.towerData) || [], "towerData");
  } else if (tab === "facilityNotams") {
    title = `NOTAMs — ${fac.label}`;
    body = renderFacilityNotamsHint(fac);
  }

  return (
    `<h1 class="erids-view-title">${esc(title)}</h1>` +
    `<div class="erids-crumb">${esc(state.artcc)} › ${esc(fac.label)} › ${esc(tab)}</div>` +
    body
  );
}

function renderFacilityNotamsHint(fac) {
  const entries = (state.notams && state.notams.entries) || [];
  const icao = fac.id;
  const filtered = entries.filter((e) => {
    const loc = String(e.location || e.icao || e.facility || "").toUpperCase();
    return !loc || loc.includes(icao) || loc.includes(icao.slice(1));
  });
  const stamp = formatUpdatedStamp(state.notams && state.notams.fetchedAt);
  let html = `<p class="erids-meta">Updated ${esc(stamp)} · ARTCC feed filtered for ${esc(icao)}</p>`;
  if (state.notams && state.notams.error) {
    html += `<p class="erids-meta error">${esc(state.notams.error)}</p>`;
  }
  if (state.loadingLive) html += `<p class="erids-meta">Loading…</p>`;
  if (!filtered.length) {
    html += `<div class="erids-empty">No matching NOTAMs (0 of ${entries.length} ARTCC entries).</div>`;
  } else {
    html +=
      `<ul class="erids-msg-list">` +
      filtered
        .slice(0, 40)
        .map((e) => `<li>${esc(formatNotamEntry(e))}</li>`)
        .join("") +
      `</ul>`;
  }
  html += `<div class="erids-form-row" style="margin-top:12px"><button type="button" class="erids-btn" id="eridsRefreshLive">Refresh</button></div>`;
  return html;
}

function renderHome() {
  const facs = (state.config && state.config.facilities) || [];
  const homeBtns = (state.config && state.config.homeButtons) || [];
  const label = (state.config && state.config.label) || state.artcc;
  let html =
    `<h1 class="erids-view-title">${esc(state.artcc)} — ${esc(label)}</h1>` +
    `<div class="erids-crumb">Home</div>`;

  if (homeBtns.length) {
    const grouped = {};
    homeBtns.forEach((b) => {
      const g = b.group || "Center";
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(b);
    });
    html +=
      `<span class="erids-badge">${esc(state.configSource)}</span>` +
      renderButtonGroups(
        Object.keys(grouped).map((g) => ({ group: g, buttons: grouped[g] })),
        "docs"
      );
  }

  html += `<div class="erids-section-bar">Facilities</div>`;
  if (!facs.length) {
    html += `<div class="erids-empty">No facility pages configured for ${esc(state.artcc)}. Live WX / Messages still work for this ARTCC.</div>`;
  } else {
    html +=
      `<div class="erids-facility-grid">` +
      facs
        .map(
          (f) =>
            `<button type="button" class="erids-btn erids-btn-lg" data-open-facility="${esc(f.id)}" data-shortcut-id="fac:${esc(f.id)}" data-shortcut-label="${esc(f.label)}" data-shortcut-view="facility">${esc(f.label)}<br><span style="font-size:11px;font-weight:600;opacity:.85">${esc(f.name || f.id)}</span></button>`
        )
        .join("") +
      `</div>`;
  }
  return html;
}

function renderMessages() {
  const notams = (state.notams && state.notams.entries) || [];
  const sigs = (state.sigmets && state.sigmets.entries) || [];
  const tm = (state.config && state.config.tmMessages) || [];
  const nStamp = formatUpdatedStamp(state.notams && state.notams.fetchedAt);
  const sStamp = formatUpdatedStamp(state.sigmets && state.sigmets.fetchedAt);

  let html =
    `<h1 class="erids-view-title">Messages — ${esc(state.artcc)}</h1>` +
    `<div class="erids-crumb">Messages</div>` +
    `<div class="erids-form-row"><button type="button" class="erids-btn" id="eridsRefreshLive">Refresh</button></div>`;

  html += `<div class="erids-section-bar">NOTAMs (${notams.length})</div>`;
  html += `<p class="erids-meta">Updated ${esc(nStamp)}</p>`;
  if (state.notams && state.notams.error) {
    html += `<p class="erids-meta error">${esc(state.notams.error)}</p>`;
  }
  if (state.loadingLive) html += `<p class="erids-meta">Loading…</p>`;
  html += notams.length
    ? `<ul class="erids-msg-list">${notams
        .slice(0, 50)
        .map((e) => `<li>${esc(formatNotamEntry(e))}</li>`)
        .join("")}</ul>`
    : `<div class="erids-empty">0 of 0</div>`;

  html += `<div class="erids-section-bar">TM Messages <span class="erids-badge">${esc(state.configSource)}</span></div>`;
  html += tm.length
    ? `<ul class="erids-msg-list">${tm
        .map(
          (m) =>
            `<li><span class="ts">${esc(m.ts || "")}</span>${esc(m.text || "")}</li>`
        )
        .join("")}</ul>`
    : `<div class="erids-empty">No TM messages.</div>`;

  html += `<div class="erids-section-bar">WX Messages — SIGMETs (${sigs.length})</div>`;
  html += `<p class="erids-meta">Updated ${esc(sStamp)}</p>`;
  if (state.sigmets && state.sigmets.error) {
    html += `<p class="erids-meta error">${esc(state.sigmets.error)}</p>`;
  }
  html += sigs.length
    ? `<ul class="erids-msg-list">${sigs
        .slice(0, 40)
        .map((e) => `<li>${esc(formatSigmetEntry(e))}</li>`)
        .join("")}</ul>`
    : `<div class="erids-empty">No active SIGMETs for ${esc(state.artcc)}.</div>`;

  return html;
}

function renderWx() {
  const sigs = (state.sigmets && state.sigmets.entries) || [];
  const sStamp = formatUpdatedStamp(state.sigmets && state.sigmets.fetchedAt);
  let html =
    `<h1 class="erids-view-title">Weather — ${esc(state.artcc)}</h1>` +
    `<div class="erids-crumb">WX</div>` +
    `<div class="erids-form-row">` +
    `<input class="erids-input" id="eridsWxIcao" maxlength="4" value="${esc(state.wxIcao)}" placeholder="ICAO" aria-label="Airport ICAO">` +
    `<button type="button" class="erids-btn" id="eridsWxGet">GET METAR</button>` +
    `<button type="button" class="erids-btn" id="eridsRefreshLive">Refresh SIGMETs</button>` +
    `</div>`;

  html += `<div class="erids-section-bar">METARs (${state.metars.length} / ${MAX_METARS})</div>`;
  if (!state.metars.length) {
    html += `<div class="erids-empty">Enter an airport ICAO and tap GET METAR.</div>`;
  } else {
    html += state.metars
      .map((m) => {
        const cat = m.fltCat || "VFR";
        return (
          `<div class="erids-wx-card">` +
          `<span class="icao">${esc(m.icao)}</span>` +
          `<span class="cat ${esc(cat)}">${esc(cat)}</span>` +
          `<button type="button" class="erids-btn" style="float:right;min-height:36px;min-width:64px;padding:6px 10px;font-size:12px" data-del-metar="${esc(m.icao)}">Delete</button>` +
          `<div class="raw">${esc(m.text)}</div>` +
          (m.error ? `<p class="erids-meta error">${esc(m.error)}</p>` : "") +
          `</div>`
        );
      })
      .join("");
  }

  html += `<div class="erids-section-bar">SIGMETs (${sigs.length})</div>`;
  html += `<p class="erids-meta">Updated ${esc(sStamp)}</p>`;
  if (state.sigmets && state.sigmets.error) {
    html += `<p class="erids-meta error">${esc(state.sigmets.error)}</p>`;
  }
  html += sigs.length
    ? `<ul class="erids-msg-list">${sigs
        .slice(0, 30)
        .map((e) => `<li>${esc(formatSigmetEntry(e))}</li>`)
        .join("")}</ul>`
    : `<div class="erids-empty">No active SIGMETs.</div>`;

  return html;
}

function renderDocs() {
  const fac = currentFacility();
  const centerGroups = [];
  const homeBtns = (state.config && state.config.homeButtons) || [];
  if (homeBtns.length) {
    centerGroups.push({ group: "Center Documents", buttons: homeBtns });
  }
  let facGroups = [];
  if (fac && fac.tabs && fac.tabs.sops) facGroups = fac.tabs.sops;

  let html =
    `<h1 class="erids-view-title">ATC Docs — ${esc(state.artcc)}${fac ? " / " + fac.label : ""}</h1>` +
    `<div class="erids-crumb">ATC Docs</div>` +
    `<span class="erids-badge">${esc(state.configSource)}</span>`;

  if (!fac) {
    html += `<p class="erids-meta">Showing center-level links. Open a facility for local SOPs.</p>`;
    html += renderButtonGroups(centerGroups, "docs");
    const allFacSops = ((state.config && state.config.facilities) || []).flatMap(
      (f) =>
        ((f.tabs && f.tabs.sops) || []).map((g) => ({
          group: f.label + " — " + (g.group || "SOPs"),
          buttons: g.buttons || [],
        }))
    );
    html += renderButtonGroups(allFacSops, "docs");
  } else {
    html += renderButtonGroups(centerGroups.concat(facGroups), "docs");
  }
  return html;
}

function renderCharts() {
  const fac = currentFacility();
  const facilities = (state.config && state.config.facilities) || [];
  const list = fac ? [fac] : facilities;

  let html =
    `<h1 class="erids-view-title">Charts — ${esc(state.artcc)}</h1>` +
    `<div class="erids-crumb">Charts · ChartFox</div>` +
    `<p class="erids-meta">Airport charts open inside ERIDS via ChartFox (<code>chartfox.org/ICAO</code>).</p>`;

  if (!list.length) {
    html += `<div class="erids-empty">No facilities configured.</div>`;
    return html;
  }

  html += `<div class="erids-facility-grid">`;
  list.forEach((f) => {
    const url = chartfoxUrl(f.id);
    html += `<button type="button" class="erids-btn erids-btn-lg" data-doc-viewer="1" data-doc-section="charts" data-doc-url="${esc(url)}" data-doc-title="${esc(f.label + " — ChartFox")}">${esc(f.label)}<br><span style="font-size:11px;font-weight:600;opacity:.85">${esc(f.id)}</span></button>`;
  });
  html += `</div>`;

  // Optional custom chart buttons from config
  if (fac && fac.tabs && fac.tabs.charts && fac.tabs.charts.length) {
    html +=
      `<div class="erids-section-bar">Configured chart links</div>` +
      `<div class="erids-btn-row">${fac.tabs.charts
        .map((b) =>
          linkButton(
            { label: b.label, url: b.url || chartfoxUrl(fac.id) },
            { section: "charts", facilityId: fac.id }
          )
        )
        .join("")}</div>`;
  }
  return html;
}

function collectSearchIndex() {
  const items = [];
  const cfg = state.config;
  if (!cfg) return items;
  (cfg.homeButtons || []).forEach((b) => {
    items.push({
      label: b.label,
      detail: "Center · " + (b.group || "Docs"),
      url: b.url,
      type: "link",
    });
  });
  (cfg.facilities || []).forEach((f) => {
    items.push({
      label: f.label + " (" + f.id + ")",
      detail: f.name || "Facility",
      type: "facility",
      facilityId: f.id,
    });
    const tabs = f.tabs || {};
    (tabs.approaches || []).forEach((row) => {
      (row.buttons || []).forEach((b) => {
        items.push({
          label: f.label + " " + row.runway + " " + b.label,
          detail: "Approach plate",
          url: b.url,
          type: "link",
        });
      });
    });
    ["sids", "stars", "runways", "sops", "comm", "remarks", "towerData"].forEach(
      (key) => {
        (tabs[key] || []).forEach((g) => {
          (g.buttons || []).forEach((b) => {
            items.push({
              label: b.label,
              detail: f.label + " · " + (g.group || key),
              url: b.url,
              type: "link",
            });
          });
        });
      }
    );
    (tabs.charts || []).forEach((b) => {
      items.push({
        label: b.label,
        detail: f.label + " · Chart",
        url: b.url,
        type: "link",
      });
    });
  });
  (cfg.contractions || []).forEach((c) => {
    items.push({
      label: c.abbr,
      detail: c.text,
      type: "contraction",
    });
  });
  return items;
}

function renderSearch(mode) {
  const q = (state.searchQ || "").trim().toLowerCase();
  const title = mode === "contractions" ? "Contractions Search" : "Search";
  const index = collectSearchIndex().filter((item) => {
    if (mode === "contractions" && item.type !== "contraction") return false;
    if (!q) return mode === "contractions" ? true : false;
    return (
      item.label.toLowerCase().includes(q) ||
      String(item.detail || "")
        .toLowerCase()
        .includes(q)
    );
  });

  let html =
    `<h1 class="erids-view-title">${esc(title)}</h1>` +
    `<div class="erids-crumb">${esc(title)}</div>` +
    `<div class="erids-form-row">` +
    `<input class="erids-input" id="eridsSearchQ" value="${esc(state.searchQ)}" placeholder="${mode === "contractions" ? "CFR, MIT, LOA…" : "Keyword…"}" aria-label="Search">` +
    `</div>`;

  if (!q && mode !== "contractions") {
    html += `<div class="erids-empty">Type a keyword to search facilities, plates, SOPs, charts, and contractions.</div>`;
  } else if (!index.length) {
    html += `<div class="erids-empty">No matches.</div>`;
  } else {
    html += `<div class="erids-btn-row">`;
    index.slice(0, 60).forEach((item) => {
      if (item.type === "facility") {
        html += `<button type="button" class="erids-btn" data-open-facility="${esc(item.facilityId)}">${esc(item.label)}</button>`;
      } else if (item.type === "contraction") {
        html += `<div class="erids-wx-card" style="min-width:180px;flex:1"><span class="icao">${esc(item.label)}</span><div class="raw">${esc(item.detail)}</div></div>`;
      } else if (item.url) {
        html += linkButton({ label: item.label, url: item.url });
      }
    });
    html += `</div>`;
  }
  return html;
}

function renderShortcuts() {
  const list = loadShortcuts();
  let html =
    `<h1 class="erids-view-title">User Shortcuts</h1>` +
    `<div class="erids-crumb">Shortcuts</div>` +
    `<p class="erids-meta">Stored in this browser only. Use Define Shortcuts, then tap a facility or link.</p>`;
  if (!list.length) {
    html += `<div class="erids-empty">No shortcuts yet.</div>`;
  } else {
    html += `<div class="erids-shortcut-list">`;
    list.forEach((s) => {
      if (s.view === "facility" || (s.id && s.id.startsWith("fac:"))) {
        const fid = s.facilityId || String(s.id || "").replace(/^fac:/, "");
        html += `<button type="button" class="erids-btn erids-btn-lg" data-open-facility="${esc(fid)}">${esc(s.label)}</button>`;
      } else if (s.url) {
        html += linkButton({ label: s.label, url: s.url });
      }
    });
    html += `</div>`;
    html += `<div class="erids-form-row" style="margin-top:16px"><button type="button" class="erids-btn" id="eridsClearShortcuts">Clear All Shortcuts</button></div>`;
  }
  return html;
}

function renderHelp() {
  return (
    `<h1 class="erids-view-title">Help</h1>` +
    `<div class="erids-crumb">Help</div>` +
    `<div class="erids-help">` +
    `<p>VATFLOW ERIDS is a touch-first mockup of the FAA En Route Information Display System for Center (ARTCC) controllers on VATSIM.</p>` +
    `<ul>` +
    `<li><b>Bottom icons</b> are always available — Home, Messages, WX, ATC Docs, Charts, Search, Help.</li>` +
    `<li><b>Back</b> steps one level (facility → home, etc.).</li>` +
    `<li><b>Live data:</b> Messages NOTAMs / SIGMETs and WX METARs refresh from existing VATFLOW weather hubs.</li>` +
    `<li><b>Charts / SOPs:</b> ChartFox and document links open in an ERIDS overlay. PDFs use an embedded PDF viewer (sign in required for proxy). Prefer direct <code>.pdf</code> URLs in Admin for best results — HTML pages that block framing need <b>Open Externally</b>.</li>` +
    `<li><b>Admin:</b> ARTCC editors/staff/admins can tap <b>Admin</b> to edit button labels and URLs; saves to the VATFLOW hub so everyone sees updates.</li>` +
    `<li><b>Shortcuts:</b> tap Define Shortcuts, then a facility or link; Show User Shortcuts lists them.</li>` +
    `<li>Pick an <b>ARTCC</b> in the header to change live weather scope and load that center’s pack (ZJX ships with demo content).</li>` +
    `</ul>` +
    `</div>`
  );
}

function adminFacility() {
  const list = (state.config && state.config.facilities) || [];
  const id = state.adminFacilityId || (list[0] && list[0].id) || null;
  return list.find((f) => f.id === id) || null;
}

function renderAdminButtonEditor(path, buttons) {
  const rows = (buttons || [])
    .map((b, i) => {
      return (
        `<div class="erids-admin-row">` +
        `<input data-admin-path="${esc(path)}" data-admin-idx="${i}" data-admin-field="label" value="${esc(b.label || "")}" placeholder="Label">` +
        `<input data-admin-path="${esc(path)}" data-admin-idx="${i}" data-admin-field="url" value="${esc(b.url || "")}" placeholder="https://…">` +
        `<button type="button" class="erids-btn" data-admin-del="${esc(path)}" data-admin-idx="${i}" style="min-height:40px">Del</button>` +
        `</div>`
      );
    })
    .join("");
  return (
    rows +
    `<div class="erids-form-row"><button type="button" class="erids-btn" data-admin-add="${esc(path)}">+ Add button</button></div>`
  );
}

function renderAdmin() {
  const canEdit = canEditArtcc(state.artcc);
  const facs = (state.config && state.config.facilities) || [];
  if (!state.adminFacilityId && facs[0]) state.adminFacilityId = facs[0].id;
  const fac = adminFacility();

  let html =
    `<h1 class="erids-view-title">Admin — ${esc(state.artcc)} links</h1>` +
    `<div class="erids-crumb">Admin</div>` +
    `<p class="erids-meta">Source: ${esc(state.configSource)}${state.configUpdatedAt ? " · hub updated " + esc(state.configUpdatedAt) : ""}</p>` +
    `<p class="erids-meta">Saves go to VATFLOW hub (<code>/erids/config</code>). If Save returns 404, merge/deploy <b>vatflow-hub PR #7</b> and set <code>ERIDS_FILE=/data/vatflow-erids.json</code> on Railway.</p>`;

  if (!isSignedIn()) {
    html +=
      `<div class="erids-empty">Sign in with VATSIM to edit ERIDS links.</div>` +
      `<div class="erids-form-row"><button type="button" class="erids-btn erids-btn-lg" id="eridsAdminLogin">Sign in with VATSIM</button></div>`;
    return html;
  }

  if (!canEdit) {
    html += `<div class="erids-empty">Your account cannot edit ${esc(state.artcc)}. Need editor/staff whitelist for this ARTCC (or global admin).</div>`;
    return html;
  }

  html +=
    `<div class="erids-form-row">` +
    `<button type="button" class="erids-btn erids-btn-lg" id="eridsAdminSave">Save to hub</button>` +
    `<button type="button" class="erids-btn" id="eridsAdminReload">Reload</button>` +
    `<button type="button" class="erids-btn" id="eridsAdminReset">Reset to bundled</button>` +
    `</div>` +
    `<div class="erids-admin-status ${esc(state.adminStatusKind)}" id="eridsAdminStatus">${esc(state.adminStatus)}</div>`;

  // Center home buttons
  html += `<div class="erids-admin-section"><div class="erids-section-bar">Center home buttons</div>`;
  html += renderAdminButtonEditor("homeButtons", (state.config && state.config.homeButtons) || []);
  html += `</div>`;

  // Facility picker
  html +=
    `<div class="erids-form-row">` +
    `<label class="erids-artcc-label" for="eridsAdminFac">Facility</label>` +
    `<select id="eridsAdminFac" class="erids-artcc-select">` +
    facs
      .map(
        (f) =>
          `<option value="${esc(f.id)}"${f.id === state.adminFacilityId ? " selected" : ""}>${esc(f.label)} (${esc(f.id)})</option>`
      )
      .join("") +
    `</select></div>`;

  if (!fac) {
    html += `<div class="erids-empty">No facilities in this pack.</div>`;
    return html;
  }

  const fox = chartfoxUrl(fac.id);
  html += `<p class="erids-meta">Default ChartFox URL for ${esc(fac.id)}: <a href="${esc(fox)}" target="_blank" rel="noopener">${esc(fox)}</a></p>`;

  // Approaches by runway
  html += `<div class="erids-admin-section"><div class="erids-section-bar">Approach plates (by runway)</div>`;
  const approaches = (fac.tabs && fac.tabs.approaches) || [];
  approaches.forEach((row, ri) => {
    html += `<div class="erids-section-bar" style="background:#2a2a4a">RWY ${esc(row.runway)}</div>`;
    html += renderAdminButtonEditor(`fac.${fac.id}.approaches.${ri}`, row.buttons || []);
  });
  html += `<div class="erids-form-row"><button type="button" class="erids-btn" id="eridsAdminAddRwy">+ Add runway row</button></div>`;
  html += `</div>`;

  // Other grouped tabs
  ["sids", "stars", "runways", "sops", "comm", "remarks", "towerData"].forEach((key) => {
    const groups = (fac.tabs && fac.tabs[key]) || [];
    html += `<div class="erids-admin-section"><div class="erids-section-bar">${esc(key)}</div>`;
    if (!groups.length) {
      html += `<div class="erids-empty">No groups. <button type="button" class="erids-btn" data-admin-add-group="${esc(key)}">+ Add group</button></div>`;
    } else {
      groups.forEach((g, gi) => {
        html +=
          `<div class="erids-form-row"><input data-admin-group-label="${esc(key)}" data-admin-gi="${gi}" value="${esc(g.group || "")}" placeholder="Group label" style="flex:1;min-height:40px;padding:6px 10px;background:#000010;border:2px solid var(--erids-blue-edge);border-radius:4px;color:var(--erids-yellow)"></div>`;
        html += renderAdminButtonEditor(`fac.${fac.id}.${key}.${gi}`, g.buttons || []);
      });
      html += `<div class="erids-form-row"><button type="button" class="erids-btn" data-admin-add-group="${esc(key)}">+ Add group</button></div>`;
    }
    html += `</div>`;
  });

  // Charts list (flat buttons)
  html += `<div class="erids-admin-section"><div class="erids-section-bar">charts (flat)</div>`;
  html += renderAdminButtonEditor(`fac.${fac.id}.charts`, (fac.tabs && fac.tabs.charts) || []);
  html += `</div>`;

  return html;
}

function resolveAdminPath(path) {
  if (!state.config) return null;
  if (path === "homeButtons") {
    if (!Array.isArray(state.config.homeButtons)) state.config.homeButtons = [];
    return { list: state.config.homeButtons };
  }
  const m = /^fac\.([A-Z0-9]+)\.(approaches|sids|stars|runways|sops|comm|remarks|towerData|charts)(?:\.(\d+))?$/.exec(path);
  if (!m) return null;
  const fac = ((state.config.facilities) || []).find((f) => f.id === m[1]);
  if (!fac) return null;
  if (!fac.tabs) fac.tabs = {};
  const key = m[2];
  if (key === "charts") {
    if (!Array.isArray(fac.tabs.charts)) fac.tabs.charts = [];
    return { list: fac.tabs.charts, fac, key };
  }
  if (key === "approaches") {
    if (!Array.isArray(fac.tabs.approaches)) fac.tabs.approaches = [];
    const idx = Number(m[3]);
    const row = fac.tabs.approaches[idx];
    if (!row) return null;
    if (!Array.isArray(row.buttons)) row.buttons = [];
    return { list: row.buttons, fac, key, row };
  }
  if (!Array.isArray(fac.tabs[key])) fac.tabs[key] = [];
  const gi = Number(m[3]);
  const group = fac.tabs[key][gi];
  if (!group) return null;
  if (!Array.isArray(group.buttons)) group.buttons = [];
  return { list: group.buttons, fac, key, group };
}

function renderMain() {
  switch (state.view) {
    case "home":
      return renderHome();
    case "facility":
      return renderFacilityTab();
    case "messages":
      return renderMessages();
    case "wx":
      return renderWx();
    case "docs":
      return renderDocs();
    case "charts":
      return renderCharts();
    case "search":
      return renderSearch("search");
    case "contractions":
      return renderSearch("contractions");
    case "shortcuts":
      return renderShortcuts();
    case "help":
      return renderHelp();
    case "admin":
      return renderAdmin();
    default:
      return renderHome();
  }
}

function render() {
  renderChrome();
  el.main.innerHTML = renderMain();
  el.main.scrollTop = 0;
}

async function onArtccChange(artcc) {
  state.artcc = artcc;
  localStorage.setItem(ARTCC_KEY, artcc);
  state.facilityId = null;
  state.view = "home";
  state.history = [];
  state.metars = [];
  const facs = (state.config && state.config.facilities) || [];
  // default WX ICAO from first facility of new config after load
  await loadConfig(artcc);
  const nextFacs = (state.config && state.config.facilities) || [];
  state.wxIcao = (nextFacs[0] && nextFacs[0].id) || "KJAX";
  void facs;
  render();
  refreshLive();
}

async function getMetar() {
  const input = document.getElementById("eridsWxIcao");
  const icao = normalizeIcao((input && input.value) || state.wxIcao);
  state.wxIcao = icao;
  try {
    const met = await fetchMetar(icao);
    state.metars = [met, ...state.metars.filter((m) => m.icao !== met.icao)].slice(
      0,
      MAX_METARS
    );
  } catch (err) {
    state.metars = [
      {
        icao,
        text: "",
        fltCat: "",
        error: (err && err.message) || "METAR fetch failed",
      },
      ...state.metars.filter((m) => m.icao !== icao),
    ].slice(0, MAX_METARS);
  }
  render();
}

function bindEvents() {
  el.artcc.addEventListener("change", () => onArtccChange(el.artcc.value));
  el.back.addEventListener("click", () => {
    if (state.viewerOpen) {
      closeDocViewer();
      return;
    }
    goBack();
  });

  el.define.addEventListener("click", () => {
    state.defineMode = !state.defineMode;
    document.body.classList.toggle("erids-define-mode", state.defineMode);
    el.define.classList.toggle("is-active", state.defineMode);
  });

  el.showSc.addEventListener("click", () => {
    navigate({ view: "shortcuts", showShortcuts: true });
  });

  el.contractions.addEventListener("click", () => {
    state.searchQ = "";
    navigate({ view: "contractions" });
  });

  el.facilityQuick.addEventListener("click", () => {
    if (!state.facilityId) return;
    navigate({
      view: "facility",
      primaryTab: "approaches",
      approachSub: "plates",
    });
  });

  if (el.adminBtn) {
    el.adminBtn.addEventListener("click", () => {
      navigate({ view: "admin" });
    });
  }

  if (el.viewerClose) {
    el.viewerClose.addEventListener("click", () => closeDocViewer());
  }

  if (el.pdfPrev) {
    el.pdfPrev.addEventListener("click", async () => {
      if (!state.pdfDoc || state.pdfPage <= 1) return;
      state.pdfPage -= 1;
      await renderPdfPage();
    });
  }
  if (el.pdfNext) {
    el.pdfNext.addEventListener("click", async () => {
      if (!state.pdfDoc || state.pdfPage >= state.pdfDoc.numPages) return;
      state.pdfPage += 1;
      await renderPdfPage();
    });
  }
  if (el.pdfZoomIn) {
    el.pdfZoomIn.addEventListener("click", async () => {
      state.pdfScale = Math.min(3, state.pdfScale + 0.2);
      await renderPdfPage();
    });
  }
  if (el.pdfZoomOut) {
    el.pdfZoomOut.addEventListener("click", async () => {
      state.pdfScale = Math.max(0.5, state.pdfScale - 0.2);
      await renderPdfPage();
    });
  }

  document.querySelectorAll(".erids-icon-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nav = btn.getAttribute("data-nav");
      if (!ICON_VIEWS.has(nav)) return;
      if (nav === "home") {
        navigate({ view: "home", facilityId: null });
      } else {
        navigate({ view: nav });
      }
      if (nav === "messages" || nav === "wx") {
        if (!state.notams || !state.sigmets) refreshLive();
      }
    });
  });

  el.primary.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-primary]");
    if (!btn || btn.getAttribute("aria-disabled") === "true") return;
    if (!currentFacility()) return;
    const id = btn.getAttribute("data-primary");
    navigate({ view: "facility", primaryTab: id });
  });

  el.secondary.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-sub]");
    if (!btn) return;
    navigate({
      view: "facility",
      primaryTab: "approaches",
      approachSub: btn.getAttribute("data-sub"),
    });
  });

  el.main.addEventListener("click", async (ev) => {
    const docBtn = ev.target.closest("[data-doc-viewer],[data-chart-viewer]");
    if (docBtn) {
      ev.preventDefault();
      if (state.defineMode && docBtn.getAttribute("data-shortcut-id")) {
        maybeCaptureShortcut({
          id: docBtn.getAttribute("data-shortcut-id"),
          label: docBtn.getAttribute("data-shortcut-label") || "Doc",
          url:
            docBtn.getAttribute("data-doc-url") ||
            docBtn.getAttribute("data-chart-url") ||
            docBtn.getAttribute("href") ||
            "",
          view: "",
          facilityId: state.facilityId,
        });
        return;
      }
      const url =
        docBtn.getAttribute("data-doc-url") ||
        docBtn.getAttribute("data-chart-url") ||
        docBtn.getAttribute("href") ||
        "";
      const title =
        docBtn.getAttribute("data-doc-title") ||
        docBtn.getAttribute("data-chart-title") ||
        docBtn.textContent ||
        "Document";
      const section =
        docBtn.getAttribute("data-doc-section") ||
        (docBtn.hasAttribute("data-chart-viewer") ? "charts" : "docs");
      if (url) openDocViewer(url, title.trim(), { section });
      return;
    }

    if (ev.target.id === "eridsAdminLogin") {
      ev.preventDefault();
      login(location.pathname + location.search + "#admin");
      return;
    }
    if (ev.target.id === "eridsAdminSave") {
      ev.preventDefault();
      try {
        state.adminStatus = "Saving…";
        state.adminStatusKind = "";
        render();
        const result = await saveHubEridsConfig(state.artcc, state.config);
        state.configSource = "hub";
        state.configUpdatedAt = result.updatedAt || new Date().toISOString();
        state.adminStatus = "Saved to hub.";
        state.adminStatusKind = "ok";
      } catch (err) {
        state.adminStatus = (err && err.message) || "Save failed";
        state.adminStatusKind = "err";
      }
      render();
      return;
    }
    if (ev.target.id === "eridsAdminReload") {
      ev.preventDefault();
      await loadConfig(state.artcc);
      state.adminStatus = "Reloaded.";
      state.adminStatusKind = "ok";
      render();
      return;
    }
    if (ev.target.id === "eridsAdminReset") {
      ev.preventDefault();
      try {
        await deleteHubEridsConfig(state.artcc);
      } catch (_) {
        /* hub may not have a pack yet */
      }
      if (state.bundledConfig) {
        state.config = structuredClone
          ? structuredClone(state.bundledConfig)
          : JSON.parse(JSON.stringify(state.bundledConfig));
      }
      state.configSource = "static";
      state.configUpdatedAt = null;
      state.adminStatus = "Reset to bundled JSON.";
      state.adminStatusKind = "ok";
      render();
      return;
    }
    if (ev.target.id === "eridsAdminAddRwy") {
      ev.preventDefault();
      const fac = adminFacility();
      if (!fac) return;
      if (!fac.tabs) fac.tabs = {};
      if (!Array.isArray(fac.tabs.approaches)) fac.tabs.approaches = [];
      fac.tabs.approaches.push({
        runway: "??",
        buttons: [{ label: "ILS", url: chartfoxUrl(fac.id) }],
      });
      render();
      return;
    }

    const addGroup = ev.target.getAttribute && ev.target.getAttribute("data-admin-add-group");
    if (addGroup) {
      ev.preventDefault();
      const fac = adminFacility();
      if (!fac) return;
      if (!fac.tabs) fac.tabs = {};
      if (!Array.isArray(fac.tabs[addGroup])) fac.tabs[addGroup] = [];
      fac.tabs[addGroup].push({
        group: "New group",
        buttons: [{ label: "New link", url: chartfoxUrl(fac.id) }],
      });
      render();
      return;
    }

    const addPath = ev.target.getAttribute && ev.target.getAttribute("data-admin-add");
    if (addPath) {
      ev.preventDefault();
      const resolved = resolveAdminPath(addPath);
      if (!resolved) return;
      const fac = adminFacility();
      resolved.list.push({
        label: "New link",
        url: fac ? chartfoxUrl(fac.id) : "",
      });
      render();
      return;
    }

    const delPath = ev.target.getAttribute && ev.target.getAttribute("data-admin-del");
    if (delPath != null && ev.target.hasAttribute("data-admin-idx")) {
      ev.preventDefault();
      const resolved = resolveAdminPath(delPath);
      const idx = Number(ev.target.getAttribute("data-admin-idx"));
      if (resolved && !isNaN(idx)) {
        resolved.list.splice(idx, 1);
        render();
      }
      return;
    }

    const t = ev.target.closest(
      "[data-open-facility],[data-goto-tab],[data-goto-view],[data-del-metar],[data-shortcut-id],#eridsWxGet,#eridsRefreshLive,#eridsClearShortcuts"
    );
    if (!t) return;

    if (t.id === "eridsWxGet") {
      ev.preventDefault();
      getMetar();
      return;
    }
    if (t.id === "eridsRefreshLive") {
      ev.preventDefault();
      refreshLive();
      return;
    }
    if (t.id === "eridsClearShortcuts") {
      ev.preventDefault();
      saveShortcuts([]);
      render();
      return;
    }

    const del = t.getAttribute("data-del-metar");
    if (del) {
      ev.preventDefault();
      state.metars = state.metars.filter((m) => m.icao !== del);
      render();
      return;
    }

    const openFac = t.getAttribute("data-open-facility");
    if (openFac) {
      ev.preventDefault();
      if (
        maybeCaptureShortcut({
          id: "fac:" + openFac,
          label: t.getAttribute("data-shortcut-label") || openFac,
          facilityId: openFac,
          view: "facility",
        })
      ) {
        return;
      }
      navigate({
        view: "facility",
        facilityId: openFac,
        primaryTab: "facilities",
      });
      return;
    }

    const gotoTab = t.getAttribute("data-goto-tab");
    if (gotoTab) {
      ev.preventDefault();
      navigate({ view: "facility", primaryTab: gotoTab });
      return;
    }

    const gotoView = t.getAttribute("data-goto-view");
    if (gotoView) {
      ev.preventDefault();
      navigate({ view: gotoView });
      return;
    }

    const scId = t.getAttribute("data-shortcut-id");
    if (scId && state.defineMode) {
      ev.preventDefault();
      maybeCaptureShortcut({
        id: scId,
        label: t.getAttribute("data-shortcut-label") || scId,
        url: t.getAttribute("data-shortcut-url") || "",
        view: t.getAttribute("data-shortcut-view") || "",
        facilityId: state.facilityId,
      });
    }
  });

  el.main.addEventListener("change", (ev) => {
    if (ev.target && ev.target.id === "eridsAdminFac") {
      state.adminFacilityId = ev.target.value;
      render();
    }
  });

  el.main.addEventListener("input", (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.id === "eridsSearchQ") {
      state.searchQ = t.value;
      const pos = t.selectionStart;
      render();
      const again = document.getElementById("eridsSearchQ");
      if (again) {
        again.focus();
        try {
          again.setSelectionRange(pos, pos);
        } catch (_) {}
      }
      return;
    }
    if (t.id === "eridsWxIcao") {
      state.wxIcao = t.value;
      return;
    }
    if (t.hasAttribute("data-admin-field")) {
      const path = t.getAttribute("data-admin-path");
      const idx = Number(t.getAttribute("data-admin-idx"));
      const field = t.getAttribute("data-admin-field");
      const resolved = resolveAdminPath(path);
      if (resolved && resolved.list[idx]) {
        resolved.list[idx][field] = t.value;
      }
      return;
    }
    if (t.hasAttribute("data-admin-group-label")) {
      const key = t.getAttribute("data-admin-group-label");
      const gi = Number(t.getAttribute("data-admin-gi"));
      const fac = adminFacility();
      if (fac && fac.tabs && fac.tabs[key] && fac.tabs[key][gi]) {
        fac.tabs[key][gi].group = t.value;
      }
    }
  });

  el.main.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    if (ev.target && ev.target.id === "eridsWxIcao") {
      ev.preventDefault();
      getMetar();
    }
  });

  window.addEventListener("vatflow-auth-changed", () => {
    if (el.adminBtn) renderChrome();
    if (state.view === "admin") render();
  });
}

function startClock() {
  const tick = () => {
    if (el.clock) el.clock.textContent = formatUtcClock();
  };
  tick();
  setInterval(tick, 1000);
}

async function init() {
  startClock();
  bindEvents();
  await initVatflowAuth().catch(() => null);
  try {
    await loadIndex();
  } catch (err) {
    state.index = { artccs: { ZJX: "zjx.json" }, defaultArtcc: "ZJX" };
    console.warn(err);
  }
  fillArtccSelect();
  try {
    await loadConfig(state.artcc);
  } catch (err) {
    state.config = {
      artcc: state.artcc,
      facilities: [],
      homeButtons: [],
      tmMessages: [],
      contractions: [],
    };
    console.warn(err);
  }
  const facs = (state.config && state.config.facilities) || [];
  state.wxIcao = (facs[0] && facs[0].id) || "KJAX";
  if (location.hash === "#admin") navigate({ view: "admin", push: false });
  else render();
  refreshLive();
}

init();
