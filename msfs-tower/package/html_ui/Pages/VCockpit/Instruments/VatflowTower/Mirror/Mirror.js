/*
 * VATFLOW Tower Cab - mirrored web page (screen $SCREEN_TMUIDS, the TMU desk's third
 * screen): shows the picture placement/web_mirror.py serves from a real browser on this
 * PC (the vZDC IDS, which needs a VATSIM login the sim's own browser can't do), and
 * sends clicks and mouse-wheel scrolling on the screen back to that page.
 *
 * MirrorView is plain DOM code (also used by preview/index.html); the MSFS wrapper at the
 * bottom only exists when BaseInstrument is defined.
 */
var MirrorView = (function () {
  var FRAME_MS = 700;

  function MirrorView(root, cfg) {
    this.cfg = cfg;
    this.img = root.querySelector("#mi-img");
    this.msg = root.querySelector("#mi-msg");
    this.okAt = 0;
    this.loading = false;
    var self = this;
    this.img.onload = function () { self.loading = false; self.okAt = Date.now(); self.msg.textContent = ""; };
    this.img.onerror = function () { self.loading = false; };
    this.img.addEventListener("mouseup", function (e) {
      var r = self.img.getBoundingClientRect();
      var x = (e.clientX - r.left) * 1024 / (r.width || 1024), y = (e.clientY - r.top) * 768 / (r.height || 768);
      self.post("/click", { x: Math.round(x), y: Math.round(y) });
    });
    this.img.addEventListener("wheel", function (e) { self.post("/scroll", { dy: e.deltaY > 0 ? 240 : -240 }); });
  }

  MirrorView.prototype.post = function (path, body) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", this.cfg.base + path, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify(body));
  };

  /** Asks for the next picture; shows how to start the mirror while none arrive. */
  MirrorView.prototype.tick = function (now) {
    now = now || Date.now();
    if (!this.loading) {
      this.loading = true;
      this.img.src = this.cfg.base + "/frame.jpg?t=" + now;
    }
    if (now - this.okAt > 5000) {
      var m = this.cfg.label + ": NO PICTURE FROM THE MIRROR - " + this.cfg.howTo;
      if (this.msg.textContent !== m) this.msg.textContent = m;
    }
  };

  MirrorView.FRAME_MS = FRAME_MS;
  return MirrorView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowMirror extends BaseInstrument {
    get templateID() { return "VatflowMirror"; }
    // Lets the sim pass mouse clicks on the screen through to the page.
    get isInteractive() { return true; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      this.view = new MirrorView(this.querySelector("#mi-root"), VATFLOW_TWR.mirror);
      this.last = 0;
    }
    Update() {
      super.Update();
      this.dim();
      var now = Date.now();
      if (now - this.last >= MirrorView.FRAME_MS) { this.last = now; this.view.tick(now); }
    }
  }
  registerInstrument("vatflow-mirror", VatflowMirror);
}
