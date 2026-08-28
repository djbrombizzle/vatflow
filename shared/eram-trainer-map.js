/**
 * ERAM Trainer scope map — ERAM-style FDB data blocks per CRC documentation.
 * Reuses EDST GPD base map (black canvas, ARTCC/sector lines).
 */
import { createEdstGpdMap, prepareEdstGpdData } from "./edst-gpd-map.js";
import {
  formatFieldB,
  formatFieldD,
  formatGs,
} from "./eram-trainer-sim.js";

const FDB_OFFSET = { NE: [72, -88], NW: [-72, -88], SE: [72, 88], SW: [-72, 88] };
const FDB_COLOR = "#ffd800";

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function offsetLatLng(map, latlng, dx, dy) {
  const pt = map.latLngToContainerPoint(latlng);
  return map.containerPointToLatLng([pt.x + dx, pt.y + dy]);
}

function vciIcon(on) {
  if (!on) return "";
  return `<svg class="fdb-vci" width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
    <rect x="1" y="1" width="7" height="7" fill="none" stroke="#22dd22" stroke-width="1"/>
    <line x1="1" y1="8" x2="8" y2="1" stroke="#22dd22" stroke-width="1"/>
  </svg>`;
}

function fdbHtml(ac, selected) {
  const cs = escapeHtml(ac.cs || "");
  const fldB = escapeHtml(formatFieldB(ac));
  const cid = escapeHtml(formatFieldD(ac));
  const gs = escapeHtml(formatGs(ac));
  const dest = escapeHtml(String(ac.arr || "").toUpperCase());
  const fence = escapeHtml(ac.fenceChar || "");
  const vci = ac.vci !== false ? vciIcon(true) : "";
  const sel = selected ? " selected" : "";

  return `<div class="eram-fdb${sel}">
    <div class="fdb-fence">${fence || "&nbsp;"}</div>
    <div class="fdb-row">
      <div class="fdb-vci-col">${vci}</div>
      <div class="fdb-bracket">
        <div class="fdb-l1">${cs}</div>
        <div class="fdb-l2">${fldB}</div>
        <div class="fdb-l3"><span class="fld-d">${cid}</span> <span class="fld-gs">${gs}</span></div>
      </div>
    </div>
    <div class="fdb-dest">${dest}</div>
  </div>`;
}

function trackIcon(selected) {
  const sz = selected ? 10 : 8;
  const col = FDB_COLOR;
  const svg = `<svg width="${sz}" height="${sz}" viewBox="0 0 10 10" aria-hidden="true">
    <rect x="2" y="2" width="6" height="6" fill="none" stroke="${col}" stroke-width="1.5"/>
    <line x1="2" y1="8" x2="8" y2="2" stroke="${col}" stroke-width="1.5"/>
  </svg>`;
  return L.divIcon({ className: "eram-track-icon", html: svg, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
}

/**
 * @param {HTMLElement} containerEl
 * @param {{ onSelect?: (cs: string) => void }} [opts]
 */
export async function createEramTrainerMap(containerEl, opts = {}) {
  if (typeof L === "undefined") throw new Error("Leaflet required");
  await prepareEdstGpdData("");

  const gpd = createEdstGpdMap(containerEl, {
    onSelect: opts.onSelect,
  });
  gpd.setMapOverlays({ showRoutes: true, showAirports: true, showFixLabels: true, showTraffic: false });
  gpd.setSectorMode("high");

  const map = gpd.map;
  const trackLayer = L.layerGroup().addTo(map);
  const fdbLayer = L.layerGroup().addTo(map);
  const leaderLayer = L.layerGroup().addTo(map);

  let aircraft = [];
  let selectedCs = null;
  let artcc = "ZDC";

  function render() {
    trackLayer.clearLayers();
    fdbLayer.clearLayers();
    leaderLayer.clearLayers();

    for (const ac of aircraft) {
      if (ac.lat == null || ac.lon == null) continue;
      const cs = (ac.cs || "").toUpperCase();
      const isSel = selectedCs && cs === selectedCs;
      const ll = L.latLng(ac.lat, ac.lon);
      const pos = ac.fdbPos || "NE";
      const off = FDB_OFFSET[pos] || FDB_OFFSET.NE;
      const fdbLl = offsetLatLng(map, ll, off[0], off[1]);

      L.marker(ll, { icon: trackIcon(isSel), interactive: true, zIndexOffset: isSel ? 500 : 100 })
        .on("click", () => { if (opts.onSelect) opts.onSelect(cs); })
        .addTo(trackLayer);

      L.polyline([ll, fdbLl], {
        color: FDB_COLOR,
        weight: 1,
        opacity: isSel ? 1 : 0.9,
      }).addTo(leaderLayer);

      L.marker(fdbLl, {
        icon: L.divIcon({
          className: "eram-fdb-marker",
          html: fdbHtml(ac, isSel),
          iconSize: [1, 1],
          iconAnchor: pos.startsWith("N") ? [0, 0] : [0, 72],
        }),
        interactive: true,
        zIndexOffset: isSel ? 600 : 200,
      })
        .on("click", () => { if (opts.onSelect) opts.onSelect(cs); })
        .addTo(fdbLayer);
    }
  }

  function setArtcc(id) {
    artcc = id;
    gpd.setArtcc(id);
  }

  function update(list, options = {}) {
    aircraft = Array.isArray(list) ? list : [];
    if ("selectedCs" in options) {
      selectedCs = options.selectedCs ? String(options.selectedCs).toUpperCase() : null;
    }
    gpd.update(aircraft, {
      artccId: artcc,
      selectedCs,
      showRoutes: true,
      showAirports: true,
      showFixLabels: true,
      showTraffic: false,
      sectorMode: "high",
      refit: !!options.refit,
    });
    render();
  }

  map.on("zoomend moveend", render);

  return {
    map,
    setArtcc,
    update,
    render,
    destroy() {
      gpd.destroy();
    },
    invalidateSize() {
      gpd.invalidateSize();
    },
  };
}
