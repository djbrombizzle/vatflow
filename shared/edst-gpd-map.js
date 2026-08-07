/**
 * EDST Graphical Plan Display (GPD) — Leaflet map for ARTCC traffic + routes.
 * Reuses FCA route geometry (route-engine + gcLine) and ARTCC boundary scope.
 * Expects global L (Leaflet) on the page.
 */
import { getArtccBounds, getArtccRings, fetchArtccBoundaries, normArtccId } from "./artcc-scope.js";
import { gcLine, getAirport, hasAirport, loadAirports } from "./fca-metering.js";
import {
  buildRoutePathLLs,
  isNavReady,
  loadNavData,
  bindAirports,
  trimAnchorsAhead,
} from "./route-engine.js";

const ARTCC_STYLE = { color: "#5a9ab8", weight: 1.5, opacity: 0.95, fill: false };
const SECTOR_STYLE = { color: "#8aa8b8", weight: 1, opacity: 0.75, fill: false };
const ROUTE_FAINT = { color: "#5a7a9a", weight: 1.25, opacity: 0.55 };
const ROUTE_SEL = { color: "#8ab4ff", weight: 2.5, opacity: 0.95 };
const ROUTE_ALERT_R = { color: "#e0483b", weight: 2.25, opacity: 0.95 };
const ROUTE_ALERT_Y = { color: "#dcd63f", weight: 2, opacity: 0.9 };
const ROUTE_ALERT_A = { color: "#e0913f", weight: 2, opacity: 0.9 };
const ROUTE_ALERT_R_DIM = { color: "#8a3030", weight: 2, opacity: 0.75 };
const ROUTE_ALERT_Y_DIM = { color: "#8a8030", weight: 1.75, opacity: 0.7 };
const ROUTE_ALERT_A_DIM = { color: "#8a5a28", weight: 1.75, opacity: 0.7 };
const AC_COLOR = "#49d3e6";
const AC_SEL = "#e0a13b";

/** @type {{ high: object|null, low: object|null }} */
const sectorCache = { high: null, low: null };
let sectorsLoading = null;

/** Normalize ARTCC id for sector property match (ZJX). */
export function sectorArtccKey(artccId) {
  return normArtccId(artccId || "").replace(/^K(?=Z)/, "");
}

/** Features for one ARTCC from a sector FeatureCollection. */
export function filterSectorsByArtcc(geojson, artccId) {
  const key = sectorArtccKey(artccId);
  if (!key || !geojson || !Array.isArray(geojson.features)) return [];
  return geojson.features.filter(f => {
    const a = ((f.properties && f.properties.artcc) || "").toUpperCase().replace(/^K(?=Z)/, "");
    return a === key;
  });
}

export function getSectorCache() {
  return sectorCache;
}

export async function loadSectorData(baseUrl = "") {
  if (sectorCache.high && sectorCache.low) return sectorCache;
  if (sectorsLoading) return sectorsLoading;
  const root = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  sectorsLoading = (async () => {
    const loadOne = async (name) => {
      try {
        const r = await fetch(root + "data/artcc-sectors-" + name + ".geojson");
        if (!r.ok) return null;
        return await r.json();
      } catch (_) {
        return null;
      }
    };
    const [high, low] = await Promise.all([loadOne("high"), loadOne("low")]);
    if (high) sectorCache.high = high;
    if (low) sectorCache.low = low;
    return sectorCache;
  })().finally(() => { sectorsLoading = null; });
  return sectorsLoading;
}

function routeStyleForAlert(sev, muted, selected) {
  if (selected && !sev) return ROUTE_SEL;
  if (sev === "r") return muted ? ROUTE_ALERT_R_DIM : ROUTE_ALERT_R;
  if (sev === "y") return muted ? ROUTE_ALERT_Y_DIM : ROUTE_ALERT_Y;
  if (sev === "a") return muted ? ROUTE_ALERT_A_DIM : ROUTE_ALERT_A;
  return selected ? ROUTE_SEL : ROUTE_FAINT;
}
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

function flightAsPilot(f) {
  const lat = f.lat != null ? +f.lat : null;
  const lon = f.lon != null ? +f.lon : null;
  const airborne = lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon);
  return {
    callsign: f.cs || f.callsign || "",
    lat: airborne ? lat : null,
    lon: airborne ? lon : null,
    hdg: f.hdg != null ? +f.hdg : null,
    dep: f.dep || "",
    arr: f.arr || "",
    route: f._routeRaw || f.route || "",
    // Board aircraft with a position are airborne for remaining-route trim.
    phase: airborne ? "air" : "gnd",
  };
}

