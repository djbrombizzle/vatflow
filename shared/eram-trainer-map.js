/**
 * ERAM Trainer scope map — ERAM-style FDB data blocks per CRC documentation.
 * Reuses EDST GPD base map (black canvas, ARTCC/sector lines).
 */
import { createEdstGpdMap, prepareEdstGpdData } from "./edst-gpd-map.js";
import {
  formatFieldB,
  formatFieldC,
  formatFieldE,
  formatFieldF,
  hasHsf,
} from "./eram-trainer-sim.js";

const FDB_OFFSET = { NE: [72, -88], NW: [-72, -88], SE: [72, 88], SW: [-72, 88] };

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function offsetLatLng(map, latlng, dx, dy) {
  const pt = map.latLngToContainerPoint(latlng);
  return map.containerPointToLatLng([pt.x + dx, pt.y + dy]);
}

function fdbHtml(ac, selected) {
  const cs = escapeHtml(ac.cs || "");
  const fldB = escapeHtml(formatFieldB(ac));
  const fldC = formatFieldC(ac);
  const fldE = escapeHtml(formatFieldE(ac));
  const fldF = escapeHtml(formatFieldF(ac));
  const cid = escapeHtml(String(ac.cid || "---").slice(-3));
  const hsf = hasHsf(ac) ? '<span class="fdb-hsf">↴</span>' : "";
  const vci = ac.vci !== false
    ? '<span class="fdb-vci" title="VCI — on frequency">◆</span>'
    : '<span class="fdb-vci off" title="VCI — not on frequency">◇</span>';
  const sel = selected ? " selected" : "";
  const line4 = fldF
    ? `<div class="fdb-l4"><span class="fld-f">${fldF}</span></div>`
    : `<div class="fdb-l4 dim"><span class="fld-f">${escapeHtml(ac.arr || "")}</span></div>`;

  return `<div class="eram-fdb${sel}">
    <div class="fdb-portal">${vci}</div>
    <div class="fdb-body">
      <div class="fdb-l1"><span class="fld-a">${cs}</span></div>
      <div class="fdb-l2"><span class="fld-b">${fldB}</span>${fldC ? `<span class="fld-c">${escapeHtml(fldC)}</span>` : ""}${hsf}</div>
      <div class="fdb-l3"><span class="fld-d">${cid}</span><span class="fld-e">${fldE}</span></div>
      ${line4}
    </div>
  </div>`;
}

function trackIcon(selected) {
  const sz = selected ? 10 : 7;
  const col = selected ? "#e0a13b" : "#7cff7c";
  const svg = `<svg width="${sz}" height="${sz}" viewBox="0 0 12 12">
    <rect x="5" y="0" width="2" height="12" fill="${col}"/>
    <rect x="0" y="5" width="12" height="2" fill="${col}"/>
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
  const vectorLayer = L.layerGroup().addTo(map);
  const leaderLayer = L.layerGroup().addTo(map);

  let aircraft = [];
  let selectedCs = null;
  let artcc = "ZDC";

  function render() {
    trackLayer.clearLayers();
    fdbLayer.clearLayers();
    vectorLayer.clearLayers();
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

      const vecNm = ((ac.gs || 0) / 60) * (ac.vecMin || 4);
      if (vecNm > 0.2) {
        const h = ((ac.hdg || 0) * Math.PI) / 180;
        const dlat = (vecNm / 60) * Math.cos(h);
        const dlon = (vecNm / 60) * Math.sin(h) / Math.cos((ac.lat * Math.PI) / 180);
        const vecEnd = L.latLng(ac.lat + dlat, ac.lon + dlon);
        L.polyline([ll, vecEnd], {
          color: isSel ? "#e0a13b" : "#7cff7c",
          weight: 1.5,
          dashArray: "4 3",
          opacity: 0.9,
        }).addTo(vectorLayer);
      }

      L.polyline([ll, fdbLl], {
        color: isSel ? "#e0a13b" : "#6a8a6a",
        weight: 1,
        opacity: 0.85,
      }).addTo(leaderLayer);

      L.marker(fdbLl, {
        icon: L.divIcon({
          className: "eram-fdb-marker",
          html: fdbHtml(ac, isSel),
          iconSize: [1, 1],
          iconAnchor: pos.startsWith("N") ? [0, 0] : [0, 60],
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
