/**
 * ERAM Trainer scope map — ERAM-style FDB data blocks per CRC documentation.
 * Reuses EDST GPD base map (black canvas, ARTCC/sector lines).
 */
import { createEdstGpdMap, prepareEdstGpdData } from "./edst-gpd-map.js";
import { formatFdbState } from "./eram-trainer-sim.js";

const FDB_OFFSET = { NE: [78, -92], NW: [-78, -92], SE: [78, 92], SW: [-78, 92] };
const FDB_COLOR = "#ffd800";

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function offsetLatLng(map, latlng, dx, dy) {
  const pt = map.latLngToContainerPoint(latlng);
  return map.containerPointToLatLng([pt.x + dx, pt.y + dy]);
}

/** CRC Fig. 29 — VCI (voice communications indicator). */
function vciIcon() {
  return `<svg class="fdb-vci" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
    <path d="M1 10 L1 4 L4 1" fill="none" stroke="#33ee33" stroke-width="1.2"/>
    <path d="M2 9 A5 5 0 0 1 9 2" fill="none" stroke="#33ee33" stroke-width="1"/>
    <path d="M3 8 A3 3 0 0 1 8 3" fill="none" stroke="#33ee33" stroke-width="1"/>
  </svg>`;
}

function fieldBHtml(fieldB, nonRvsm) {
  const { assigned, suffix, reported } = fieldB;
  if (!suffix) return escapeHtml(assigned + (reported || ""));
  const rvsmCls = nonRvsm ? " fld-b-rvsm" : "";
  let html = escapeHtml(assigned);
  html += `<span class="fld-b-sfx${rvsmCls}">${escapeHtml(suffix)}</span>`;
  if (reported) html += escapeHtml(reported);
  return html;
}

function fdbHtml(ac, selected) {
  const st = formatFdbState(ac);
  const sel = selected ? " selected" : "";
  const fenceCls = st.showFence ? " has-fence" : "";
  const line0 = st.line0
    ? `<div class="fdb-l0">${escapeHtml(st.line0)}</div>`
    : `<div class="fdb-l0 empty" aria-hidden="true">&nbsp;</div>`;

  const vciTop = st.vci ? vciIcon() : "";
  const colBottom = st.notYourControl
    ? `<span class="fdb-nyc">R</span>`
    : `<span class="fdb-nyc empty" aria-hidden="true">&nbsp;</span>`;

  const hsfMark = st.hsf
    ? `<span class="fdb-hsf" title="HSF defined — heading/speed/direct">↴</span>`
    : "";

  const line2 = fieldBHtml(st.fieldB, st.nonRvsm) + hsfMark;
  const line3 = escapeHtml(st.line3);
  const line4 = escapeHtml(st.line4);

  return `<div class="eram-fdb${sel}${fenceCls}" data-cs="${escapeHtml(ac.cs || "")}">
    ${line0}
    <div class="fdb-grid">
      <div class="fdb-col0">
        <div class="fdb-col0-top">${vciTop}</div>
        <div class="fdb-col0-bot">${colBottom}</div>
      </div>
      <div class="fdb-portal">
        <div class="fdb-l1">${escapeHtml(st.line1)}</div>
        <div class="fdb-l2">${line2}</div>
        <div class="fdb-l3">${line3}</div>
        <div class="fdb-l4${st.showHsf && st.hsf ? " hsf" : ""}">${line4}</div>
      </div>
    </div>
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
  const vectorLayer = L.layerGroup().addTo(map);
  const leaderLayer = L.layerGroup().addTo(map);

  let aircraft = [];
  let selectedCs = null;
  let artcc = "ZDC";

  function toggleFdbAction(ac, action) {
    if (!ac) return;
    if (action === "vci") ac.vci = !ac.vci;
    if (action === "hsf") ac.showHsf = !ac.showHsf;
    render();
  }

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

      const vecMin = ac.vecMin || 0;
      if (vecMin > 0 && (ac.gs || 0) > 60) {
        const h = ((ac.hdg || 0) * Math.PI) / 180;
        const vecNm = ((ac.gs || 0) / 60) * vecMin;
        const dlat = (vecNm / 60) * Math.cos(h);
        const dlon = (vecNm / 60) * Math.sin(h) / Math.cos((ac.lat * Math.PI) / 180);
        const vecEnd = L.latLng(ac.lat + dlat, ac.lon + dlon);
        L.polyline([ll, vecEnd], {
          color: FDB_COLOR,
          weight: 1,
          dashArray: "3 2",
          opacity: isSel ? 0.95 : 0.75,
        }).addTo(vectorLayer);
      }

      L.polyline([ll, fdbLl], {
        color: FDB_COLOR,
        weight: 1,
        opacity: isSel ? 1 : 0.9,
      }).addTo(leaderLayer);

      const marker = L.marker(fdbLl, {
        icon: L.divIcon({
          className: "eram-fdb-marker",
          html: fdbHtml(ac, isSel),
          iconSize: [1, 1],
          iconAnchor: pos.startsWith("N") ? [0, 0] : [0, 88],
        }),
        interactive: true,
        zIndexOffset: isSel ? 600 : 200,
      })
        .on("click", e => {
          const t = e.originalEvent?.target;
          if (t && t.closest && t.closest(".fdb-vci, .fdb-col0-top")) {
            toggleFdbAction(ac, "vci");
            return;
          }
          if (t && t.closest && t.closest(".fdb-hsf")) {
            toggleFdbAction(ac, "hsf");
            return;
          }
          if (opts.onSelect) opts.onSelect(cs);
        })
        .addTo(fdbLayer);
      marker._acCs = cs;
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
