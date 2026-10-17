/*
 * VATFLOW Tower Cab - VATSIM data feed helper shared by the in-cab displays.
 * Plain ES5/ES2015 script (MSFS's Coherent GT browser is older than Chrome),
 * uses XMLHttpRequest, no optional chaining.
 */
var VatflowFeed = (function () {
  var NM_PER_DEG = 60;

  function httpGet(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url + (url.indexOf("?") < 0 ? "?" : "&") + "_=" + Date.now(), true);
    xhr.timeout = 10000;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) cb(null, xhr.responseText);
      else cb(new Error("HTTP " + xhr.status));
    };
    xhr.onerror = function () { cb(new Error("network error")); };
    xhr.ontimeout = function () { cb(new Error("timeout")); };
    xhr.send();
  }

  /** Lat/lon -> x/y in nm from center (x east, y north), flat-earth (fine within ~50 nm). */
  function toNm(center, lat, lon) {
    return {
      x: (lon - center.lon) * NM_PER_DEG * Math.cos(center.lat * Math.PI / 180),
      y: (lat - center.lat) * NM_PER_DEG
    };
  }

  function pad(n, w) {
    var s = String(Math.max(0, Math.round(n)));
    while (s.length < w) s = "0" + s;
    return s;
  }

  /**
   * Reduce a raw feed to what the cab needs.
   * Returns { updated, traffic: [{callsign,lat,lon,x,y,distNm,alt,gs,hdg,type,dep,arr,squawk}],
   *           controllers: [{callsign,freq,name}], atis: {code,text}|null, arrivals, departures }
   */
  function summarize(feed, cfg) {
    var center = cfg.arp;
    var out = { updated: (feed.general && feed.general.update_timestamp) || null,
      traffic: [], controllers: [], atis: null, arrivals: 0, departures: 0 };
    var pilots = feed.pilots || [];
    for (var i = 0; i < pilots.length; i++) {
      var p = pilots[i];
      if (typeof p.latitude !== "number" || typeof p.longitude !== "number") continue;
      var xy = toNm(center, p.latitude, p.longitude);
      var dist = Math.sqrt(xy.x * xy.x + xy.y * xy.y);
      var fp = p.flight_plan || {};
      if (dist <= 50 && fp.arrival === cfg.icao && p.groundspeed > cfg.dbrite.minGroundspeedKt) out.arrivals++;
      if (dist <= 3 && fp.departure === cfg.icao && p.groundspeed < cfg.dbrite.minGroundspeedKt) out.departures++;
      if (dist > cfg.dbrite.rangeNm * 4) continue;       // the DBRITE can zoom out to 4x its range
      out.traffic.push({
        callsign: p.callsign, lat: p.latitude, lon: p.longitude, x: xy.x, y: xy.y, distNm: dist,
        alt: p.altitude, gs: p.groundspeed, hdg: p.heading,
        type: fp.aircraft_short || "", dep: fp.departure || "", arr: fp.arrival || "",
        squawk: p.transponder || ""
      });
    }
    var ctrls = feed.controllers || [];
    for (var j = 0; j < ctrls.length; j++) {
      var c = ctrls[j];
      for (var k = 0; k < cfg.atcPatterns.length; k++) {
        if (cfg.atcPatterns[k].test(c.callsign)) {
          out.controllers.push({ callsign: c.callsign, freq: c.frequency, name: c.name });
          break;
        }
      }
    }
    out.controllers.sort(function (a, b) { return a.callsign < b.callsign ? -1 : 1; });
    var atis = feed.atis || [];
    for (var m = 0; m < atis.length; m++) {
      if (atis[m].callsign === cfg.atisCallsign) {
        out.atis = { code: atis[m].atis_code || "", text: (atis[m].text_atis || []).join(" ") };
      }
    }
    return out;
  }

  /** Polls the feed; calls onData(summary) / onError(err). Returns a stop() function. */
  function poll(cfg, onData, onError) {
    var stopped = false;
    var timer = null;
    function tick() {
      if (stopped) return;
      httpGet(cfg.feedUrl, function (err, text) {
        if (!stopped) {
          if (err) { if (onError) onError(err); }
          else {
            try { onData(summarize(JSON.parse(text), cfg)); }
            catch (e) { if (onError) onError(e); }
          }
          timer = setTimeout(tick, cfg.feedRefreshSec * 1000);
        }
      });
    }
    tick();
    return function () { stopped = true; if (timer) clearTimeout(timer); };
  }

  /** METAR text -> { raw, wind: {dir, kt, gust}|null, windRaw: "19007"|"19007G15"|null, altim: "29.95"|null } */
  function parseMetar(text) {
    var out = { raw: text || "", wind: null, windRaw: null, altim: null };
    var w = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(out.raw);
    if (w) {
      out.wind = { dir: w[1], kt: parseInt(w[2], 10), gust: w[3] ? parseInt(w[3], 10) : null };
      out.windRaw = w[1] + w[2] + (w[3] ? "G" + w[3] : "");
    }
    var a = /\bA(\d{4})\b/.exec(out.raw);
    if (a) out.altim = (parseInt(a[1], 10) / 100).toFixed(2);
    return out;
  }

  /** Polls VATSIM METARs for each ICAO every 5 min; onData({ICAO: parsed}) after each round. */
  function pollMetars(icaos, onData) {
    var latest = {};
    function round() {
      var left = icaos.length;
      icaos.forEach(function (icao) {
        httpGet("https://metar.vatsim.net/metar.php?id=" + icao, function (err, text) {
          if (!err && /\S/.test(text)) latest[icao] = parseMetar(String(text).trim());
          if (--left === 0) { onData(latest); setTimeout(round, 5 * 60 * 1000); }
        });
      });
    }
    round();
  }

  return { httpGet: httpGet, toNm: toNm, pad: pad, summarize: summarize, poll: poll,
    parseMetar: parseMetar, pollMetars: pollMetars };
})();
