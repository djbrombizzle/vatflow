/*
 * VATFLOW Tower Cab - small canvas helpers shared by the radar screens.
 * MSFS's instrument browser has no real monospace font, so text is laid out
 * one character per fixed-width cell to keep STARS-style columns lined up.
 */
var VatflowDraw = (function () {
  /** Draws s with every character in a cell of width cw (left aligned at x, baseline y). */
  function mono(ctx, s, x, y, cw) {
    s = String(s);
    var align = ctx.textAlign;
    ctx.textAlign = "center";
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) !== " ") ctx.fillText(s.charAt(i), x + cw * (i + 0.5), y);
    }
    ctx.textAlign = align;
  }

  /** Polygon from a flat [x0,y0,x1,y1,...] array through a projection function. */
  function path(ctx, flat, proj, close) {
    ctx.beginPath();
    for (var i = 0; i < flat.length; i += 2) {
      var p = proj(flat[i], flat[i + 1]);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    if (close) ctx.closePath();
  }

  function zulu(sec) {
    var pad = VatflowFeed.pad;
    return { hh: pad(Math.floor(sec / 3600) % 24, 2), mm: pad(Math.floor(sec / 60) % 60, 2), ss: pad(Math.floor(sec) % 60, 2) };
  }

  function zuluNow() {
    try {
      if (typeof SimVar !== "undefined") return SimVar.GetSimVarValue("E:ZULU TIME", "seconds");
    } catch (e) { /* fall through to the PC clock */ }
    var d = new Date();
    return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  }

  function showError(view, e) {
    try {
      var ctx = view.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
      ctx.font = "18px monospace";
      ctx.fillStyle = "#ff4040";
      ctx.fillText("ERR " + String((e && e.message) || e).slice(0, 70), 14, view.canvas.height - 44);
    } catch (e2) { /* nothing more we can do */ }
  }

  /**
   * Redraw scheduler for a canvas gauge. Returns tick(): call it from the sim's Update();
   * it draws at most every intervalMs and then nudges the canvas style so MSFS repaints
   * the screen (see below). A watchdog timer also draws if Update() stops
   * being called, and a drawing error is shown on the screen (and logged) instead of
   * freezing the picture, so the next frame still runs.
   */
  function loop(view, intervalMs) {
    var last = 0, busy = false, flip = false;
    function tick(force) {
      var now = Date.now();
      if (busy || (!force && now - last < intervalMs)) return;
      busy = true;
      last = now;
      try {
        view.draw(now, zuluNow());
        // MSFS only re-renders a VCockpit page onto the 3D screen when the page's DOM
        // changes; new pixels inside a <canvas> alone don't count, so the screen froze
        // on its first frame. An invisible style change after each frame marks it dirty.
        flip = !flip;
        view.canvas.style.opacity = flip ? "0.999" : "1";
      } catch (e) {
        showError(view, e);
        if (typeof console !== "undefined") console.error("VATFLOW gauge error", (e && e.stack) || e);
      } finally {
        busy = false;
      }
    }
    setInterval(function () { if (Date.now() - last > intervalMs * 2.5) tick(true); }, intervalMs);
    return tick;
  }

  return { mono: mono, path: path, zulu: zulu, zuluNow: zuluNow, loop: loop };
})();
