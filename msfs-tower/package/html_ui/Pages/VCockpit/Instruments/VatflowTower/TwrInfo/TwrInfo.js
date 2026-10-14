/*
 * VATFLOW Tower Cab - TWR INFO display (in-cab screen SCREEN_TWRINFO).
 *
 * Shows what a local controller glances at: Zulu time, the real-world METAR
 * wind and altimeter (what VATSIM controllers issue), the VATSIM ATIS letter,
 * who is online at DCA / Potomac / ZDC, and inbound/outbound counts. The sim's
 * own wind and pressure at the cab are shown small underneath for comparison.
 *
 * TwrInfoView is plain DOM code (also used by preview/index.html); the MSFS
 * wrapper at the bottom only exists when BaseInstrument is defined.
 */
var TwrInfoView = (function () {
  var METAR_REFRESH_MS = 5 * 60 * 1000;

  function parseMetar(text) {
    var out = { raw: text || "", wind: null, altim: null };
    var w = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(out.raw);
    if (w) out.wind = { dir: w[1], kt: parseInt(w[2], 10), gust: w[3] ? parseInt(w[3], 10) : null };
    var a = /\bA(\d{4})\b/.exec(out.raw);
    if (a) out.altim = (parseInt(a[1], 10) / 100).toFixed(2);
    return out;
  }

  function TwrInfoView(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.feed = null;
    this.metar = null;
    this.feedError = null;
    this.el = {};
    var ids = ["icao", "zulu", "atis", "wind", "windArrow", "altim", "metar", "atc", "counts", "sim", "status"];
    for (var i = 0; i < ids.length; i++) this.el[ids[i]] = root.querySelector("#ti-" + ids[i]);
    this.el.icao.textContent = cfg.icao;
  }

  TwrInfoView.parseMetar = parseMetar;

  TwrInfoView.prototype.setFeed = function (summary) { this.feed = summary; this.feedError = null; };
  TwrInfoView.prototype.setFeedError = function (e) { this.feedError = String(e && e.message ? e.message : e); };
  TwrInfoView.prototype.setMetar = function (text) { this.metar = parseMetar(text); };

  /** Starts METAR polling (the VATSIM feed is polled by the caller). */
  TwrInfoView.prototype.startMetar = function () {
    var self = this;
    function tick() {
      VatflowFeed.httpGet(self.cfg.metarUrl, function (err, text) {
        if (!err) self.setMetar(String(text).trim());
        setTimeout(tick, err ? 30000 : METAR_REFRESH_MS);
      });
    }
    tick();
  };

  /** sim: { zuluSec, windDirTrue, windKt, slpMb } (any field may be missing) */
  TwrInfoView.prototype.render = function (sim) {
    var pad = VatflowFeed.pad, el = this.el, cfg = this.cfg;
    sim = sim || {};
    if (typeof sim.zuluSec === "number" && !isNaN(sim.zuluSec)) {
      var z = sim.zuluSec;
      el.zulu.textContent = pad(Math.floor(z / 3600) % 24, 2) + pad(Math.floor(z / 60) % 60, 2) + ":" + pad(Math.floor(z) % 60, 2) + "Z";
    }

    var m = this.metar;
    if (m && m.wind) {
      var w = m.wind;
      var calm = w.kt === 0;
      // METAR wind is true; towers issue magnetic
      var mag = w.dir === "VRB" ? "VRB" : pad(((parseInt(w.dir, 10) - cfg.magVarDeg) % 360 + 360) % 360 || 360, 3);
      el.wind.textContent = calm ? "CALM" : mag + "@" + w.kt + (w.gust ? "G" + w.gust : "");
      if (w.dir !== "VRB" && !calm) {
        el.windArrow.style.display = "block";
        // arrow points where the wind blows FROM, on a north-up dial
        el.windArrow.style.transform = "rotate(" + parseInt(w.dir, 10) + "deg)";
      } else {
        el.windArrow.style.display = "none";
      }
    } else {
      el.wind.textContent = "---";
    }
    el.altim.textContent = m && m.altim ? m.altim : "--.--";
    el.metar.textContent = m ? m.raw : "METAR: WAITING";

    var f = this.feed;
    el.atis.textContent = f && f.atis && f.atis.code ? f.atis.code : "-";
    if (f) {
      var parts = [];
      for (var i = 0; i < f.controllers.length; i++) {
        parts.push(f.controllers[i].callsign + " " + f.controllers[i].freq);
      }
      el.atc.textContent = parts.length ? parts.join("   ") : "NO DCA / PCT / ZDC ATC ONLINE";
      el.counts.textContent = "ARR " + f.arrivals + " (50NM)   DEP " + f.departures + " (ON GND)";
    }
    el.status.textContent = this.feedError ? "VATSIM FEED: " + this.feedError.toUpperCase() : (f ? "" : "VATSIM FEED: WAITING");

    if (typeof sim.windDirTrue === "number" && typeof sim.slpMb === "number") {
      var simMag = ((Math.round(sim.windDirTrue - cfg.magVarDeg) % 360) + 360) % 360 || 360;
      el.sim.textContent = "SIM AT CAB " + pad(simMag, 3) + "@" + Math.round(sim.windKt) + "  " + (sim.slpMb * 0.0295300).toFixed(2);
    }
  };

  return TwrInfoView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowTwrInfo extends BaseInstrument {
    get templateID() { return "VatflowTwrInfo"; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.view = new TwrInfoView(this.querySelector("#ti-root"), VATFLOW_TWR);
      this.view.startMetar();
      this.lastDraw = 0;
      var view = this.view;
      VatflowFeed.poll(VATFLOW_TWR, function (d) { view.setFeed(d); }, function (e) { view.setFeedError(e); });
    }
    Update() {
      super.Update();
      var now = Date.now();
      if (now - this.lastDraw < 500) return;
      this.lastDraw = now;
      this.view.render({
        zuluSec: SimVar.GetSimVarValue("E:ZULU TIME", "seconds"),
        windDirTrue: SimVar.GetSimVarValue("AMBIENT WIND DIRECTION", "degrees"),
        windKt: SimVar.GetSimVarValue("AMBIENT WIND VELOCITY", "knots"),
        slpMb: SimVar.GetSimVarValue("SEA LEVEL PRESSURE", "millibars")
      });
    }
  }
  registerInstrument("vatflow-twrinfo", VatflowTwrInfo);
}
