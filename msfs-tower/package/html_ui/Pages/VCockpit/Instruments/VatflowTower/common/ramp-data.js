/*
 * VATFLOW Tower Cab - live ramp data shared by the ramp list and the ramp map screens:
 * the VATSIM feed and the ramp hub's read-only state, turned into rows by the same code
 * vatflow.io's gates / ramp pages run (common/vatflow-ramp.js = shared/ramp-core.js,
 * common/ramp-kdca.js = the KDCA layout).
 *
 * VatflowRampData.airports / .layout: the airports on vatflow.io's ramp page and their
 * layouts for the RAMP app, read live from vatflow.io (so new airports and ramp changes
 * there show up in the cab), else the copies in the package (ramp/<ICAO>.json, built by
 * tools/build_vatflow_bundles.mjs).
 */
var VatflowRampData = (function () {
  var R = typeof VatflowRamp !== "undefined" ? VatflowRamp : null;
  var HUB = "https://web-production-3d9fe.up.railway.app/hub/ramp/state";
  var SITE = "https://vatflow.io/data/ramp/";
  var layouts = {}, liveIndex = null;

  function localBase() {
    return (typeof VATFLOW_TWR !== "undefined" && VATFLOW_TWR.rampBase) || "/Pages/VCockpit/Instruments/VatflowTower/ramp/";
  }

  function getJson(url, cb) {
    var x = new XMLHttpRequest(), done = false;
    function fin(err, d) { if (!done) { done = true; cb(err, d); } }
    x.open("GET", url, true);
    x.timeout = 10000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      // package files can come back with status 0 in the sim's browser
      if (x.status === 200 || (x.status === 0 && x.responseText)) {
        try { fin(null, JSON.parse(x.responseText)); } catch (e) { fin(e); }
      } else fin(new Error("HTTP " + x.status));
    };
    x.ontimeout = function () { fin(new Error("timeout")); };
    x.send();
  }

  /** First url that answers with what ok(d) accepts. */
  function first(urls, ok, cb) {
    (function next(i) {
      if (i >= urls.length) { cb(null); return; }
      getJson(urls[i], function (err, d) { if (!err && d && ok(d)) cb(d, urls[i]); else next(i + 1); });
    })(0);
  }

  function RampData(layoutRaw) {
    this.L = R && layoutRaw ? R.indexLayout(JSON.parse(JSON.stringify(layoutRaw))) : null;
    this.state = R && this.L ? R.emptyState(this.L.icao) : null;
    this.realGates = {};
    this.pilots = [];
    this.memory = new Map();       // parked / pushing detection between updates
    this.autoMemo = new Map();     // keeps gate proposals stable between updates
    this.hubOk = false;
    this.hubErr = "";
    this.feedErr = "";
  }

  RampData.prototype.setPilots = function (feed) { this.pilots = (feed && feed.pilots) || []; this.feedErr = ""; };
  RampData.prototype.setHub = function (resp) {
    if (resp && resp.ok && resp.state) {
      this.state = resp.state;
      this.realGates = resp.realGates || {};
      this.hubOk = true;
      this.hubErr = "";
    } else {
      this.hubOk = false;
      this.hubErr = (resp && resp.error) || "ramp hub: no state";
    }
  };

  /** Polls the VATSIM feed (15 s) and the ramp hub (10 s) until stop(). */
  RampData.prototype.start = function (feedUrl) {
    var self = this;
    (function feed() {
      if (self.stopped) return;
      VatflowFeed.httpGet(feedUrl, function (err, text) {
        if (err) self.feedErr = err.message;
        else { try { self.setPilots(JSON.parse(text)); } catch (e) { self.feedErr = e.message; } }
        setTimeout(feed, 15000);
      });
    })();
    (function hub() {
      if (self.stopped) return;
      var xhr = new XMLHttpRequest();
      xhr.open("POST", HUB, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.timeout = 10000;
      var done = function () { setTimeout(hub, 10000); };
      xhr.onload = function () {
        try { self.setHub(JSON.parse(xhr.responseText)); } catch (e) { self.hubOk = false; self.hubErr = "ramp hub: " + e.message; }
        done();
      };
      xhr.onerror = function () { self.hubOk = false; self.hubErr = "ramp hub: network error"; done(); };
      xhr.ontimeout = function () { self.hubOk = false; self.hubErr = "ramp hub: timeout"; done(); };
      xhr.send(JSON.stringify({ icao: self.L ? self.L.icao : "KDCA" }));
    })();
  };

  RampData.prototype.stop = function () { this.stopped = true; };

  /** Inbounds over INBOUND_MAX_NM out, which deriveFlights leaves out (as gates.html farRows). */
  RampData.prototype.farRows = function (have) {
    var L = this.L, out = [], flights = (this.state && this.state.flights) || {};
    for (var i = 0; i < this.pilots.length; i++) {
      var p = this.pilots[i], fp = p.flight_plan || {};
      var cs = String(p.callsign || "").toUpperCase();
      if (have[cs] || String(fp.arrival || "").toUpperCase() !== L.icao) continue;
      var lat = Number(p.latitude), lon = Number(p.longitude);
      var d = isFinite(lat) && isFinite(lon) ? R.distNm(lat, lon, L.field.lat, L.field.lon) : 1e9;
      if (d <= R.INBOUND_MAX_NM) continue;
      var gs = Number(p.groundspeed) || 0;
      out.push({ callsign: cs, type: String(fp.aircraft_short || fp.aircraft || "").split("/")[0].toUpperCase(),
        dep: String(fp.departure || "").toUpperCase(), arr: L.icao, op: R.operatorFor(L, cs, fp.remarks),
        entry: flights[cs] || null, stand: (flights[cs] && flights[cs].stand) || null, atStand: null,
        state: R.STATES.INBOUND, distNm: d, etaMin: gs > 40 ? Math.round((d / gs) * 60) : null });
    }
    return out;
  };

  /** Every flight at / for the airport, with gate proposals (as gates.html / ramp.html). */
  RampData.prototype.rows = function (now) {
    var rows = R.deriveFlights(this.L, this.pilots, this.state, this.memory, now || Date.now());
    var have = {};
    rows.forEach(function (r) { have[r.callsign] = true; });
    rows = rows.concat(this.farRows(have));
    R.autoAssignStands(this.L, rows, this.autoMemo, this.realGates || {});
    return rows;
  };

  /** "" when all is well, else what is wrong (for the status line). */
  RampData.prototype.problem = function () {
    if (!this.L) return "ramp engine or layout missing";
    return this.feedErr ? "VATSIM " + this.feedErr : !this.hubOk ? (this.hubErr || "connecting...") : "";
  };

  /** [{icao, name}]: the package's list, plus any airport vatflow.io has added since. */
  RampData.airports = function (cb) {
    var list = (typeof VATFLOW_RAMP_AIRPORTS !== "undefined" ? VATFLOW_RAMP_AIRPORTS : []).slice();
    function merge(live) {
      var have = {};
      list.forEach(function (a) { have[a.icao] = true; });
      (live || []).forEach(function (a) { if (a && a.icao && !have[a.icao]) list.push({ icao: a.icao, name: a.name || "" }); });
      return list;
    }
    if (liveIndex) { cb(merge(liveIndex)); return; }
    getJson(SITE + "index.json", function (err, d) {
      if (!err && d && d.airports) liveIndex = d.airports;
      cb(merge(liveIndex));
    });
  };

  /** The airport's ramp layout (raw JSON) or null; from vatflow.io, else the package. */
  RampData.layout = function (icao, cb) {
    if (layouts[icao]) { cb(layouts[icao]); return; }
    var ok = function (d) { return d && d.icao && d.stands && d.charts; };
    first([SITE + encodeURIComponent(icao) + ".json", localBase() + icao + ".json",
      "coui://html_ui/Pages/VCockpit/Instruments/VatflowTower/ramp/" + icao + ".json"], ok, function (d) {
      if (d) layouts[icao] = d;
      cb(d);
    });
  };

  /** Whether the package has a ramp layout for the airport (no network needed to say so). */
  RampData.has = function (icao) {
    var list = typeof VATFLOW_RAMP_AIRPORTS !== "undefined" ? VATFLOW_RAMP_AIRPORTS : [];
    for (var i = 0; i < list.length; i++) if (list[i].icao === icao) return true;
    return false;
  };

  return RampData;
})();
