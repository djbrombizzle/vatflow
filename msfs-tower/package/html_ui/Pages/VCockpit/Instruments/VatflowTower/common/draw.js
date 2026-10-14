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

  return { mono: mono, path: path, zulu: zulu };
})();
