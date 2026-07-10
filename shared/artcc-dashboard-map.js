/**
 * Focused Leaflet map for ARTCC Dashboard — matches FCA TMU map styling.
 * Expects global L (Leaflet) loaded on the page.
 */
import { getArtccBounds, getArtccRings } from "./artcc-scope.js";
import {
  computeSequence, getAirport, gcLine,
} from "./fca-metering.js";
import { buildRoutePathLLs, isNavReady } from "./route-engine.js";

const ARTCC_STYLE = { color: "#3a4d5e", weight: 1, opacity: 0.85, fill: false };

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function delayColor(sec) {
  return sec < 30 ? "#56d364" : sec < 300 ? "#f5a623" : "#ff6b6b";
}

function planeIcon(color, hdg, active, num) {
  const badge = active && num != null
    ? `<div style="position:absolute;top:-7px;right:-7px;background:${color};color:#13110a;border-radius:50%;
         width:13px;height:13px;font:700 9px/13px monospace;text-align:center;box-shadow:0 0 5px #000">${num}</div>`
    : "";
  const sz = active ? 16 : 12;
  const svg = `<div class="plane" style="position:relative;width:${sz}px;height:${sz}px">
    <div style="transform:rotate(${hdg || 0}deg);width:${sz}px;height:${sz}px">
      <svg viewBox="0 0 24 24" width="${sz}" height="${sz}">
        <path d="M12 2 L19 21 L12 16.5 L5 21 Z" fill="${color}" stroke="#0a0e14" stroke-width="1.2"/>
      </svg></div>${badge}</div>`;
  return L.divIcon({ className: "", html: svg, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
}

function routePathCoords(p) {
  const dep = getAirport(p.dep);
  const arr = getAirport(p.arr);
  const airborne = p.lat != null && p.phase !== "gnd";
  let path;
  if (isNavReady()) {
    path = buildRoutePathLLs(p, {
      origin: dep,
      destination: arr,
      includeNow: airborne,
    });
  } else {
    path = [];
    if (dep) path.push(dep.slice());
    if (airborne) path.push([p.lat, p.lon]);
    if (arr) path.push(arr.slice());
  }
  if (path.length < 2) return [];
  let coords = [];
  for (let i = 0; i < path.length - 1; i++) {
    const seg = gcLine(path[i], path[i + 1]);
    if (i > 0) seg.shift();
    coords = coords.concat(seg);
  }
  return coords;
}

function extendBounds(bounds, lat, lon) {
  if (lat == null || lon == null) return bounds;
  const ll = L.latLng(lat, lon);
  return bounds ? bounds.extend(ll) : L.latLngBounds(ll, ll);
}

/**
 * @param {HTMLElement} containerEl
 * @returns {{ map, setArtcc, update, render }}
 */
export function createArtccDashboardMap(containerEl) {
  const map = L.map(containerEl, {
    zoomControl: false,
    worldCopyJump: false,
    attributionControl: true,
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 11,
    minZoom: 3,
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  }).addTo(map);

  const boundaryLayer = L.layerGroup().addTo(map);
  const labelLayer = L.layerGroup().addTo(map);
  const fcaLayer = L.layerGroup().addTo(map);
  const seqLayer = L.layerGroup().addTo(map);
  const trafficLayer = L.layerGroup().addTo(map);

  let currentArtcc = "";
  let lastFcas = [];
  let lastPilots = [];
  let lastPrefiles = [];
  let lastFitArtcc = "";

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
    }
  }

  function renderFcas(fcas) {
    fcaLayer.clearLayers();
    for (const f of fcas) {
      if (!f.enabled || !f.points || f.points.length < 2) continue;
      const color = f.color || "#e8a838";
      L.polyline(f.points, {
        color,
        weight: 2.5,
        opacity: 0.8,
        dashArray: "2 6",
      }).addTo(fcaLayer);
      f.points.forEach((pt, i) => {
        if (i === 0 || i === f.points.length - 1) {
          L.circleMarker(pt, {
            radius: 3,
            color,
            fillColor: color,
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
          html: `<span style="color:${color};text-shadow:0 0 6px #000,0 0 6px #000">▮ ${escapeHtml(f.name || f.id)}</span>`,
          iconSize: [120, 12],
        }),
      }).addTo(fcaLayer);
    }
  }

  function renderSequences(fcas, pilots, prefiles) {
    seqLayer.clearLayers();
    const seqMap = new Map();

    for (const f of fcas) {
      if (!f.enabled || !f.points || f.points.length < 2) continue;
      const color = f.color || "#e8a838";
      const s = computeSequence(f, pilots, prefiles || [], { includeEdct: true });
      const fullRoutes = s.items.length <= 40;

      s.items.forEach((c, i) => {
        if (!seqMap.has(c.p.callsign)) {
          seqMap.set(c.p.callsign, { n: i + 1, color, p: c.p, fca: f });
        }

        const col = delayColor(c.delay || 0);
        if (c.cross) {
          L.circleMarker([c.cross.lat, c.cross.lon], {
            radius: 4,
            color: col,
            fillColor: col,
            fillOpacity: 0.9,
            weight: 1,
          })
            .bindTooltip(`#${i + 1} ${escapeHtml(c.p.callsign)}`, { className: "artcc-label", direction: "top" })
            .addTo(seqLayer);
        }

        const o = (c.p.lat != null && c.p.lon != null) ? [c.p.lat, c.p.lon] : null;
        if (o || c.phase === "gnd") {
          const coords = fullRoutes ? routePathCoords(c.p) : [];
          if (coords.length >= 2) {
            L.polyline(coords, {
              color,
              weight: 1.5,
              opacity: 0.3,
              dashArray: "3 6",
            }).addTo(seqLayer);
          } else if (o && c.cross) {
            L.polyline([o, [c.cross.lat, c.cross.lon]], {
              color,
              weight: 1,
              opacity: 0.3,
              dashArray: "1 5",
            }).addTo(seqLayer);
          }
        }

        if (c.phase === "gnd" && !o) {
          const gndO = getAirport(c.p.dep);
          if (gndO) {
            L.marker(gndO, {
              icon: L.divIcon({
                className: "",
                iconSize: [12, 12],
                iconAnchor: [6, 6],
                html: `<div style="width:9px;height:9px;background:${color};border:1px solid #0a0e14;transform:rotate(45deg);box-shadow:0 0 6px ${color}"></div>`,
              }),
            })
              .bindTooltip(`${escapeHtml(c.p.callsign)} · ${escapeHtml(c.p.dep)}`, { className: "artcc-label", direction: "top" })
              .addTo(seqLayer);
          }
        }
      });
    }

    return seqMap;
  }

  function renderTraffic(seqMap, pilots) {
    trafficLayer.clearLayers();
    if (!map.getCenter()) return;
    let b;
    try { b = map.getBounds().pad(0.2); } catch (_) { return; }
    let shown = 0;

    for (const p of pilots) {
      if (p.lat == null || p.lon == null) continue;
      if (!b.contains([p.lat, p.lon])) continue;
      const hit = seqMap.get(p.callsign);
      const color = hit ? hit.color : (p.phase === "gnd" ? "#5e7184" : "#49d3e6");
      const active = !!hit;
      if (shown > 900) break;
      const m = L.marker([p.lat, p.lon], {
        icon: planeIcon(color, p.hdg || 0, active, hit ? hit.n : null),
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

  function fitToContent(fcas, pilots, prefiles, artccId) {
    let bounds = null;
    const artccB = getArtccBounds(artccId);
    if (artccB) bounds = L.latLngBounds(artccB);

    for (const f of fcas) {
      for (const pt of (f.points || [])) {
        bounds = extendBounds(bounds, pt[0], pt[1]);
      }
      const s = computeSequence(f, pilots, prefiles || [], { includeEdct: true });
      for (const c of s.items) {
        if (c.cross) bounds = extendBounds(bounds, c.cross.lat, c.cross.lon);
        if (c.p.lat != null) bounds = extendBounds(bounds, c.p.lat, c.p.lon);
        const gnd = getAirport(c.p.dep);
        if (gnd) bounds = extendBounds(bounds, gnd[0], gnd[1]);
      }
    }

    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.12));
      return;
    }
    if (artccB) map.fitBounds(L.latLngBounds(artccB).pad(0.08));
    else map.setView([39, -98], 4);
  }

  function render({ refit = false } = {}) {
    if (!currentArtcc) return;
    drawBoundary(currentArtcc);
    renderFcas(lastFcas);
    if (refit || lastFitArtcc !== currentArtcc) {
      fitToContent(lastFcas, lastPilots, lastPrefiles, currentArtcc);
      lastFitArtcc = currentArtcc;
    }
    const seqMap = renderSequences(lastFcas, lastPilots, lastPrefiles);
    renderTraffic(seqMap, lastPilots);
  }

  function setArtcc(artccId) {
    currentArtcc = (artccId || "").toUpperCase();
    render({ refit: true });
  }

  function update({ artccId, fcas, pilots, prefiles, refit }) {
    if (artccId) currentArtcc = artccId.toUpperCase();
    lastFcas = fcas || [];
    lastPilots = pilots || [];
    lastPrefiles = prefiles || [];
    render({ refit: !!refit });
  }

  map.on("moveend zoomend", () => {
    if (!currentArtcc || !map.getCenter()) return;
    const seqMap = renderSequences(lastFcas, lastPilots, lastPrefiles);
    renderTraffic(seqMap, lastPilots);
  });

  map.invalidateSize();
  return { map, setArtcc, update, render };
}
