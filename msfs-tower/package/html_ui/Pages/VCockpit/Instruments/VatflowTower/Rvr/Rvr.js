/*
 * VATFLOW Tower Cab - RVR monitor (an app on any screen: MENU > RVR).
 *
 * The FAA's live runway visual range for the airport the cab is at, the table from
 *   https://rvr.data.faa.gov/cgi-bin/rvr-details.pl?content=table&airport=<FAA id>
 * (the same table as the FAA RVR Status Monitor's airport page, without the charts),
 * read again every minute like that page. The FAA page sends no CORS header, which the
 * sim's screens need, so it is read through the VATFLOW hub (vatflow-hub /hub/rvr: the
 * same table as JSON, with CORS); straight from the FAA only if the hub cannot be reached
 * (works in a browser with CORS turned off, not in the sim):
 *   RWY  TD (touchdown)  MP (midpoint)  RO (rollout)  feet, ">6000" above the top of the
 *        scale, a trend arrow when rising / falling, FFF = sensor failed, blank = none
 *   E    runway edge light step (0..5)    C   centreline light step (0..5)
 * Values under 2400 ft show amber, under 1200 ft red. Airports with no RVR (outside the
 * US, or no sensors) say so.
 */
var RvrView = (function () {
  var REFRESH_MS = 60 * 1000;
  var HUB = "https://vatflow-hub-production.up.railway.app/hub/rvr?airport=";
  var URL = "https://rvr.data.faa.gov/cgi-bin/rvr-details.pl?content=table&rrate=medium&layout=2x2&gifsize=large&fontsize=large&fs=lg&airport=";

  function text(html) {
    return String(html).replace(/<[^>]*>/g, "").replace(/&nbsp;?/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<")
      .replace(/&#9650;/g, "\u25B2").replace(/&#9660;/g, "\u25BC").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  }

  /**
   * The FAA page -> { name, time, rows: [{ rwy, td, mp, ro, e, c }] } (cells as shown,
   * "" = none), or null when the page has no RVR table (no such airport / no sensors).
   */
  function parse(html) {
    html = String(html || "");
    var t = html.indexOf("<table border>");
    if (t < 0) return null;
    var name = /<strong>([^<]*\([^<]*\))<\/strong>/.exec(html);
    var time = /<th>(\d\d:\d\d:\d\dz)<\/th>/i.exec(html);
    var rows = [], re = /<tr><th>([^<]*)<\/th>([\s\S]*?)<\/tr>/gi, m;
    var body = html.slice(t);
    while ((m = re.exec(body))) {
      var cells = [], cr = /<td[^>]*>([\s\S]*?)<\/td>/gi, c;
      while ((c = cr.exec(m[2]))) cells.push(text(c[1]));
      if (cells.length < 5) continue;
      rows.push({ rwy: text(m[1]), td: cells[0], mp: cells[1], ro: cells[2], e: cells[3], c: cells[4] });
    }
    return { name: name ? text(name[1]) : "", time: time ? time[1].toUpperCase() : "", rows: rows };
  }

  /** "amber" / "red" / "" for an RVR cell. */
  function level(v) {
    var n = parseInt(v, 10);
    if (!v || v.charAt(0) === ">" || isNaN(n)) return "";
    return n < 1200 ? "red" : n < 2400 ? "amber" : "";
  }

  /** The FAA's 3-letter id for the cab's airport (KATL -> ATL). */
  function faaId(cfg) {
    if (cfg.lid) return cfg.lid;
    var i = cfg.icao || "";
    return i.length === 4 && i.charAt(0) === "K" ? i.slice(1) : i;
  }

  function RvrView(el, cfg) {
    this.el = el;
    this.cfg = cfg;
    this.data = undefined;      // undefined: not loaded yet, null: no RVR here
    this.err = null;
    this.at = 0;
    el.innerHTML = '<div class="rv-root"><div class="rv-top"><span class="rv-title">RVR</span><span class="rv-apt"></span>' +
      '<span class="rv-time"></span></div><div class="rv-body"></div><div class="rv-foot">FAA RVR - TD TOUCHDOWN, MP MIDPOINT, ' +
      'RO ROLLOUT (FT) - E EDGE / C CENTRELINE LIGHT STEP</div></div>';
    this.f = { apt: el.querySelector(".rv-apt"), time: el.querySelector(".rv-time"), body: el.querySelector(".rv-body") };
    this.last = "";
  }

  RvrView.parse = parse;
  RvrView.level = level;
  RvrView.faaId = faaId;
  RvrView.url = function (cfg) { return URL + faaId(cfg); };
  RvrView.hubUrl = function (cfg) { return (cfg.rvrHub || HUB) + faaId(cfg); };

  /** The hub's answer -> the same shape as parse() (null: no RVR here); throws if it is not one. */
  RvrView.fromHub = function (text) {
    var j = JSON.parse(text);
    if (!j || !j.ok || !j.rows) throw new Error(j && j.error ? j.error : "bad hub answer");
    return j.rows.length ? { name: j.name || "", time: j.time || "", rows: j.rows } : null;
  };

  RvrView.prototype.start = function () {
    var self = this;
    function done(err, data) {
      if (err) self.err = err.message || String(err);
      else { self.err = null; self.data = data; self.at = Date.now(); }
      self.render();
      setTimeout(tick, err ? 20000 : REFRESH_MS);
    }
    function tick() {
      VatflowFeed.httpGet(RvrView.hubUrl(self.cfg), function (err, text) {
        var data;
        if (!err) { try { data = RvrView.fromHub(text); } catch (e) { err = e; } }
        if (!err) { done(null, data); return; }
        VatflowFeed.httpGet(RvrView.url(self.cfg), function (err2, html) {     // the FAA itself
          if (err2) done(new Error("hub " + (err.message || err) + ", FAA " + (err2.message || err2)));
          else done(null, parse(html));
        });
      });
    }
    tick();
  };

  RvrView.prototype.render = function () {
    var f = this.f, d = this.data, id = faaId(this.cfg);
    var html;
    if (d === undefined) html = '<div class="rv-msg">' + (this.err ? "RVR: " + this.err.toUpperCase() + " - TRYING AGAIN" : "LOADING " + id + " RVR...") + "</div>";
    else if (!d || !d.rows.length) html = '<div class="rv-msg">NO RVR FOR ' + id + " (FAA RVR COVERS US AIRPORTS WITH RVR SENSORS)</div>";
    else {
      html = '<table class="rv-tab"><tr><th>RWY</th><th>TD</th><th>MP</th><th>RO</th><th>E</th><th>C</th></tr>';
      d.rows.forEach(function (r) {
        html += "<tr><th>" + r.rwy + "</th>";
        [r.td, r.mp, r.ro].forEach(function (v) { html += '<td class="rv-v ' + level(v) + '">' + v + "</td>"; });
        html += "<td>" + r.e + "</td><td>" + r.c + "</td></tr>";
      });
      html += "</table>";
      if (d.rows.length > 10) html = html.replace('class="rv-tab"', 'class="rv-tab rv-small"');
    }
    if (html !== this.last) { f.body.innerHTML = html; this.last = html; }
    f.apt.textContent = id + (d && d.name ? "  " + d.name.replace(/^\S+\s+/, "") : "");
    f.time.textContent = d && d.time ? d.time + (this.err ? "  (OLD: " + this.err.toUpperCase() + ")" : "") : "";
  };

  return RvrView;
})();
