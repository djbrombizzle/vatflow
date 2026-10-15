/*
 * VATFLOW Tower Cab - airport data for airports that aren't bundled (common/airports/),
 * built in the cab from OpenStreetMap through the Overpass API. Produces the same object
 * as tools/build_airport_data.py: runways, the control tower (first guess for the
 * placement screen) and the ASDE-X / DBRITE maps (ASDE-X in meters, DBRITE in nm,
 * x east / y north of the ARP). Map data (c) OpenStreetMap contributors (ODbL).
 */
var VatflowOsmAirport = (function () {
  var M_PER_DEG = 111320, FT_PER_M = 3.28084, CAB_BELOW_TOP_M = 6;
  var FIELD_M = 4500, DBRITE_M = 40000, DBRITE_NM = 22;
  var ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  ];

  function query(lat, lon) {
    var c = lat.toFixed(5) + "," + lon.toFixed(5), f = "(around:" + FIELD_M + "," + c + ")";
    return "[out:json][timeout:90];(" +
      'way["aeroway"~"^(aerodrome|apron|terminal|hangar|taxiway|taxilane|runway|stopway)$"]' + f + ";" +
      'relation["aeroway"="aerodrome"]' + f + ";" +
      'nwr["aeroway"~"^(control_tower|tower)$"]' + f + ";" +
      'nwr["man_made"="tower"]["tower:type"="airport_control"]' + f + ";" +
      'way["aeroway"="runway"](around:' + DBRITE_M + "," + c + ");" +
      ");out geom;";
  }

  function frame(arp) {
    var k = M_PER_DEG * Math.cos(arp.lat * Math.PI / 180);
    return function (lat, lon) { return [(lon - arp.lon) * k, (lat - arp.lat) * M_PER_DEG]; };
  }

  /** Ramer-Douglas-Peucker on [[x, y], ...]. */
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    var x1 = pts[0][0], y1 = pts[0][1], x2 = pts[pts.length - 1][0], y2 = pts[pts.length - 1][1];
    var dx = x2 - x1, dy = y2 - y1, norm = Math.sqrt(dx * dx + dy * dy), dmax = 0, idx = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var d = norm < 1e-6 ? Math.sqrt(Math.pow(pts[i][0] - x1, 2) + Math.pow(pts[i][1] - y1, 2))
        : Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / norm;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps) return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
    return [pts[0], pts[pts.length - 1]];
  }

  function flat(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) out.push(Math.round(pts[i][0] * 10) / 10, Math.round(pts[i][1] * 10) / 10);
    return out;
  }

  function geomM(g, toM) {
    var out = [];
    for (var i = 0; i < (g || []).length; i++) out.push(toM(g[i].lat, g[i].lon));
    return out;
  }

  function isTower(t) {
    return t.aeroway === "control_tower" || t.aeroway === "tower" || t.building === "control_tower" ||
      (t.man_made === "tower" && (t["tower:type"] === "airport_control" || t["tower:type"] === "control")) ||
      t.service === "aircraft_control";
  }

  function heightM(t) {
    var v = t.height || t.est_height;
    if (v && !isNaN(parseFloat(v))) return parseFloat(v);
    if (t["building:levels"] && !isNaN(parseFloat(t["building:levels"]))) return parseFloat(t["building:levels"]) * 3.5;
    return null;
  }

  function closed(g) {
    return g && g.length > 2 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
  }

  function bearing(a, b) {
    var k = Math.cos(a[0] * Math.PI / 180);
    return (Math.atan2((b[1] - a[1]) * k, b[0] - a[0]) * 180 / Math.PI + 360) % 360;
  }

  /** Runway ids "08L/26R" on a way from a to b: which id belongs to end a (it points from a to b). */
  function orient(ref, a, b) {
    var ids = String(ref || "").split("/");
    if (ids.length !== 2) return null;
    var brg = bearing(a, b), n0 = parseInt(ids[0], 10) * 10, diff = Math.abs(((brg - n0) % 360 + 540) % 360 - 180);
    return diff <= 90 ? { ids: [ids[0], ids[1]], a: a, b: b } : { ids: [ids[0], ids[1]], a: b, b: a };
  }

  /**
   * Builds the airport object from an Overpass "out geom" result.
   * base: {icao, name, lid, arp: {lat, lon}, elevFt}; nearby: [{icao, lat, lon, type}] for the DBRITE.
   */
  function build(osm, base, nearby) {
    var arp = base.arp, toM = frame(arp), els = (osm && osm.elements) || [];
    var asdex = { land: [], aprons: [], buildings: [], taxiways: [], runways: [] };
    var dbrite = { runways: [], airports: [], heliports: [], navaids: [] };
    var runways = [], tower = null;
    for (var i = 0; i < els.length; i++) {
      var e = els[i], t = e.tags || {}, a = t.aeroway, g = e.geometry, pts, d;
      if (isTower(t)) {
        var lat = e.lat, lon = e.lon;
        if (lat === undefined && g && g.length) {
          var n = closed(g) ? g.length - 1 : g.length, sl = 0, so = 0;
          for (var j = 0; j < n; j++) { sl += g[j].lat; so += g[j].lon; }
          lat = sl / n; lon = so / n;
        } else if (lat === undefined && e.center) { lat = e.center.lat; lon = e.center.lon; }
        if (lat !== undefined) {
          var p = toM(lat, lon), dist = Math.sqrt(p[0] * p[0] + p[1] * p[1]);
          if (!tower || dist < tower.dist) tower = { dist: dist, lat: lat, lon: lon, h: heightM(t), name: t.name || "", p: p };
        }
        continue;
      }
      if (e.type === "relation" && a === "aerodrome") {
        for (var m = 0; m < (e.members || []).length; m++) {
          var mem = e.members[m];
          if (mem.type === "way" && mem.role === "outer" && mem.geometry) asdex.land.push(flat(rdp(geomM(mem.geometry, toM), 2)));
        }
        continue;
      }
      if (e.type !== "way" || !g || g.length < 2) continue;
      pts = geomM(g, toM);
      d = Math.min(Math.sqrt(pts[0][0] * pts[0][0] + pts[0][1] * pts[0][1]),
        Math.sqrt(pts[pts.length - 1][0] * pts[pts.length - 1][0] + pts[pts.length - 1][1] * pts[pts.length - 1][1]));
      var field = d < FIELD_M + 1500;
      if (a === "runway" && !closed(g)) {
        var e0 = pts[0], e1 = pts[pts.length - 1];
        dbrite.runways.push([e0[0] / 1852, e0[1] / 1852, e1[0] / 1852, e1[1] / 1852].map(function (v) { return Math.round(v * 1000) / 1000; }));
      }
      if (!field) continue;
      if (a === "aerodrome") asdex.land.push(flat(rdp(pts, 2)));
      else if (a === "apron") asdex.aprons.push(flat(rdp(pts, 1)));
      else if (a === "terminal" || a === "hangar") asdex.buildings.push(flat(rdp(pts, 1)));
      else if (a === "taxiway" || a === "taxilane") asdex.taxiways.push({ w: a === "taxiway" ? 23 : 15, p: flat(rdp(pts, 1)) });
      else if (a === "runway" || a === "stopway") {
        var w = parseFloat(t.width) || 46;
        asdex.runways.push({ w: w, p: flat(rdp(pts, 1)), ref: t.ref || "", c: closed(g) ? 1 : 0 });
        if (a === "runway" && !closed(g) && t.ref) {
          var o = orient(t.ref, [g[0].lat, g[0].lon], [g[g.length - 1].lat, g[g.length - 1].lon]);
          if (o) runways.push({ ids: o.ids, a: [round5(o.a[0]), round5(o.a[1])], b: [round5(o.b[0]), round5(o.b[1])] });
        }
      }
    }
    for (var k = 0; k < (nearby || []).length; k++) {
      var ap = nearby[k], q = toM(ap.lat, ap.lon), x = q[0] / 1852, y = q[1] / 1852;
      if (Math.sqrt(x * x + y * y) <= DBRITE_NM) dbrite.airports.push({ id: ap.icao, t: ap.type || "airport", x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
    }
    var out = {
      icao: base.icao, name: base.name, lid: base.lid, arp: arp, elevFt: base.elevFt || 0,
      runways: runways, tower: null, maps: { asdex: asdex, dbrite: dbrite }, src: "OpenStreetMap"
    };
    if (tower) {
      out.tower = {
        lat: round7(tower.lat), lon: round7(tower.lon), heightM: tower.h,
        floorFtMsl: Math.round((base.elevFt || 0) + (tower.h ? (tower.h - CAB_BELOW_TOP_M) * FT_PER_M : 150)),
        headingTrue: Math.round((Math.atan2(-tower.p[0], -tower.p[1]) * 180 / Math.PI + 360) % 360),
        src: "OpenStreetMap" + (tower.name ? " (" + tower.name + ")" : "") + (tower.h ? "" : ", height unknown")
      };
    }
    return out;
  }

  function round5(v) { return Math.round(v * 1e5) / 1e5; }
  function round7(v) { return Math.round(v * 1e7) / 1e7; }

  /** Fetches and builds; tries the Overpass servers in turn. cb(err, airport). */
  function fetchAirport(base, nearby, cb) {
    var body = "data=" + encodeURIComponent(query(base.arp.lat, base.arp.lon));
    (function attempt(i) {
      if (i >= ENDPOINTS.length) { cb(new Error("OpenStreetMap map servers did not answer")); return; }
      var x = new XMLHttpRequest();
      x.open("POST", ENDPOINTS[i], true);
      x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
      x.timeout = 120000;
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        if (x.status !== 200) { attempt(i + 1); return; }
        try { cb(null, build(JSON.parse(x.responseText), base, nearby)); } catch (e) { cb(e); }
      };
      x.ontimeout = function () { /* readyState 4 follows with status 0 */ };
      x.send(body);
    })(0);
  }

  return { query: query, build: build, fetchAirport: fetchAirport, orient: orient, ENDPOINTS: ENDPOINTS };
})();
