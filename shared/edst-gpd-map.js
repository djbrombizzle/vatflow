/**
 * EDST Graphical Plan Display (GPD) — Leaflet map for ARTCC traffic + routes.
 * Reuses FCA route geometry (route-engine + gcLine) and ARTCC boundary scope.
 * Expects global L (Leaflet) on the page.
 */
import { getArtccBounds, getArtccRings, fetchArtccBoundaries } from "./artcc-scope.js";
import { gcLine, getAirport, hasAirport, loadAirports } from "./fca-metering.js";
import { buildRoutePathLLs, isNavReady, loadNavData, bindAirports } from "./route-engine.js";

const ARTCC_STYLE = { color: "#3a9a9a", weight: 1.5, opacity: 0.9, fill: false };
const ROUTE_FAINT = { color: "#5a7a9a", weight: 1.25, opacity: 0.45, dashArray: "4 6" };
const ROUTE_SEL = { color: "#8ab4ff", weight: 2.5, opacity: 0.95, dashArray: "6 4" };
const AC_COLOR = "#49d3e6";
const AC_SEL = "#e0a13b";

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function planeIcon(color, hdg, selected) {
  const sz = selected ? 18 : 13;
  const svg = `<div style="position:relative;width:${sz}px;height:${sz}px">
    <div style="transform:rotate(${hdg || 0}deg);width:${sz}px;height:${sz}px">
      <svg viewBox="0 0 24 24" width="${sz}" height="${sz}">
        <path d="M12 2 L19 21 L12 16.5 L5 21 Z" fill="${color}" stroke="#0a0e14" stroke-width="1.2"/>
      </svg></div></div>`;
  return L.divIcon({ className: "", html: svg, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
}

/** Hub flight or board aircraft → [[lat,lon], ...] */
function routeAnchorsFromFlight(f) {
  const fixes = f.routeFixes || f.route_fixes || null;
  const pts = [];
  if (Array.isArray(fixes)) {
    for (const x of fixes) {
      const lat = x.lat != null ? +x.lat : (x.latitude != null ? +x.latitude : null);
      const lon = x.lon != null ? +x.lon : (x.longitude != null ? +x.longitude : null);
      if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!pts.length || pts[pts.length - 1][0] !== lat || pts[pts.length - 1][1] !== lon) {
        pts.push([lat, lon]);
      }
    }
  }
  const lat = f.lat != null ? +f.lat : null;
  const lon = f.lon != null ? +f.lon : null;
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    if (!pts.length) pts.push([lat, lon]);
    else {
      const first = pts[0];
      const dLat = first[0] - lat, dLon = first[1] - lon;
      if (dLat * dLat + dLon * dLon > 1e-8) pts.unshift([lat, lon]);
    }
  }
  return pts;
}

