/*
 * VATFLOW Tower Cab - TWR INFO display (in-cab screen SCREEN_TWRINFO).
 *
 * Laid out like the IDS in the cab: "AW" (actual wind) in big type, which is the
 * sim's own wind at the cab (2-minute average, magnetic, with gusts when the
 * peak is 10 kt or more above it), the altimeter, Zulu time, the VATSIM ATIS
 * letter, the real-world METAR, who is online at this airport (VATFLOW_TWR.atcPatterns), and
 * inbound/outbound counts.
 *
 * TwrInfoView is plain DOM code (also used by preview/index.html); the MSFS
 * wrapper at the bottom only exists when BaseInstrument is defined.
 */
var TwrInfoView = (function () {
  var METAR_REFRESH_MS = 5 * 60 * 1000;

  var parseMetar = VatflowFeed.parseMetar;
  var AVG_MS = 2 * 60 * 1000;      // AW: 2-minute average
  var GUST_MS = 10 * 60 * 1000;    // gust: peak over 10 minutes...
  var GUST_OVER_KT = 10;           // ...reported when 10 kt or more above the average

  /**
   * Actual wind from samples [{t, dir (true, from), kt}].
   * Returns { dir (true, rounded to 10 deg, 1..360), kt, gust|null, calm } or null.
   */
  function actualWind(samples, now) {
    var x = 0, y = 0, n = 0, peak = 0;
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (now - s.t <= AVG_MS) {
        var r = s.dir * Math.PI / 180;
        x += Math.sin(r) * s.kt; y += Math.cos(r) * s.kt; n++;
      }
      if (now - s.t <= GUST_MS && s.kt > peak) peak = s.kt;
    }
    if (!n) return null;
    var kt = Math.round(Math.sqrt(x * x + y * y) / n);
    var avgSpeed = 0;
    for (var j = 0; j < samples.length; j++) if (now - samples[j].t <= AVG_MS) avgSpeed += samples[j].kt;
    avgSpeed /= n;
    if (kt < 3) return { dir: 0, kt: 0, gust: null, calm: true };
    var dir = Math.round(((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360 / 10) * 10 || 360;
    var gust = peak - avgSpeed >= GUST_OVER_KT ? Math.round(peak) : null;
    return { dir: dir, kt: kt, gust: gust, calm: false };
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
    this.samples = [];
  }

  TwrInfoView.actualWind = actualWind;

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

    var m = this.metar, now = Date.now();
    if (typeof sim.windDirTrue === "number" && typeof sim.windKt === "number" && !isNaN(sim.windKt)) {
      var last = this.samples[this.samples.length - 1];
      if (!last || now - last.t >= 1000) this.samples.push({ t: now, dir: sim.windDirTrue, kt: sim.windKt });
      while (this.samples.length && now - this.samples[0].t > GUST_MS) this.samples.shift();
    }
    var aw = actualWind(this.samples, now);
    if (aw && aw.calm) {
      el.wind.textContent = "CALM";
      el.windArrow.style.display = "none";
    } else if (aw) {
      // towers issue magnetic
      var magDir = Math.round((((aw.dir - cfg.magVarDeg) % 360) + 360) % 360 / 10) * 10 || 360;
      el.wind.textContent = pad(magDir, 3) + " " + pad(aw.kt, 2) + (aw.gust ? "G" + aw.gust : "");
      el.windArrow.style.display = "block";
      // arrow points where the wind blows FROM, on a north-up dial
      el.windArrow.style.transform = "rotate(" + aw.dir + "deg)";
    } else {
      el.wind.textContent = "--- --";
      el.windArrow.style.display = "none";
    }
    var big = el.wind.textContent.length > 6 ? "78px" : "";   // gusts: keep it on one line
    if (el.wind.style.fontSize !== big) el.wind.style.fontSize = big;
    el.altim.textContent = m && m.altim ? m.altim : "--.--";
    el.metar.textContent = m ? m.raw : "METAR: WAITING";

    var f = this.feed;
    el.atis.textContent = f && f.atis && f.atis.code ? f.atis.code : "-";
    if (f) {
      var parts = [];
      for (var i = 0; i < f.controllers.length; i++) {
        parts.push(f.controllers[i].callsign + " " + f.controllers[i].freq);
      }
      el.atc.textContent = parts.length ? parts.join("   ") : "NO " + (this.cfg.lid || this.cfg.icao) + " ATC ONLINE";
      el.counts.textContent = "ARR " + f.arrivals + " (50NM)   DEP " + f.departures + " (ON GND)";
    }
    el.status.textContent = this.feedError ? "VATSIM FEED: " + this.feedError.toUpperCase() : (f ? "" : "VATSIM FEED: WAITING");

    var parts2 = [];
    if (m && m.wind) {
      var w = m.wind;
      var metMag = w.dir === "VRB" ? "VRB" : pad(((parseInt(w.dir, 10) - cfg.magVarDeg) % 360 + 360) % 360 || 360, 3);
      parts2.push("METAR WIND " + (w.kt === 0 ? "CALM" : metMag + "@" + w.kt + (w.gust ? "G" + w.gust : "")));
    }
    if (typeof sim.slpMb === "number" && !isNaN(sim.slpMb)) parts2.push("SIM ALTIMETER " + (sim.slpMb * 0.0295300).toFixed(2));
    el.sim.textContent = parts2.join("    ");
  };

  return TwrInfoView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowTwrInfo extends BaseInstrument {
    get templateID() { return "VatflowTwrInfo"; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      this.dayNight = VatflowDimmer.master();     // day / night for every screen and the cab lights
      this.lastDraw = 0;
      var self = this;
      // which airport the cab is at decides the METAR, ATIS and ATC shown
      VatflowSite.resolve(function () {
        var view = self.view = new TwrInfoView(self.querySelector("#ti-root"), VATFLOW_TWR);
        view.startMetar();
        VatflowFeed.poll(VATFLOW_TWR, function (d) { view.setFeed(d); }, function (e) { view.setFeedError(e); });
      });
      // this screen is always there, so it is the one that puts the cab in the tower when a
      // flight starts (AUTO PLACE on the SETUP screen)
      VatflowPlace.autoPlace();
    }
    Update() {
      super.Update();
      this.dim();
      this.dayNight();
      var now = Date.now();
      if (!this.view || now - this.lastDraw < 500) return;
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
