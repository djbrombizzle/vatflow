/**
 * Focused Leaflet map for ARTCC Dashboard — one center, FCA overlays, program traffic.
 * Expects global L (Leaflet) loaded on the page.
 */
import { getArtccBounds, getArtccRings } from "./artcc-scope.js";
import { computeSequence } from "./fca-metering.js";

const ARTCC_STYLE = { color: "#3a4d5e", weight: 1.5, opacity: 0.9, fill: false };

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function planeIcon(color, hdg, active, num) {
  const badge = active && num != null
    ? `<div style="position:absolute;top:-7px;right:-7px;background:${color};color:#13110a;border-radius:50%;
         width:13px;height:13px;font:700 9px/13px monospace;text-align:center;box-shadow:0 0 5px #000">${num}</div>`
    : "";
  const sz = active ? 16 : 12;
  const svg = `<div style="position:relative;width:${sz}px;height:${sz}px">
    <div style="transform:rotate(${hdg || 0}deg);width:${sz}px;height:${sz}px">
      <svg viewBox="0 0 24 24" width="${sz}" height="${sz}">
        <path d="M12 2 L19 21 L12 16.5 L5 21 Z" fill="${color}" stroke="#0a0e14" stroke-width="1.2"/>
      </svg></div>${badge}</div>`;
  return L.divIcon({ className: "", html: svg, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
}

/**
 * @param {HTMLElement} containerEl
 * @returns {{ map, setArtcc, update, render }}
 */
export function createArtccDashboardMap(containerEl) {
  const map = L.map(containerEl, {
    zoomControl: true,
    worldCopyJump: false,
    attributionControl: true,
  });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 20,
  }).addTo(map);

  const boundaryLayer = L.layerGroup().addTo(map);
  const labelLayer = L.layerGroup().addTo(map);
  const fcaLayer = L.layerGroup().addTo(map);
  const trafficLayer = L.layerGroup().addTo(map);

  let currentArtcc = "";
  let lastFcas = [];
  let lastPilots = [];
  let lastPrefiles = [];

  function drawBoundary(artccId) {
    boundaryLayer.clearLayers();
    labelLayer.clearLayers();
    const rings = getArtccRings(artccId);
    if (!rings) return;
    for (const ring of rings) {
      L.polyline(ring, ARTCC_STYLE).addTo(boundaryLayer);
    }
    const bounds = getArtccBounds(artccId);
    if (bounds) {
      const c = L.latLngBounds(bounds).getCenter();
      L.marker(c, {
        interactive: false,
        icon: L.divIcon({ className: "artcc-label", html: artccId, iconSize: [34, 12] }),
      }).addTo(labelLayer);
      map.fitBounds(L.latLngBounds(bounds).pad(0.08));
    }
  }

  function renderFcas(fcas) {
    fcaLayer.clearLayers();
    for (const f of fcas) {
      if (!f.enabled || !f.points || f.points.length < 2) continue;
      L.polyline(f.points, {
        color: f.color || "#e8a838",
        weight: 3,
        opacity: 0.85,
        dashArray: "2 6",
      }).addTo(fcaLayer);
      f.points.forEach((pt, i) => {
        if (i === 0 || i === f.points.length - 1) {
          L.circleMarker(pt, {
            radius: 3,
            color: f.color || "#e8a838",
            fillColor: f.color || "#e8a838",
            fillOpacity: 1,
            weight: 0,
          }).addTo(fcaLayer);
        }
      });
      const mid = f.points[Math.floor(f.points.length / 2)];
      L.marker(mid, {
        interactive: false,
        icon: L.divIcon({
          className: "artcc-label",
          html: `<span style="color:${f.color || "#e8a838"};text-shadow:0 0 6px #000">▮ ${escapeHtml(f.name || f.id)}</span>`,
          iconSize: [120, 12],
        }),
      }).addTo(fcaLayer);
    }
  }

  function renderTraffic(fcas, pilots, prefiles) {
    trafficLayer.clearLayers();
    const seqMap = new Map();
    for (const f of fcas) {
      if (!f.enabled || !f.points || f.points.length < 2) continue;
      const s = computeSequence(f, pilots, prefiles || [], { includeEdct: true });
      s.items.forEach((c, i) => {
        if (!seqMap.has(c.p.callsign)) {
          seqMap.set(c.p.callsign, { n: i + 1, color: f.color || "#e8a838", p: c.p });
        }
      });
    }
    let shown = 0;
    for (const p of pilots) {
      if (p.lat == null || p.lon == null) continue;
      const hit = seqMap.get(p.callsign);
      if (!hit) continue;
      if (shown > 500) break;
      const color = hit.color;
      const m = L.marker([p.lat, p.lon], {
        icon: planeIcon(color, p.hdg || 0, true, hit.n),
        keyboard: false,
        riseOnHover: true,
      });
      m.bindTooltip(
        `<b style="color:${color}">${escapeHtml(p.callsign)}</b> ${escapeHtml(p.type || "")}<br>` +
        `${escapeHtml(p.dep || "????")} → ${escapeHtml(p.arr || "????")}<br>` +
        `FL${String(Math.round((p.alt || 0) / 100)).padStart(3, "0")}  ${p.gs || 0}kt`,
        { className: "artcc-label", direction: "top", offset: [0, -6] },
      );
      m.addTo(trafficLayer);
      shown++;
    }
  }

  function render() {
    if (!currentArtcc) return;
    drawBoundary(currentArtcc);
    renderFcas(lastFcas);
    renderTraffic(lastFcas, lastPilots, lastPrefiles);
  }

  function setArtcc(artccId) {
    currentArtcc = (artccId || "").toUpperCase();
    render();
  }

  function update({ artccId, fcas, pilots, prefiles }) {
    if (artccId) currentArtcc = artccId.toUpperCase();
    lastFcas = fcas || [];
    lastPilots = pilots || [];
    lastPrefiles = prefiles || [];
    render();
  }

  map.invalidateSize();
  return { map, setArtcc, update, render };
}
