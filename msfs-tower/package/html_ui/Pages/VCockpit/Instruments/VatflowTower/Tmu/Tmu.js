/*
 * VATFLOW Tower Cab - TMU desk monitors ($SCREEN_TMUARR, $SCREEN_TMUDEP): plain text
 * lists on yellow like the DCA TMU position. From the VATSIM feed:
 *   ARR  inbound to the airport, airborne: distance, altitude, ETA (distance / groundspeed)
 *   DEP  filed out of the airport, on the ground at the field: P-time, taxiing or at the gate
 * TmuView is plain DOM code (also used by preview/index.html); the MSFS wrappers at the
 * bottom only exist when BaseInstrument is defined.
 */
var TmuView = (function () {
  var ROWS = 21;
  var pad = function (n, w) { return VatflowFeed.pad(n, w); };

  function TmuView(root, cfg, mode) {
    this.cfg = cfg;
    this.mode = mode;                 // "ARR" | "DEP"
    this.pilots = [];
    this.err = "";
    this.el = {};
    var ids = ["title", "count", "zulu", "head", "list", "foot"];
    for (var i = 0; i < ids.length; i++) this.el[ids[i]] = root.querySelector("#tm-" + ids[i]);
    var c = cfg.icao.replace(/^K/, "");
    this.el.title.textContent = c + " TMU - " + (mode === "ARR" ? "ARRIVALS" : "DEPARTURES");
    this.el.head.innerHTML = mode === "ARR"
      ? '<span class="c-cs">ACID</span><span class="c-ty">TYPE</span><span class="c-ap">ORIG</span><span class="c-n1">DIST</span><span class="c-n2">ALT</span><span class="c-x">ETA</span>'
      : '<span class="c-cs">ACID</span><span class="c-ty">TYPE</span><span class="c-ap">DEST</span><span class="c-n1">P-TIME</span><span class="c-n2">STATUS</span><span class="c-x">ROUTE</span>';
  }

  TmuView.prototype.setFeed = function (feed) { this.pilots = (feed && feed.pilots) || []; this.err = ""; };
  TmuView.prototype.setError = function (e) { this.err = String((e && e.message) || e); };

  function nm(a, b, c, d) {
    var r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * 3440.065;
  }

  /** Rows for the list (exported for tests). */
  TmuView.prototype.rows = function (now) {
    var cfg = this.cfg, out = [];
    for (var i = 0; i < this.pilots.length; i++) {
      var p = this.pilots[i], fp = p.flight_plan;
      if (!fp || typeof p.latitude !== "number") continue;
      var d = nm(p.latitude, p.longitude, cfg.arp.lat, cfg.arp.lon), gs = p.groundspeed || 0;
      if (this.mode === "ARR") {
        if (fp.arrival !== cfg.icao || gs < 50) continue;
        out.push({ cs: p.callsign, type: (fp.aircraft_short || "").slice(0, 4), ap: fp.departure || "",
          dist: Math.round(d), alt: p.altitude || 0, eta: Math.round(d / gs * 60) });
      } else {
        if (fp.departure !== cfg.icao || d > 3 || gs >= 50) continue;
        var dt = fp.deptime && fp.deptime !== "0000" ? fp.deptime : "";
        out.push({ cs: p.callsign, type: (fp.aircraft_short || "").slice(0, 4), ap: fp.arrival || "",
          ptime: dt, status: gs > 3 ? "TAXI" : "GATE", route: (fp.route || "").split(/\s+/).slice(0, 3).join(" ") });
      }
    }
    if (this.mode === "ARR") out.sort(function (a, b) { return a.eta - b.eta; });
    else out.sort(function (a, b) { return (a.ptime || "9999") < (b.ptime || "9999") ? -1 : (a.ptime === b.ptime ? 0 : 1); });
    return out;
  };

  TmuView.prototype.render = function (now) {
    now = now || Date.now();
    var z = new Date(now), el = this.el;
    el.zulu.textContent = pad(z.getUTCHours(), 2) + pad(z.getUTCMinutes(), 2) + ":" + pad(z.getUTCSeconds(), 2) + "Z";
    var rows = this.rows(now), h = "";
    for (var i = 0; i < Math.min(rows.length, ROWS); i++) {
      var r = rows[i], cls = "tm-row" + (i % 2 ? " alt" : "");
      if (this.mode === "ARR") {
        var t = new Date(now + r.eta * 60000);
        h += '<div class="' + cls + '"><span class="c-cs">' + r.cs + '</span><span class="c-ty">' + r.type +
          '</span><span class="c-ap">' + r.ap + '</span><span class="c-n1">' + r.dist + 'NM</span><span class="c-n2">' +
          (r.alt >= 18000 ? "FL" + pad(Math.round(r.alt / 100), 3) : Math.round(r.alt / 100) * 100) +
          '</span><span class="c-x' + (r.eta <= 15 ? " tm-soon" : "") + '">' + pad(t.getUTCHours(), 2) + pad(t.getUTCMinutes(), 2) +
          "Z  " + r.eta + "M</span></div>";
      } else {
        h += '<div class="' + cls + '"><span class="c-cs">' + r.cs + '</span><span class="c-ty">' + r.type +
          '</span><span class="c-ap">' + r.ap + '</span><span class="c-n1">' + (r.ptime ? r.ptime + "Z" : "-") +
          '</span><span class="c-n2">' + r.status + '</span><span class="c-x">' + r.route + "</span></div>";
      }
    }
    if (!rows.length) h = '<div class="tm-row">' + (this.err ? "" : "NONE") + "</div>";
    if (h !== this.last) { el.list.innerHTML = h; this.last = h; }
    var soon = 0;
    for (var j = 0; j < rows.length; j++) if (this.mode === "ARR" ? rows[j].eta <= 60 : rows[j].status === "TAXI") soon++;
    el.count.textContent = rows.length + (this.mode === "ARR" ? " ACTIVE   " + soon + " IN 60 MIN" : " ON GROUND   " + soon + " TAXIING");
    el.foot.textContent = this.err ? "VATSIM FEED: " + this.err.toUpperCase() : "VATSIM";
  };

  return TmuView;
})();

/** MSFS wrapper for one TMU screen; TmuArr.js / TmuDep.js each register theirs. */
function vatflowRegisterTmu(mode, tag, templateId) {
  if (typeof BaseInstrument === "undefined") return;
  class VatflowTmu extends BaseInstrument {
    get templateID() { return templateId; }
    get isInteractive() { return false; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      var view = this.view = new TmuView(this.querySelector("#tm-root"), VATFLOW_TWR, mode);
      (function tick() {
        VatflowFeed.httpGet(VATFLOW_TWR.feedUrl, function (err, text) {
          if (err) view.setError(err);
          else { try { view.setFeed(JSON.parse(text)); } catch (e) { view.setError(e); } }
          setTimeout(tick, 30000);
        });
      })();
      this.lastDraw = 0;
    }
    Update() {
      super.Update();
      this.dim();
      if (Date.now() - this.lastDraw >= 1000) { this.lastDraw = Date.now(); this.view.render(); }
    }
  }
  registerInstrument(tag, VatflowTmu);
}
