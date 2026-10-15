/*
 * VATFLOW Tower Cab - the TMU desk's two APT Dashboard screens (vatflow.io Airport TMU,
 * "Apt Dashboard" for KDCA):
 *   $SCREEN_APTDEMAND  DEMAND vs AAR, 15-minute ETA bins for the next two hours, olive up
 *                      to the AAR's share per bin and red above it (AptDemandView, canvas)
 *   $SCREEN_APTLIST    the Aircraft List in metered (STA) order: # CALLSIGN TYPE DEP GATE
 *                      STATUS DIST GS ETA STA DLY REC WU (AptListView, DOM table)
 * Both run the page's flow (common/apt-flow.js) on the VATSIM feed and the hub's program.
 * The views are plain code (also used by preview/index.html); the MSFS wrappers are
 * registered by AptDemand.js / AptList.js.
 */

/** Live data for one screen: VATSIM feed (30 s), hub program, airport positions. */
function VatflowAptData(cfg) {
  this.cfg = cfg;
  this.feed = null;
  this.feedErr = "";
  this.hub = null;
  var self = this;
  if (typeof VatflowMetering !== "undefined") {
    VatflowMetering.loadAirports(function () { self.airportsReady = true; }).catch(function () { /* fallback below */ });
  }
}
VatflowAptData.prototype.lookup = function (icao) {
  var g = typeof VatflowMetering !== "undefined" ? VatflowMetering.getAirport(icao) : null;
  if (g) return g;
  return icao === this.cfg.icao ? [this.cfg.arp.lat, this.cfg.arp.lon] : null;
};
VatflowAptData.prototype.start = function () {
  var self = this;
  (function tick() {
    VatflowFeed.httpGet(self.cfg.feedUrl, function (err, text) {
      if (err) self.feedErr = err.message;
      else { try { self.feed = JSON.parse(text); self.feedErr = ""; } catch (e) { self.feedErr = e.message; } }
      setTimeout(tick, 30000);
    });
  })();
  if (typeof VatflowHub !== "undefined") VatflowHub.listen(function (st) { self.hub = st; });
};
VatflowAptData.prototype.flow = function (now) {
  if (!this.feed) return null;
  var t = this.cfg.icao, self = this;
  return VatflowAptFlow.computeFlow({ feed: this.feed, target: t, now: now || Date.now(),
    program: this.hub && this.hub.rates ? this.hub.rates[t] || null : null,
    edcts: this.hub ? this.hub.edcts : null, lookup: function (c) { return self.lookup(c); } });
};
VatflowAptData.prototype.programText = function (flow) {
  var hub = typeof VatflowHub !== "undefined" ? VatflowHub.status() : "bad";
  if (!flow) return hub === "ok" ? "" : "PROGRAMS " + (hub === "bad" ? "OFFLINE" : "...");
  var r = flow.rate;
  if (!flow.hasProgram) return "NO PROGRAM - AAR " + r.aar + " (DEFAULT)" + (hub === "ok" ? "" : " - HUB " + (hub === "bad" ? "OFFLINE" : "..."));
  var bits = ["PROGRAM AAR " + r.aar];
  if (r.mit) bits.push(r.mit + " MIT"); else if (r.trail) bits.push(r.trail + " MIN TRAIL");
  if (r.jetsOnly) bits.push("JETS ONLY");
  if (r.excludeWake && r.excludeWake.length) bits.push("EXCL WAKE " + r.excludeWake.join(""));
  return bits.join(" - ");
};

