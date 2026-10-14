/*
 * VATFLOW Tower Cab - screen brightness, shared by every in-cab screen.
 *
 * Four knobs on the console's knob panel set L: vars (model behaviors, drag to turn):
 *   L:VATFLOW_DIM_ALL      every screen
 *   L:VATFLOW_DIM_DBRITE   overhead DBRITE
 *   L:VATFLOW_DIM_ASDEX    overhead ASDE-X
 *   L:VATFLOW_DIM_CONSOLE  TWR INFO, IDST, voice switch, clock
 * Each is 0 (full bright, the default) .. 90 (darkest). A screen's brightness is
 * (1 - ALL/100) * (1 - own/100), never below 5 %. It dims by laying a black layer of
 * that opacity over the page: the sim makes the screen glow from the page's pixels, so
 * darker pixels also mean less glow at night. While a knob turns, the screen shows its
 * brightness for two seconds.
 */
var VatflowDimmer = (function () {
  var MIN = 0.05;

  function level(dimAll, dimOwn) {
    var a = Math.max(0, Math.min(90, dimAll || 0)), o = Math.max(0, Math.min(90, dimOwn || 0));
    return Math.max(MIN, (1 - a / 100) * (1 - o / 100));
  }

  /**
   * Puts the dimming layer over host (the gauge element). group: "DBRITE" | "ASDEX" | "CONSOLE".
   * Returns update(): call it from the gauge's Update() (reads the L: vars), or
   * update(dimAll, dimOwn) to set it directly (browser preview, tests).
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
    return function update(dimAll, dimOwn) {
      if (dimAll === undefined && typeof SimVar !== "undefined") {
        dimAll = SimVar.GetSimVarValue("L:VATFLOW_DIM_ALL", "number");
        dimOwn = SimVar.GetSimVarValue("L:VATFLOW_DIM_" + group, "number");
      }
      var b = level(dimAll, dimOwn), now = Date.now();
      var pct = Math.round(b * 100);
      if (pct !== last) {
        shade.style.opacity = String(1 - b);
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

  return { attach: attach, level: level };
})();
