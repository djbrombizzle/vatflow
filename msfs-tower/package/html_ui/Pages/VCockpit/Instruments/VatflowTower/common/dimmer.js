/*
 * VATFLOW Tower Cab - screen brightness, shared by every in-cab screen.
 *
 * Four knobs on the console's knob panel set L: vars (model behaviors, drag to turn):
 *   L:VATFLOW_DIM_ALL      every screen
 *   L:VATFLOW_DIM_DBRITE   overhead DBRITE
 *   L:VATFLOW_DIM_ASDEX    overhead ASDE-X
 *   L:VATFLOW_DIM_CONSOLE  TWR INFO, IDST, voice switch, clock
 * Each is 0 (full bright, the default) .. 90 (darkest). A screen's brightness is
 * (1 - ALL/100) * (1 - own/100), never below 5 %, times BOOST:
 *   L:VATFLOW_BOOST  100 (normal, the default) .. 200 (twice as bright, for bright days);
 *                    BRIGHTER on TOWER SETUP past 100 %, kept for the next flight
 * The screens glow twice as strongly as they need to (emissive 4000, export_interior_gltf.py)
 * and normally sit behind a black layer that takes that back to 100 %; above 100 % the
 * layer thins out, at 200 % it is gone. The sim makes the screen glow from the page's
 * pixels, so darker pixels also mean less glow at night. While a knob turns, the screen
 * shows its brightness for two seconds.
 *
 * Day / night (AUTO, on unless switched off on the TOWER SETUP screen): one screen works
 * out the sun's height at the cab from the sim's position and time (master()) and sets
 *   L:VATFLOW_NIGHT  0 (sun above 6 deg) .. 100 (sun below -6 deg, full night)
 * Every screen then dims to NIGHT_LEVEL of its knob brightness at night. With AUTO CAB
 * LIGHTS the ceiling lights go off at night and the console task lights (cabin light
 * circuit 3, systems.cfg) come on, like a real cab after dark.
 *   L:VATFLOW_DIM_MANUAL     1 = no automatic screen dimming
 *   L:VATFLOW_LIGHTS_MANUAL  1 = no automatic cab lights (all on)
 *
 * Also sets the overhead monitors' starting height / swivel (initMonitorPose).
 */