function routePathCoords(f) {
  let path = routeAnchorsFromFlight(f);
  if (path.length < 2 && isNavReady()) {
    const p = {
      callsign: f.cs || f.callsign || "",
      lat: f.lat, lon: f.lon,
      dep: f.dep, arr: f.arr,
      route: f._routeRaw || f.route || "",
      phase: "air",
    };
    path = buildRoutePathLLs(p, {
      origin: getAirport(p.dep),
      destination: getAirport(p.arr),
      includeNow: p.lat != null && p.lon != null,
    }) || [];
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
 * Resolve asset roots when the page lives under /vusalink/edst/.
 * @param {string} [repoRoot] absolute or relative path to vatflow root (trailing slash ok)
 */
export async function prepareEdstGpdData(repoRoot = "../../") {
  const root = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
  bindAirports(getAirport, hasAirport);
  await Promise.all([
    fetchArtccBoundaries(root),
    loadNavData(root + "data/nav").catch(() => null),
    loadAirports().catch(() => null),
  ]);
}

/**
 * @param {HTMLElement} containerEl
 * @param {{ onSelect?: (cs: string) => void }} [opts]
 * @returns {{ map, setArtcc, update, destroy, invalidateSize, getTrafficCount }}
 */
export function createEdstGpdMap(containerEl, opts = {}) {
  if (typeof L === "undefined") throw new Error("Leaflet (L) is required");

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
  const routeLayer = L.layerGroup().addTo(map);
  const trafficLayer = L.layerGroup().addTo(map);

  let currentArtcc = "";
  let lastFlights = [];
  let selectedCs = null;
  let lastFitArtcc = "";
  let trafficCount = 0;
  const onSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;

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
        icon: L.divIcon({
          className: "gpd-artcc-label",
          html: `<span>${escapeHtml(artccId)}</span>`,
          iconSize: [40, 14],
        }),
      }).addTo(labelLayer);
    }
  }

  function fitToArtcc(artccId, flights) {
    let bounds = null;
    const artccB = getArtccBounds(artccId);
    if (artccB) bounds = L.latLngBounds(artccB);
    for (const f of flights || []) {
      if (f.lat != null && f.lon != null) bounds = extendBounds(bounds, f.lat, f.lon);
    }
    if (bounds && bounds.isValid()) map.fitBounds(bounds.pad(0.1));
    else map.setView([39, -98], 4);
  }

  function renderRoutes(flights, sel) {
    routeLayer.clearLayers();
    for (const f of flights) {
      const cs = (f.cs || f.callsign || "").toUpperCase();
      const coords = routePathCoords(f);
      if (coords.length < 2) continue;
      const isSel = sel && cs === sel;
      L.polyline(coords, isSel ? ROUTE_SEL : ROUTE_FAINT).addTo(routeLayer);
    }
  }

  function renderTraffic(flights, sel) {
    trafficLayer.clearLayers();
    trafficCount = 0;
    let b;
    try { b = map.getBounds().pad(0.25); } catch (_) { return; }

    for (const f of flights) {
      const lat = f.lat != null ? +f.lat : null;
      const lon = f.lon != null ? +f.lon : null;
      if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (b && !b.contains([lat, lon])) continue;
      const cs = (f.cs || f.callsign || "").toUpperCase();
      const isSel = !!(sel && cs === sel);
      const color = isSel ? AC_SEL : AC_COLOR;
      const alt = f.alt != null ? f.alt : (f.fl != null ? f.fl : Math.round((f.altFt || 0) / 100));
      const m = L.marker([lat, lon], {
        icon: planeIcon(color, f.hdg || 0, isSel),
        keyboard: false,
        riseOnHover: true,
        zIndexOffset: isSel ? 600 : 0,
      });
      m.bindTooltip(
        `<b style="color:${color}">${escapeHtml(cs)}</b> ${escapeHtml(f.type || "")}<br>` +
        `${escapeHtml(f.dep || "????")} → ${escapeHtml(f.arr || "????")}<br>` +
        `FL${String(Math.round(alt || 0)).padStart(3, "0")}  ${f.gs || 0}kt`,
        { className: "gpd-tip", direction: "top", offset: [0, -6] },
      );
      if (onSelect && cs) {
        m.on("click", () => onSelect(cs));
      }
      m.addTo(trafficLayer);
      trafficCount++;
      if (trafficCount > 900) break;
    }
  }

  function render({ refit = false } = {}) {
    if (!currentArtcc) {
      drawBoundary("");
      routeLayer.clearLayers();
      trafficLayer.clearLayers();
      trafficCount = 0;
      return;
    }
    drawBoundary(currentArtcc);
    if (refit || lastFitArtcc !== currentArtcc) {
      fitToArtcc(currentArtcc, lastFlights);
      lastFitArtcc = currentArtcc;
    }
    renderRoutes(lastFlights, selectedCs);
    renderTraffic(lastFlights, selectedCs);
  }

  function setArtcc(artccId) {
    currentArtcc = (artccId || "").toUpperCase();
    render({ refit: true });
  }

  /**
   * @param {object[]} flights liveFlights / board aircraft
   * @param {{ selectedCs?: string|null, artccId?: string, refit?: boolean }} [options]
   */
  function update(flights, options = {}) {
    if (options.artccId) currentArtcc = String(options.artccId).toUpperCase();
    lastFlights = Array.isArray(flights) ? flights : [];
    if ("selectedCs" in options) {
      selectedCs = options.selectedCs ? String(options.selectedCs).toUpperCase() : null;
    }
    render({ refit: !!options.refit });
  }

  function invalidateSize() {
    try { map.invalidateSize(true); } catch (_) {}
  }

  function destroy() {
    try { map.remove(); } catch (_) {}
  }

  function getTrafficCount() { return trafficCount; }

  map.on("moveend zoomend", () => {
    if (!currentArtcc) return;
    renderTraffic(lastFlights, selectedCs);
  });

  map.setView([39, -98], 4);
  invalidateSize();
  return { map, setArtcc, update, destroy, invalidateSize, getTrafficCount };
}
