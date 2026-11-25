/**
 * EDST Graphic Plan Display (GPD) map, ERAM style (RA-Position User Manual TI 6110.101, ch. 5).
 *
 * Leaflet does the projection, panning and zoom; the ERAM look is drawn on top:
 *  - map features (Map Features menu): own center (bold white), adjacent centers, sector boundaries (white),
 *    approach control boundaries (dashed gray), SAA (white, orange while alerting), airways (white),
 *    waypoints (+), navaids (circle), airports (box), each with optional labels;
 *  - aircraft (an HTML/SVG overlay): position symbol, direction-of-flight vector, leader line and the five-line
 *    data block (line 0 alerts, ACID, altitude, destination + ground speed, line 4). Suppressed aircraft get a
 *    limited block (symbol and altitude). Every field is clickable (onField);
 *  - routes, only when asked for: Show / Show All, the selected aircraft, trial plans (dashed, with a second
 *    leader labelled with the trial plan ID), route preview, and the points of a graphic trial plan.
 * Text and geometry helpers are in edst-gpd.js. Expects global L (Leaflet).
 */
import { getArtccBounds, getArtccRings, fetchArtccBoundaries, normArtccId } from "./artcc-scope.js";
import { gcLine, getAirport, hasAirport, loadAirports, airportEntries } from "./fca-metering.js";
import { buildRoutePathLLs, isNavReady, loadNavData, bindAirports, trimAnchorsAhead } from "./route-engine.js";
import {
  altLine, line4, alertCells, blockSeverity, destShort, pad3, rangeForZoom, zoomForRange, projectPosition,
  pathUpTo, placeBlocks,
} from "./edst-gpd.js";

