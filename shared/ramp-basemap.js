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

/**
 * Web Mercator metres per pixel at zoom 0 on the equator, for MapLibre's tiles.
 *
 * MapLibre GL sizes the world as 512 x 2^zoom pixels, not the 256 of the older
 * slippy-map convention — so this is the equator's circumference over 512, and
 * using the 256 figure makes every zoom exactly one too high, which renders the
 * basemap at twice the scope's scale. The calibration below means a wrong
 * constant can never survive anyway, but it should start out right.
 */
const M_PER_PX_Z0 = 40075016.6855785 / 512;

/** Ground distance used to measure the map's real scale, in metres. */
const CAL_M = 1000;

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

/**
 * How far the zoom must move so that `measuredPx` becomes `wantPx`.
 *
 * Scale doubles per zoom level, so the correction is the log2 of the ratio. This
 * is what lets the basemap calibrate itself against the live map rather than
 * trusting a hard-coded tile-size convention.
 */
export function zoomCorrection(measuredPx, wantPx) {
  if (!isFinite(measuredPx) || !isFinite(wantPx) || measuredPx <= 0 || wantPx <= 0) return 0;
  return Math.log2(wantPx / measuredPx);
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
    container.style.display = "none";   // opt-in; the page turns it on
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

  const state = { ok: true, visible: false, last: null, failed: false, zoomOffset: 0, calibrated: false };

  function jump(view) {
    const cam = viewToCamera(view, proj);
    const zoom = cam.zoom + state.zoomOffset;
    if (!isFinite(zoom) || zoom < 0 || zoom > 24) return;
    map.jumpTo({ center: cam.center, zoom, bearing: cam.bearing });
  }

  /**
   * Measure what the map actually did and correct for it.
   *
   * Projects two points a known distance apart and compares the pixels between
   * them with the pixels the scope would use. Any disagreement is a pure power
   * of two, so one correction fixes it at every zoom — and it holds whatever
   * tile size or projection tweak the library uses.
   */
  function calibrate() {
    if (!state.ok || !state.visible || !state.last) return;
    const view = state.last;
    try {
      const a = proj.toLL(view.cx, view.cy);
      const b = proj.toLL(view.cx + CAL_M, view.cy);
      const pa = map.project([a[1], a[0]]);
      const pb = map.project([b[1], b[0]]);
      const measured = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      const correction = zoomCorrection(measured, CAL_M * view.scale);
      if (Math.abs(correction) > 0.01) {
        state.zoomOffset += correction;
        jump(view);
      }
      state.calibrated = true;
    } catch (_) { /* the map is not ready to project yet; try again next tick */ }
  }

  map.on("load", () => {
    // Strip everything the scope does better itself.
    try {
      for (const layer of map.getStyle().layers || []) {
        if (!KEEP_LAYER.test(layer.id)) map.removeLayer(layer.id);
      }
    } catch (_) { /* a style without those layers is still fine */ }
    calibrate();
    onStatus(null);
  });

  // Re-check occasionally: cheap, and it catches a style or library change that
  // moves the scale under us rather than leaving the overlay silently adrift.
  const calTimer = setInterval(calibrate, 2000);

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
      jump(view);
      if (!state.calibrated) calibrate();
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

    /** Zoom levels added to the computed camera to match the scope. */
    get zoomOffset() { return state.zoomOffset; },

    /** The underlying MapLibre map — for debugging and for measuring register. */
    get map() { return map; },

    destroy() {
      clearInterval(calTimer);
      try { map.remove(); } catch (_) { /* already gone */ }
      state.ok = false;
    },
  };

  return api;
}
