/*
 * VATFLOW Tower Cab - TWR INFO display (in-cab screen SCREEN_TWRINFO).
 *
 * Laid out like the IDS in the cab: "AW" (actual wind) in big type, which is the
 * sim's own wind at the cab (2-minute average, magnetic, with gusts the way a US
 * ASOS / AWOS reports them, see actualWind), the altimeter, Zulu time, the VATSIM
 * ATIS letter and the real-world METAR.
 *
 * Windshear alert: when the wind at the cab suddenly gains or loses 15 kt or more against
 * its 2-minute sustained speed (windshear()), a huge bright red WINDSHEAR ALERT with the
 * gain / loss covers the lower half of the screen (MICROBURST ALERT for a loss of 30 kt or
 * more) and an alarm beeps. The screens can't play sound, so the sim does: sound.xml loops
 * vatflow_windshear.wav (the cab's sound folder) while L:VATFLOW_WS_ALERT is 1. It stays up until the wind
 * has been steady for a minute. MUTE (on the screen, or the red button under the monitor,
 * which flashes while the alarm sounds) silences and hides it until that alert is over.
 *   L:VATFLOW_WS_ALERT  1 while the alarm sounds (the button flashes)
 *   L:VATFLOW_WS_MUTE   set to 1 by the button; the screen mutes and puts it back to 0
 *
 * TwrInfoView is plain DOM code (also used by preview/index.html); the MSFS
 * wrapper at the bottom only exists when BaseInstrument is defined.
 */
