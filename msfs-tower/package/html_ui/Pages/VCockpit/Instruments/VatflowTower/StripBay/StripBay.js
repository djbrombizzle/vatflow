/*
 * VATFLOW Tower Cab - a flight strip bay ($SCREEN_STRIPS_n) and its position sign
 * ($SCREEN_SIGN_n). Strips follow the FAA terminal departure strip:
 *
 *   | ACID      | BCN   | DEP | ROUTE ............................ DEST |  |  |  |
 *   | TYPE/EQ   | Pxxxx |     |                                          |  |  |  |
 *   | CID   REV | ALT   |     | RMK                                      |  |  |  |
 *
 * Tap a strip to pick it up (any bay), tap where it goes: another strip (it goes in front
 * of it), a separator (top of that section) or the empty part of the bay (bottom).
 * COCK offsets it as a reminder, DELETE removes it. The model is common/strips.js.
 */
var StripBayView = (function () {
  var W = 512, H = 896, HEAD = 36, FOOT = 60, SEP_H = 26, STRIP_H = 58, MIN_H = 38, GAP = 3;
  var C = {
    board: "#262b31", head: "#0f141a", headText: "#e8eef4", paper: "#ebe6d4", paperVfr: "#e4ecd8", ink: "#161616",
    rule: "#8f8878", sep: "#1c2733", sepText: "#f2f5f8", held: "#ffb000", hint: "#9fb3c6", amended: "#b3261e",
    btn: "#1b2a3a", btnLine: "#4c6a88", btnText: "#e8f1fa", del: "#5a1a14"
  };

  function StripBayView(canvas, n) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.n = n;               // bay 0..2
    this.icao = null;
    this.cfg = null;
    this.st = null;
    this.rows = [];
    this.buttons = [];
    var self = this;
    canvas.addEventListener("mouseup", function (e) {
      var r = canvas.getBoundingClientRect();
      var x = (e.clientX - r.left) * canvas.width / (r.width || canvas.width);
      var y = (e.clientY - r.top) * canvas.height / (r.height || canvas.height);
      self.click(x, y);
    });
  }

  StripBayView.colors = C;

  StripBayView.prototype.setAirport = function (icao) { this.icao = icao; this.reload(); };

  StripBayView.prototype.reload = function () {
    if (!this.icao) return;
    this.cfg = VatflowStrips.config(this.icao);
    this.st = VatflowStrips.normalize(VatflowStrips.state(this.icao), this.cfg);
    this.bay = this.cfg.bays[this.n];
    VatflowStrips.applyPose(this.n, this.bay);
  };

  StripBayView.prototype.act = function (fn) {
    if (!this.icao) return;
    this.st = VatflowStrips.update(this.icao, fn);
    this.draw();
  };

  StripBayView.prototype.click = function (x, y) {
    var i, b, self = this;
    for (i = 0; i < this.buttons.length; i++) {
      b = this.buttons[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { this.act(b.fn); return; }
    }
    var held = this.st && this.st.held;
    for (i = 0; i < this.rows.length; i++) {
      var r = this.rows[i];
      if (y < r.y0 || y > r.y1) continue;
      if (r.type === "strip") {
        if (!held) this.act(function (st) { st.held = r.id; });
        else if (held === r.id) this.act(function (st) { st.held = null; });
        else this.act(function (st) { VatflowStrips.place(st, st.held, self.n, r.sec, r.idx); st.held = null; });
      } else if (held) {
        var idx = r.type === "sep" ? 0 : -1;
        this.act(function (st) { VatflowStrips.place(st, st.held, self.n, r.sec, idx); st.held = null; });
      }
      return;
    }
  };

  /** Rows for the bay: separators and strips, squeezed to fit. */
  StripBayView.prototype.layout = function () {
    var secs = this.st.bays[this.n], seps = this.bay.seps, total = 0, nSeps = seps.length, s;
    for (s = 0; s < secs.length; s++) total += secs[s].length;
    var avail = H - HEAD - FOOT - 8 - nSeps * (SEP_H + GAP);
    var h = total ? Math.max(MIN_H, Math.min(STRIP_H, Math.floor(avail / total) - GAP)) : STRIP_H;
    var rows = [], y = HEAD + 4, bottom = H - FOOT - 4, hidden = 0;
    for (s = 0; s < secs.length; s++) {
      if (nSeps) { rows.push({ type: "sep", sec: s, y0: y, y1: y + SEP_H, name: seps[s] }); y += SEP_H + GAP; }
      for (var i = 0; i < secs[s].length; i++) {
        if (y + h > bottom - (s < secs.length - 1 ? (secs.length - 1 - s) * (SEP_H + GAP) : 0)) { hidden++; continue; }
        rows.push({ type: "strip", sec: s, idx: i, id: secs[s][i], y0: y, y1: y + h });
        y += h + GAP;
      }
    }
    rows.push({ type: "end", sec: secs.length - 1, y0: y, y1: bottom });
    return { rows: rows, h: h, total: total, hidden: hidden };
  };

  function fit(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }

  /** Route box text: route then destination, wrapped into lines of n characters. */
  function routeLines(strip, n, lines) {
    var words = (strip.route ? strip.route + " " : "").split(" ").filter(function (w) { return w; });
    words.push(strip.dest || "");
    var out = [""];
    for (var i = 0; i < words.length; i++) {
      var w = words[i], cur = out[out.length - 1];
      if ((cur ? cur.length + 1 : 0) + w.length <= n) out[out.length - 1] = cur ? cur + " " + w : w;
      else if (out.length < lines) out.push(fit(w, n));
      else { out[out.length - 1] = fit(cur, n - 4) + " ./." ; break; }
    }
    // the destination always shows at the end
    var last = out[out.length - 1], dest = strip.dest || "";
    if (dest && last.slice(-dest.length) !== dest) out[out.length - 1] = fit(last, n - dest.length - 1) + " " + dest;
    return out;
  }

  StripBayView.drawStrip = function (ctx, s, x, y, w, h, held) {
    var k = h / STRIP_H, mono = VatflowDraw.mono;
    ctx.fillStyle = s.vfr ? C.paperVfr : C.paper;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 1;
    var c1 = x + 128, c2 = c1 + 66, c3 = c2 + 52, box = 24, bx = x + w - box * 3;
    var cols = [c1, c2, c3, bx, bx + box, bx + box * 2];
    ctx.beginPath();
    for (var i = 0; i < cols.length; i++) { ctx.moveTo(cols[i] + 0.5, y); ctx.lineTo(cols[i] + 0.5, y + h); }
    ctx.stroke();
    var l1 = y + 17 * k, l2 = y + 34 * k, l3 = y + 51 * k;
    ctx.fillStyle = C.ink;
    ctx.textBaseline = "alphabetic";
    ctx.font = "bold " + Math.round(17 * k) + "px monospace";
    mono(ctx, fit(s.cs, 11), x + 5, l1, 10.5 * k);
    ctx.font = Math.round(14 * k) + "px monospace";
    var cw = 8.4 * k;
    mono(ctx, fit(s.type, 14), x + 5, l2, cw);
    mono(ctx, fit(s.cid, 3), x + 5, l3, cw);
    if (s.rev) {
      ctx.fillStyle = s.amended ? C.amended : C.ink;
      mono(ctx, fit(String(s.rev), 3), c1 - 4 - 3 * cw, l3, cw);
      ctx.fillStyle = C.ink;
    }
    mono(ctx, fit(s.bcn, 4), c1 + 5, l1, cw);
    mono(ctx, fit(s.ptime, 5), c1 + 5, l2, cw);
    mono(ctx, fit(s.alt, 7), c1 + 5, l3, cw);
    mono(ctx, fit(s.dep, 4), c2 + 6, l1, cw);
    var n = Math.floor((bx - c3 - 10) / cw);
    var rl = routeLines(s, n, 2);
    mono(ctx, rl[0] || "", c3 + 5, l1, cw);
    if (rl[1]) mono(ctx, rl[1], c3 + 5, l2, cw);
    if (s.rmk) mono(ctx, fit(s.rmk.replace(/\s+/g, " "), n), c3 + 5, l3, cw);
    if (held) {
      ctx.strokeStyle = C.held;
      ctx.lineWidth = 4;
      ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
    }
  };

  StripBayView.prototype.button = function (ctx, label, x, y, w, h, fn, fill) {
    ctx.fillStyle = fill || C.btn;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.btnLine;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = C.btnText;
    ctx.font = "bold 18px monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, x + w / 2, y + h / 2 + 6);
    ctx.textAlign = "left";
    this.buttons.push({ x: x, y: y, w: w, h: h, fn: fn });
  };

  StripBayView.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.board;
    ctx.fillRect(0, 0, W, H);
    this.buttons = [];
    if (!this.st) {
      ctx.fillStyle = C.hint;
      ctx.font = "bold 20px monospace";
      ctx.fillText("LOCATING AIRPORT...", 20, 80);
      return;
    }
    var L = this.layout(), held = this.st.held;
    this.rows = L.rows;
    // header: bay name, strip count, zulu
    ctx.fillStyle = C.head;
    ctx.fillRect(0, 0, W, HEAD);
    ctx.fillStyle = C.headText;
    ctx.font = "bold 20px monospace";
    ctx.fillText(fit(this.bay.name, 16), 10, 25);
    ctx.font = "16px monospace";
    var z = VatflowDraw.zulu(VatflowDraw.zuluNow());
    ctx.textAlign = "right";
    ctx.fillText(L.total + " STRIP" + (L.total === 1 ? "" : "S") + "   " + z.hh + z.mm + "Z", W - 10, 24);
    ctx.textAlign = "left";
    for (var i = 0; i < L.rows.length; i++) {
      var r = L.rows[i];
      if (r.type === "sep") {
        ctx.fillStyle = C.sep;
        ctx.fillRect(6, r.y0, W - 12, SEP_H);
        ctx.fillStyle = C.sepText;
        ctx.font = "bold 16px monospace";
        ctx.textAlign = "center";
        ctx.fillText(fit(r.name, 24) + (held ? "   ▾" : ""), W / 2, r.y0 + 18);
        ctx.textAlign = "left";
      } else if (r.type === "strip") {
        var s = this.st.strips[r.id];
        var off = s.cocked ? 24 : 0;
        StripBayView.drawStrip(ctx, s, 6 + off, r.y0, W - 12 - 24, r.y1 - r.y0, held === r.id);
      } else if (held && r.y1 - r.y0 > 20) {
        ctx.strokeStyle = C.hint;
        ctx.setLineDash ? ctx.setLineDash([6, 6]) : null;
        ctx.lineWidth = 2;
        ctx.strokeRect(8, r.y0 + 2, W - 16, Math.min(60, r.y1 - r.y0 - 4));
        ctx.setLineDash ? ctx.setLineDash([]) : null;
        ctx.fillStyle = C.hint;
        ctx.font = "15px monospace";
        ctx.fillText("TAP HERE: BOTTOM OF THE BAY", 18, r.y0 + 26);
      }
    }
    if (L.hidden) {
      ctx.fillStyle = C.held;
      ctx.font = "bold 15px monospace";
      ctx.fillText("+" + L.hidden + " MORE NOT SHOWN", 12, H - FOOT - 8);
    }
    // footer: what to do / the held strip's buttons
    var fy = H - FOOT;
    ctx.fillStyle = C.head;
    ctx.fillRect(0, fy, W, FOOT);
    if (held && this.st.strips[held]) {
      this.button(ctx, "PUT BACK", 8, fy + 8, 156, 44, function (st) { st.held = null; });
      this.button(ctx, "COCK", 178, fy + 8, 156, 44, function (st) { VatflowStrips.cock(st, st.held); st.held = null; });
      this.button(ctx, "DELETE", 348, fy + 8, 156, 44, function (st) { VatflowStrips.remove(st, st.held, true); }, C.del);
    } else {
      ctx.fillStyle = C.hint;
      ctx.font = "16px monospace";
      ctx.fillText("TAP A STRIP TO PICK IT UP", 12, fy + 36);
    }
  };

  return StripBayView;
})();

