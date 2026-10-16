/*
 * VATFLOW Tower Cab - a flight strip bay ($SCREEN_STRIPS_n, 1536x896: three 512 columns) and its position sign
 * ($SCREEN_SIGN_n). Strips follow the FAA terminal departure strip:
 *
 *   | ACID      | BCN   | DEP | ROUTE ............................ DEST |  |  |  |
 *   | TYPE/EQ   | Pxxxx |     |                                          |  |  |  |
 *   | CID   REV | ALT   |     | RMK                                      |  |  |  |
 *
 * The board is three columns wide; each separator's section sits in one column (set on the
 * STRIP BAYS screen). A bay with no separators fills its columns left to right.
 * Tap a strip to pick it up (any bay), tap where it goes: another strip (it goes in front
 * of it), a separator (top of that section) or the empty part of a column (its bottom).
 * COCK offsets it as a reminder, DELETE removes it. The model is common/strips.js.
 */
var StripBayView = (function () {
  var W = 1536, H = 896, COLS = 3, CW = W / COLS, HEAD = 36, FOOT = 60, SEP_H = 26, STRIP_H = 58, MIN_H = 38, GAP = 3;
  var C = {
    board: "#262b31", head: "#0f141a", headText: "#e8eef4", paper: "#ebe6d4", paperVfr: "#e4ecd8", ink: "#161616",
    rule: "#8f8878", sep: "#1c2733", sepText: "#f2f5f8", held: "#ffb000", hint: "#9fb3c6", send: "#1d4f7a", amended: "#b3261e",
    btn: "#1b2a3a", btnLine: "#4c6a88", btnText: "#e8f1fa", del: "#5a1a14", rail: "#a8873c"
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
      if (y < r.y0 || y > r.y1 || x < r.x0 || x > r.x1) continue;
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

  /**
   * Rows for the bay: separators and strips, column by column, squeezed to fit (each row
   * has x0 / x1: its column). Columns with no section get no rows.
   */
  StripBayView.prototype.layout = function () {
    var secs = this.st.bays[this.n], seps = this.bay.seps, nSeps = seps.length, total = 0, s, c;
    for (s = 0; s < secs.length; s++) total += secs[s].length;
    var cols = VatflowStrips.cols(this.bay), rows = [], hidden = 0, bottom = H - FOOT - 4;
    // what goes in each column: [{sec, from, to}] (a bay with no separators: its strips split in three)
    var parts = [[], [], []];
    if (!nSeps) {
      var per = Math.max(1, Math.ceil(secs[0].length / COLS));
      for (c = 0; c < COLS; c++) parts[c].push({ sec: 0, from: c * per, to: Math.min(secs[0].length, (c + 1) * per), sep: false });
    } else {
      for (s = 0; s < secs.length; s++) parts[cols[s]].push({ sec: s, from: 0, to: secs[s].length, sep: true });
    }
    for (c = 0; c < COLS; c++) {
      var x0 = c * CW, x1 = x0 + CW, list = parts[c];
      if (!list.length) continue;
      var n = 0, nSep = 0;
      list.forEach(function (p) { n += p.to - p.from; if (p.sep) nSep++; });
      var avail = bottom - HEAD - 4 - nSep * (SEP_H + GAP);
      var h = n ? Math.max(MIN_H, Math.min(STRIP_H, Math.floor(avail / n) - GAP)) : STRIP_H;
      var y = HEAD + 4;
      for (var k = 0; k < list.length; k++) {
        var p = list[k], sepsBelow = 0;
        for (var q = k + 1; q < list.length; q++) if (list[q].sep) sepsBelow++;
        if (p.sep) { rows.push({ type: "sep", sec: p.sec, x0: x0, x1: x1, y0: y, y1: y + SEP_H, name: seps[p.sec] }); y += SEP_H + GAP; }
        for (var i = p.from; i < p.to; i++) {
          if (y + h > bottom - sepsBelow * (SEP_H + GAP)) { hidden++; continue; }
          rows.push({ type: "strip", sec: p.sec, idx: i, id: secs[p.sec][i], x0: x0, x1: x1, y0: y, y1: y + h });
          y += h + GAP;
        }
        // the empty space under a section that has another below it in this column: its bottom
        if (k < list.length - 1) continue;
        rows.push({ type: "end", sec: p.sec, x0: x0, x1: x1, y0: y, y1: bottom });
      }
    }
    return { rows: rows, total: total, hidden: hidden };
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
    ctx.font = "bold 22px monospace";
    ctx.fillText(fit(this.bay.name, 24), 12, 26);
    ctx.font = "18px monospace";
    var z = VatflowDraw.zulu(VatflowDraw.zuluNow());
    ctx.textAlign = "right";
    ctx.fillText(L.total + " STRIP" + (L.total === 1 ? "" : "S") + "   " + z.hh + z.mm + "Z", W - 12, 25);
    ctx.textAlign = "left";
    // rails between the columns
    ctx.fillStyle = C.rail;
    for (var c = 1; c < COLS; c++) ctx.fillRect(c * CW - 2, HEAD, 4, H - HEAD - FOOT);
    for (var i = 0; i < L.rows.length; i++) {
      var r = L.rows[i], x0 = r.x0, cw = r.x1 - r.x0;
      if (r.type === "sep") {
        ctx.fillStyle = C.sep;
        ctx.fillRect(x0 + 6, r.y0, cw - 12, SEP_H);
        ctx.fillStyle = C.sepText;
        ctx.font = "bold 16px monospace";
        ctx.textAlign = "center";
        ctx.fillText(fit(r.name, 24) + (held ? "   \u25BE" : ""), x0 + cw / 2, r.y0 + 18);
        ctx.textAlign = "left";
      } else if (r.type === "strip") {
        var s = this.st.strips[r.id];
        var off = s.cocked ? 24 : 0;
        StripBayView.drawStrip(ctx, s, x0 + 6 + off, r.y0, cw - 12 - 24, r.y1 - r.y0, held === r.id);
      } else if (held && r.y1 - r.y0 > 20) {
        ctx.strokeStyle = C.hint;
        ctx.setLineDash ? ctx.setLineDash([6, 6]) : null;
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 8, r.y0 + 2, cw - 16, Math.min(60, r.y1 - r.y0 - 4));
        ctx.setLineDash ? ctx.setLineDash([]) : null;
        ctx.fillStyle = C.hint;
        ctx.font = "15px monospace";
        ctx.fillText("TAP HERE: BOTTOM OF THIS COLUMN", x0 + 18, r.y0 + 26);
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
      this.button(ctx, "PUT BACK", 8, fy + 8, 200, 44, function (st) { st.held = null; });
      this.button(ctx, "COCK", 222, fy + 8, 200, 44, function (st) { VatflowStrips.cock(st, st.held); st.held = null; });
      this.button(ctx, "DELETE", 436, fy + 8, 200, 44, function (st) { VatflowStrips.remove(st, st.held, true); }, C.del);
      // send it to another bay (the end of that bay's first section), e.g. TMU -> GROUND
      var at = VatflowStrips.where(this.st, held), bx = 660, self = this;
      this.cfg.bays.forEach(function (bay, b) {
        if (at && at.bay === b) return;
        self.button(ctx, "TO " + String(bay.name || "BAY " + (b + 1)).slice(0, 12), bx, fy + 8, 230, 44, function (st) {
          VatflowStrips.place(st, st.held, b, 0, -1);
          st.held = null;
        }, C.send);
        bx += 244;
      });
      ctx.fillStyle = C.held;
      ctx.font = "bold 18px monospace";
      ctx.fillText("HOLDING " + held + ", OR TAP A SPOT", bx + 10, fy + 37);
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
 * prints / drops strips for all three (one reader, so strips aren't added twice), and runs
 * STRIP SYNC with other cabs (common/strip-sync.js).
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
        if (!sign && n === 1) {
          vatflowStripFeed(site);
          VatflowStripSync.start(site.icao);     // STRIP SYNC with other cabs (TOWER SETUP), once
        }
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

/** Reads the VATSIM feed every 20 s and prints / drops strips (one screen does this, once). */
function vatflowStripFeed(site) {
  if (vatflowStripFeed.running) return;      // the sim attached bay 1 again: the reader already runs
  vatflowStripFeed.running = true;
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