var TwrInfoView = (function () {
  var METAR_REFRESH_MS = 5 * 60 * 1000;

  var parseMetar = VatflowFeed.parseMetar;
  // Wind the way a US ASOS / AWOS works it out, from the sim's wind sampled once a second:
  var AVG_MS = 2 * 60 * 1000;      // sustained wind: the 2-minute average
  var PEAK_MS = 5 * 1000;          // peaks: 5-second averages...
  var PEAK_WITHIN_MS = 60 * 1000;  // ...the highest within the past minute
  var GUST_MS = 10 * 60 * 1000;    // reported gust: the highest one in the past 10 minutes
  var GUST_MIN_SUSTAINED = 9;      // a gust needs a sustained wind of 9 kt or more
  var GUST_OVER_KT = 5;            // and a peak at least 5 kt above it

  var WS_KT = 15;                  // windshear: a sudden gain / loss of 15 kt or more
  var WS_MICROBURST_KT = 30;       // a loss of 30 kt or more: microburst
  var WS_HOLD_MS = 60 * 1000;      // the alert stays up until steady this long
  var WS_NEED_MS = 60 * 1000;      // needs a minute of wind history (no alert at startup)

  /** Mean speed of the samples in (now - ms, now]. */
  function meanSpeed(samples, now, ms) {
    var sum = 0, n = 0;
    for (var i = 0; i < samples.length; i++) {
      var age = now - samples[i].t;
      if (age >= 0 && age < ms) { sum += samples[i].kt; n++; }
    }
    return n ? sum / n : null;
  }

  /**
   * One check, like the ASOS makes it continuously: is there a gust right now? The sustained
   * (2-minute) wind must be 9 kt or more and the highest 5-second average in the past minute
   * at least 5 kt above it. Returns that peak (kt) or null.
   */
  function gustNow(samples, now) {
    var sustained = meanSpeed(samples, now, AVG_MS);
    if (sustained === null || sustained < GUST_MIN_SUSTAINED) return null;
    var peak = null;
    for (var i = 0; i < samples.length; i++) {
      var age = now - samples[i].t;
      if (age < 0 || age >= PEAK_WITHIN_MS) continue;
      var p = meanSpeed(samples, samples[i].t, PEAK_MS);     // the 5 s ending at this sample
      if (p !== null && (peak === null || p > peak)) peak = p;
    }
    return peak !== null && peak - sustained >= GUST_OVER_KT ? peak : null;
  }

  /**
   * Windshear check: the past 5 seconds' mean speed against the 2-minute sustained speed.
   * Returns the gain (+) / loss (-) in kt when it is 15 kt or more, else null.
   */
  function windshear(samples, now) {
    if (!samples.length || now - samples[0].t < WS_NEED_MS) return null;
    var sustained = meanSpeed(samples, now, AVG_MS), recent = meanSpeed(samples, now, PEAK_MS);
    if (sustained === null || recent === null) return null;
    var d = Math.round(recent - sustained);
    return Math.abs(d) >= WS_KT ? d : null;
  }

  /**
   * Actual wind from samples [{t, dir (true, from), kt}] and the gusts recorded so far
   * (gusts: [{t, kt}], from gustNow; pass the same array each time, it is kept to 10 minutes).
   * Returns { dir (true, rounded to 10 deg, 1..360), kt, gust|null, calm } or null.
   * kt is the 2-minute mean speed, dir the 2-minute vector average; the gust shown is the
   * highest recorded in the past 10 minutes (so never less than 14 kt), if above kt.
   */
  function actualWind(samples, now, gusts) {
    var x = 0, y = 0, n = 0;
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (now - s.t < AVG_MS && now >= s.t) {
        var r = s.dir * Math.PI / 180;
        x += Math.sin(r) * s.kt; y += Math.cos(r) * s.kt; n++;
      }
    }
    if (!n) return null;
    gusts = gusts || [];
    var g = gustNow(samples, now);
    var lastG = gusts[gusts.length - 1];
    if (g !== null && (!lastG || lastG.t !== now)) gusts.push({ t: now, kt: g });
    while (gusts.length && now - gusts[0].t > GUST_MS) gusts.shift();
    var kt = Math.round(meanSpeed(samples, now, AVG_MS));
    if (kt < 3) return { dir: 0, kt: 0, gust: null, calm: true };
    var dir = Math.round(((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360 / 10) * 10 || 360;
    var top = 0;
    for (var j = 0; j < gusts.length; j++) if (gusts[j].kt > top) top = gusts[j].kt;
    var gust = top && Math.round(top) > kt ? Math.round(top) : null;
    return { dir: dir, kt: kt, gust: gust, calm: false };
  }

  function TwrInfoView(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.feed = null;
    this.metar = null;
    this.feedError = null;
    this.el = {};
    var ids = ["icao", "zulu", "atis", "wind", "windArrow", "altim", "metar", "sim", "status"];
    for (var i = 0; i < ids.length; i++) this.el[ids[i]] = root.querySelector("#ti-" + ids[i]);
    this.el.icao.textContent = cfg.icao;
    this.samples = [];
    this.gusts = [];
    this.ws = { active: false, kt: 0, seen: 0, muted: false };
    var self = this;
    this.el.ws = root.querySelector("#ti-ws");
    this.el.wsText = root.querySelector("#ti-wsText");
    this.el.wsKt = root.querySelector("#ti-wsKt");
    var mute = root.querySelector("#ti-wsMute");
    if (mute) mute.addEventListener("mouseup", function () { self.mute(); });
  }

  TwrInfoView.windshear = windshear;

  /** MUTE: silences and hides the alert showing now (a later one alerts again). */
  TwrInfoView.prototype.mute = function () {
    if (this.ws.active) this.ws.muted = true;
    this.showAlert(Date.now());
  };


  /** Updates the alert from the latest wind (d: windshear() now) and shows / sounds it. */
  TwrInfoView.prototype.checkWindshear = function (d, now) {
    var ws = this.ws;
    if (d !== null) {
      if (!ws.active) { ws.active = true; ws.muted = false; ws.kt = d; }
      else if (Math.abs(d) > Math.abs(ws.kt)) ws.kt = d;
      ws.seen = now;
    } else if (ws.active && now - ws.seen > WS_HOLD_MS) {
      ws.active = false; ws.muted = false; ws.kt = 0;
    }
    this.showAlert(now);
  };

  TwrInfoView.prototype.showAlert = function (now) {
    var ws = this.ws, on = ws.active && !ws.muted, el = this.el;
    if (el.ws) {
      el.ws.style.display = on ? "flex" : "none";
      if (on) {
        el.wsText.textContent = ws.kt <= -WS_MICROBURST_KT ? "MICROBURST ALERT" : "WINDSHEAR ALERT";
        el.wsKt.textContent = Math.abs(ws.kt) + " KT " + (ws.kt > 0 ? "GAIN" : "LOSS");
        el.ws.className = "ti-ws" + (Math.floor(now / 500) % 2 ? " flash" : "");
      }
    }
    if (typeof SimVar !== "undefined") SimVar.SetSimVarValue("L:VATFLOW_WS_ALERT", "number", on ? 1 : 0);
  };

  TwrInfoView.actualWind = actualWind;
  TwrInfoView.gustNow = gustNow;

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
    if (sim.moving) { this.samples = []; this.gusts.length = 0; }   // wind from the old spot means nothing here
    if (typeof sim.windDirTrue === "number" && typeof sim.windKt === "number" && !isNaN(sim.windKt)) {
      var last = this.samples[this.samples.length - 1];
      if (!last || now - last.t >= 1000) this.samples.push({ t: now, dir: sim.windDirTrue, kt: sim.windKt });
      while (this.samples.length && now - this.samples[0].t > AVG_MS + PEAK_MS) this.samples.shift();
    }
    var aw = actualWind(this.samples, now, this.gusts);
    this.checkWindshear(sim.moving ? null : windshear(this.samples, now), now);
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
    get isInteractive() { return true; }             // the windshear MUTE button
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
      if (SimVar.GetSimVarValue("L:VATFLOW_WS_MUTE", "number")) {     // the red button under the monitor
        SimVar.SetSimVarValue("L:VATFLOW_WS_MUTE", "number", 0);
        this.view.mute();
      }
      this.view.render({
        moving: VatflowPlace.busy(),                  // the cab is being moved: its wind jumps
        zuluSec: SimVar.GetSimVarValue("E:ZULU TIME", "seconds"),
        windDirTrue: SimVar.GetSimVarValue("AMBIENT WIND DIRECTION", "degrees"),
        windKt: SimVar.GetSimVarValue("AMBIENT WIND VELOCITY", "knots"),
        slpMb: SimVar.GetSimVarValue("SEA LEVEL PRESSURE", "millibars")
      });
    }
  }
  registerInstrument("vatflow-twrinfo", VatflowTwrInfo);
}