/** Hub-expanded routeFixes → route-engine anchors (full filed track). */
function anchorsFromRouteFixes(f) {
  const fixes = f.routeFixes || f.route_fixes || null;
  if (!Array.isArray(fixes) || !fixes.length) return [];
  const anchors = [];
  for (const x of fixes) {
    const lat = x.lat != null ? +x.lat : (x.latitude != null ? +x.latitude : null);
    const lon = x.lon != null ? +x.lon : (x.longitude != null ? +x.longitude : null);
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = (x.name || x.fix || x.id || "").toString().toUpperCase();
    if (anchors.length) {
      const prev = anchors[anchors.length - 1].ll;
      if (prev[0] === lat && prev[1] === lon) continue;
    }
    anchors.push({ name: name || "FIX", ll: [lat, lon], kind: "fix" });
  }
  return anchors;
}

function pathFromAnchors(anchors) {
  const path = [];
  for (const a of anchors || []) {
    if (!a || !a.ll) continue;
    if (!path.length) path.push(a.ll.slice());
    else {
      const prev = path[path.length - 1];
      if (prev[0] !== a.ll[0] || prev[1] !== a.ll[1]) path.push(a.ll.slice());
    }
  }
  return path;
}

/**
 * Remaining route ahead of the aircraft (FCA builder / route-engine style).
 * Prefer hub-expanded routeFixes (SID/STAR already resolved) trimmed at NOW;
 * otherwise parse the filed route via route-engine.
 */
