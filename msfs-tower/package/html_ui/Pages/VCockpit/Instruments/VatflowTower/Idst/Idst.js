/*
 * VATFLOW Tower Cab - IDST release screen (in-cab screen $SCREEN_IDST).
 *
 * The departures from this airport that VATFLOW meters (filed routes crossing an
 * active FCA program), with their release (CFR / EDCT) times. Same data and same
 * release engine as the vatflow.io IDST page (common/vatflow-metering.js is a bundle
 * of shared/fca-metering.js), so a release issued here shows up there and the other way round.
 *
 * Select an aircraft (click its row, or the up/down keys) and press ISSUE RELEASE:
 * the engine slots it behind airborne traffic and other releases and freezes the time.
 * CANCEL removes the release. Both need your VATSIM CID (common/airport.js, idst.cid)
 * connected as a controller, as on the web page.
 *
 * Input: clicks on the screen, or the hardware keys under it, which set
 * L:VATFLOW_IDST_KEY (1 up, 2 down, 3 issue, 4 cancel).
 *
 * IdstView is plain DOM code (also used by preview/index.html); the MSFS wrapper at
 * the bottom only exists when BaseInstrument is defined.
 */
// MSFS's instrument browser is older than Chrome: give the bundled engine what it may lack.
// Its reference-data downloads go through XMLHttpRequest (what the other screens use and
// what works in the sim) instead of fetch().
var VatflowXhrFetch = function (url) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.timeout = 30000;
    xhr.onload = function () {
      var t = xhr.responseText;
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status,
        text: function () { return Promise.resolve(t); },
        json: function () { return Promise.resolve(JSON.parse(t)); } });
    };
    xhr.onerror = function () { reject(new Error("network error " + url)); };
    xhr.ontimeout = function () { reject(new Error("timeout " + url)); };
    xhr.send();
  });
};
if (typeof window !== "undefined") window.fetch = VatflowXhrFetch;
if (typeof Promise !== "undefined" && !Promise.prototype.finally) {
  Promise.prototype.finally = function (fn) {
    return this.then(function (v) { fn(); return v; }, function (e) { fn(); throw e; });
  };
}

