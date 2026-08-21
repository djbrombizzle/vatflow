/**
 * EDST SIG — SIGMETs for the controller's FIR/ARTCC.
 *
 * Sources:
 *   1. AWC airsigmet (US convective / domestic) — polygon within 150 NM of the
 *      ARTCC boundary (NWS FIR tags often omit KZJX etc.; convective products
 *      are issued by KKCI)
 *   2. AWC isigmet — international SIGMETs for this FIR (firId, raw FIR list,
 *      or geometry within 150 NM). AWC assigns a single firId even when the
 *      bulletin covers multiple FIRs (e.g. CHARLIE 3 as KZHU while KZMA is listed).
 *   3. NWS Aviation SIGMET GeoJSON — FIR-tagged rows, used to fill gaps.
 *      NWS `start=` is a 6-hour lookback and still returns superseded / previous-
 *      hour products; those are dropped when AWC's current list is available.
 *
 * AWC blocks browser CORS; public proxies are used as fallback (same pattern as winds-aloft).
 */
(function (global) {
  "use strict";

  var NWS_SIGMETS = "https://api.weather.gov/aviation/sigmets";
  var AWC_AIRSIGMET = "https://aviationweather.gov/api/data/airsigmet?format=json";
  var AWC_ISIGMET = "https://aviationweather.gov/api/data/isigmet?format=json";
  var DEFAULT_HUB =
    "https://web-production-3d9fe.up.railway.app";
  var BOUNDARY_URLS = [
    "../../data/artcc-boundaries-high.geojson",
    "../data/artcc-boundaries-high.geojson",
    "data/artcc-boundaries-high.geojson",
    "/data/artcc-boundaries-high.geojson",
  ];
  // Public CORS proxies — avoid allorigins (often 15–20s / 522). Prefer hub.
  var CORS_PROXIES = [
    function (u) {
      return "https://corsproxy.io/?url=" + encodeURIComponent(u);
    },
  ];
  var FETCH_TIMEOUT_MS = 6000;
  var HUB_TIMEOUT_MS = 5000;
  /** Include SIGMETs whose geometry comes this close to the FIR/ARTCC boundary. */
  var SIGMET_PROXIMITY_NM = 150;
  var EARTH_NM = 3440.065;

  /** ARTCC id (ZJX) -> rings of [lon, lat] */
  var artccPolys = null;
  var artccLoad = null;
  /** ARTCC id -> {minLat, maxLat, minLon, maxLon} */
  var artccBBox = Object.create(null);

  function normalizeArtcc(raw) {
    var id = String(raw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!id) return "";
    // Prefer bare Zxx for boundary matching; keep K-prefix for NWS/isig FIR compare
    return id;
  }

  function bareArtcc(id) {
    return String(id || "")
      .toUpperCase()
      .replace(/^K(?=Z)/, "");
  }

  function firMatches(fir, artcc) {
    var a = bareArtcc(artcc);
    var f = bareArtcc(fir);
    return !!a && !!f && a === f;
  }

  /** US convective sequence: 21E, 13C, 4W. Not an ICAO letter series. */
  function isConvectiveSeq(seq) {
    return /^\d+[A-Z]$/.test(String(seq || "").trim().toUpperCase());
  }

  /** ICAO SIGMET series: CHARLIE 3, FOXTROT 3. Same letter, higher number supersedes. */
  function parseIntlSeries(seq) {
    var m = String(seq || "")
      .trim()
      .toUpperCase()
      .match(/^([A-Z]+)\s+(\d+)$/);
    if (!m) return null;
    return { letter: m[1], num: parseInt(m[2], 10) };
  }

  /**
   * Short hazard label for the SIG header.
   * NWS phenomenon is often a WMO URI (http://codes.wmo.int/.../FRQ_TS).
   */
  function normalizeHazard(raw) {
    var s = String(raw || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s) || /codes\.wmo\.int/i.test(s)) {
      var path = s.replace(/\/+$/, "");
      var slash = path.lastIndexOf("/");
      s = slash >= 0 ? path.slice(slash + 1) : path;
    }
    return s.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function dropSupersededIntl(entries) {
    var best = Object.create(null);
    (entries || []).forEach(function (e) {
      var parsed = parseIntlSeries(e && e.sequence);
      if (!parsed) return;
      if (best[parsed.letter] == null || parsed.num > best[parsed.letter])
        best[parsed.letter] = parsed.num;
    });
    return (entries || []).filter(function (e) {
      var parsed = parseIntlSeries(e && e.sequence);
      if (!parsed) return true;
      return parsed.num === best[parsed.letter];
    });
  }

  function parseTime(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number" && isFinite(value)) {
      var ms = value < 1e12 ? value * 1000 : value;
      var d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    var parsed = new Date(String(value));
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function entryStart(entry) {
    return entry.validTimeFrom != null ? entry.validTimeFrom : entry.start;
  }
  function entryEnd(entry) {
    return entry.validTimeTo != null ? entry.validTimeTo : entry.end;
  }

  function isCurrentlyValid(entry, now) {
    var start = parseTime(entryStart(entry));
    var end = parseTime(entryEnd(entry));
    if (start && now < start) return false;
    if (end && now > end) return false;
    return true;
  }

  function fetchJson(url, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : FETCH_TIMEOUT_MS;
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = null;
    if (ctrl && timeoutMs > 0) {
      timer = setTimeout(function () {
        try {
          ctrl.abort();
        } catch (_) {}
      }, timeoutMs);
    }
    return fetch(url, {
      method: opts.method || "GET",
      mode: "cors",
      credentials: "omit",
      cache: opts.cache || "no-store",
      signal: ctrl ? ctrl.signal : undefined,
      headers: Object.assign(
        { Accept: "application/geo+json, application/json, text/plain, */*" },
        opts.headers || {}
      ),
      body: opts.body,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
        return res.json();
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
      });
  }

  function hubBase() {
    try {
      if (global.settings && global.settings.hubUrl)
        return String(global.settings.hubUrl).replace(/\/+$/, "");
    } catch (_) {}
    return DEFAULT_HUB;
  }

  /** Hub-cached AWC feed (avoids browser CORS + slow allorigins). */
  function fetchAwcViaHub(kind) {
    var path = kind === "isig" ? "/hub/isigmet" : "/hub/airsigmet";
    return fetchJson(hubBase() + path, {
      method: "POST",
      timeoutMs: HUB_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then(function (data) {
      if (!data || data.ok === false)
        throw new Error((data && data.error) || "hub awc failed");
      var entries = data.entries;
      if (!Array.isArray(entries)) throw new Error("hub awc empty");
      return entries;
    });
  }

  /** Race CORS proxy (and optional direct) with short timeouts — never allorigins. */
  function fetchJsonFlexible(url, opts) {
    opts = opts || {};
    var attempts = [];
    if (opts.viaHub === "air" || opts.viaHub === "isig") {
      attempts.push(function () {
        return fetchAwcViaHub(opts.viaHub);
      });
    }
    if (opts.tryDirect !== false) {
      attempts.push(function () {
        return fetchJson(url, { timeoutMs: opts.directTimeoutMs || 4000 });
      });
    }
    CORS_PROXIES.forEach(function (prox) {
      attempts.push(function () {
        return fetchJson(prox(url), { timeoutMs: opts.proxyTimeoutMs || 5000 });
      });
    });

    // Race first success; fall through sequentially only if race rejects all.
    // Start hub + proxy in parallel when hub is preferred.
    if (attempts.length === 1) return attempts[0]();
    return new Promise(function (resolve, reject) {
      var pending = attempts.length;
      var lastErr = new Error("all fetches failed");
      var done = false;
      attempts.forEach(function (fn) {
        Promise.resolve()
          .then(fn)
          .then(function (data) {
            if (done) return;
            done = true;
            resolve(data);
          })
          .catch(function (err) {
            lastErr = err || lastErr;
            pending -= 1;
            if (!done && pending <= 0) reject(lastErr);
          });
      });
    });
  }

  function withTimeoutFallback(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          resolve(fallback);
        }
      }, ms);
      Promise.resolve(promise)
        .then(function (v) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(v);
          }
        })
        .catch(function () {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(fallback);
          }
        });
    });
  }

  function nwsStartIso(hoursBack) {
    var d = new Date(Date.now() - (hoursBack || 6) * 60 * 60 * 1000);
    return d.toISOString();
  }

  function inRing(lat, lon, ring) {
    // ring: [[lon,lat], ...]
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0],
        yi = ring[i][1];
      var xj = ring[j][0],
        yj = ring[j][1];
      if (
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi
      )
        inside = !inside;
    }
    return inside;
  }

  function pointInArtcc(artcc, lat, lon) {
    if (!artccPolys || lat == null || lon == null) return null;
    var rings = artccPolys[bareArtcc(artcc)];
    if (!rings || !rings.length) return null;
    for (var i = 0; i < rings.length; i++) {
      if (inRing(lat, lon, rings[i])) return true;
    }
    return false;
  }

  var ARTCC_ID_ALIASES = {
    PAZA: "ZAN",
    PHZH: "ZHN",
    TJZS: "ZUA",
    HCF: "ZHN",
    ANC: "ZAN",
    HNL: "ZHN",
  };

  function ingestBoundaries(geo) {
    var map = Object.create(null);
    (geo && geo.features ? geo.features : []).forEach(function (f) {
      var p = (f && f.properties) || {};
      var id = String(p.id || p.ID || p.prefix || "")
        .toUpperCase()
        .replace(/^K(?=Z)/, "");
      if (ARTCC_ID_ALIASES[id]) id = ARTCC_ID_ALIASES[id];
      if (!id || !f.geometry) return;
      if (p.mapHighlightOnly || id.indexOf("-") !== -1) return;
      // Skip oceanic / non-CONUS FIR blobs when id is not a US ARTCC
      if (!/^Z[A-Z]{2}$/.test(id) && !/^(PAZA|PHZH|TJZS)$/.test(id)) return;
      var g = f.geometry;
      var rings = [];
      if (g.type === "Polygon" && g.coordinates && g.coordinates.length)
        rings.push(g.coordinates[0]);
      else if (g.type === "MultiPolygon")
        (g.coordinates || []).forEach(function (poly) {
          if (poly && poly.length) rings.push(poly[0]);
        });
      if (!rings.length) return;
      if (!map[id]) map[id] = [];
      Array.prototype.push.apply(map[id], rings);
    });
    artccPolys = map;
    artccBBox = Object.create(null);
    return Object.keys(map).length;
  }

  function loadArtccBoundaries() {
    if (artccPolys) return Promise.resolve(artccPolys);
    if (artccLoad) return artccLoad;
    var urls = BOUNDARY_URLS.slice();
    artccLoad = (function tryNext() {
      if (!urls.length) {
        artccPolys = Object.create(null);
        return Promise.resolve(artccPolys);
      }
      var url = urls.shift();
      return fetchJson(url)
        .then(function (geo) {
          var n = ingestBoundaries(geo);
          if (!n) throw new Error("no ARTCC polygons in " + url);
          return artccPolys;
        })
        .catch(function () {
          return tryNext();
        });
    })();
    return artccLoad;
  }

  function boundsForArtcc(artcc) {
    var id = bareArtcc(artcc);
    if (artccBBox[id]) return artccBBox[id];
    var rings = artccPolys && artccPolys[id];
    if (!rings || !rings.length) return null;
    var minLat = 90,
      maxLat = -90,
      minLon = 180,
      maxLon = -180;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var i = 0; i < ring.length; i++) {
        var lon = ring[i][0],
          lat = ring[i][1];
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
    artccBBox[id] = {
      minLat: minLat,
      maxLat: maxLat,
      minLon: minLon,
      maxLon: maxLon,
    };
    return artccBBox[id];
  }

  function haversineNm(lat1, lon1, lat2, lon2) {
    var p1 = (lat1 * Math.PI) / 180;
    var p2 = (lat2 * Math.PI) / 180;
    var dphi = p2 - p1;
    var dl = ((lon2 - lon1) * Math.PI) / 180;
    var a =
      Math.sin(dphi / 2) * Math.sin(dphi / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Equirectangular point-to-segment distance in NM (good to ~150 NM). */
  function distPointToSegNm(lat, lon, lat1, lon1, lat2, lon2) {
    var cos = Math.cos((lat * Math.PI) / 180);
    var ax = (lon1 - lon) * cos * 60;
    var ay = (lat1 - lat) * 60;
    var bx = (lon2 - lon) * cos * 60;
    var by = (lat2 - lat) * 60;
    var abx = bx - ax,
      aby = by - ay;
    var len2 = abx * abx + aby * aby;
    if (len2 < 1e-12) return Math.sqrt(ax * ax + ay * ay);
    var t = Math.max(0, Math.min(1, (-ax * abx - ay * aby) / len2));
    var px = ax + t * abx;
    var py = ay + t * aby;
    return Math.sqrt(px * px + py * py);
  }

  function distPointToRingsNm(lat, lon, rings) {
    if (!rings || !rings.length) return Infinity;
    var best = Infinity;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      if (!ring || ring.length < 2) continue;
      for (var i = 0; i < ring.length - 1; i++) {
        var d = distPointToSegNm(
          lat,
          lon,
          ring[i][1],
          ring[i][0],
          ring[i + 1][1],
          ring[i + 1][0]
        );
        if (d < best) best = d;
        if (best === 0) return 0;
      }
    }
    return best;
  }

  function coordsToRing(coords) {
    var ring = [];
    if (!coords || !coords.length) return ring;
    for (var i = 0; i < coords.length; i++) {
      var c = coords[i];
      var lat = c.lat != null ? +c.lat : c[1] != null ? +c[1] : null;
      var lon = c.lon != null ? +c.lon : c[0] != null ? +c[0] : null;
      if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon))
        continue;
      ring.push([lon, lat]);
    }
    if (
      ring.length >= 2 &&
      (ring[0][0] !== ring[ring.length - 1][0] ||
        ring[0][1] !== ring[ring.length - 1][1])
    ) {
      ring.push([ring[0][0], ring[0][1]]);
    }
    return ring;
  }

  function inExpandedBBox(bbox, lat, lon, nm) {
    if (!bbox) return true;
    var dlat = (nm || 0) / 60;
    var clon = Math.max(0.2, Math.abs(Math.cos((lat * Math.PI) / 180)));
    var dlon = (nm || 0) / (60 * clon);
    return (
      lat >= bbox.minLat - dlat &&
      lat <= bbox.maxLat + dlat &&
      lon >= bbox.minLon - dlon &&
      lon <= bbox.maxLon + dlon
    );
  }

  function ringBounds(ring) {
    var minLat = 90,
      maxLat = -90,
      minLon = 180,
      maxLon = -180;
    for (var i = 0; i < ring.length; i++) {
      var lon = ring[i][0],
        lat = ring[i][1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    return {
      minLat: minLat,
      maxLat: maxLat,
      minLon: minLon,
      maxLon: maxLon,
    };
  }

  function bboxesOverlap(a, b, nm) {
    if (!a || !b) return false;
    var dlat = (nm || 0) / 60;
    var midLat = (a.minLat + a.maxLat + b.minLat + b.maxLat) / 4;
    var clon = Math.max(0.2, Math.abs(Math.cos((midLat * Math.PI) / 180)));
    var dlon = (nm || 0) / (60 * clon);
    return (
      a.minLat - dlat <= b.maxLat &&
      a.maxLat + dlat >= b.minLat &&
      a.minLon - dlon <= b.maxLon &&
      a.maxLon + dlon >= b.minLon
    );
  }

  /** True when a point is inside the ARTCC or within `nm` of its boundary. */
  function pointNearArtcc(artcc, lat, lon, nm) {
    if (pointInArtcc(artcc, lat, lon) === true) return true;
    if (!(nm > 0)) return false;
    var rings = artccPolys && artccPolys[bareArtcc(artcc)];
    if (!rings || !rings.length) return false;
    if (!inExpandedBBox(boundsForArtcc(artcc), lat, lon, nm)) return false;
    return distPointToRingsNm(lat, lon, rings) <= nm;
  }

  /**
   * True when SIGMET geometry touches the ARTCC or comes within `nm` NM
   * of the boundary (vertex or ARTCC vertex vs SIGMET polygon).
   */
  function geometryNearArtcc(artcc, coords, nm) {
    nm = nm == null ? SIGMET_PROXIMITY_NM : nm;
    var ring = coordsToRing(coords);
    if (!ring.length) return false;
    var sumLat = 0,
      sumLon = 0,
      n = 0;
    var i;
    for (i = 0; i < ring.length; i++) {
      var lat = ring[i][1],
        lon = ring[i][0];
      if (pointNearArtcc(artcc, lat, lon, nm)) return true;
      // Last point may duplicate the first on a closed ring — still fine to sum
      sumLat += lat;
      sumLon += lon;
      n++;
    }
    if (n > 0 && pointNearArtcc(artcc, sumLat / n, sumLon / n, 0)) return true;

    var artccRings = artccPolys && artccPolys[bareArtcc(artcc)];
    var artBBox = boundsForArtcc(artcc);
    if (!artccRings || !artccRings.length || ring.length < 4 || !artBBox)
      return false;
    var sigBBox = ringBounds(ring);
    if (!bboxesOverlap(sigBBox, artBBox, nm)) return false;
    for (var r = 0; r < artccRings.length; r++) {
      var aRing = artccRings[r];
      for (i = 0; i < aRing.length; i++) {
        var alat = aRing[i][1],
          alon = aRing[i][0];
        if (inRing(alat, alon, ring)) return true;
        if (nm > 0 && distPointToRingsNm(alat, alon, [ring]) <= nm) return true;
      }
    }
    return false;
  }

  function geometryTouchesArtcc(artcc, coords) {
    return geometryNearArtcc(artcc, coords, SIGMET_PROXIMITY_NM);
  }

  function coordsFromNwsGeometry(geom) {
    if (!geom || !geom.coordinates) return [];
    var out = [];
    function walk(node, depth) {
      if (!Array.isArray(node) || !node.length) return;
      if (typeof node[0] === "number" && typeof node[1] === "number") {
        out.push({ lon: node[0], lat: node[1] });
        return;
      }
      for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
    }
    walk(geom.coordinates, 0);
    return out;
  }

  function indexAwcBySeries(list) {
    var bySeries = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (!item || typeof item !== "object") return;
      var series = String(item.seriesId || item.series || "")
        .trim()
        .toUpperCase();
      var raw =
        item.rawAirSigmet ||
        item.rawSigmet ||
        item.rawOb ||
        item.raw ||
        "";
      item._rawText = String(raw || "").trim();
      if (series) bySeries[series] = item;
    });
    return { bySeries: bySeries, list: list || [] };
  }

  function fmtZulu(iso) {
    var d = parseTime(iso);
    if (!d) return String(iso || "?");
    var dd = String(d.getUTCDate()).padStart(2, "0");
    var hh = String(d.getUTCHours()).padStart(2, "0");
    var mm = String(d.getUTCMinutes()).padStart(2, "0");
    return dd + hh + mm + "Z";
  }

  /**
   * Short SIGMET body: first blank-line paragraph of the raw product text.
   * Used as the collapsed list preview; full raw is kept separately for expand.
   */
  function firstParagraph(raw) {
    var text = String(raw || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
    if (!text) return "";
    // Convective products append OUTLOOK after the SIGMET body
    var outlookAt = text.search(/\n\s*OUTLOOK\b/i);
    if (outlookAt >= 0) text = text.slice(0, outlookAt);
    var parts = text.split(/\n\s*\n/);
    var para = String(parts[0] || "").trim();
    return para;
  }

  function normalizeRaw(raw) {
    return String(raw || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
  }

  /** Collapsed preview + full bulletin for expand/collapse. */
  function textsFromRaw(raw, fallbackShort) {
    var full = normalizeRaw(raw);
    var short = firstParagraph(full) || String(fallbackShort || "").trim();
    if (!short) short = "(no text available)";
    if (!full) full = short;
    return { text: short, fullText: full };
  }

  function buildStubFromNws(props) {
    var fir = props.fir || props.atsu || "";
    var seq = props.sequence || "";
    var hazard = props.hazard || props.phenomenon || "";
    var lines = [];
    lines.push(
      String(fir || "SIGMET") + (seq ? " SIGMET " + seq : " SIGMET")
    );
    if (hazard) {
      var haz = normalizeHazard(hazard);
      if (haz) lines.push("HAZARD: " + haz.toUpperCase());
    }
    if (props.issueTime) lines.push("ISSUED: " + fmtZulu(props.issueTime));
    var start = props.start || props.validTimeFrom;
    var end = props.end || props.validTimeTo;
    if (start || end) {
      lines.push("VALID " + fmtZulu(start) + "-" + fmtZulu(end));
    }
    return lines.join("\n");
  }

  function buildTextFromNws(props, awcHit) {
    var stub = buildStubFromNws(props);
    if (awcHit && awcHit._rawText) return textsFromRaw(awcHit._rawText, stub);
    return { text: stub, fullText: stub };
  }

  function fromNwsFeature(feature, airIdx, isigIdx) {
    var props = (feature && feature.properties) || {};
    var seq = String(props.sequence || "")
      .trim()
      .toUpperCase();
    var awcHit =
      (seq && airIdx.bySeries[seq]) ||
      (seq && isigIdx.bySeries[seq]) ||
      null;
    var start = props.start || props.validTimeFrom || null;
    var end = props.end || props.validTimeTo || null;
    if (awcHit) {
      if (start == null && awcHit.validTimeFrom != null)
        start = awcHit.validTimeFrom;
      if (end == null && awcHit.validTimeTo != null) end = awcHit.validTimeTo;
    }
    var hazard = normalizeHazard(
      props.hazard ||
        props.phenomenon ||
        (awcHit && (awcHit.qualifier
          ? String(awcHit.qualifier) + " " + String(awcHit.hazard || "")
          : awcHit.hazard)) ||
        ""
    );
    var texts = buildTextFromNws(props, awcHit);
    return {
      id: String(props.id || (feature && feature.id) || seq || Math.random()),
      fir: String(props.fir || props.atsu || "").toUpperCase(),
      sequence: seq,
      hazard: hazard,
      start: start,
      end: end,
      issueTime: props.issueTime || null,
      text: texts.text,
      fullText: texts.fullText,
      source: "nws",
    };
  }

  function fromAirsigmet(item, artcc) {
    var seq = String(item.seriesId || "").toUpperCase();
    var raw = String(
      item.rawAirSigmet || item.rawSigmet || item.raw || ""
    ).trim();
    var texts = textsFromRaw(raw, "");
    return {
      id: String(item.airSigmetId || seq || Math.random()),
      fir: bareArtcc(artcc),
      sequence: seq,
      hazard: normalizeHazard(item.hazard),
      start: item.validTimeFrom != null ? item.validTimeFrom : null,
      end: item.validTimeTo != null ? item.validTimeTo : null,
      issueTime: item.issueTime || item.creationTime || null,
      text: texts.text,
      fullText: texts.fullText,
      source: "airsigmet",
    };
  }

  function fromIsigmet(item, artcc) {
    var fir = String(item.firId || "")
      .trim()
      .toUpperCase();
    var raw = String(item.rawSigmet || item.rawOb || item.raw || "").trim();
    var texts = textsFromRaw(raw, "");
    var q = String(item.qualifier || "").trim();
    var haz = normalizeHazard(item.hazard);
    if (q && haz && haz.indexOf(q.toLowerCase()) < 0)
      haz = normalizeHazard(q + " " + haz);
    return {
      id: String(
        item.isigmetId || item.icaoId || item.seriesId || Math.random()
      ),
      fir: fir || bareArtcc(artcc),
      sequence: String(item.seriesId || "").toUpperCase(),
      hazard: haz,
      start: item.validTimeFrom || null,
      end: item.validTimeTo || null,
      issueTime: item.issueTime || null,
      text: texts.text,
      fullText: texts.fullText,
      source: "isigmet",
    };
  }

  /** FIR ids listed on an international SIGMET (header "KZMA KZHU SIGMET …"). */
  function firsFromIsigmet(item) {
    var out = [];
    function add(s) {
      var b = bareArtcc(s);
      if (b && /^Z[A-Z]{2}$/.test(b) && out.indexOf(b) < 0) out.push(b);
    }
    add(item && item.firId);
    var raw = String(
      (item && (item.rawSigmet || item.rawOb || item.raw)) || ""
    ).toUpperCase();
    raw.split(/\n/).forEach(function (line) {
      if (!/\bSIGMET\b/.test(line)) return;
      var re = /\b(K?Z[A-Z]{2})\b/g;
      var m;
      while ((m = re.exec(line))) add(m[1]);
    });
    return out;
  }

  function isigmetRelevant(item, artcc) {
    if (!item) return false;
    var a = bareArtcc(artcc);
    var firs = firsFromIsigmet(item);
    for (var i = 0; i < firs.length; i++) {
      if (firs[i] === a) return true;
    }
    return geometryTouchesArtcc(artcc, item.coords || []);
  }

  /** NWS 6h lookback still lists previous-hour / superseded products. */
  function nwsIsStaleAgainstAwc(seq, airOk, airIdx, isigOk, isigIdx) {
    if (!seq) return false;
    var airLive = airOk && airIdx && airIdx.list && airIdx.list.length;
    var isigLive = isigOk && isigIdx && isigIdx.list && isigIdx.list.length;
    if (isConvectiveSeq(seq) && airLive && !airIdx.bySeries[seq]) return true;
    if (parseIntlSeries(seq) && isigLive && !isigIdx.bySeries[seq]) return true;
    return false;
  }

  function wrapAwcList(promise) {
    return Promise.resolve(promise)
      .then(function (data) {
        return { ok: true, list: Array.isArray(data) ? data : [] };
      })
      .catch(function () {
        return { ok: false, list: [] };
      });
  }

  /**
   * Fetch currently valid SIGMETs for an ARTCC/FIR (e.g. ZTL or KZTL).
   * @returns {Promise<{artcc:string, entries:Array, error:?string}>}
   */
  function fetchSigmetsForArtcc(artccRaw) {
    var artcc = normalizeArtcc(artccRaw);
    if (!artcc) {
      return Promise.resolve({
        artcc: "",
        entries: [],
        error: "No ARTCC/FIR available for this session.",
      });
    }

    var nwsUrl =
      NWS_SIGMETS + "?start=" + encodeURIComponent(nwsStartIso(6));

    return Promise.all([
      loadArtccBoundaries(),
      fetchJson(nwsUrl, { timeoutMs: 5000 }).catch(function () {
        return { features: [] };
      }),
      // AWC origin can be 10–30s; hub cache / short race, then proceed without it.
      withTimeoutFallback(
        wrapAwcList(
          fetchJsonFlexible(AWC_AIRSIGMET, {
            viaHub: "air",
            tryDirect: false,
          })
        ),
        7000,
        { ok: false, list: [] }
      ),
      withTimeoutFallback(
        wrapAwcList(
          fetchJsonFlexible(AWC_ISIGMET, {
            viaHub: "isig",
            tryDirect: false,
          })
        ),
        7000,
        { ok: false, list: [] }
      ),
    ]).then(function (results) {
      var nws = results[1] || {};
      var airPack = results[2] && results[2].list ? results[2] : { ok: false, list: [] };
      var isigPack = results[3] && results[3].list ? results[3] : { ok: false, list: [] };
      var airIdx = indexAwcBySeries(airPack.list);
      var isigIdx = indexAwcBySeries(isigPack.list);
      var airOk = !!airPack.ok;
      var isigOk = !!isigPack.ok;
      var now = new Date();
      var seen = Object.create(null);
      var entries = [];

      function pushEntry(entry) {
        if (!entry || !isCurrentlyValid(entry, now)) return;
        var key =
          (entry.sequence || entry.id || "") +
          "|" +
          String(entry.start || "") +
          "|" +
          String(entry.end || "");
        if (entry.sequence && seen["seq:" + entry.sequence]) return;
        if (seen[key]) return;
        seen[key] = true;
        if (entry.sequence) seen["seq:" + entry.sequence] = true;
        entries.push(entry);
      }

      // 1) AWC domestic / convective — within 150 NM of staffed ARTCC
      (Array.isArray(airIdx.list) ? airIdx.list : []).forEach(function (item) {
        if (!item) return;
        var coords = item.coords || [];
        if (!geometryTouchesArtcc(artcc, coords)) return;
        pushEntry(fromAirsigmet(item, artcc));
      });

      // 2) AWC international — FIR on the bulletin (not just firId) or 150 NM
      (Array.isArray(isigIdx.list) ? isigIdx.list : []).forEach(function (item) {
        if (!isigmetRelevant(item, artcc)) return;
        pushEntry(fromIsigmet(item, artcc));
      });

      // 3) NWS features — FIR tag or geometry; skip products AWC already replaced
      var nwsFeatures = Array.isArray(nws.features) ? nws.features : [];
      nwsFeatures.forEach(function (f) {
        var props = (f && f.properties) || {};
        var seq = String(props.sequence || "")
          .trim()
          .toUpperCase();
        if (nwsIsStaleAgainstAwc(seq, airOk, airIdx, isigOk, isigIdx)) return;
        var fir = String(props.fir || "")
          .trim()
          .toUpperCase();
        var byFir = firMatches(fir, artcc);
        var byGeom = geometryTouchesArtcc(
          artcc,
          coordsFromNwsGeometry(f && f.geometry)
        );
        if (!byFir && !byGeom) return;
        pushEntry(fromNwsFeature(f, airIdx, isigIdx));
      });

      entries = dropSupersededIntl(entries);

      entries.sort(function (a, b) {
        var ae = parseTime(entryEnd(a));
        var be = parseTime(entryEnd(b));
        if (ae && be) return ae - be;
        return String(a.sequence).localeCompare(String(b.sequence));
      });

      return { artcc: bareArtcc(artcc), entries: entries, error: null };
    });
  }

  function seedArtccPolys(map) {
    artccPolys = map || Object.create(null);
    artccBBox = Object.create(null);
    return artccPolys;
  }

  global.EdstSigmets = {
    normalizeArtcc: normalizeArtcc,
    fetchSigmetsForArtcc: fetchSigmetsForArtcc,
    firstParagraph: firstParagraph,
    textsFromRaw: textsFromRaw,
    normalizeHazard: normalizeHazard,
    // test helpers
    _pointInArtcc: pointInArtcc,
    _loadArtccBoundaries: loadArtccBoundaries,
    _geometryTouchesArtcc: geometryTouchesArtcc,
    _geometryNearArtcc: geometryNearArtcc,
    _fromAirsigmet: fromAirsigmet,
    _fromIsigmet: fromIsigmet,
    _buildTextFromNws: buildTextFromNws,
    _ingestBoundaries: ingestBoundaries,
    _seedArtccPolys: seedArtccPolys,
    _isigmetRelevant: isigmetRelevant,
    _firsFromIsigmet: firsFromIsigmet,
    _dropSupersededIntl: dropSupersededIntl,
    _nwsIsStaleAgainstAwc: nwsIsStaleAgainstAwc,
    _isCurrentlyValid: isCurrentlyValid,
    _SIGMET_PROXIMITY_NM: SIGMET_PROXIMITY_NM,
    _haversineNm: haversineNm,
  };
})(typeof window !== "undefined" ? window : globalThis);
