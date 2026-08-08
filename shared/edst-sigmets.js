/**
 * EDST SIG — SIGMETs for the controller's FIR/ARTCC.
 *
 * Sources:
 *   1. AWC airsigmet (US convective / domestic) — scoped by polygon vs ARTCC boundary
 *      (NWS FIR tags often omit KZJX etc.; convective products are issued by KKCI)
 *   2. NWS Aviation SIGMET GeoJSON — FIR-tagged international / legacy rows
 *   3. AWC isigmet — international SIGMETs filtered by firId
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

  /** ARTCC id (ZJX) -> rings of [lon, lat] */
  var artccPolys = null;
  var artccLoad = null;

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

  function ingestBoundaries(geo) {
    var map = Object.create(null);
    (geo && geo.features ? geo.features : []).forEach(function (f) {
      var p = (f && f.properties) || {};
      var id = String(p.id || p.ID || p.prefix || "")
        .toUpperCase()
        .replace(/^K(?=Z)/, "");
      if (!id || !f.geometry) return;
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

  /** True when SIGMET geometry touches the ARTCC (vertex or centroid inside). */
  function geometryTouchesArtcc(artcc, coords) {
    if (!coords || !coords.length) return false;
    var sumLat = 0,
      sumLon = 0,
      n = 0;
    for (var i = 0; i < coords.length; i++) {
      var c = coords[i];
      var lat = c.lat != null ? +c.lat : c[1] != null ? +c[1] : null;
      var lon = c.lon != null ? +c.lon : c[0] != null ? +c[0] : null;
      if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon))
        continue;
      if (pointInArtcc(artcc, lat, lon) === true) return true;
      sumLat += lat;
      sumLon += lon;
      n++;
    }
    if (n > 0 && pointInArtcc(artcc, sumLat / n, sumLon / n) === true)
      return true;
    return false;
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
      var haz = String(hazard)
        .replace(/^https?:\/\/[^ ]+\//, "")
        .replace(/_/g, " ")
        .toUpperCase();
      lines.push("HAZARD: " + haz);
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
    var hazard = String(
      props.hazard ||
        props.phenomenon ||
        (awcHit && awcHit.hazard) ||
        ""
    ).toLowerCase();
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
      hazard: String(item.hazard || "").toLowerCase(),
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
    if (!firMatches(fir, artcc)) return null;
    var raw = String(item.rawSigmet || item.rawOb || "").trim();
    var texts = textsFromRaw(raw, "");
    return {
      id: String(
        item.isigmetId || item.icaoId || item.seriesId || Math.random()
      ),
      fir: fir,
      sequence: String(item.seriesId || "").toUpperCase(),
      hazard: String(item.hazard || "").toLowerCase(),
      start: item.validTimeFrom || null,
      end: item.validTimeTo || null,
      issueTime: item.issueTime || null,
      text: texts.text,
      fullText: texts.fullText,
      source: "isigmet",
    };
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
        fetchJsonFlexible(AWC_AIRSIGMET, {
          viaHub: "air",
          tryDirect: false,
        }),
        7000,
        []
      ),
      withTimeoutFallback(
        fetchJsonFlexible(AWC_ISIGMET, {
          viaHub: "isig",
          tryDirect: false,
        }),
        7000,
        []
      ),
    ]).then(function (results) {
      var nws = results[1] || {};
      var airIdx = indexAwcBySeries(results[2]);
      var isigIdx = indexAwcBySeries(results[3]);
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

      // 1) AWC domestic / convective — geometry vs staffed ARTCC
      (Array.isArray(airIdx.list) ? airIdx.list : []).forEach(function (item) {
        if (!item) return;
        var coords = item.coords || [];
        if (!geometryTouchesArtcc(artcc, coords)) return;
        pushEntry(fromAirsigmet(item, artcc));
      });

      // 2) NWS features — FIR tag match OR geometry touches ARTCC
      var nwsFeatures = Array.isArray(nws.features) ? nws.features : [];
      nwsFeatures.forEach(function (f) {
        var props = (f && f.properties) || {};
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

      // 3) International SIGMETs for this FIR
      (Array.isArray(isigIdx.list) ? isigIdx.list : []).forEach(function (item) {
        pushEntry(fromIsigmet(item, artcc));
      });

      entries.sort(function (a, b) {
        var ae = parseTime(entryEnd(a));
        var be = parseTime(entryEnd(b));
        if (ae && be) return ae - be;
        return String(a.sequence).localeCompare(String(b.sequence));
      });

      return { artcc: bareArtcc(artcc), entries: entries, error: null };
    });
  }

  global.EdstSigmets = {
    normalizeArtcc: normalizeArtcc,
    fetchSigmetsForArtcc: fetchSigmetsForArtcc,
    firstParagraph: firstParagraph,
    textsFromRaw: textsFromRaw,
    // test helpers
    _pointInArtcc: pointInArtcc,
    _loadArtccBoundaries: loadArtccBoundaries,
    _geometryTouchesArtcc: geometryTouchesArtcc,
    _fromAirsigmet: fromAirsigmet,
    _fromIsigmet: fromIsigmet,
    _buildTextFromNws: buildTextFromNws,
  };
})(typeof window !== "undefined" ? window : globalThis);
