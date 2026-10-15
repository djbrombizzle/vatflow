/*
 * VATFLOW Tower Cab - ARTCC video maps (the maps CRC shows), from vNAS.
 *
 * The ARTCC file (the vNAS ARTCC configuration, e.g. ZTL.json) lives in the separate
 * "vatflow-towercab-maps" Community package under html_ui/.../VatflowTower/facilities/
 * (its update-maps.bat downloads it and updates the package's layout.json). It lists every
 * video map and which facility uses which. The map drawings (GeoJSON) are downloaded
 * live from vNAS by id when a screen shows them.
 *
 *   facility(icao, cb)      cb(info or null): this airport's tower, its ASDE-X map, the
 *                           TRACON's STARS maps (with their STARS numbers), the cab maps
 *                           and the runway configurations (names for map presets)
 *   loadMap(artcc, id, cb)  cb(err, geojson) (kept in memory once loaded)
 *   toLines / toAsdex       GeoJSON -> what the DBRITE / ASDE-X draw
 */
var VatflowVnas = (function () {
  var FILES = "https://data-api.vnas.vatsim.net/Files/VideoMaps/";
  // ARTCC of the bundled airports (others: the airport's FIR in the VATSpy list, KZxx -> Zxx)
  var ARTCC = { KDCA: "ZDC", KATL: "ZTL" };
  var M_PER_DEG = 111320;
  var artccs = {}, maps = {}, waits = {};

  function base() {
    return (typeof VATFLOW_TWR !== "undefined" && VATFLOW_TWR.facilitiesBase) || "/Pages/VCockpit/Instruments/VatflowTower/facilities/";
  }

  function get(url, cb) {
    var x = new XMLHttpRequest();
    x.open("GET", url, true);
    x.timeout = 60000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      // local package files can come back with status 0 in the sim's browser
      if (x.status === 200 || (x.status === 0 && x.responseText)) {
        try { cb(null, JSON.parse(x.responseText)); } catch (e) { cb(e); }
      } else cb(new Error("HTTP " + x.status));
    };
    x.send();
  }

  /** One request per url at a time; everyone asking gets the same answer. */
  function once(store, key, url, cb) {
    if (store[key] !== undefined) { cb(store[key] ? null : new Error("not available"), store[key]); return; }
    if (waits[url]) { waits[url].push(cb); return; }
    waits[url] = [cb];
    get(url, function (err, d) {
      store[key] = err ? null : d;
      var w = waits[url]; delete waits[url];
      for (var i = 0; i < w.length; i++) w[i](err, d);
    });
  }

  function artccFor(icao, cb) {
    if (ARTCC[icao]) { cb(ARTCC[icao]); return; }
    if (typeof VatflowSite === "undefined") { cb(null); return; }
    VatflowSite.loadVatspy(function (err, list) {
      for (var i = 0; list && i < list.length; i++) {
        if (list[i].icao === icao) {
          var fir = list[i].fir || "";
          cb(/^KZ[A-Z]{2}$/.test(fir) ? fir.slice(1) : null);
          return;
        }
      }
      cb(null);
    });
  }

  function walk(f, parent, fn) {
    fn(f, parent);
    var kids = f.childFacilities || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i], f.starsConfiguration ? f : parent, fn);
  }

  /** What the ARTCC file says about airport lid: pure, for tests. */
  function describe(art, lid) {
    var byId = {};
    var vm = art.videoMaps || [];
    for (var i = 0; i < vm.length; i++) byId[vm[i].id] = vm[i];
    var tower = null, tracon = null;
    walk(art.facility || {}, null, function (f, parent) {
      if (f.id === lid && (f.towerCabConfiguration || f.asdexConfiguration || f.starsConfiguration)) {
        tower = f;
        tracon = f.starsConfiguration ? f : parent;
      }
    });
    if (!tower) return null;
    function entry(id) {
      var m = byId[id];
      return m ? { id: id, name: m.name, short: m.shortName || "", stars: m.starsId || null, cat: m.starsBrightnessCategory || "A", tags: m.tags || [] } : null;
    }
    var cab = tower.towerCabConfiguration, ax = tower.asdexConfiguration;
    var stars = [];
    var sids = (tracon && tracon.starsConfiguration && tracon.starsConfiguration.videoMapIds) || [];
    for (var j = 0; j < sids.length; j++) { var e = entry(sids[j]); if (e) stars.push(e); }
    stars.sort(function (a, b) { return (a.stars || 999) - (b.stars || 999) || (a.name < b.name ? -1 : 1); });
    var re = new RegExp("^" + lid + "\\b", "i"), cabMaps = [], asdexMaps = [];
    for (var k = 0; k < vm.length; k++) {
      var t = vm[k].tags || [];
      if (!re.test(vm[k].name)) continue;
      if (t.indexOf("ASDEX") >= 0) asdexMaps.push(entry(vm[k].id));
      else if (t.indexOf("CAB") >= 0 || t.indexOf("TOWER") >= 0) cabMaps.push(entry(vm[k].id));
    }
    var configs = [];
    var rc = (ax && ax.runwayConfigurations) || [];
    for (var r = 0; r < rc.length; r++) configs.push(rc[r].name);
    return {
      artcc: art.id, lid: lid, name: tower.name, tracon: tracon ? tracon.id : null,
      towerLocation: (cab && cab.towerLocation) || (ax && ax.towerLocation) || null,
      cabMap: cab && cab.videoMapId ? entry(cab.videoMapId) : null,
      asdexMap: ax && ax.videoMapId ? entry(ax.videoMapId) : null,
      asdexRotation: ax ? ax.defaultRotation || 0 : 0,
      stars: stars, cabMaps: cabMaps, asdexMaps: asdexMaps, configs: configs
    };
  }

  /** cb(info or null): needs the ARTCC file in the maps package. */
  function facility(icao, lid, cb) {
    artccFor(icao, function (artcc) {
      if (!artcc) { cb(null); return; }
      once(artccs, artcc, base() + artcc + ".json", function (err, art) {
        cb(art ? describe(art, lid || icao.replace(/^K/, "")) : null);
      });
    });
  }

  function loadMap(artcc, id, cb) { once(maps, artcc + "/" + id, FILES + artcc + "/" + id + ".geojson", cb); }

  function proj(arp) {
    var k = M_PER_DEG * Math.cos(arp.lat * Math.PI / 180);
    return function (c) { return [(c[0] - arp.lon) * k, (c[1] - arp.lat) * M_PER_DEG]; };
  }

  function eachGeom(g, fn) {
    if (!g) return;
    var t = g.type, c = g.coordinates;
    if (t === "LineString") fn("line", [c]);
    else if (t === "MultiLineString") fn("line", c);
    else if (t === "Polygon") fn("poly", c);
    else if (t === "MultiPolygon") for (var i = 0; i < c.length; i++) fn("poly", c[i]);
    else if (t === "Point") fn("point", [[c]]);
    else if (t === "GeometryCollection") for (var j = 0; j < g.geometries.length; j++) eachGeom(g.geometries[j], fn);
  }

  function flatten(ring, P, scale) {
    var out = [];
    for (var i = 0; i < ring.length; i++) { var q = P(ring[i]); out.push(Math.round(q[0] / scale * 1000) / 1000, Math.round(q[1] / scale * 1000) / 1000); }
    return out;
  }

  /**
   * GeoJSON -> {lines: [{c, w, p}], polys: [{c, p}], texts: [{x, y, t, c}]} in nm from the ARP
   * (DBRITE). c: the feature's own colour, or null (then the STARS map colour is used).
   */
  function toLines(gj, arp) {
    var P = proj(arp), out = { lines: [], polys: [], texts: [] };
    var fs = (gj && gj.features) || [];
    for (var i = 0; i < fs.length; i++) {
      var pr = fs[i].properties || {}, col = pr.color || null, w = pr.thickness || 1;
      eachGeom(fs[i].geometry, function (kind, parts) {
        for (var j = 0; j < parts.length; j++) {
          if (kind === "line") out.lines.push({ c: col, w: w, p: flatten(parts[j], P, 1852) });
          else if (kind === "poly") out.polys.push({ c: col, p: flatten(parts[j], P, 1852) });
          else if (pr.text) {
            var q = P(parts[j][0]);
            out.texts.push({ x: q[0] / 1852, y: q[1] / 1852, t: [].concat(pr.text).join(" "), c: col });
          }
        }
      });
    }
    return out;
  }

  /** ASDE-X GeoJSON (properties.asdex: runway / taxiway / apron / structure) -> the ASDE-X map (meters). */
  function toAsdex(gj, arp) {
    var P = proj(arp), out = { land: [], aprons: [], buildings: [], taxiways: [], runways: [], polys: [] };
    var order = { apron: 0, taxiway: 1, runway: 2, structure: 3 };
    var fs = (gj && gj.features) || [];
    for (var i = 0; i < fs.length; i++) {
      var pr = fs[i].properties || {}, kind = pr.asdex || "apron";
      eachGeom(fs[i].geometry, function (k, parts) {
        if (k !== "poly") return;
        out.polys.push({ k: kind, z: order[kind] === undefined ? 0 : order[kind], c: pr.color || "", p: flatten(parts[0], P, 1) });
      });
    }
    out.polys.sort(function (a, b) { return a.z - b.z; });
    // the field outline (for fitting the screen): every polygon's points
    var all = [];
    for (var j = 0; j < out.polys.length; j++) all = all.concat(out.polys[j].p);
    if (all.length) out.land.push(all);
    out.vnas = true;
    return out;
  }

  return { facility: facility, describe: describe, loadMap: loadMap, toLines: toLines, toAsdex: toAsdex, ARTCC: ARTCC, FILES: FILES };
})();