var IdstView = (function () {
  var M = typeof VatflowMetering !== "undefined" ? VatflowMetering : null;
  var ROWS = 11;

  /** XHR request (Coherent GT's fetch is not relied on for writes). cb(err, text). */
  function request(method, url, headers, body, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    for (var k in headers) xhr.setRequestHeader(k, headers[k]);
    xhr.timeout = 15000;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) cb(null, xhr.responseText);
      else cb(new Error("HTTP " + xhr.status + " " + String(xhr.responseText || "").slice(0, 80)));
    };
    xhr.onerror = function () { cb(new Error("network error")); };
    xhr.ontimeout = function () { cb(new Error("timeout")); };
    xhr.send(body || null);
  }

  function hhmm(ms) {
    var d = new Date(ms), pad = VatflowFeed.pad;
    return pad(d.getUTCHours(), 2) + pad(d.getUTCMinutes(), 2);
  }

  /** VATSIM feed pilot -> the shape fca-metering expects (as in idst.html fetchLive). */
  function toPilots(feed) {
    var out = [];
    var list = (feed && feed.pilots) || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (typeof p.latitude !== "number" || typeof p.longitude !== "number") continue;
      var gs = p.groundspeed || 0;
      var f = M.fpFields(p.flight_plan || {});
      var o = { callsign: p.callsign, lat: p.latitude, lon: p.longitude, alt: p.altitude || 0, gs: gs,
        hdg: p.heading || 0, phase: gs < 50 ? "gnd" : "air" };
      for (var k in f) o[k] = f[k];
      out.push(o);
    }
    return out;
  }

  function normalizeFca(f) {
    if (!f || !f.id) return null;
    if (!Array.isArray(f.points)) f.points = [];
    if (!Array.isArray(f.order)) f.order = [];
    if (!f.releases || typeof f.releases !== "object" || Array.isArray(f.releases)) f.releases = {};
    if (f.enabled == null) f.enabled = true;
    return f;
  }

  function IdstView(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.icfg = cfg.idst || {};
    this.fcas = [];
    this.pilots = [];
    this.controllers = [];
    this.rows = [];
    this.sel = null;          // selected callsign
    this.busy = false;
    this.msg = "";
    this.msgMs = 0;
    this.feedMs = 0;
    this.fcaMs = 0;
    this.err = { feed: null, fca: null, engine: null };
    this.airports = 0;
    this.auth = { verified: false, callsign: null };
    var ids = ["icao", "auth", "zulu", "list", "msg", "up", "down", "issue", "cancel", "status"];
    this.el = {};
    for (var i = 0; i < ids.length; i++) this.el[ids[i]] = root.querySelector("#id-" + ids[i]);
    this.el.icao.textContent = cfg.icao;
    var self = this;
    function bind(id, key) {
      self.el[id].addEventListener("mouseup", function (e) { e.stopPropagation(); self.key(key); });
    }
    bind("up", 1); bind("down", 2); bind("issue", 3); bind("cancel", 4);
    this.el.list.addEventListener("mouseup", function (e) {
      var t = e.target;
      while (t && t !== self.el.list && !(t.getAttribute && t.getAttribute("data-cs"))) t = t.parentNode;
      if (t && t.getAttribute && t.getAttribute("data-cs")) { self.sel = t.getAttribute("data-cs"); self.render(); }
    });
  }

  IdstView.prototype.say = function (s) { this.msg = s; this.msgMs = Date.now(); };

  IdstView.prototype.restHeaders = function (write) {
    var h = { apikey: this.icfg.supabaseKey, Authorization: "Bearer " + this.icfg.supabaseKey };
    if (write) { h["Content-Type"] = "application/json"; h.Prefer = "resolution=merge-duplicates,return=minimal"; }
    return h;
  };

  /** Starts the data: airports + nav (for route expansion), VATSIM feed, FCA programs. */
  IdstView.prototype.start = function () {
    var self = this, base = this.icfg.siteBase || "https://vatflow.io/";
    if (!M) { this.err.engine = "ENGINE NOT LOADED (common/vatflow-metering.js)"; return; }
    (function feed() {
      VatflowFeed.httpGet(self.cfg.feedUrl, function (err, text) {
        if (err) self.err.feed = err.message;
        else {
          try { self.setFeed(JSON.parse(text)); } catch (e) { self.err.feed = e.message; }
        }
        setTimeout(feed, (self.icfg.feedRefreshSec || 30) * 1000);
      });
    })();
    (function fcas() {
      self.loadFcas(function () { setTimeout(fcas, (self.icfg.fcaRefreshSec || 15) * 1000); });
    })();
    // reference data for the release engine (airport positions, routes, ARTCC boundaries)
    function guard(name, fn) {
      try {
        var pr = fn();
        if (pr && pr.then) pr.then(null, function (e) { self.err.engine = name + " " + ((e && e.message) || e); });
      } catch (e) { self.err.engine = name + " " + ((e && e.message) || e); }
    }
    guard("AIRPORTS", function () {
      return M.loadAirports(function (n) {
        self.airports = n;
        guard("WINDS-BIND", function () { M.bindWindAirportLookup(function (icao) { return M.getAirport(icao); }); });
        guard("NAV", function () { return M.loadNavData(base + "data/nav"); });
        guard("ARTCC", function () { return M.fetchArtccBoundaries(base); });
        guard("WINDS", function () { return M.fetchWinds(); });
      });
    });
  };

  IdstView.prototype.setFeed = function (feed) {
    this.pilots = toPilots(feed);
    this.controllers = feed.controllers || [];
    this.auth = M.verifyTowerAtc(this.controllers, this.icfg.cid);
    this.feedMs = Date.now();
    this.err.feed = null;
  };

  /**
   * rows: [{id, data}] from Supabase. The server copy replaces the local one as is, so a
   * release cancelled on the web page (or anywhere else) disappears here too. The screen
   * keeps no releases of its own: every issue / cancel is written straight to the server.
   */
  IdstView.prototype.setFcaRows = function (rows) {
    var out = [];
    for (var j = 0; j < rows.length; j++) {
      var rf = normalizeFca(rows[j].data || {});
      if (rf) out.push(rf);
    }
    this.fcas = out;
    this.fcaMs = Date.now();
    this.err.fca = null;
  };

  IdstView.prototype.loadFcas = function (done) {
    var self = this;
    request("GET", this.icfg.supabaseUrl + "/rest/v1/fcas?select=id,data", this.restHeaders(false), null,
      function (err, text) {
        if (err) self.err.fca = err.message;
        else if (!self.busy) {   // an issue / cancel in flight has fresher data than this poll
          try { self.setFcaRows(JSON.parse(text)); } catch (e) { self.err.fca = e.message; }
        }
        if (done) done();
      });
  };

  IdstView.prototype.compute = function () {
    if (!M) return [];
    var active = this.fcas.filter(function (f) { return f.enabled && f.points && f.points.length >= 2; });
    return M.computeTowerDepartures(this.cfg.icao, active, this.pilots, []).departures || [];
  };

  IdstView.prototype.canWrite = function () {
    if (this.demo) return !this.busy;
    if (!this.icfg.cid) { this.say("SET YOUR VATSIM CID IN common/airport.js (idst.cid) TO ISSUE"); return false; }
    if (!this.auth.verified) { this.say("CID " + this.icfg.cid + " IS NOT CONNECTED AS A CONTROLLER ON VATSIM"); return false; }
    if (this.busy) { this.say("WAIT..."); return false; }
    return true;
  };

  /**
   * Fetches the latest copy of the program, applies change(fca) to it and writes it back
   * (as idst.html does, the whole program row is upserted; releases are merged per callsign
   * first so a release someone else just issued is not lost).
   */
  IdstView.prototype.writeFca = function (fcaId, change, onDone) {
    var self = this, url = this.icfg.supabaseUrl + "/rest/v1/fcas";
    if (this.demo) {   // preview with made-up data: change the local copy only
      var local = this.fcas.filter(function (f) { return f.id === fcaId; })[0];
      var res = local ? change(local) : null;
      if (res === null) this.say("NO SLOT - NOT CROSSING THE PROGRAM LINE?");
      else onDone(res);
      return;
    }
    this.busy = true;
    request("GET", url + "?select=id,data&id=eq." + encodeURIComponent(fcaId), this.restHeaders(false), null,
      function (err, text) {
        if (err) { self.busy = false; self.say("READ FAILED: " + err.message); return; }
        var rows;
        try { rows = JSON.parse(text); } catch (e) { rows = []; }
        if (!rows.length) { self.busy = false; self.say("PROGRAM NO LONGER EXISTS"); return; }
        // start from the server's current copy of this program (not the local one, which
        // could still hold a release someone has since cancelled)
        var fca = normalizeFca(rows[0].data || {});
        if (!fca) { self.busy = false; self.say("PROGRAM DATA UNREADABLE"); return; }
        self.fcas = self.fcas.map(function (f) { return f.id === fcaId ? fca : f; });
        var result = change(fca);
        if (result === null) { self.busy = false; self.say("NO SLOT - NOT CROSSING THE PROGRAM LINE?"); return; }
        var body = JSON.stringify({ id: fca.id, data: fca, updated_at: new Date().toISOString() });
        request("POST", url, self.restHeaders(true), body, function (err2) {
          self.busy = false;
          if (err2) self.say("WRITE FAILED: " + err2.message);
          else onDone(result);
        });
      });
  };

  IdstView.prototype.selectedRow = function () {
    for (var i = 0; i < this.rows.length; i++) if (this.rows[i].callsign === this.sel) return this.rows[i];
    return null;
  };

  /** 1 up, 2 down, 3 issue, 4 cancel */
  IdstView.prototype.key = function (k) {
    var self = this, rows = this.rows, idx = -1;
    for (var i = 0; i < rows.length; i++) if (rows[i].callsign === this.sel) idx = i;
    if (k === 1 || k === 2) {
      if (!rows.length) return;
      idx = idx < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, idx + (k === 1 ? -1 : 1)));
      this.sel = rows[idx].callsign;
      this.render();
      return;
    }
    var row = this.selectedRow();
    if (!row) { this.say("SELECT AN AIRCRAFT FIRST"); this.render(); return; }
    if (!this.canWrite()) { this.render(); return; }
    var cs = row.callsign;
    if (k === 3) {
      if (row.frozen) { this.say(cs + " ALREADY RELEASED " + hhmm(row.edctMs) + "Z - CANCEL FIRST TO RE-ISSUE"); this.render(); return; }
      this.say("ISSUING " + cs + "...");
      this.writeFca(row.fcaId, function (fca) {
        if (M.getRelease(fca, cs)) return M.getRelease(fca, cs);   // someone else just issued it
        return M.markReady(fca, cs, self.pilots, Date.now()) || null;
      }, function (rel) {
        self.say(cs + " RELEASE " + hhmm(rel.edctMs) + "Z  (WINDOW -2/+1 MIN)");
        self.render();
      });
    } else if (k === 4) {
      if (!row.frozen) { this.say(cs + " HAS NO RELEASE"); this.render(); return; }
      this.say("CANCELLING " + cs + "...");
      this.writeFca(row.fcaId, function (fca) { M.clearReady(fca, cs); return true; },
        function () { self.say(cs + " RELEASE CANCELLED"); self.render(); });
    }
    this.render();
  };

  IdstView.prototype.statusOf = function (r, now) {
    if (!r.frozen) {
      var d = Math.round(r.delayMin || 0);
      return { cls: "st-adv", text: "EST " + hhmm(r.edctMs) + (d > 0 ? " +" + d + "M" : "") };
    }
    var dt = r.edctMs - now;
    if (dt > M.COMPLIANCE_EARLY_MS) {
      var s = Math.round(dt / 1000);
      return { cls: "st-wait", text: "HOLD " + Math.floor(s / 60) + ":" + VatflowFeed.pad(s % 60, 2) };
    }
    if (dt >= -M.COMPLIANCE_LATE_MS) return { cls: "st-now", text: "RELEASE NOW" };
    return { cls: "st-late", text: "MISSED - REISSUE" };
  };

  IdstView.prototype.render = function () {
    var el = this.el, now = Date.now(), pad = VatflowFeed.pad;
    var z = new Date(now);
    el.zulu.textContent = pad(z.getUTCHours(), 2) + pad(z.getUTCMinutes(), 2) + ":" + pad(z.getUTCSeconds(), 2) + "Z";

    if (!this.icfg.cid) { el.auth.className = "id-auth no"; el.auth.textContent = "VIEW ONLY - NO CID SET"; }
    else if (this.auth.verified) { el.auth.className = "id-auth ok"; el.auth.textContent = "RDY " + this.auth.callsign; }
    else { el.auth.className = "id-auth no"; el.auth.textContent = "VIEW ONLY - CID OFFLINE"; }

    var rows = [];
    try { rows = this.compute(); this.err.compute = null; } catch (e) { this.err.compute = e.message; }
    this.rows = rows;
    if (this.sel && !this.selectedRow()) this.sel = null;

    var idx = 0;
    for (var i = 0; i < rows.length; i++) if (rows[i].callsign === this.sel) idx = i;
    var first = Math.max(0, Math.min(idx - ROWS + 2, rows.length - ROWS));
    var html = "";
    for (var j = first; j < Math.min(rows.length, first + ROWS); j++) {
      var r = rows[j], st = this.statusOf(r, now);
      html += '<div class="id-row ' + (r.frozen ? "frozen" : "adv") + (r.callsign === this.sel ? " sel" : "") +
        '" data-cs="' + r.callsign + '">' +
        '<span class="c-cs">' + r.callsign + "</span>" +
        '<span class="c-type">' + (r.type || "").slice(0, 4) + "</span>" +
        '<span class="c-dest">' + (r.arr || "") + "</span>" +
        '<span class="c-fca" style="color:' + (r.fcaColor || "#dfe7ef") + '">' + String(r.fcaName || "").slice(0, 16) + "</span>" +
        '<span class="c-rel">' + (r.frozen ? hhmm(r.edctMs) + "Z" : "--") + "</span>" +
        '<span class="c-state ' + st.cls + '">' + st.text + "</span></div>";
    }
    if (!rows.length) {
      html = '<div class="id-empty">' + (this.fcaMs && this.feedMs
        ? "NO " + this.cfg.icao + " DEPARTURES IN A VATFLOW PROGRAM RIGHT NOW"
        : "LOADING VATSIM FEED AND VATFLOW PROGRAMS...") + "</div>";
    }
    if (html !== this.lastHtml) { el.list.innerHTML = html; this.lastHtml = html; }

    el.msg.textContent = now - this.msgMs < 20000 ? this.msg : "";
    var active = this.fcas.filter(function (f) { return f.enabled; }).length;
    var errs = [];
    if (this.err.feed) errs.push("VATSIM " + this.err.feed);
    if (this.err.compute) errs.push("ENGINE " + this.err.compute);
    if (this.err.fca) errs.push("VATFLOW " + this.err.fca);
    if (this.err.engine && !/^WINDS/.test(this.err.engine)) errs.push(this.err.engine);
    el.status.textContent = errs.length ? errs.join("   ").toUpperCase()
      : "PROGRAMS " + active + " ACTIVE   " + rows.length + " METERED DEP   VATSIM " +
        (this.feedMs ? Math.round((now - this.feedMs) / 1000) + "S" : "--") + "   VATFLOW " +
        (this.fcaMs ? Math.round((now - this.fcaMs) / 1000) + "S" : "--") + "   APTS " + this.airports;
  };

  return IdstView;
})();

