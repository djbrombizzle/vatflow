/**
 * RampView — OSM aeroway basemap behind the scope.
 *
 * The scope draws stands, targets and ramp areas in a local metres frame. The
 * taxiway and apron shapes underneath it are the same OpenStreetMap data every
 * good surface map is built on, so there is no reason to hand-draw them: put a
 * vector basemap behind the canvas and drive its camera from the scope's view.
 *
 * Everything here degrades to nothing: if MapLibre is missing or the tiles fail,
 * the basemap stays hidden and the scope renders exactly as it did before.
 */

const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

/** Web Mercator metres per pixel at zoom 0 on the equator. */
const M_PER_PX_Z0 = 156543.03392804097;

/**
 * Basemap layers worth keeping under an airport surface. Roads, labels, POIs
 * and boundaries are noise here — the scope draws its own labels, and a road
 * name under a stand box is actively unhelpful.
 */
const KEEP_LAYER = /^(background|landcover|landuse|water|waterway|aeroway|building)/;

/**
 * The scope's view as a map camera.
 *
 * Our scale is pixels per metre on the ground; Mercator's is metres per pixel
 * at the equator, shrinking by cos(latitude). Getting this wrong shows up as a
 * basemap that drifts out of register as you pan north or south, so it is a
 * pure function with its own test.
 *
 * @param {{cx: number, cy: number, scale: number, rot?: number}} view
 * @param {{toLL: Function}} proj
 * @returns {{center: [number, number], zoom: number, bearing: number}}
 */
export function viewToCamera(view, proj) {
  const [lat, lon] = proj.toLL(view.cx, view.cy);
  const metresPerPixel = 1 / view.scale;
  const cos = Math.cos((lat * Math.PI) / 180);
  const zoom = Math.log2((M_PER_PX_Z0 * cos) / metresPerPixel);
  return {
    center: [lon, lat],
    zoom,
    bearing: -((view.rot || 0) * 180) / Math.PI,
  };
}

/** The scope scale a given camera zoom corresponds to — the inverse, for tests. */
export function cameraToScale(zoom, lat) {
  const cos = Math.cos((lat * Math.PI) / 180);
  return Math.pow(2, zoom) / (M_PER_PX_Z0 * cos);
}

/** Our projection speaks [lat, lon]; MapLibre wants [lon, lat]. */
function llToLonLat(ll) {
  return [ll[1], ll[0]];
}

/** True when two views are close enough that the camera need not move. */
export function viewUnchanged(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.cx - b.cx) < 0.05 &&
    Math.abs(a.cy - b.cy) < 0.05 &&
    Math.abs(a.scale - b.scale) < 1e-6 &&
    Math.abs((a.rot || 0) - (b.rot || 0)) < 1e-6;
}

/**
 * Mount a basemap behind the scope canvas.
 *
 * @param {HTMLElement} container an element positioned behind the canvas
 * @param {object} proj projection from ramp-airport
 * @param {{ onStatus?: Function, onFail?: Function, styleUrl?: string }} [opts]
 * @returns {{ sync: Function, setVisible: Function, visible: boolean, ok: boolean, destroy: Function }}
 */
export function mountRampBasemap(container, proj, opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  const onFail = opts.onFail || (() => {});
  const dead = {
    ok: false, visible: false,
    sync() {}, setVisible() {}, destroy() {},
  };

  if (typeof window === "undefined" || typeof window.maplibregl === "undefined") {
    onStatus("Basemap unavailable — MapLibre did not load.");
    onFail();
    return dead;
  }

  let map;
  try {
    map = new window.maplibregl.Map({
      container,
      style: opts.styleUrl || STYLE_URL,
      center: llToLonLat(proj.toLL(0, 0)),
      zoom: 13,
      attributionControl: false,
      interactive: false,          // the scope owns all input
      fadeDuration: 0,
      preserveDrawingBuffer: false,
    });
  } catch (err) {
    onStatus("Basemap unavailable — " + err.message);
    onFail();
    return dead;
  }

  const state = { ok: true, visible: true, last: null, failed: false };

  map.on("load", () => {
    // Strip everything the scope does better itself.
    try {
      for (const layer of map.getStyle().layers || []) {
        if (!KEEP_LAYER.test(layer.id)) map.removeLayer(layer.id);
      }
    } catch (_) { /* a style without those layers is still fine */ }
    onStatus(null);
  });

  map.on("error", e => {
    // One message, not one per failed tile.
    if (state.failed) return;
    state.failed = true;
    state.ok = false;
    container.style.display = "none";
    onStatus("Basemap tiles unavailable — showing the scope on its own.");
    onFail();
  });

  const api = {
    get ok() { return state.ok; },
    get visible() { return state.visible; },

    /** Point the camera at the scope's current view. */
    sync(view) {
      if (!state.ok || !state.visible) return;
      if (viewUnchanged(state.last, view)) return;
      state.last = { cx: view.cx, cy: view.cy, scale: view.scale, rot: view.rot || 0 };
      const cam = viewToCamera(view, proj);
      if (!isFinite(cam.zoom) || cam.zoom < 0 || cam.zoom > 24) return;
      map.jumpTo({ center: cam.center, zoom: cam.zoom, bearing: cam.bearing });
    },

    setVisible(on) {
      state.visible = !!on && !state.failed;
      container.style.display = state.visible ? "" : "none";
      if (state.visible) {
        state.last = null;
        map.resize();
      }
    },

    resize() {
      if (state.ok) map.resize();
    },

    destroy() {
      try { map.remove(); } catch (_) { /* already gone */ }
      state.ok = false;
    },
  };

  return api;
}