/* ---------- DEMAND vs AAR ---------- */
var AptDemandView = (function () {
  var F = VatflowAptFlow;
  function AptDemandView(canvas, cfg, data) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cfg = cfg;
    this.data = data;
  }
  AptDemandView.prototype.draw = function (now) {
    now = now || Date.now();
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, cfg = this.cfg;
    var flow = this.data.flow(now);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#080b10"; ctx.fillRect(0, 0, W, H);
    // header
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.font = "bold 22px monospace"; ctx.fillStyle = "#e8a838"; ctx.fillText("APT DASHBOARD", 20, 34);
    ctx.fillStyle = "#d4dde6"; ctx.fillText(cfg.icao, 210, 34);
    ctx.textAlign = "right"; ctx.fillText(F.fmtZ(now) + "Z", W - 20, 34);
    ctx.font = "14px monospace"; ctx.fillStyle = "#9aa8b5";
    ctx.fillText(this.data.feedErr ? "VATSIM " + this.data.feedErr.toUpperCase() : this.data.programText(flow), W - 110, 33);
    ctx.fillStyle = "#1e2834"; ctx.fillRect(0, 50, W, 2);
    // card
    var cx = 20, cy = 66, cw = W - 40, ch = 560;
    ctx.fillStyle = "#0a0e14"; ctx.fillRect(cx, cy, cw, ch);
    ctx.strokeStyle = "#1e2834"; ctx.lineWidth = 1; ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
    ctx.textAlign = "left"; ctx.font = "16px monospace"; ctx.fillStyle = "#9aa8b5";
    ctx.fillText("DEMAND vs AAR — 15 MIN BINS", cx + 22, cy + 32);
    if (!flow) { ctx.fillStyle = "#5c6b78"; ctx.fillText("Waiting for the VATSIM feed...", cx + 22, cy + 80); return; }
    var aar = flow.rate.aar;
    var bins = F.buildDemandBins(flow, aar, F.DEMAND_BIN_MIN, F.DEMAND_BIN_COUNT);
    var total = bins.counts.reduce(function (a, b) { return a + b; }, 0);
    var anyMetered = flow.flights.some(function (f) { return f.status !== "ARRIVED" && F.isMetered(f); });
    if (!total && !anyMetered) {
      ctx.textAlign = "center"; ctx.fillStyle = "#5c6b78"; ctx.font = "18px monospace";
      ctx.fillText("No metered demand in the next " + (bins.binCount * bins.binMin) + " minutes.", cx + cw / 2, cy + ch / 2);
    } else {
      // the page's chart geometry (720 x 280 viewBox) scaled into the card
      var n = bins.binCount, maxCount = Math.max.apply(null, [bins.binCap * 2, 1].concat(bins.counts));
      var px = cx + 22, py = cy + 56, pw = cw - 44 - 110, ph = ch - 56 - 60, gap = 14;
      var barW = (pw - gap * (n - 1)) / n;
      var yOf = function (v) { return py + ph - (v / maxCount) * ph; };
      // AAR line + label
      var aarY = yOf(bins.binCap);
      ctx.strokeStyle = "#e8c84a"; ctx.lineWidth = 2; ctx.setLineDash([8, 7]);
      ctx.beginPath(); ctx.moveTo(px, aarY); ctx.lineTo(px + pw + 12, aarY); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#e8c84a"; ctx.font = "bold 18px monospace"; ctx.textAlign = "left";
      ctx.fillText("AAR " + aar, px + pw + 20, aarY + 6);
      for (var i = 0; i < n; i++) {
        var c = bins.counts[i], x = px + i * (barW + gap);
        var under = Math.min(c, bins.binCap), over = Math.max(0, c - bins.binCap);
        if (under > 0) { ctx.fillStyle = "#8a7a3a"; ctx.fillRect(x, yOf(under), barW, (under / maxCount) * ph); }
        if (over > 0) {
          ctx.fillStyle = "rgba(232,90,58,0.35)"; ctx.fillRect(x - 3, yOf(c) - 3, barW + 6, (over / maxCount) * ph + 3);
          ctx.fillStyle = "#e85a3a"; ctx.fillRect(x, yOf(c), barW, (over / maxCount) * ph);
        }
        ctx.textAlign = "center";
        if (c) { ctx.fillStyle = over ? "#ff8a70" : "#d4dde6"; ctx.font = "bold 18px monospace"; ctx.fillText(String(c), x + barW / 2, yOf(c) - 8); }
        ctx.fillStyle = "#5c6b78"; ctx.font = "14px monospace";   // bin start time
        ctx.fillText(F.fmtZ(flow.now + i * bins.binMin * 60000), x + barW / 2, py + ph + 24);
      }
    }
    // hint and next-hour / gates summary
    ctx.textAlign = "left"; ctx.font = "14px monospace"; ctx.fillStyle = "#5c6b78";
    ctx.fillText("Olive is at or below capacity (" + bins.binCap + "/bin from AAR " + aar + "/hr). Red is over capacity.", cx, cy + ch + 26);
    ctx.font = "bold 18px monospace";
    ctx.fillStyle = flow.demandHr > aar ? "#e07070" : "#d4dde6";
    ctx.fillText("NEXT 60 MIN " + flow.demandHr + " / " + aar, cx, cy + ch + 62);
    var gx = cx + 280;
    ctx.font = "16px monospace";
    flow.allGates.slice(0, 6).forEach(function (g) {
      ctx.fillStyle = flow.gateColors[g[0]] || "#d4dde6";
      var t = g[0] + " " + g[1];
      ctx.fillText(t, gx, cy + ch + 62);
      gx += t.length * 10 + 26;
    });
  };
  return AptDemandView;
})();