function routePathCoords(f) {
  const p = flightAsPilot(f);
  const airborne = p.phase === "air";
  let path = [];

  let hubAnchors = anchorsFromRouteFixes(f);
  if (hubAnchors.length >= 2) {
    if (airborne) hubAnchors = trimAnchorsAhead(hubAnchors, p);
    path = pathFromAnchors(hubAnchors);
  }

  if (path.length < 2 && isNavReady()) {
    path = buildRoutePathLLs(p, {
      origin: getAirport(p.dep),
      destination: getAirport(p.arr),
      includeNow: airborne,
    }) || [];
  }

  if (path.length < 2) {
    const anchors = [];
    if (airborne) {
      anchors.push({ name: "NOW", ll: [p.lat, p.lon], kind: "now" });
    } else {
      const dep = getAirport(p.dep);
      if (dep) anchors.push({ name: p.dep, ll: dep.slice(), kind: "apt" });
    }
    const arr = getAirport(p.arr);
    if (arr) anchors.push({ name: p.arr, ll: arr.slice(), kind: "apt" });
    path = pathFromAnchors(anchors);
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
  const tasks = [
    fetchArtccBoundaries(root),
    loadNavData(root + "data/nav").catch(() => null),
    loadAirports().catch(() => null),
    loadSectorData(root).catch(() => null),
  ];
  // Optional SUA for A-box / GPD — ignore failures
  try {
    const probe = await import("./edst-conflict-probe.js");
    tasks.push(probe.loadSuaData(root).catch(() => 0));
  } catch (_) { /* ignore */ }
  await Promise.all(tasks);
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
    attributionControl: false,
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  // Solid black canvas — no street/basemap tiles (ERAM-style GPD).
  if (containerEl && containerEl.style) containerEl.style.background = "#000";
  try { map.getContainer().style.background = "#000"; } catch (_) { /* ignore */ }

  const boundaryLayer = L.layerGroup().addTo(map);
  const sectorLayer = L.layerGroup().addTo(map);
  const labelLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const trafficLayer = L.layerGroup().addTo(map);

  let currentArtcc = "";
  let lastFlights = [];
  let selectedCs = null;
  let lastFitArtcc = "";
  let trafficCount = 0;
  let alertByCs = null; // Map or object: cs -> {r,y,a,rMuted,yMuted,aMuted,status}
  let alertShowFilter = null; // {type:'r'|'y'|'a', cs?:string} — Show / Show All
  let sectorMode = "off"; // 'off' | 'high' | 'low'
  const onSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;

  function drawSectors(artccId) {
    sectorLayer.clearLayers();
    if (sectorMode !== "high" && sectorMode !== "low") return;
    const gj = sectorCache[sectorMode];
    const feats = filterSectorsByArtcc(gj, artccId);
    for (const f of feats) {
      L.geoJSON(f, {
        style: SECTOR_STYLE,
        interactive: false,
      }).addTo(sectorLayer);
    }
  }

  function drawBoundary(artccId) {
    boundaryLayer.clearLayers();
    labelLayer.clearLayers();
    const id = normArtccId(artccId);
    if (!id) return;
    const rings = getArtccRings(id);
    if (!rings) return;
    for (const ring of rings) {
      L.polyline(ring, ARTCC_STYLE).addTo(boundaryLayer);
    }
    const bounds = getArtccBounds(id);
    if (bounds) {
      const c = L.latLngBounds(bounds).getCenter();
      L.marker(c, {
        interactive: false,
        icon: L.divIcon({
          className: "gpd-artcc-label",
          html: `<span>${escapeHtml(id)}</span>`,
          iconSize: [40, 14],
        }),
      }).addTo(labelLayer);
    }
  }

  function fitToArtcc(artccId, flights) {
    let bounds = null;
    const artccB = getArtccBounds(normArtccId(artccId));
    if (artccB) bounds = L.latLngBounds(artccB);
    for (const f of flights || []) {
      if (f.lat != null && f.lon != null) bounds = extendBounds(bounds, f.lat, f.lon);
    }
    if (bounds && bounds.isValid()) map.fitBounds(bounds.pad(0.1));
    else map.setView([39, -98], 4);
  }

  function alertEntry(cs) {
    if (!alertByCs) return null;
    if (typeof alertByCs.get === "function") return alertByCs.get(cs) || null;
    return alertByCs[cs] || null;
  }

  /** Conflict segments to overlay (optionally filtered by Show / Show ALL). */
  function conflictSegments(cs) {
    const e = alertEntry(cs);
    if (!e || e.status || !Array.isArray(e.segments)) return [];
    let segs = e.segments;
    if (alertShowFilter) {
      const t = alertShowFilter.type;
      const onlyCs = alertShowFilter.cs;
      if (onlyCs && onlyCs !== cs) return [];
      segs = segs.filter(s => s.sev === t);
    }
    // Worst-first draw order so red paints over yellow
    const rank = { r: 3, y: 2, a: 1 };
    return segs.slice().sort((a, b) => (rank[a.sev] || 0) - (rank[b.sev] || 0));
  }

  function renderRoutes(flights, sel) {
    routeLayer.clearLayers();
    for (const f of flights) {
      const cs = (f.cs || f.callsign || "").toUpperCase();
      const coords = routePathCoords(f);
      if (coords.length < 2) continue;
      const isSel = sel && cs === sel;
      // Full remaining route stays faint/selected — never paint the whole path alert-colored.
      L.polyline(coords, isSel ? ROUTE_SEL : ROUTE_FAINT).addTo(routeLayer);
      for (const seg of conflictSegments(cs)) {
        if (!seg.coords || seg.coords.length < 2) continue;
        L.polyline(seg.coords, routeStyleForAlert(seg.sev, !!seg.muted, false)).addTo(routeLayer);
      }
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
      drawSectors("");
      routeLayer.clearLayers();
      trafficLayer.clearLayers();
      trafficCount = 0;
      return;
    }
    drawBoundary(currentArtcc);
    drawSectors(currentArtcc);
    if (refit || lastFitArtcc !== currentArtcc) {
      fitToArtcc(currentArtcc, lastFlights);
      lastFitArtcc = currentArtcc;
    }
    renderRoutes(lastFlights, selectedCs);
    renderTraffic(lastFlights, selectedCs);
  }

  function setArtcc(artccId) {
    currentArtcc = normArtccId(artccId);
    render({ refit: true });
  }

  /**
   * Map Options sector lines: 'off' | 'high' | 'low'
   * @param {string} mode
   */
  function setSectorMode(mode) {
    const m = String(mode || "off").toLowerCase();
    sectorMode = (m === "high" || m === "low") ? m : "off";
    drawSectors(currentArtcc);
  }

  function getSectorMode() {
    return sectorMode;
  }

  /**
   * @param {object[]} flights liveFlights / board aircraft
   * @param {{ selectedCs?: string|null, artccId?: string, refit?: boolean,
   *           alertByCs?: Map|object|null, alertShowFilter?: object|null,
   *           sectorMode?: string }} [options]
   */
  function update(flights, options = {}) {
    if (options.artccId) currentArtcc = normArtccId(options.artccId);
    lastFlights = Array.isArray(flights) ? flights : [];
    if ("selectedCs" in options) {
      selectedCs = options.selectedCs ? String(options.selectedCs).toUpperCase() : null;
    }
    if ("alertByCs" in options) alertByCs = options.alertByCs || null;
    if ("alertShowFilter" in options) alertShowFilter = options.alertShowFilter || null;
    if ("sectorMode" in options && options.sectorMode != null) {
      const m = String(options.sectorMode).toLowerCase();
      sectorMode = (m === "high" || m === "low") ? m : "off";
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
  return {
    map, setArtcc, update, destroy, invalidateSize, getTrafficCount,
    setSectorMode, getSectorMode,
  };
}
