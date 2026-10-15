/*
 * VATFLOW Tower Cab - ramp list (screen $SCREEN_RAMP), the in-cab copy of
 * vatflow.io/gates.html?icao=KDCA: inbound traffic with its gate (ASSIGNED on the ramp
 * board, REAL from today's real flight, PROP from the airline's gates) and departures
 * on the ground with gate, status and P-time.
 *
 * Same logic as the page: common/vatflow-ramp.js is a bundle of shared/ramp-core.js and
 * common/ramp-kdca.js the KDCA gate layout. Live data: the VATSIM feed and the ramp hub's
 * read-only state (no sign-in). View only.
 *
 * RampView is plain DOM code (also used by preview/index.html); the MSFS wrapper at the
 * bottom only exists when BaseInstrument is defined.
 */
var RampView = (function () {
  var R = typeof VatflowRamp !== "undefined" ? VatflowRamp : null;
  var HUB = "https://web-production-3d9fe.up.railway.app/hub/ramp/state";
  var MAX_ROWS = 22;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtEta(m) {
    return m == null ? "-" : m >= 60 ? Math.floor(m / 60) + "h" + VatflowFeed.pad(m % 60, 2) : m + "m";
  }

  function RampView(root, layoutRaw) {
    this.el = {};
    var ids = ["icao", "status", "zulu", "in", "out", "inCount", "outCount"];
    for (var i = 0; i < ids.length; i++) this.el[ids[i]] = root.querySelector("#rp-" + ids[i]);
    this.L = R && layoutRaw ? R.indexLayout(JSON.parse(JSON.stringify(layoutRaw))) : null;
    this.state = R && this.L ? R.emptyState(this.L.icao) : null;
    this.realGates = {};
    this.pilots = [];
    this.memory = new Map();
    this.autoMemo = new Map();
    this.hubOk = false;
    this.hubErr = "";
    this.feedErr = "";
    if (this.L) this.el.icao.textContent = this.L.icao;
  }

  RampView.prototype.setPilots = function (feed) { this.pilots = (feed && feed.pilots) || []; this.feedErr = ""; };
  RampView.prototype.setHub = function (resp) {
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

  RampView.prototype.start = function (feedUrl) {
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
  RampView.prototype.farRows = function (have) {
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

  RampView.prototype.inboundGate = function (r) {
    var L = this.L, lbl = function (id) { return R.standLabel(L, id); };
    if (r.entry && r.entry.stand) return { gate: lbl(r.entry.stand), cls: "asg", src: "ASSIGNED" };
    if (r.autoStand && r.realGate && r.realGate.stand === r.stand) return { gate: lbl(r.stand), cls: "real", src: "REAL" };
    if (r.realGate && !r.realGate.stand) return { gate: r.realGate.gate, cls: "real", src: "REAL" };
    if (r.autoStand) return { gate: lbl(r.stand), cls: "prop", src: "PROP" };
    return { gate: "", cls: "muted", src: "" };
  };

  RampView.prototype.render = function (now) {
    now = now || Date.now();
    var el = this.el, pad = VatflowFeed.pad, z = new Date(now);
    el.zulu.textContent = pad(z.getUTCHours(), 2) + pad(z.getUTCMinutes(), 2) + "Z";
    if (!this.L) { el.status.textContent = "RAMP ENGINE OR LAYOUT MISSING"; el.status.className = "rp-status bad"; return; }
    var L = this.L, S = R.STATES, self = this;
    var rows = R.deriveFlights(L, this.pilots, this.state, this.memory, now);
    var have = {};
    rows.forEach(function (r) { have[r.callsign] = true; });
    rows = rows.concat(this.farRows(have));
    R.autoAssignStands(L, rows, this.autoMemo, this.realGates || {});

    var inb = rows.filter(function (r) { return r.state === S.INBOUND || r.state === S.TAXI_IN; })
      .sort(function (a, b) {
        return (a.state === S.TAXI_IN ? 0 : 1) - (b.state === S.TAXI_IN ? 0 : 1) ||
          (a.etaMin == null ? 1e9 : a.etaMin) - (b.etaMin == null ? 1e9 : b.etaMin) || a.distNm - b.distNm;
      });
    var h = inb.slice(0, MAX_ROWS).map(function (r) {
      var g = self.inboundGate(r);
      var eta = r.state === S.TAXI_IN ? "TAXI" : r.etaMin != null ? fmtEta(r.etaMin) : Math.round(r.distNm) + "nm";
      return '<div class="rp-row"><span class="c1">' + esc(r.callsign) + '</span><span class="c2">' + esc(r.type) +
        '</span><span class="c3">' + esc(r.dep || "?") + '</span><span class="c4">' + esc(eta) +
        '</span><span class="c5 ' + g.cls + '">' + esc(g.gate || "-") + '</span><span class="c6">' + esc(g.src) + "</span></div>";
    }).join("") || '<div class="rp-empty">No inbound traffic.</div>';
    if (h !== this.lastIn) { el.in.innerHTML = h; this.lastIn = h; }
    el.inCount.textContent = inb.length;

    var outb = rows.filter(function (r) { return r.state !== S.INBOUND && r.state !== S.TAXI_IN && r.dep === L.icao; })
      .sort(function (a, b) {
        return (a.ptime == null ? 1e15 : a.ptime) - (b.ptime == null ? 1e15 : b.ptime) || (a.callsign < b.callsign ? -1 : 1);
      });
    var o = outb.slice(0, MAX_ROWS).map(function (r) {
      var gate = r.atStand || r.stand;
      var pt = r.ptime != null ? R.ptimeCountdown(r.ptime, now) : "";
      return '<div class="rp-row"><span class="c1">' + esc(r.callsign) + '</span><span class="c2">' + esc(r.type) +
        '</span><span class="c3">' + esc(r.arr || "?") + '</span><span class="c5">' + esc(gate ? R.standLabel(L, gate) : "-") +
        '</span><span class="c7">' + esc(r.state) + '</span><span class="c4">' + esc(pt) + "</span></div>";
    }).join("") || '<div class="rp-empty">No departures on the ground.</div>';
    if (o !== this.lastOut) { el.out.innerHTML = o; this.lastOut = o; }
    el.outCount.textContent = outb.length;

    var bad = this.feedErr ? "VATSIM " + this.feedErr : !this.hubOk ? (this.hubErr || "connecting...") : "";
    el.status.textContent = bad ? bad.toUpperCase() : (L.name || "") + " - LIVE";
    el.status.className = bad ? "rp-status bad" : "rp-status";
  };

  return RampView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowRampList extends BaseInstrument {
    get templateID() { return "VatflowRampList"; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      this.view = new RampView(this.querySelector("#rp-root"), typeof VATFLOW_RAMP_LAYOUT !== "undefined" ? VATFLOW_RAMP_LAYOUT : null);
      this.view.start(VATFLOW_TWR.feedUrl);
      this.lastDraw = 0;
      var self = this;
      setInterval(function () { if (Date.now() - self.lastDraw > 2500) self.draw(); }, 1000);
    }
    draw() {
      this.lastDraw = Date.now();
      try { this.view.render(); } catch (e) { console.error("VATFLOW ramp error", (e && e.stack) || e); }
    }
    Update() {
      super.Update();
      this.dim();
      if (Date.now() - this.lastDraw >= 2000) this.draw();
    }
  }
  registerInstrument("vatflow-ramplist", VatflowRampList);
}
