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
const ROUTE_FAINT = { color: "#5a7a9a", weight: 1.25, opacity: 0.45, dashArray: "4 6" };
const ROUTE_SEL = { color: "#8ab4ff", weight: 2.5, opacity: 0.95, dashArray: "6 4" };
const ROUTE_ALERT_R = { color: "#e0483b", weight: 2.25, opacity: 0.95, dashArray: "6 4" };
const ROUTE_ALERT_Y = { color: "#dcd63f", weight: 2, opacity: 0.9, dashArray: "6 4" };
const ROUTE_ALERT_A = { color: "#e0913f", weight: 2, opacity: 0.9, dashArray: "6 4" };
const ROUTE_ALERT_R_DIM = { color: "#8a3030", weight: 2, opacity: 0.75, dashArray: "4 6" };
const ROUTE_ALERT_Y_DIM = { color: "#8a8030", weight: 1.75, opacity: 0.7, dashArray: "4 6" };
const ROUTE_ALERT_A_DIM = { color: "#8a5a28", weight: 1.75, opacity: 0.7, dashArray: "4 6" };
const AC_COLOR = "#49d3e6";
const AC_SEL = "#e0a13b";

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
  let alertByCs = null; // Map or object: cs -> {r,y,a,rMuted,yMuted,aMuted,status}
  let alertShowFilter = null; // {type:'r'|'y'|'a', cs?:string} — Show / Show All
  const onSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;

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

  function routeSeverity(cs) {
    const e = alertEntry(cs);
    if (!e || e.status) return { sev: null, muted: false };
    if (alertShowFilter) {
      const t = alertShowFilter.type;
      const onlyCs = alertShowFilter.cs;
      if (onlyCs && onlyCs !== cs) return { sev: null, muted: false };
      if (t === "r" && e.r > 0) return { sev: "r", muted: !!e.rMuted };
      if (t === "y" && e.y > 0) return { sev: "y", muted: !!e.yMuted };
      if (t === "a" && e.a > 0) return { sev: "a", muted: !!e.aMuted };
      // Show All for type still draws others faint; highlight matching
      if (!onlyCs) {
        if (t === "r" && e.r > 0) return { sev: "r", muted: !!e.rMuted };
        if (t === "y" && e.y > 0) return { sev: "y", muted: !!e.yMuted };
        if (t === "a" && e.a > 0) return { sev: "a", muted: !!e.aMuted };
        return { sev: null, muted: false };
      }
      return { sev: null, muted: false };
    }
    if (e.r > 0) return { sev: "r", muted: !!e.rMuted };
    if (e.y > 0) return { sev: "y", muted: !!e.yMuted };
    if (e.a > 0) return { sev: "a", muted: !!e.aMuted };
    return { sev: null, muted: false };
  }

  function renderRoutes(flights, sel) {
    routeLayer.clearLayers();
    for (const f of flights) {
      const cs = (f.cs || f.callsign || "").toUpperCase();
      const coords = routePathCoords(f);
      if (coords.length < 2) continue;
      const isSel = sel && cs === sel;
      const { sev, muted } = routeSeverity(cs);
      L.polyline(coords, routeStyleForAlert(sev, muted, isSel)).addTo(routeLayer);
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
    currentArtcc = normArtccId(artccId);
    render({ refit: true });
  }

  /**
   * @param {object[]} flights liveFlights / board aircraft
   * @param {{ selectedCs?: string|null, artccId?: string, refit?: boolean,
   *           alertByCs?: Map|object|null, alertShowFilter?: object|null }} [options]
   */
  function update(flights, options = {}) {
    if (options.artccId) currentArtcc = normArtccId(options.artccId);
    lastFlights = Array.isArray(flights) ? flights : [];
    if ("selectedCs" in options) {
      selectedCs = options.selectedCs ? String(options.selectedCs).toUpperCase() : null;
    }
    if ("alertByCs" in options) alertByCs = options.alertByCs || null;
    if ("alertShowFilter" in options) alertShowFilter = options.alertShowFilter || null;
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
