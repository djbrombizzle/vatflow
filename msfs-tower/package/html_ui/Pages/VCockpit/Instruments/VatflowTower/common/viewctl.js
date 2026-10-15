/*
 * VATFLOW Tower Cab - zoom and pan for the DBRITE and ASDE-X: a small pad of buttons
 * (+ / - zoom, arrows pan, C back to the whole picture) in the screen's corner. The
 * view is kept per screen (VatflowStore "VIEW_<app>_<screen>").
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
    this.onChange = null;
  }

  ViewCtl.prototype.save = function () {
    if (this.key) VatflowStore.set(this.key, { zoom: this.zoom, panX: this.panX, panY: this.panY });
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

  ViewCtl.prototype.reset = function () { this.zoom = 1; this.panX = 0; this.panY = 0; this.save(); };

  ViewCtl.prototype.isHome = function () { return this.zoom === 1 && !this.panX && !this.panY; };

  /** {scale, cx, cy} for the view, from the app's own fit. */
  ViewCtl.prototype.apply = function (s0, cx0, cy0) {
    var mx = this.W / 2, my = this.H / 2;
    return { scale: s0 * this.zoom, cx: mx + (cx0 - mx - this.panX) * this.zoom, cy: my + (cy0 - my - this.panY) * this.zoom };
  };

  /** The button pad, in the app's element (bottom-right, above the MAPS / MENU tabs). */
  ViewCtl.prototype.pad = function (host) {
    var doc = host.ownerDocument || document, self = this;
    var box = doc.createElement("div");
    box.style.cssText = "position:absolute;right:4px;bottom:44px;width:141px;display:flex;flex-wrap:wrap;z-index:890;opacity:0.8;";
    [["+", function () { self.zoomBy(1); }], ["▲", function () { self.pan(0, -1); }], ["−", function () { self.zoomBy(-1); }],
     ["◀", function () { self.pan(-1, 0); }], ["C", function () { self.reset(); }], ["▶", function () { self.pan(1, 0); }],
     ["", null], ["▼", function () { self.pan(0, 1); }], ["", null]].forEach(function (b) {
      var e = doc.createElement("div");
      e.style.cssText = BTN + (b[1] ? "" : "visibility:hidden;");
      e.textContent = b[0];
      if (b[1]) e.addEventListener("mouseup", function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); b[1](); });
      box.appendChild(e);
    });
    host.appendChild(box);
    // mouse wheel zooms too, where the sim passes it on
    host.addEventListener("wheel", function (ev) { self.zoomBy(ev.deltaY < 0 ? 1 : -1); });
    return box;
  };

  return ViewCtl;
})();
