/*
 * VATFLOW Tower Cab - zoom and pan for the DBRITE and ASDE-X: a small pad of buttons
 * (+ / - zoom, arrows pan, C back to the whole picture) in the screen's corner, and for the
 * ASDE-X a rotate row (turn left / AUTO / turn right). The view is kept per screen
 * (VatflowStore "VIEW_<app>_<screen>"). The arrows are drawn with CSS shapes: the sim's
 * screen font has no arrow characters (they showed as empty boxes).
 *
 * A view applies on top of the app's own fit: base scale s0 and centre (cx0, cy0) in
 * canvas pixels become scale s0 * zoom, centred on the panned point. Pan is in base
 * pixels, so a step moves the picture a fixed share of the screen at any zoom.
 */
var VatflowViewCtl = (function () {
  var MIN = 0.25, MAX = 16, STEP = 1.4, PAN = 0.18;
  var BTN = "box-sizing:border-box;width:44px;height:40px;margin:0 3px 3px 0;background:#1b2a3a;border:2px solid #35506b;" +
    "color:#cfe0f0;font:bold 22px monospace;display:flex;align-items:center;justify-content:center;";

  function ViewCtl(key, W, H) {
    this.key = key;
    this.W = W;
    this.H = H;
    var v = (key && VatflowStore.get(key, null)) || {};
    this.zoom = v.zoom > 0 ? v.zoom : 1;
    this.panX = +v.panX || 0;
    this.panY = +v.panY || 0;
    this.rot = typeof v.rot === "number" ? v.rot : null;   // the map's top heading, set by hand; null = AUTO
    this.onChange = null;
  }

  ViewCtl.prototype.save = function () {
    if (this.key) VatflowStore.set(this.key, { zoom: this.zoom, panX: this.panX, panY: this.panY, rot: this.rot });
    if (this.onChange) this.onChange();
  };

  /** Zoom in (dir > 0) or out, about the screen centre. */
  ViewCtl.prototype.zoomBy = function (dir) {
    this.zoom = Math.max(MIN, Math.min(MAX, this.zoom * (dir > 0 ? STEP : 1 / STEP)));
    if (Math.abs(this.zoom - 1) < 0.01) this.zoom = 1;
    this.save();
  };

  /** Pans the picture: dx / dy = -1, 0, 1 (right / down positive: see more to the right / below). */
  ViewCtl.prototype.pan = function (dx, dy) {
    this.panX += dx * PAN * this.W / this.zoom;
    this.panY += dy * PAN * this.H / this.zoom;
    this.save();
  };

  /**
   * Turns the map by hand: deg > 0 turns the picture left (counter-clockwise; the heading at
   * the top goes up), from cur (the heading at the top now) when it was on AUTO.
   */
  ViewCtl.prototype.rotateBy = function (deg, cur) {
    var from = this.rot === null ? (cur || 0) : this.rot;
    this.rot = Math.round((((from + deg) % 360) + 360) % 360);
    this.save();
  };

  /** Back to AUTO: the app turns the map itself (the ASDE-X: the view out of its window). */
  ViewCtl.prototype.autoRotate = function () { this.rot = null; this.save(); };

  /** The heading to put at the top: the one set by hand, else the app's own (auto). */
  ViewCtl.prototype.upHeading = function (auto) { return this.rot === null ? auto : this.rot; };

  ViewCtl.prototype.reset = function () { this.zoom = 1; this.panX = 0; this.panY = 0; this.save(); };

  ViewCtl.prototype.isHome = function () { return this.zoom === 1 && !this.panX && !this.panY; };

  /** {scale, cx, cy} for the view, from the app's own fit. */
  ViewCtl.prototype.apply = function (s0, cx0, cy0) {
    var mx = this.W / 2, my = this.H / 2;
    return { scale: s0 * this.zoom, cx: mx + (cx0 - mx - this.panX) * this.zoom, cy: my + (cy0 - my - this.panY) * this.zoom };
  };

  var INK = "#cfe0f0";
  /** A button's symbol as CSS shapes: up / down / left / right triangles, minus, turn left / right. */
  function icon(doc, kind) {
    var e = doc.createElement("div"), t = "transparent";
    if (kind === "up") e.style.cssText = "width:0;height:0;border-left:10px solid " + t + ";border-right:10px solid " + t + ";border-bottom:14px solid " + INK + ";";
    else if (kind === "down") e.style.cssText = "width:0;height:0;border-left:10px solid " + t + ";border-right:10px solid " + t + ";border-top:14px solid " + INK + ";";
    else if (kind === "left") e.style.cssText = "width:0;height:0;border-top:10px solid " + t + ";border-bottom:10px solid " + t + ";border-right:14px solid " + INK + ";";
    else if (kind === "right") e.style.cssText = "width:0;height:0;border-top:10px solid " + t + ";border-bottom:10px solid " + t + ";border-left:14px solid " + INK + ";";
    else if (kind === "minus") e.style.cssText = "width:16px;height:4px;background:" + INK + ";";
    else if (kind === "rotl" || kind === "rotr") {
      // a curved arrow drawn on a small canvas: three quarters of a circle, counter-clockwise
      // (left) or clockwise (right), with its arrow head
      var c = doc.createElement("canvas"), g, ccw = kind === "rotl";
      c.width = 26; c.height = 26;
      g = c.getContext && c.getContext("2d");
      if (g) {
        // a circle open at the top (from -120 to -60 degrees); counter-clockwise ends at the
        // gap's right end heading left, clockwise at its left end heading right
        var cx = 13, cy = 14, r = 8, d = Math.PI / 180, end = (ccw ? -60 : -120) * d;
        g.strokeStyle = INK; g.fillStyle = INK; g.lineWidth = 3;
        g.beginPath();
        g.arc(cx, cy, r, -60 * d, 240 * d, false);
        g.stroke();
        var ex = cx + r * Math.cos(end), ey = cy + r * Math.sin(end), dir = ccw ? -1 : 1;
        g.beginPath();
        g.moveTo(ex + dir * 6, ey); g.lineTo(ex - dir * 3, ey - 6); g.lineTo(ex - dir * 3, ey + 6);
        g.closePath(); g.fill();
      }
      e = c;
    }
    return e;
  }

  /**
   * The button pad, in the app's element (bottom-right, above the MAPS / MENU tabs).
   * opts.rotate(): the heading at the top now; given, a rotate row goes above the pad.
   */
  ViewCtl.prototype.pad = function (host, opts) {
    var doc = host.ownerDocument || document, self = this;
    var box = doc.createElement("div");
    box.style.cssText = "position:absolute;right:4px;bottom:44px;width:141px;display:flex;flex-wrap:wrap;z-index:890;opacity:0.8;";
    function button(sym, fn) {
      var e = doc.createElement("div");
      e.style.cssText = BTN + (fn ? "" : "visibility:hidden;");
      if (sym.length > 1 && sym !== "AUTO") e.appendChild(icon(doc, sym));
      else e.textContent = sym;
      if (fn) e.addEventListener("mouseup", function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); fn(); });
      box.appendChild(e);
      return e;
    }
    var auto = null;
    if (opts && opts.rotate) {
      button("rotl", function () { self.rotateBy(15, opts.rotate()); show(); });
      auto = button("AUTO", function () { self.autoRotate(); show(); });
      auto.style.fontSize = "13px";
      button("rotr", function () { self.rotateBy(-15, opts.rotate()); show(); });
    }
    function show() { if (auto) auto.style.color = self.rot === null ? "#7dffa0" : "#6f8399"; }
    show();
    [["+", function () { self.zoomBy(1); }], ["up", function () { self.pan(0, -1); }], ["minus", function () { self.zoomBy(-1); }],
     ["left", function () { self.pan(-1, 0); }], ["C", function () { self.reset(); }], ["right", function () { self.pan(1, 0); }],
     ["", null], ["down", function () { self.pan(0, 1); }], ["", null]].forEach(function (b) { button(b[0], b[1]); });
    host.appendChild(box);
    // mouse wheel zooms too, where the sim passes it on
    host.addEventListener("wheel", function (ev) { self.zoomBy(ev.deltaY < 0 ? 1 : -1); });
    return box;
  };

  return ViewCtl;
})();