if (typeof BaseInstrument !== "undefined") {
  class VatflowIdst extends BaseInstrument {
    get templateID() { return "VatflowIdst"; }
    // Lets the sim pass mouse clicks on the screen through to the page.
    get isInteractive() { return true; }
    connectedCallback() {
      super.connectedCallback();
      this.dim = VatflowDimmer.attach(this, "CONSOLE");
      this.view = new IdstView(this.querySelector("#id-root"), VATFLOW_TWR);
      this.view.start();
      this.lastDraw = 0;
      var self = this;
      setInterval(function () { if (Date.now() - self.lastDraw > 2500) self.draw(); }, 1000);
    }
    draw() {
      this.lastDraw = Date.now();
      try { this.view.render(); } catch (e) { console.error("VATFLOW IDST error", (e && e.stack) || e); }
    }
    Update() {
      super.Update();
      this.dim();
      // hardware keys under the screen (model behaviors) -> L:VATFLOW_IDST_KEY
      var k = SimVar.GetSimVarValue("L:VATFLOW_IDST_KEY", "number");
      if (k) {
        SimVar.SetSimVarValue("L:VATFLOW_IDST_KEY", "number", 0);
        this.view.key(Math.round(k));
      }
      if (Date.now() - this.lastDraw >= 1000) this.draw();
    }
  }
  registerInstrument("vatflow-idst", VatflowIdst);
}