const WHITE = "#e6e6e6";
const COL = { r: "#ff3b3b", y: "#ffd400", a: "#ff9a3c", w: WHITE, brown: "#c8913a", coral: "#ff7f50", trial: "#7fdcff" };
const CENTER_STYLE = { color: "#f2f2f2", weight: 2.6, opacity: 1, fill: false, interactive: false };
const ADJ_STYLE = { color: "#bdbdbd", weight: 1.6, opacity: 0.8, fill: false, interactive: false };
const SECTOR_STYLE = { color: "#d8d8d8", weight: 1, opacity: 0.75, fill: false, interactive: false };
const APCH_STYLE = { color: "#8c8c8c", weight: 1.2, opacity: 0.9, dashArray: "8 6", fill: false, interactive: false };
const SAA_STYLE = { color: "#9a9a9a", weight: 0.9, opacity: 0.8, fill: false, interactive: false };
const SAA_ALERT = { color: COL.a, weight: 1.8, opacity: 1, fill: false, interactive: false };
const AIRWAY_STYLE = { color: "#9a9a9a", weight: 0.8, opacity: 0.7, interactive: false };

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
  return geojson.features.filter((f) => {
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
        return r.ok ? await r.json() : null;
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

// ---- map feature data (loaded on first use, bucketed by 1° cell for drawing what is in view)
let ROOT = "../../";
const feat = { neighbors: null, apch: null, fixes: null, navaids: null, airways: null, airports: null, sua: null };
const featLoading = {};

function bucketize(entries) {
  const b = new Map();
  for (const e of entries) {
    const k = Math.floor(e.lat) + ":" + Math.floor(e.lon);
    let a = b.get(k);
    if (!a) b.set(k, (a = []));
    a.push(e);
  }
  return b;
}
function inBuckets(buckets, bounds, max) {
  const out = [];
  if (!buckets) return out;
  const s = Math.floor(bounds.getSouth()), n = Math.floor(bounds.getNorth());
  const w = Math.floor(bounds.getWest()), e = Math.floor(bounds.getEast());
  for (let la = s; la <= n; la++) {
    for (let lo = w; lo <= e; lo++) {
      const a = buckets.get(la + ":" + lo);
      if (!a) continue;
      for (const x of a) {
        if (bounds.contains([x.lat, x.lon])) out.push(x);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}
async function getJson(path) {
  const r = await fetch(ROOT + path);
  if (!r.ok) throw new Error(path + " HTTP " + r.status);
  return r.json();
}
/** Load one map feature set: neighbors | apch | fixes | navaids | airways | airports | sua. */
function loadFeature(name) {
  if (feat[name]) return Promise.resolve(feat[name]);
  if (featLoading[name]) return featLoading[name];
  const job = (async () => {
    if (name === "neighbors") feat.neighbors = await getJson("data/artcc-neighbors.json");
    else if (name === "apch") feat.apch = await getJson("data/pct-sectors.geojson");
    else if (name === "fixes") {
      const d = await getJson("data/nav/fixes.json");
      const list = [];
      for (const [id, pts] of Object.entries(d)) for (const p of pts || []) list.push({ id, lat: p[0], lon: p[1] });
      feat.fixes = bucketize(list);
    } else if (name === "navaids") {
      const d = await getJson("data/nav/navaids.json");
      const list = [];
      // navaids.json maps both the identifier and the name to positions; keep the identifiers.
      for (const [id, pts] of Object.entries(d)) if (id.length <= 3) for (const p of pts || []) list.push({ id, lat: p[0], lon: p[1] });
      feat.navaids = bucketize(list);
    } else if (name === "airways") {
      const d = await getJson("data/nav/airways.json");
      const segs = [];
      for (const [id, aw] of Object.entries(d)) {
        const w = (aw && aw.w) || [];
        for (let i = 0; i < w.length - 1; i++) {
          segs.push({ id, lat: (w[i][1] + w[i + 1][1]) / 2, lon: (w[i][2] + w[i + 1][2]) / 2, a: [w[i][1], w[i][2]], b: [w[i + 1][1], w[i + 1][2]] });
        }
      }
      feat.airways = bucketize(segs);
    } else if (name === "airports") {
      const list = [];
      for (const [id, ll] of airportEntries()) {
        // Towered-size airports have ICAO-style ids; skip 3-character private strips from VATSpy.
        if (/^[A-Z]{4}$/.test(id)) list.push({ id, lat: ll[0], lon: ll[1] });
      }
      if (!list.length) throw new Error("airports not loaded yet");
      feat.airports = bucketize(list);
    } else if (name === "sua") {
      const probe = await import("./edst-conflict-probe.js");
      await probe.loadSuaData(ROOT);
      const polys = probe.getSuaPolys ? probe.getSuaPolys() : [];
      if (!polys.length) throw new Error("no SAA data");
      feat.sua = polys.map((p) => {
        let la = 0, lo = 0, n = 0;
        for (const c of p.rings[0] || []) { lo += c[0]; la += c[1]; n++; }
        return { ...p, lat: n ? la / n : 0, lon: n ? lo / n : 0 };
      });
    }
    return feat[name];
  })().finally(() => { delete featLoading[name]; });
  featLoading[name] = job;
  return job;
}

// ---- routes
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
    phase: airborne ? "air" : "gnd",
  };
}
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
function densify(path) {
  if (path.length < 2) return [];
  let coords = [];
  for (let i = 0; i < path.length - 1; i++) {
    const seg = gcLine(path[i], path[i + 1]);
    if (i > 0) seg.shift();
    coords = coords.concat(seg);
  }
  return coords;
}
/** Remaining route ahead of the aircraft: hub routeFixes trimmed at the aircraft, else the route engine. */
export function routePathCoords(f) {
  const p = flightAsPilot(f);
  const airborne = p.phase === "air";
  let path = [];
  let anchors = anchorsFromRouteFixes(f);
  if (anchors.length >= 2) {
    if (airborne) anchors = trimAnchorsAhead(anchors, p);
    path = anchors.map((a) => a.ll.slice());
    if (airborne) path.unshift([p.lat, p.lon]);
  }
  if (path.length < 2 && isNavReady()) {
    path = buildRoutePathLLs(p, { origin: getAirport(p.dep), destination: getAirport(p.arr), includeNow: airborne }) || [];
  }
  if (path.length < 2) {
    path = [];
    if (airborne) path.push([p.lat, p.lon]);
    else { const d = getAirport(p.dep); if (d) path.push(d.slice()); }
    const a = getAirport(p.arr);
    if (a) path.push(a.slice());
  }
  return densify(path);
}
/** A trial plan's path: its explicit points (graphic trial) or its route string through the route engine. */
function trialPathCoords(f, route, fixes) {
  if (Array.isArray(fixes) && fixes.length) {
    const pts = [];
    if (f.lat != null && f.lon != null) pts.push([+f.lat, +f.lon]);
    for (const x of fixes) if (x && x.lat != null && x.lon != null) pts.push([+x.lat, +x.lon]);
    const arr = getAirport(f.arr);
    if (arr) pts.push(arr.slice());
    return densify(pts);
  }
  return routePathCoords({ ...f, _routeRaw: route, route, routeFixes: null });
}

export async function prepareEdstGpdData(repoRoot = "../../") {
  const root = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
  ROOT = root;
  bindAirports(getAirport, hasAirport);
  await Promise.all([
    fetchArtccBoundaries(root),
    loadNavData(root + "data/nav").catch(() => null),
    loadAirports().catch(() => null),
    loadSectorData(root).catch(() => null),
    loadFeature("sua").catch(() => null),
  ]);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * @param {HTMLElement} containerEl
 * @param {{onField?: (cs, field, ev, extra) => void, onMapClick?: (latlng, ev) => void,
 *          onView?: ({rangeNm, center}) => void}} [opts]
 */
export function createEdstGpdMap(containerEl, opts = {}) {
  if (typeof L === "undefined") throw new Error("Leaflet (L) is required");
  const map = L.map(containerEl, {
    zoomControl: false, attributionControl: false, worldCopyJump: false,
    zoomSnap: 0, zoomDelta: 0.5, wheelPxPerZoomLevel: 140, doubleClickZoom: false,
    zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
  });
  containerEl.style.background = "#000";
  const canvas = L.canvas({ padding: 0.3 });
  const lines = {
    adj: L.layerGroup().addTo(map), center: L.layerGroup().addTo(map), sector: L.layerGroup().addTo(map),
    apch: L.layerGroup().addTo(map), saa: L.layerGroup().addTo(map), airway: L.layerGroup().addTo(map),
    route: L.layerGroup().addTo(map),
  };
  // Point symbols and labels (canvas) and aircraft (HTML + SVG) sit above the map panes.
  const pointCanvas = document.createElement("canvas");
  pointCanvas.className = "gpd-points";
  const overlay = document.createElement("div");
  overlay.className = "gpd-overlay";
  containerEl.appendChild(pointCanvas);
  containerEl.appendChild(overlay);

  let S = {
    artccId: "", flights: [], selectedCs: null, alertByCs: null, ackedFor: null, shownRoutes: new Set(),
    showFilter: null, trials: [], futureMin: 0, suppress: false, nonAdsb: null, altInfo: null, graphic: null,
    saaAlert: new Set(), selTrialId: null, selAlert: null,
    features: { sectors: "off", adjacent: true, apch: true, saa: true, saaLabels: false, airports: false,
      airportLabels: false, navaids: false, navaidLabels: false, waypoints: false, waypointLabels: false, airways: false },
    ac: { autoOffset: true, previewMin: 0 },
  };
  let drawnArtcc = "", drawnSectors = "", drawnAdj = null, drawnApch = null;
  const pathCache = new Map();   // cs -> {key, coords}
  let routeArrows = [];          // [{coords, color}]: direction arrows drawn along displayed routes

  function alertEntry(cs) {
    const m = S.alertByCs;
    if (!m) return null;
    return typeof m.get === "function" ? m.get(cs) || null : m[cs] || null;
  }
  function pathFor(f) {
    const cs = f.cs;
    const key = (f._routeRaw || f.route || "") + "|" + (f.lat != null ? (+f.lat).toFixed(2) : "") + "," + (f.lon != null ? (+f.lon).toFixed(2) : "");
    const c = pathCache.get(cs);
    if (c && c.key === key) return c.coords;
    const coords = routePathCoords(f);
    pathCache.set(cs, { key, coords });
    return coords;
  }
  function rangeNm() {
    return rangeForZoom(map.getZoom(), containerEl.clientWidth || 800, map.getCenter().lat);
  }

  // ---- boundaries
  function drawCenter() {
    lines.center.clearLayers();
    const id = normArtccId(S.artccId);
    for (const ring of getArtccRings(id) || []) L.polyline(ring, { ...CENTER_STYLE, renderer: canvas }).addTo(lines.center);
  }
  function drawSectors() {
    lines.sector.clearLayers();
    const mode = S.features.sectors;
    if (mode !== "high" && mode !== "low") return;
    for (const f of filterSectorsByArtcc(sectorCache[mode], S.artccId)) {
      L.geoJSON(f, { style: { ...SECTOR_STYLE }, renderer: canvas, interactive: false }).addTo(lines.sector);
    }
  }
  function drawAdjacent() {
    lines.adj.clearLayers();
    if (!S.features.adjacent) return;
    loadFeature("neighbors").then((nb) => {
      if (!S.features.adjacent) return;
      lines.adj.clearLayers();
      const id = normArtccId(S.artccId).replace(/^K(?=Z)/, "");
      for (const n of (nb && nb[id]) || []) {
        for (const ring of getArtccRings(n) || []) L.polyline(ring, { ...ADJ_STYLE, renderer: canvas }).addTo(lines.adj);
      }
    }).catch(() => {});
  }
  function drawApch() {
    lines.apch.clearLayers();
    if (!S.features.apch) return;
    loadFeature("apch").then((gj) => {
      if (!S.features.apch) return;
      lines.apch.clearLayers();
      L.geoJSON(gj, { style: { ...APCH_STYLE }, renderer: canvas, interactive: false }).addTo(lines.apch);
    }).catch(() => {});
  }
  function drawSaa() {
    lines.saa.clearLayers();
    if (!S.features.saa || !feat.sua) return;
    const b = map.getBounds().pad(0.3);
    for (const p of feat.sua) {
      if (!b.contains([p.lat, p.lon])) continue;
      const alert = S.saaAlert && S.saaAlert.has(p.name);
      for (const ring of p.rings) {
        L.polyline(ring.map((c) => [c[1], c[0]]), { ...(alert ? SAA_ALERT : SAA_STYLE), renderer: canvas }).addTo(lines.saa);
      }
    }
  }
  function drawAirways(range) {
    lines.airway.clearLayers();
    if (!S.features.airways || range > 400) return;
    loadFeature("airways").then((bk) => {
      lines.airway.clearLayers();
      if (!S.features.airways) return;
      const b = map.getBounds().pad(0.2);
      for (const s of inBuckets(bk, b, 6000)) L.polyline([s.a, s.b], { ...AIRWAY_STYLE, renderer: canvas }).addTo(lines.airway);
    }).catch(() => {});
  }
  function drawBoundaries(force) {
    if (force || drawnArtcc !== S.artccId) { drawCenter(); drawnArtcc = S.artccId; drawnAdj = null; drawnApch = null; drawnSectors = ""; }
    if (drawnSectors !== S.features.sectors) { drawSectors(); drawnSectors = S.features.sectors; }
    if (drawnAdj !== S.features.adjacent) { drawAdjacent(); drawnAdj = S.features.adjacent; }
    if (drawnApch !== S.features.apch) { drawApch(); drawnApch = S.features.apch; }
  }

  // ---- point features (canvas): waypoints +, navaids circle, airports box, SAA labels
  function drawPoints() {
    const w = containerEl.clientWidth, h = containerEl.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (pointCanvas.width !== Math.round(w * dpr) || pointCanvas.height !== Math.round(h * dpr)) {
      pointCanvas.width = Math.round(w * dpr); pointCanvas.height = Math.round(h * dpr);
      pointCanvas.style.width = w + "px"; pointCanvas.style.height = h + "px";
    }
    const g = pointCanvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = "11px ERAM, EDST, EDSTv2, Consolas, monospace";
    g.lineWidth = 1;
    const range = rangeNm() * 0.97;   // the Range button rounds: "400" may be 400.3
    const b = map.getBounds();
    const F = S.features;
    const label = (x, y, t) => { g.fillStyle = "#cfcfcf"; g.fillText(t, x + 6, y - 4); };
    const want = [];
    if ((F.waypoints || F.waypointLabels) && range <= 200) want.push("fixes");
    if ((F.navaids || F.navaidLabels) && range <= 500) want.push("navaids");
    if ((F.airports || F.airportLabels) && range <= 400) want.push("airports");
    want.forEach((n) => { if (!feat[n]) loadFeature(n).then(() => drawPoints()).catch(() => {}); });
    if (feat.fixes && want.includes("fixes")) {
      g.strokeStyle = WHITE;
      for (const p of inBuckets(feat.fixes, b, 1500)) {
        const pt = map.latLngToContainerPoint([p.lat, p.lon]);
        if (F.waypoints) { g.beginPath(); g.moveTo(pt.x - 4, pt.y); g.lineTo(pt.x + 4, pt.y); g.moveTo(pt.x, pt.y - 4); g.lineTo(pt.x, pt.y + 4); g.stroke(); }
        if (F.waypointLabels) label(pt.x, pt.y, p.id);
      }
    }
    if (feat.navaids && want.includes("navaids")) {
      g.strokeStyle = WHITE;
      for (const p of inBuckets(feat.navaids, b, 600)) {
        const pt = map.latLngToContainerPoint([p.lat, p.lon]);
        if (F.navaids) { g.beginPath(); g.arc(pt.x, pt.y, 5, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2); g.fillStyle = WHITE; g.fill(); }
        if (F.navaidLabels) label(pt.x, pt.y, p.id);
      }
    }
    if (F.airports || F.airportLabels) {
      // Zoomed in: every airport in view. Zoomed out (too many to read): your traffic's departure and arrival airports.
      let list = [];
      if (feat.airports && want.includes("airports")) list = inBuckets(feat.airports, b, 800);
      else if (!want.includes("airports")) {
        const seen = new Set();
        for (const f of S.flights) {
          for (const id of [f.dep, f.arr]) {
            const k = String(id || "").toUpperCase();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            const ll = getAirport(k);
            if (ll && b.contains(ll)) list.push({ id: k, lat: ll[0], lon: ll[1] });
          }
        }
      }
      g.strokeStyle = WHITE;
      for (const p of list) {
        const pt = map.latLngToContainerPoint([p.lat, p.lon]);
        if (F.airports) g.strokeRect(pt.x - 4, pt.y - 4, 8, 8);
        if (F.airportLabels) label(pt.x, pt.y, p.id);
      }
    }
    if (F.saa && F.saaLabels && feat.sua) {
      for (const p of feat.sua) {
        if (!b.contains([p.lat, p.lon])) continue;
        const pt = map.latLngToContainerPoint([p.lat, p.lon]);
        g.fillStyle = S.saaAlert && S.saaAlert.has(p.name) ? COL.a : "#cfcfcf";
        g.fillText(String(p.name || "").replace(/,.*$/, ""), pt.x - 20, pt.y);
      }
    }
  }

  // ---- routes
  function routeSet() {
    const set = new Set(S.shownRoutes || []);
    if (S.selectedCs) set.add(S.selectedCs);
    const sf = S.showFilter;
    if (sf) {
      if (sf.cs) {
        set.add(sf.cs);
        const e = alertEntry(sf.cs);
        ((e && e.partners && e.partners[sf.type]) || []).forEach((p) => set.add(p));
      } else {
        for (const f of S.flights) { const e = alertEntry(f.cs); if (e && !e.status && e[sf.type] > 0) set.add(f.cs); }
      }
    }
    return set;
  }
  function drawRoutes() {
    lines.route.clearLayers();
    routeArrows = [];
    const byCs = new Map(S.flights.map((f) => [f.cs, f]));
    const set = routeSet();
    // Route preview (AC Display): the next N minutes for every aircraft with a full data block.
    if (S.ac.previewMin > 0) {
      for (const f of S.flights) {
        if (set.has(f.cs) || f.lat == null || !(+f.gs > 60)) continue;
        const c = pathUpTo(pathFor(f), (+f.gs / 60) * S.ac.previewMin);
        if (c.length >= 2) L.polyline(c, { color: "#b0b0b0", weight: 1, opacity: 0.8, interactive: false }).addTo(lines.route);
      }
    }
    for (const cs of set) {
      const f = byCs.get(cs);
      if (!f) continue;
      const coords = pathFor(f);
      if (coords.length < 2) continue;
      const e = alertEntry(cs);
      const sev = blockSeverity(e, S.ackedFor ? S.ackedFor(cs) : null);
      L.polyline(coords, { color: COL[sev] || WHITE, weight: cs === S.selectedCs ? 2 : 1.6, opacity: 0.95, interactive: false }).addTo(lines.route);
      routeArrows.push({ coords, color: COL[sev] || WHITE });
      const sf = S.showFilter;
      for (const seg of (e && !e.status && e.segments) || []) {
        if (sf && sf.type !== seg.sev) continue;
        if (!seg.coords || seg.coords.length < 2) continue;
        L.polyline(seg.coords, { color: COL[seg.sev], weight: 4.5, opacity: seg.muted ? 0.55 : 1, interactive: false }).addTo(lines.route);
      }
    }
    for (const t of S.trials || []) {
      const f = byCs.get(t.cs);
      if (!f) continue;
      const coords = trialPathCoords(f, t.route, t.fixes);
      if (coords.length < 2) continue;
      L.polyline(coords, { color: COL[t.sev] || COL.trial, weight: t.id === S.selTrialId ? 2.4 : 1.6, dashArray: "7 5", opacity: 0.95, interactive: false }).addTo(lines.route);
      routeArrows.push({ coords, color: COL[t.sev] || COL.trial });
    }
    const gr = S.graphic;
    if (gr && gr.points && byCs.get(gr.cs)) {
      const f = byCs.get(gr.cs);
      const pts = [[+f.lat, +f.lon]].concat(gr.points);
      L.polyline(pts, { color: COL.trial, weight: 1.8, dashArray: "4 4", interactive: false }).addTo(lines.route);
      gr.points.forEach((p) => L.circleMarker(p, { radius: 3, color: COL.trial, weight: 1.5, fill: false, interactive: false }).addTo(lines.route));
    }
  }

  // ---- aircraft overlay
  function drawAircraft() {
    const w = containerEl.clientWidth, h = containerEl.clientHeight;
    const set = routeSet();
    const trialsByCs = new Map();
    (S.trials || []).forEach((t) => { if (!trialsByCs.has(t.cs)) trialsByCs.set(t.cs, []); trialsByCs.get(t.cs).push(t); });
    const items = [];
    for (const f of S.flights) {
      if (f.lat == null || f.lon == null) continue;
      const pos = S.futureMin > 0 ? projectPosition(f, pathFor(f), S.futureMin) : { lat: +f.lat, lon: +f.lon, hdg: +f.hdg || 0 };
      if (!pos) continue;
      const pt = map.latLngToContainerPoint([pos.lat, pos.lon]);
      if (pt.x < -80 || pt.y < -80 || pt.x > w + 80 || pt.y > h + 80) continue;
      const cs = f.cs;
      const full = !S.suppress || set.has(cs) || trialsByCs.has(cs) || cs === S.selectedCs;
      const e = alertEntry(cs);
      const acked = S.ackedFor ? S.ackedFor(cs) : null;
      const sev = blockSeverity(e, acked);
      const ai = S.altInfo ? S.altInfo(cs, f) : {};
      const info = { present: f.alt, assigned: ai.assigned, interim: ai.interim, block: ai.block };
      const alt = altLine(info);
      if (!full) { items.push({ f, cs, pt, pos, full, sev, alt }); continue; }
      const l4 = line4(info);
      const cells = alertCells(e, acked);
      const l0 = cells.some((c) => c.text);
      const dest = destShort(f.arr) || "----";
      const gs = pad3(f.gs || 0);
      const nLines = 3 + (l0 ? 1 : 0) + (l4 ? 1 : 0);
      const chars = Math.max(cs.length, alt.length, (dest + " " + gs).length, l4.length, 5);
      items.push({ f, cs, pt, pos, full, sev, alt, l4, cells, l0, dest, gs, w: chars * 7.4 + 6, h: nLines * 13 + 2 });
    }
    const fulls = items.filter((i) => i.full);
    const placed = placeBlocks(fulls.map((i) => ({ x: i.pt.x, y: i.pt.y, w: i.w, h: i.h })), { auto: S.ac.autoOffset });
    fulls.forEach((it, k) => { it.place = placed[k]; });

    let svg = "", html = "";
    for (const ra of routeArrows) {
      let carry = 55, prev = null;
      for (const ll of ra.coords) {
        const q = map.latLngToContainerPoint(ll);
        if (prev) {
          const dx = q.x - prev.x, dy = q.y - prev.y, len = Math.hypot(dx, dy);
          let at = carry;
          while (at < len) {
            const x0 = prev.x + (dx * at) / len, y0 = prev.y + (dy * at) / len;
            if (x0 > -10 && y0 > -10 && x0 < w + 10 && y0 < h + 10) {
              const ux = dx / len, uy = dy / len;
              svg += `<path d="M${(x0 - ux * 7 - uy * 4).toFixed(1)} ${(y0 - uy * 7 + ux * 4).toFixed(1)}L${x0.toFixed(1)} ${y0.toFixed(1)}L${(x0 - ux * 7 + uy * 4).toFixed(1)} ${(y0 - uy * 7 - ux * 4).toFixed(1)}" fill="none" stroke="${ra.color}" stroke-width="1.6"/>`;
            }
            at += 110;
          }
          carry = at - len;
        }
        prev = q;
      }
    }
    for (const it of items) {
      const { pt, cs } = it;
      const color = COL[it.sev] || WHITE;
      const x = pt.x.toFixed(1), y = pt.y.toFixed(1);
      // Direction of flight
      const rad = ((it.pos.hdg || 0) * Math.PI) / 180;
      const vx = pt.x + Math.sin(rad) * 14, vy = pt.y - Math.cos(rad) * 14;
      const moving = +it.f.gs >= 60;   // no direction-of-flight vector on the ground
      if (!it.full) {
        svg += `<rect x="${pt.x - 2}" y="${pt.y - 2}" width="4" height="4" fill="${color}"/>`;
        if (moving) svg += `<line x1="${x}" y1="${y}" x2="${vx.toFixed(1)}" y2="${vy.toFixed(1)}" stroke="${color}" stroke-width="1"/>`;
        html += `<div class="gpd-ldb" style="left:${pt.x + 5}px;top:${pt.y - 6}px;color:${color}" data-cs="${esc(cs)}" data-f="acid" title="${esc(cs)}">${esc(it.alt.slice(0, 3))}</div>`;
        continue;
      }
      const sel = cs === S.selectedCs;
      svg += `<path d="M${pt.x} ${pt.y - 5}L${pt.x + 5} ${pt.y}L${pt.x} ${pt.y + 5}L${pt.x - 5} ${pt.y}Z" fill="none" stroke="${color}" stroke-width="${sel ? 2 : 1.3}"/>`;
      const ax = pt.x + Math.sin(rad) * 20, ay = pt.y - Math.cos(rad) * 20;
      if (moving) svg += `<line x1="${(pt.x + Math.sin(rad) * 6).toFixed(1)}" y1="${(pt.y - Math.cos(rad) * 6).toFixed(1)}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="${color}" stroke-width="1.6"/>`;
      const hx = (d) => (ax + Math.sin(rad + d) * -5).toFixed(1), hy = (d) => (ay - Math.cos(rad + d) * -5).toFixed(1);
      if (moving) svg += `<path d="M${hx(0.5)} ${hy(0.5)}L${ax.toFixed(1)} ${ay.toFixed(1)}L${hx(-0.5)} ${hy(-0.5)}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
      const pl = it.place;
      const bx = pt.x + pl.dx, by = pt.y + pl.dy;
      svg += `<line x1="${x}" y1="${y}" x2="${(pt.x + pl.lx).toFixed(1)}" y2="${(pt.y + pl.ly).toFixed(1)}" stroke="${color}" stroke-width="1"/>`;
      // Non-ADS-B: coral A opposite the leader (5.1.3, l).
      if (S.nonAdsb && S.nonAdsb(cs)) {
        html += `<div class="gpd-adsb" style="left:${pt.x - pl.lx * 0.55 - 4}px;top:${pt.y - pl.ly * 0.55 - 7}px" title="Non-ADS-B">A</div>`;
      }
      let b = "";
      if (it.l0) {
        b += `<div class="l0">` + it.cells.map((c) => {
          const cls = c.status ? "st" : c.acked ? "ack" : (c.sev + (c.muted ? " muted" : ""));
          const isSel = S.selAlert && S.selAlert.cs === cs && S.selAlert.type === c.sev ? " sel" : "";
          return `<span class="ai ${cls}${isSel}" data-cs="${esc(cs)}" data-f="alert" data-sev="${c.sev}">${c.text ? esc(c.text) : "&nbsp;"}</span>`;
        }).join(" ") + `</div>`;
      }
      b += `<div><span class="fld acid${sel ? " sel" : ""}" data-cs="${esc(cs)}" data-f="acid">${esc(cs)}</span></div>`;
      b += `<div><span class="fld" data-cs="${esc(cs)}" data-f="alt">${esc(it.alt)}</span></div>`;
      b += `<div><span class="fld" data-cs="${esc(cs)}" data-f="dest">${esc(it.dest)}</span> <span class="fld" data-cs="${esc(cs)}" data-f="spd">${esc(it.gs)}</span></div>`;
      if (it.l4) b += `<div><span class="fld" data-cs="${esc(cs)}" data-f="alt">${esc(it.l4)}</span></div>`;
      html += `<div class="gpd-db" style="left:${bx.toFixed(1)}px;top:${by.toFixed(1)}px;color:${color}">${b}</div>`;
      // Trial plans: a second leader labelled with the trial plan ID (5.1, e.3.b).
      (trialsByCs.get(cs) || []).forEach((t, k) => {
        const tx = pt.x - pl.lx * 0.9 - 4, ty = pt.y + 24 + k * 14;
        const tc = COL[t.sev] || COL.trial;
        svg += `<line x1="${x}" y1="${y}" x2="${(tx + 4).toFixed(1)}" y2="${(ty - 2).toFixed(1)}" stroke="${tc}" stroke-width="1" stroke-dasharray="3 2"/>`;
        html += `<div class="gpd-tl${t.id === S.selTrialId ? " sel" : ""}" style="left:${tx}px;top:${ty - 8}px;color:${tc}" data-cs="${esc(cs)}" data-f="trial" data-trial="${t.id}">${esc(t.label)}</div>`;
      });
    }
    overlay.innerHTML = `<svg class="gpd-svg" width="${w}" height="${h}">${svg}</svg>${html}`;
  }

  function redraw() {
    drawPoints();
    drawAircraft();
  }
  let featTimer = null;
  function redrawFeatures() {
    clearTimeout(featTimer);
    featTimer = setTimeout(() => { drawSaa(); drawAirways(rangeNm()); drawPoints(); }, 60);
  }
  let rafId = 0;
  map.on("move zoom", () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; drawPoints(); drawAircraft(); });
  });
  map.on("moveend zoomend", () => {
    redraw();
    redrawFeatures();
    if (opts.onView) opts.onView({ rangeNm: rangeNm(), center: map.getCenter() });
  });
  map.on("click", (ev) => { if (opts.onMapClick) opts.onMapClick(ev.latlng, ev.originalEvent); });

  // Field clicks: left, right (contextmenu) and middle (auxclick). Handled here so the map doesn't pan or select.
  ["click", "contextmenu", "auxclick", "mousedown", "dblclick"].forEach((type) => {
    overlay.addEventListener(type, (ev) => {
      const el = ev.target.closest("[data-f]");
      if (!el) return;
      ev.stopPropagation();
      if (type === "mousedown") { if (ev.button === 1) ev.preventDefault(); return; }
      if (type === "dblclick") return;
      if (type === "auxclick" && ev.button !== 1) return;
      if (type === "contextmenu") ev.preventDefault();
      if (opts.onField) opts.onField(el.dataset.cs, el.dataset.f, ev, { sev: el.dataset.sev, trial: el.dataset.trial ? +el.dataset.trial : null, el });
    });
  });

  /** New state (any subset of S); redraws what changed. */
  function update(next = {}) {
    const artccChanged = "artccId" in next && normArtccId(next.artccId) !== S.artccId;
    if ("features" in next) S.features = { ...S.features, ...next.features };
    if ("ac" in next) S.ac = { ...S.ac, ...next.ac };
    for (const k of Object.keys(next)) if (k !== "features" && k !== "ac") S[k] = next[k];
    if ("artccId" in next) S.artccId = normArtccId(next.artccId);
    S.flights = (S.flights || []).map((f) => ({ ...f, cs: String(f.cs || f.callsign || "").toUpperCase() }));
    drawBoundaries(artccChanged);
    if ("features" in next || "saaAlert" in next) { drawSaa(); drawAirways(rangeNm()); }
    drawRoutes();
    redraw();
  }
  function fitArtcc() {
    const b = getArtccBounds(normArtccId(S.artccId));
    if (b) map.fitBounds(L.latLngBounds(b).pad(0.05));
    else map.setView([39, -98], 4);
  }
  function setView(center, range) {
    const c = center || map.getCenter();
    map.setView(c, zoomForRange(range || rangeNm(), containerEl.clientWidth || 800, c.lat != null ? c.lat : c[0]), { animate: false });
  }
  function getView() {
    const c = map.getCenter();
    return { center: [c.lat, c.lng], rangeNm: rangeNm() };
  }
  function invalidateSize() {
    try { map.invalidateSize(false); } catch (_) {}
    redraw();
  }
  /** Map features that are on but hidden at this range: [{name, maxRange}]. */
  function hiddenFeatures() {
    const r = rangeNm() * 0.97, F = S.features, out = [];
    if ((F.waypoints || F.waypointLabels) && r > 200) out.push({ name: "waypoints", maxRange: 200 });
    if (F.airways && r > 400) out.push({ name: "airways", maxRange: 400 });
    if ((F.navaids || F.navaidLabels) && r > 500) out.push({ name: "NAVAIDs", maxRange: 500 });
    if ((F.airports || F.airportLabels) && r > 400) out.push({ name: "all airports", maxRange: 400 });
    return out;
  }
  function getTrafficCount() {
    return overlay.querySelectorAll(".gpd-db,.gpd-ldb").length;
  }
  function saaNear() {
    const b = getArtccBounds(normArtccId(S.artccId));
    if (!feat.sua) return [];
    const box = b ? L.latLngBounds(b).pad(0.05) : map.getBounds();
    return feat.sua.filter((p) => box.contains([p.lat, p.lon]));
  }

  map.setView([39, -98], 4);
  return {
    map, update, fitArtcc, setView, getView, invalidateSize, getTrafficCount, saaNear, hiddenFeatures,
    destroy: () => { try { map.remove(); } catch (_) {} },
  };
}