/* ---------- Aircraft List ---------- */
var AptListView = (function () {
  var F = VatflowAptFlow;
  var ROWS = 21;
  var COLS = [["#", "c-n"], ["CALLSIGN", "c-cs"], ["TYPE", "c-ty"], ["DEP", "c-dp"], ["GATE", "c-gt"], ["STATUS", "c-st"],
    ["DIST", "c-ds"], ["GS", "c-gs"], ["ETA Z", "c-et"], ["STA Z", "c-sa"], ["DLY", "c-dl"], ["REC WU (INFO)", "c-wu"]];
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function AptListView(root, cfg, data) {
    this.cfg = cfg;
    this.data = data;
    this.el = { prog: root.querySelector("#al-prog"), zulu: root.querySelector("#al-zulu"), head: root.querySelector("#al-head"),
      body: root.querySelector("#al-body"), foot: root.querySelector("#al-foot"), icao: root.querySelector("#al-icao") };
    this.el.icao.textContent = cfg.icao;
    this.el.head.innerHTML = COLS.map(function (c) { return '<span class="' + c[1] + '">' + c[0] + (c[0] === "#" ? " ▴" : "") + "</span>"; }).join("");
  }
  AptListView.prototype.render = function (now) {
    now = now || Date.now();
    var el = this.el, flow = this.data.flow(now), cfg = this.cfg;
    el.zulu.textContent = F.fmtZ(now) + "Z";
    el.prog.textContent = this.data.feedErr ? "VATSIM " + this.data.feedErr.toUpperCase() : this.data.programText(flow);
    var h = "";
    if (!flow) h = '<div class="al-msg">Waiting for the VATSIM feed...</div>';
    else if (!flow.flights.length) h = '<div class="al-msg">No traffic filed to ' + esc(cfg.icao) + " right now. The feed refreshes every 30 seconds.</div>";
    else {
      var gsText = F.groundStopFor(this.data.hub && this.data.hub.groundStops, cfg.icao);
      flow.flights.slice(0, ROWS).forEach(function (f, i) {
        var wu = F.recWu(f, flow, f.status === "GROUND" && !f.vfr ? gsText : null);
        h += '<div class="al-row' + (i % 2 ? " even" : "") + '">' +
          '<span class="c-n mut">' + f.seq + "</span>" +
          '<span class="c-cs str">' + esc(f.callsign) + "</span>" +
          '<span class="c-ty">' + esc(f.type) + "</span>" +
          '<span class="c-dp">' + esc(f.dep) + "</span>" +
          '<span class="c-gt" style="color:' + (flow.gateColors[f.gate] || "#d4dde6") + '">' + esc(f.gate) + "</span>" +
          '<span class="c-st" style="color:' + F.statusColor(f) + '">' + f.status + (f.est ? "*" : "") + "</span>" +
          '<span class="c-ds">' + Math.round(f.dist) + "</span>" +
          '<span class="c-gs">' + (f.gs || "—") + "</span>" +
          '<span class="c-et">' + F.fmtZ(f.eta) + "</span>" +
          '<span class="c-sa str">' + F.fmtZ(f.sta) + "</span>" +
          '<span class="c-dl" style="color:' + F.delayColor(f.delay) + '">' + F.fmtDelay(f.delay) + "</span>" +
          '<span class="c-wu" style="color:' + wu.c + '">' + esc(wu.t) + "</span></div>";
      });
    }
    if (h !== this.last) { el.body.innerHTML = h; this.last = h; }
    if (flow) {
      var n = { AIRBORNE: 0, GROUND: 0, PROPOSED: 0, ARRIVED: 0 };
      flow.flights.forEach(function (f) { n[f.status]++; });
      el.foot.textContent = flow.flights.length + " FLIGHTS - " + n.AIRBORNE + " AIRBORNE - " + n.GROUND + " GROUND - " +
        n.PROPOSED + " PROPOSED - " + n.ARRIVED + " ARRIVED" + (flow.flights.length > ROWS ? "   (FIRST " + ROWS + " BY STA)" : "") +
        "   * = DEPARTURE FIELD UNKNOWN";
    }
  };
  return AptListView;
})();

/** MSFS wrappers: which = "demand" | "list". */
function vatflowRegisterAptDash(which, tag, templateId) {
  if (typeof BaseInstrument === "undefined") return;
  class VatflowAptDash extends BaseInstrument {
    get templateID() { return templateId; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      this.data = new VatflowAptData(VATFLOW_TWR);
      this.data.start();
      if (which === "demand") {
        this.view = new AptDemandView(this.querySelector("canvas"), VATFLOW_TWR, this.data);
        this.tick = VatflowDraw.loop(this.view, 2000);
      } else {
        this.view = new AptListView(this.querySelector("#al-root"), VATFLOW_TWR, this.data);
        this.last = 0;
      }
    }
    Update() {
      super.Update();
      this.dim();
      if (this.tick) this.tick(false);
      else if (Date.now() - this.last >= 2000) {
        this.last = Date.now();
        try { this.view.render(); } catch (e) { console.error("VATFLOW apt list", (e && e.stack) || e); }
      }
    }
  }
  registerInstrument(tag, VatflowAptDash);
}
