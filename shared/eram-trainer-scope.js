/**
 * ERAM scope UI — draggable views, Zulu clock, toolbar (CRC ERAM docs).
 */

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function formatZulu(d = new Date()) {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  return `${pad2(h)}${pad2(m)} ${pad2(s)}`;
}

/**
 * Drag reposition per CRC: left-click drag on move handle.
 * @param {HTMLElement} el
 * @param {string} [handleSelector]
 */
export function makeDraggable(el, handleSelector) {
  if (!el) return;
  const handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (!handle) return;

  let startX = 0;
  let startY = 0;
  let origL = 0;
  let origT = 0;
  let dragging = false;

  function onDown(e) {
    if (e.button !== 0) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT") return;
    dragging = true;
    const r = el.getBoundingClientRect();
    origL = r.left;
    origT = r.top;
    startX = e.clientX;
    startY = e.clientY;
    el.style.transform = "none";
    el.style.left = `${origL}px`;
    el.style.top = `${origT}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    el.style.left = `${origL + dx}px`;
    el.style.top = `${origT + dy}px`;
  }

  function onUp() {
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }

  handle.addEventListener("mousedown", onDown);
}

export function startZuluClock(el, extraEl) {
  function tick() {
    const z = formatZulu();
    if (el) el.textContent = z;
    if (extraEl) extraEl.textContent = z;
  }
  tick();
  return setInterval(tick, 1000);
}

export function setMcaFeedback(el, lines, type) {
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

export function setResponseArea(el, { instruction, hint, cpdlc, extra }) {
  if (!el) return;
  let html = "";
  if (instruction) {
    html += `<div class="instr">TRAINER — ${escapeHtml(instruction)}</div>`;
  }
  if (hint) {
    html += `<div style="color:#8ab4d4">${escapeHtml(hint)}</div>`;
  }
  if (cpdlc) {
    html += `<div class="cpdlc">CPDLC: ${escapeHtml(cpdlc)}</div>`;
  }
  if (extra) {
    html += `<div>${escapeHtml(extra)}</div>`;
  }
  el.innerHTML = html || '<span style="color:#8a9088">Response Area — command output appears here</span>';
}

export function renderBeaconList(el, aircraft, selectedCs) {
  if (!el) return;
  const rows = (aircraft || []).map(ac => {
    const cs = (ac.cs || "").toUpperCase();
    const sq = ac.squawk || "1200";
    const active = cs === selectedCs ? " active" : "";
    return `<div class="${active.trim()}">${sq} ${cs}</div>`;
  });
  el.innerHTML = rows.join("") || '<span style="color:#666">—</span>';
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function initEramScopeUi(root = document) {
  makeDraggable(root.getElementById("mca"), ".mca-preview");
  makeDraggable(root.getElementById("mca"), ".mca-feedback");
  makeDraggable(root.getElementById("responseArea"), ".ra-drag");
  makeDraggable(root.getElementById("timeView"));
  makeDraggable(root.getElementById("trainerChecklist"), ".eram-pop-hdr");
  makeDraggable(root.getElementById("beaconView"), ".eram-pop-hdr");

  root.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-close");
      const panel = root.getElementById(id);
      if (panel) panel.classList.add("hidden");
    });
  });
}