var VatflowDimmer = (function () {
  var MIN = 0.05, NIGHT_LEVEL = 0.4, MAX_BOOST = 2, HEADROOM = 2;

  /** BOOST 100..200 (L: var; 0 = not set yet = 100) -> 1..2. */
  function boostFactor(v) { return Math.max(1, Math.min(MAX_BOOST, (v || 100) / 100)); }

  /**
   * How much of the page shows through the black layer for brightness b (0.05 .. 2). The
   * layer works on page colours, which the sim turns into light about as colour^2.2; up to
   * 100 % that is the knobs' feel as before, above it the light grows in step with b.
   */
  function shadeFor(b) {
    var light = b <= 1 ? Math.pow(b, 2.2) : b;
    return Math.min(1, Math.pow(light / HEADROOM, 1 / 2.2));
  }

  function level(dimAll, dimOwn) {
    var a = Math.max(0, Math.min(90, dimAll || 0)), o = Math.max(0, Math.min(90, dimOwn || 0));
    return Math.max(MIN, (1 - a / 100) * (1 - o / 100));
  }

  /**
   * Puts the dimming layer over host (the gauge element). group: "DBRITE" | "ASDEX" | "CONSOLE".
   * Returns update(): call it from the gauge's Update() (reads the L: vars), or
   * update(dimAll, dimOwn, boost) to set it directly (browser preview, tests).
   */
  function attach(host, group, doc) {
    doc = doc || document;
    if (host.style && !host.style.position) host.style.position = "relative";
    var shade = doc.createElement("div");
    shade.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;background:#000;opacity:0;" +
      "pointer-events:none;z-index:1000;";
    var label = doc.createElement("div");
    label.style.cssText = "position:absolute;right:12px;top:10px;padding:4px 12px;background:#000;color:#fff;" +
      "font:bold 26px monospace;border:2px solid #888;display:none;pointer-events:none;z-index:1001;";
    host.appendChild(shade);
    host.appendChild(label);
    var last = -1, shownAt = 0, init = false;
    return function update(dimAll, dimOwn, boost) {
      var night = 0;
      if (dimAll === undefined && typeof SimVar !== "undefined") {
        dimAll = SimVar.GetSimVarValue("L:VATFLOW_DIM_ALL", "number");
        dimOwn = SimVar.GetSimVarValue("L:VATFLOW_DIM_" + group, "number");
        boost = SimVar.GetSimVarValue("L:VATFLOW_BOOST", "number");
        if (!SimVar.GetSimVarValue("L:VATFLOW_DIM_MANUAL", "number")) night = SimVar.GetSimVarValue("L:VATFLOW_NIGHT", "number") || 0;
      }
      var b = Math.max(MIN, level(dimAll, dimOwn) * autoFactor(night) * boostFactor(boost)), now = Date.now();
      var pct = Math.round(b * 100);
      if (pct !== last) {
        shade.style.opacity = String(Math.round((1 - shadeFor(b)) * 1000) / 1000);
        if (init) {             // not on the first frame: only when someone turns a knob
          label.textContent = "BRT " + pct + "%";
          label.style.display = "block";
          shownAt = now;
        }
        last = pct;
        init = true;
      } else if (shownAt && now - shownAt > 2000) {
        label.style.display = "none";
        shownAt = 0;
      }
      return b;
    };
  }

  /** Screen brightness factor for night 0..100 (AUTO). */
  function autoFactor(night) {
    var n = Math.max(0, Math.min(100, night || 0)) / 100;
    return 1 - n * (1 - NIGHT_LEVEL);
  }

  /** The sun's height above the horizon in degrees at lat / lon (deg), for a time (ms, UTC). */
  function sunElevation(lat, lon, ms) {
    var d = new Date(ms), rad = Math.PI / 180;
    var start = Date.UTC(d.getUTCFullYear(), 0, 1), day = Math.floor((ms - start) / 86400000) + 1;
    var hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    var g = 2 * Math.PI / 365 * (day - 1 + (hours - 12) / 24);
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
      0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var solarMin = hours * 60 + eqt + 4 * lon;                 // true solar time, minutes
    var ha = (solarMin / 4 - 180) * rad;
    var se = Math.sin(lat * rad) * Math.sin(decl) + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(ha);
    return Math.asin(Math.max(-1, Math.min(1, se))) / rad;
  }

  /** 0 (day) .. 100 (night) from the sun's height: day above 6 deg, night below -6 deg. */
  function nightFor(elevDeg) { return Math.round(Math.max(0, Math.min(1, (6 - elevDeg) / 12)) * 100); }

  /**
   * Day / night for the whole cab: call from one always-on gauge's Update (TWR INFO). Every
   * 10 s: the sun at the cab (sim position and time) -> L:VATFLOW_NIGHT, and with AUTO CAB
   * LIGHTS the light circuits: ceiling (cabin circuits 1, 2 = circuit.17 / .18) off at night,
   * console task lights (cabin 3 = circuit.40) on.
   */
  var CIRC_CEILING = [17, 18], CIRC_CONSOLE = 40;
  function master() {
    var last = 0;
    if (typeof SimVar !== "undefined" && typeof VatflowStore !== "undefined") {
      SimVar.SetSimVarValue("L:VATFLOW_DIM_MANUAL", "number", VatflowStore.get("DIM_AUTO", true) === false ? 1 : 0);
      SimVar.SetSimVarValue("L:VATFLOW_LIGHTS_MANUAL", "number", VatflowStore.get("LIGHTS_AUTO", true) === false ? 1 : 0);
      SimVar.SetSimVarValue("L:VATFLOW_BOOST", "number", Math.round(boostFactor(VatflowStore.get("BOOST", 100)) * 100));
    }
    function circuit(n, on) {
      var is = !!SimVar.GetSimVarValue("CIRCUIT SWITCH ON:" + n, "bool");
      if (is !== on) SimVar.SetSimVarValue("K:ELECTRICAL_CIRCUIT_TOGGLE", "number", n);
    }
    return function update() {
      if (typeof SimVar === "undefined") return;
      var now = Date.now();
      if (now - last < 10000) return;
      last = now;
      try {
        var lat = SimVar.GetSimVarValue("PLANE LATITUDE", "degree latitude");
        var lon = SimVar.GetSimVarValue("PLANE LONGITUDE", "degree longitude");
        var zs = SimVar.GetSimVarValue("E:ZULU TIME", "seconds");
        var day = SimVar.GetSimVarValue("E:ZULU DAY OF YEAR", "number");
        var year = SimVar.GetSimVarValue("E:ZULU YEAR", "number") || new Date().getUTCFullYear();
        if (!isFinite(lat) || !isFinite(zs) || !day) return;
        var ms = Date.UTC(year, 0, 1) + (day - 1) * 86400000 + zs * 1000;
        var night = nightFor(sunElevation(lat, lon, ms));
        SimVar.SetSimVarValue("L:VATFLOW_NIGHT", "number", night);
        var dark = night >= 50;
        if (SimVar.GetSimVarValue("L:VATFLOW_LIGHTS_MANUAL", "number")) dark = false;
        CIRC_CEILING.forEach(function (n) { circuit(n, !dark); });
        circuit(CIRC_CONSOLE, dark);
      } catch (e) { if (typeof console !== "undefined") console.error("VATFLOW day/night", e); }
    };
  }

  /**
   * Overhead monitor pose. Its height and swivel are model animations driven by
   * L:VATFLOW_<label>_HEIGHT (0..40, cm below the top of its travel; 15 = as built) and
   * L:VATFLOW_<label>_TWIST (0..100, 50 = straight). L: vars start at 0 when a flight
   * loads, so the monitor's own screen sets the as-built pose once (not again if the
   * screen reloads during the flight, which would undo your adjustment).
   */
  function initMonitorPose(label) {
    if (typeof SimVar === "undefined") return;
    var flag = "L:VATFLOW_" + label + "_POSE_SET";
    if (SimVar.GetSimVarValue(flag, "number")) return;
    SimVar.SetSimVarValue("L:VATFLOW_" + label + "_HEIGHT", "number", 15);
    SimVar.SetSimVarValue("L:VATFLOW_" + label + "_TWIST", "number", 50);
    SimVar.SetSimVarValue(flag, "number", 1);
  }

  return {
    attach: attach, level: level, initMonitorPose: initMonitorPose, autoFactor: autoFactor,
    sunElevation: sunElevation, nightFor: nightFor, master: master, NIGHT_LEVEL: NIGHT_LEVEL,
    boostFactor: boostFactor, shadeFor: shadeFor
  };
})();
