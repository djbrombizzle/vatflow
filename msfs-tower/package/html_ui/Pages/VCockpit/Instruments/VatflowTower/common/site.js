/*
 * VATFLOW Tower Cab - which airport the cab is at, and its data.
 *
 * resolve(cb): finds the airport nearest the cab (in the sim: the aircraft's position;
 * in a browser: ?apt=XXXX or VATFLOW_TWR.icao), fills VATFLOW_TWR for it (ICAO, name,
 * reference point, METAR, ATC callsigns, DBRITE labels ...) and calls cb(site). Bundled
 * airports (common/airports/*.js) come with runways, tower position and maps; for any
 * other airport the name and position come from the VATSpy airport list and
 * loadData(cb) builds the rest from OpenStreetMap once (then it is kept in the sim's
 * storage). Airport-specific tweaks are in VATFLOW_TWR_OVERRIDES (common/airport.js).
 */
var VatflowSite = (function () {
  var VATSPY_URL = "https://cdn.jsdelivr.net/gh/vatsimnetwork/vatspy-data-project@master/VATSpy.dat";
  var BUNDLED_NM = 10, VATSPY_NM = 15, NM_PER_DEG = 60;
  var site = null, waiting = [], busy = false, vatspy = null, vatspyWait = [];

  function distNm(lat1, lon1, lat2, lon2) {
    var x = (lon2 - lon1) * NM_PER_DEG * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), y = (lat2 - lat1) * NM_PER_DEG;
    return Math.sqrt(x * x + y * y);
  }

  function bundled() { return typeof VATFLOW_AIRPORTS !== "undefined" ? VATFLOW_AIRPORTS : {}; }

  /** VATSpy.dat [Airports]: ICAO|Name|Lat|Lon|IATA/LID|FIR|IsPseudo -> [{icao, name, lat, lon, lid}] */
  function parseVatspy(txt) {
    var out = [], inApt = false, lines = String(txt || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.charAt(0) === "[") { inApt = /^\[Airports\]/i.test(line); continue; }
      if (!inApt || !line || line.charAt(0) === ";") continue;
      var c = line.split("|");
      if (c.length < 4 || c[6] === "1") continue;
      var lat = parseFloat(c[2]), lon = parseFloat(c[3]);
      if (isNaN(lat) || isNaN(lon)) continue;
      out.push({ icao: c[0].trim().toUpperCase(), name: (c[1] || "").trim().toUpperCase(), lat: lat, lon: lon,
        lid: (c[4] || "").trim().toUpperCase(), fir: (c[5] || "").trim().toUpperCase() });
    }
    return out;
  }

  function nearest(list, lat, lon, maxNm) {
    var best = null, bd = maxNm;
    for (var i = 0; i < list.length; i++) {
      var d = distNm(lat, lon, list[i].lat, list[i].lon);
      if (d <= bd) { bd = d; best = list[i]; }
    }
    return best;
  }

  function bundledList() {
    var out = [], b = bundled();
    for (var k in b) out.push({ icao: k, name: b[k].name, lat: b[k].arp.lat, lon: b[k].arp.lon, lid: b[k].lid });
    return out;
  }

  function loadVatspy(cb) {
    if (vatspy) { cb(null, vatspy); return; }
    vatspyWait.push(cb);
    if (vatspyWait.length > 1) return;
    var x = new XMLHttpRequest();
    x.open("GET", VATSPY_URL, true);
    x.timeout = 60000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      var err = null;
      if (x.status === 200) vatspy = parseVatspy(x.responseText);
      else err = new Error("airport list: HTTP " + x.status);
      var w = vatspyWait; vatspyWait = [];
      for (var i = 0; i < w.length; i++) w[i](err, vatspy);
    };
    x.send();
  }

  /** The sim's view of the cab, or null outside the sim / before the flight has loaded. */
  function simState() {
    if (typeof SimVar === "undefined") return null;
    try {
      var lat = SimVar.GetSimVarValue("PLANE LATITUDE", "degrees"), lon = SimVar.GetSimVarValue("PLANE LONGITUDE", "degrees");
      if (typeof lat !== "number" || (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01)) return null;
      var ht = SimVar.GetSimVarValue("PLANE HEADING DEGREES TRUE", "degrees");
      var hm = SimVar.GetSimVarValue("PLANE HEADING DEGREES MAGNETIC", "degrees");
      return {
        lat: lat, lon: lon, altFt: SimVar.GetSimVarValue("PLANE ALTITUDE", "feet"), hdgTrue: ht,
        magVar: (((ht - hm) % 360) + 540) % 360 - 180,       // east positive
        groundFt: SimVar.GetSimVarValue("GROUND ALTITUDE", "feet"),
        onGround: !!SimVar.GetSimVarValue("SIM ON GROUND", "bool")
      };
    } catch (e) { return null; }
  }

  function forcedIcao() {
    try {
      var m = /[?&]apt=([A-Za-z0-9]{3,4})/.exec(String((typeof location !== "undefined" && location.search) || ""));
      if (m) return m[1].toUpperCase();
    } catch (e) { /* not a page */ }
    return null;
  }

  function fromBundled(icao) {
    var b = bundled()[icao];
    return b ? { icao: icao, name: b.name, lid: b.lid, arp: b.arp, elevFt: b.elevFt, data: b } : null;
  }

  /** Makes VATFLOW_TWR describe site s (data: runways / tower / maps when known). */
  /**
   * Field elevation from the FAA control tower data (common/faa-towers.js: [lat, lon, agl,
   * amsl]): the ground under the airport's tower = its top minus its height. US only; null
   * when there is no tower within 2.5 nm.
   */
  function faaElevFt(arp) {
    if (typeof VATFLOW_FAA_TOWERS === "undefined" || !arp) return null;
    var best = null, bestD = 2.5;
    for (var i = 0; i < VATFLOW_FAA_TOWERS.length; i++) {
      var t = VATFLOW_FAA_TOWERS[i], d = distNm(arp.lat, arp.lon, t[0], t[1]);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best ? Math.round(best[3] - best[2]) : null;
  }

  function apply(cfg, s, overrides) {
    var data = s.data || {};
    var lid = s.lid || (s.icao.length === 4 && s.icao.charAt(0) === "K" ? s.icao.slice(1) : s.icao);
    cfg.icao = s.icao;
    cfg.lid = lid;
    cfg.name = s.name || s.icao;
    cfg.arp = { lat: s.arp.lat, lon: s.arp.lon };
    cfg.elevFt = s.elevFt || faaElevFt(s.arp) || 0;
    if (typeof s.magVar === "number") cfg.magVarDeg = Math.round(s.magVar * 10) / 10;
    cfg.runways = data.runways || [];
    cfg.tower = data.tower ? { lat: data.tower.lat, lon: data.tower.lon } : cfg.arp;
    cfg.atcPatterns = [new RegExp("^" + lid + "_"), new RegExp("^" + s.icao + "_")];
    cfg.atisCallsign = s.icao + "_ATIS";
    cfg.metarUrl = "https://metar.vatsim.net/metar.php?id=" + s.icao;
    cfg.dbrite.altimeterStations = [s.icao];
    cfg.dbrite.towerLabel = lid + " TOWER";
    var finals = [];
    for (var i = 0; i < cfg.runways.length; i++) {
      finals.push({ rwy: cfg.runways[i].ids[0], lengthNm: 8 }, { rwy: cfg.runways[i].ids[1], lengthNm: 8 });
    }
    cfg.dbrite.finals = finals;
    var o = overrides && overrides[s.icao];
    if (o) merge(cfg, o);
    if (typeof VatflowStore !== "undefined" && cfg.idst) cfg.idst.cid = VatflowStore.get("CID", "") || cfg.idst.cid || "";
    return cfg;
  }

  function merge(dst, src) {
    for (var k in src) {
      var v = src[k];
      if (v && typeof v === "object" && !(v instanceof RegExp) && !Array.isArray(v) && dst[k] && typeof dst[k] === "object") merge(dst[k], v);
      else dst[k] = v;
    }
  }

  function finish(s) {
    site = s;
    if (typeof VATFLOW_TWR !== "undefined") apply(VATFLOW_TWR, s, typeof VATFLOW_TWR_OVERRIDES !== "undefined" ? VATFLOW_TWR_OVERRIDES : null);
    if (s.data && s.data.maps) VATFLOW_MAPS = s.data.maps;
    var w = waiting; waiting = [];
    for (var i = 0; i < w.length; i++) { try { w[i](s); } catch (e) { if (typeof console !== "undefined") console.error(e); } }
  }

  /** Waits for the sim to report a position (up to ~20 s), then works out the airport. */
  function resolve(cb) {
    if (site) { cb(site); return; }
    waiting.push(cb);
    if (busy) return;
    busy = true;
    var forced = forcedIcao(), tries = 0;
    (function waitForSim() {
      var st = simState();
      if (!st && typeof SimVar !== "undefined" && !forced && tries++ < 40) { setTimeout(waitForSim, 500); return; }
      if (!st || forced) { byIcao(forced || (typeof VATFLOW_TWR !== "undefined" ? VATFLOW_TWR.icao : "KDCA")); return; }
      byPosition(st);
    })();
  }

  function byIcao(icao) {
    var s = fromBundled(icao);
    if (s) { finish(s); return; }
    var cached = typeof VatflowStore !== "undefined" ? VatflowStore.get("APT_" + icao, null) : null;
    if (cached) { finish({ icao: icao, name: cached.name, lid: cached.lid, arp: cached.arp, elevFt: cached.elevFt, data: cached }); return; }
    loadVatspy(function (err, list) {
      var a = null;
      for (var i = 0; list && i < list.length; i++) if (list[i].icao === icao) { a = list[i]; break; }
      if (!a) { finish(fromBundled("KDCA") || { icao: icao, name: icao, arp: { lat: 0, lon: 0 } }); return; }
      finish({ icao: a.icao, name: a.name, lid: a.lid, arp: { lat: a.lat, lon: a.lon }, elevFt: 0, data: null });
    });
  }

  function byPosition(st) {
    var b = nearest(bundledList(), st.lat, st.lon, BUNDLED_NM), s;
    if (b) {
      s = fromBundled(b.icao);
      s.magVar = st.magVar;
      finish(s);
      return;
    }
    var last = typeof VatflowStore !== "undefined" ? VatflowStore.get("SITE_LAST", null) : null;
    // the ground under the cab: the field's elevation (the tower stands on it), valid up in
    // the tower too, not only on the ground
    var ground = isFinite(st.groundFt) && st.groundFt > -1500 && st.groundFt < 15000 ? Math.round(st.groundFt) : null;
    function withData(s2) {
      var cached = typeof VatflowStore !== "undefined" ? VatflowStore.get("APT_" + s2.icao, null) : null;
      if (cached) { s2.data = cached; if (cached.elevFt) s2.elevFt = cached.elevFt; }
      if (!s2.elevFt && ground !== null) s2.elevFt = ground;      // (an older saved spot had 0)
      s2.magVar = st.magVar;
      finish(s2);
    }
    if (last && distNm(st.lat, st.lon, last.arp.lat, last.arp.lon) <= VATSPY_NM) { withData(last); return; }
    loadVatspy(function (err, list) {
      var a = list ? nearest(list, st.lat, st.lon, VATSPY_NM) : null;
      var s2 = a ? { icao: a.icao, name: a.name, lid: a.lid, arp: { lat: a.lat, lon: a.lon } }
        : { icao: "----", name: "UNKNOWN AIRPORT", lid: "", arp: { lat: st.lat, lon: st.lon } };
      s2.elevFt = ground !== null ? ground : 0;
      if (a && typeof VatflowStore !== "undefined") VatflowStore.set("SITE_LAST", s2);
      withData(s2);
    });
  }

  /**
   * Full data (runways, tower, maps) for the resolved airport: cb(data or null, err).
   * Only one screen at a time asks OpenStreetMap (L:VATFLOW_OSM_LOCK); the others wait
   * for its result in the sim's storage.
   */
  function loadData(cb) {
    resolve(function (s) {
      if (s.data) { cb(s.data); return; }
      if (s.icao === "----") { cb(null, new Error("no airport within " + VATSPY_NM + " nm")); return; }
      var key = "APT_" + s.icao, sim = typeof SimVar !== "undefined", t0 = Date.now();
      function done(d) {
        s.data = d;
        if (typeof VATFLOW_TWR !== "undefined") apply(VATFLOW_TWR, s, typeof VATFLOW_TWR_OVERRIDES !== "undefined" ? VATFLOW_TWR_OVERRIDES : null);
        VATFLOW_MAPS = d.maps;
        cb(d);
      }
      (function waitOrFetch() {
        var cached = typeof VatflowStore !== "undefined" ? VatflowStore.get(key, null) : null;
        if (cached) { done(cached); return; }
        var lock = sim ? SimVar.GetSimVarValue("L:VATFLOW_OSM_LOCK", "number") : 0, now = Date.now() / 1000;
        if (lock && now - lock < 150 && Date.now() - t0 < 160000) { setTimeout(waitOrFetch, 3000); return; }
        if (sim) SimVar.SetSimVarValue("L:VATFLOW_OSM_LOCK", "number", now);
        loadVatspy(function (err, list) {
          var near = [];
          for (var i = 0; list && i < list.length; i++) {
            if (distNm(s.arp.lat, s.arp.lon, list[i].lat, list[i].lon) <= 25) near.push(list[i]);
          }
          VatflowOsmAirport.fetchAirport({ icao: s.icao, name: s.name, lid: s.lid, arp: s.arp, elevFt: s.elevFt }, near, function (e, d) {
            if (sim) SimVar.SetSimVarValue("L:VATFLOW_OSM_LOCK", "number", 0);
            if (e) { cb(null, e); return; }
            try { VatflowStore.set(key, d); } catch (e2) { /* too big for storage: rebuilt next time */ }
            done(d);
          });
        });
      })();
    });
  }

  function current() { return site; }
  function reset() { site = null; busy = false; waiting = []; }

  return {
    faaElevFt: faaElevFt,
    resolve: resolve, loadData: loadData, current: current, apply: apply, simState: simState,
    parseVatspy: parseVatspy, nearest: nearest, distNm: distNm, reset: reset, loadVatspy: loadVatspy
  };
})();
var VATFLOW_MAPS = typeof VATFLOW_MAPS !== "undefined" ? VATFLOW_MAPS : null;
