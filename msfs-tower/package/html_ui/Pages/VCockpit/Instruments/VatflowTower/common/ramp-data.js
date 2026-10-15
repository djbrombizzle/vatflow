/*
 * VATFLOW Tower Cab - live ramp data shared by the ramp list and the ramp map screens:
 * the VATSIM feed and the ramp hub's read-only state, turned into rows by the same code
 * vatflow.io's gates / ramp pages run (common/vatflow-ramp.js = shared/ramp-core.js,
 * common/ramp-kdca.js = the KDCA layout).
 */
var VatflowRampData = (function () {
  var R = typeof VatflowRamp !== "undefined" ? VatflowRamp : null;
  var HUB = "https://web-production-3d9fe.up.railway.app/hub/ramp/state";

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

  /** Polls the VATSIM feed (15 s) and the ramp hub (10 s). */
  RampData.prototype.start = function (feedUrl) {
    var self = this;
    (function feed() {
      VatflowFeed.httpGet(feedUrl, function (err, text) {
        if (err) self.feedErr = err.message;
        else { try { self.setPilots(JSON.parse(text)); } catch (e) { self.feedErr = e.message; } }
        setTimeout(feed, 15000);
      });
    })();
    (function hub() {
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

  return RampData;
})();