/** Position sign under a bay: the bay's name. */
var StripSignView = (function () {
  function StripSignView(canvas, n) { this.canvas = canvas; this.ctx = canvas.getContext("2d"); this.n = n; this.name = ""; }
  StripSignView.prototype.setName = function (name) { this.name = name || ""; this.draw(); };
  StripSignView.prototype.draw = function () {
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = "#13161a";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#e9e4d2";
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, W - 12, H - 12);
    ctx.fillStyle = "#f4f1e6";
    var size = Math.min(76, Math.floor((W - 40) / Math.max(1, this.name.length) * 1.6));
    ctx.font = "bold " + size + "px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(this.name, W / 2, H / 2 + size * 0.36);
    ctx.textAlign = "left";
  };
  return StripSignView;
})();

/**
 * MSFS gauges for bay n (1..3) and its sign. Bay 1's screen also reads the VATSIM feed and
 * prints / drops strips for all three (one reader, so strips aren't added twice).
 */
function vatflowRegisterStripBay(n, sign) {
  if (typeof BaseInstrument === "undefined") return;
  var tag = (sign ? "vatflow-sign-" : "vatflow-strips-") + n, templateId = (sign ? "VatflowSign" : "VatflowStrips") + n;
  class VatflowStripScreen extends BaseInstrument {
    get templateID() { return templateId; }
    get isInteractive() { return !sign; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      var canvas = this.querySelector("canvas"), self = this;
      this.view = sign ? new StripSignView(canvas, n - 1) : new StripBayView(canvas, n - 1);
      this.rev = -1;
      this.flip = false;
      VatflowSite.resolve(function (site) {
        self.site = site;
        if (sign) self.view.setName(VatflowStrips.config(site.icao).bays[n - 1].name);
        else self.view.setAirport(site.icao);
        if (!sign && n === 1) vatflowStripFeed(site);
      });
    }
    Update() {
      super.Update();
      this.dim();
      if (!this.site) return;
      var r = VatflowStrips.rev(), now = Date.now();
      if (r !== this.rev || now - (this.last || 0) > 1000) {
        if (r !== this.rev) {
          this.rev = r;
          if (sign) this.view.setName(VatflowStrips.config(this.site.icao).bays[n - 1].name);
          else this.view.reload();
        }
        this.last = now;
        if (!sign) this.view.draw();
        this.flip = !this.flip;     // the sim repaints a canvas screen only when the page changes
        this.view.canvas.style.opacity = this.flip ? "0.999" : "1";
      }
    }
  }
  registerInstrument(tag, VatflowStripScreen);
}

/** Reads the VATSIM feed every 20 s and prints / drops strips (one screen does this). */
function vatflowStripFeed(site) {
  (function tick() {
    VatflowFeed.httpGet(VATFLOW_TWR.feedUrl, function (err, text) {
      if (!err) {
        try {
          var feed = JSON.parse(text), now = Date.now();
          var cfg = VatflowStrips.config(site.icao), st = VatflowStrips.normalize(VatflowStrips.state(site.icao), cfg);
          if (VatflowStrips.ingest(st, cfg, feed.pilots, { icao: site.icao, arp: site.arp, elevFt: site.elevFt || VATFLOW_TWR.elevFt }, now)) {
            VatflowStrips.update(site.icao, function (fresh) {
              // apply to the newest copy (a controller may have moved strips meanwhile)
              return VatflowStrips.ingest(fresh, cfg, feed.pilots, { icao: site.icao, arp: site.arp, elevFt: site.elevFt || VATFLOW_TWR.elevFt }, now);
            });
          }
        } catch (e) { if (typeof console !== "undefined") console.error("VATFLOW strips", e); }
      }
      setTimeout(tick, 20000);
    });
  })();
}
