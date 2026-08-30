/**
 * Key-free dark basemap for VATFLOW Leaflet maps.
 *
 * CARTO raster tiles now stamp "API KEY REQUIRED" without a key. OpenFreeMap
 * Dark is a Dark Matter-style vector basemap (no signup, no API key).
 *
 * Load after Leaflet, MapLibre GL JS, and @maplibre/maplibre-gl-leaflet.
 */
(function (global) {
  "use strict";

  var STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
  var BASE_ATTR =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
    '&copy; <a href="https://openfreemap.org/">OpenFreeMap</a>';

  function injectCss() {
    if (typeof document === "undefined") return;
    if (document.getElementById("vatflow-basemap-css")) return;
    var style = document.createElement("style");
    style.id = "vatflow-basemap-css";
    style.textContent =
      ".leaflet-gl-layer .maplibregl-control-container{display:none!important}" +
      ".leaflet-gl-layer .maplibregl-canvas:focus{outline:none}";
    (document.head || document.documentElement).appendChild(style);
  }

  function addVatflowBasemap(map, extraAttribution) {
    injectCss();
    if (!map || typeof L === "undefined") return null;

    var extra = extraAttribution ? String(extraAttribution).replace(/^\s*[·•|]\s*/, "") : "";
    if (map.attributionControl) {
      map.attributionControl.addAttribution(extra ? BASE_ATTR + " · " + extra : BASE_ATTR);
    }

    if (typeof L.maplibreGL !== "function") {
      console.warn("VATFLOW: MapLibre GL Leaflet is not loaded; map has no basemap.");
      return null;
    }

    return L.maplibreGL({
      style: STYLE_URL,
      pane: "tilePane",
      interactive: false,
      // Leaflet attribution is set above; don't also copy MapLibre source credits.
      attributionControl: false,
    }).addTo(map);
  }

  global.addVatflowBasemap = addVatflowBasemap;
})(typeof window !== "undefined" ? window : this);
