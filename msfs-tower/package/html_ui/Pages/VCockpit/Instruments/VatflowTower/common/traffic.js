/*
 * VATFLOW Tower Cab - where the Tower Radar (DBRITE) and Ground Radar (ASDE-X) get their
 * traffic. TRAFFIC on TOWER SETUP (or the VATSIM / SIM tab on either radar) picks it, for
 * every screen at once (VatflowStore "TRAFFIC_SRC"):
 *   VATSIM  the VATSIM data feed, every cfg.feedRefreshSec (positions about every 15 s)
 *   SIM     the aircraft in your sim, once a second: AI traffic, ADS-B / real-traffic
 *           injectors, multiplayer, and VATSIM aircraft as vPilot shows them (smooth).
 *           Callsign, type, route and squawk come from the VATSIM feed when a sim aircraft
 *           sits where a VATSIM pilot is (VATSIM traffic under vPilot), else from the sim
 *           (its ATC id when it has one) or "TFC" + a number.
 * Either way the radars get the same summary as VatflowFeed.summarize (summary.source says
 * which). The ramp maps keep reading VATSIM.
 *
 * Sim traffic: Coherent.call("GET_AIR_TRAFFIC") -> [{uId, name?, lat, lon, alt (m), heading}]
 * (what the sim's own traffic displays use; your own aircraft, the cab, is not in it). The
 * sim only answers it once the page has registered the traffic view listener
 * (RegisterViewListener("JS_LISTENER_TRAFFIC"), as the SDK's TrafficInstrument does);
 * before that the call fails with "GET_AIR_TRAFFIC not bound".
 * Ground speed is worked out from how far each one moved since the last read.
 */
var VatflowTraffic = (function () {
  var SIM_MS = 1000;
  var M_TO_FT = 3.28084;
  var MATCH_NM = 0.6, MATCH_FT = 1500, KEEP_NM = 2;

  // the sim's traffic listener: registered once per page, ready when the sim calls back
  var listener = null, listenerReady = false, listenerAt = 0;
  function trafficListener() {
    if (!listener && typeof RegisterViewListener === "function") {
      try {
        listenerAt = Date.now();
        listener = RegisterViewListener("JS_LISTENER_TRAFFIC", function () { listenerReady = true; });
      } catch (e) { listener = null; }
    }
    // ready when the sim says so (or, if it never calls back, try after 3 s anyway)
    return listenerReady || (listener && Date.now() - listenerAt > 3000);
  }

  /** Short words for the radars' status line (the sim's own errors are long). */
  function shortError(e) {
    var m = String((e && e.message) || e || "");
    if (/not bound/i.test(m)) return new Error("WAITING FOR THE SIM'S TRAFFIC LIST");
    return new Error(m.length > 40 ? m.slice(0, 40) : m);
  }

  function source() {
    var s = typeof VatflowStore !== "undefined" ? VatflowStore.get("TRAFFIC_SRC", "VATSIM") : "VATSIM";
    return s === "SIM" ? "SIM" : "VATSIM";
  }

  function setSource(s) { VatflowStore.set("TRAFFIC_SRC", s === "SIM" ? "SIM" : "VATSIM"); }

  function distNm(lat1, lon1, lat2, lon2) {
    var x = (lon2 - lon1) * 60 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180), y = (lat2 - lat1) * 60;
    return Math.sqrt(x * x + y * y);
  }

  /**
   * The sim's traffic list -> VATSIM-style pilots, so VatflowFeed.summarize can take it.
   * state keeps each sim aircraft's last fix (ground speed) and its VATSIM match (sticky).
   * vatsim: the latest VATSIM pilots (or none).
   */
  function toPilots(list, vatsim, state, nowMs) {
    var out = [], used = {}, pilots = vatsim || [];
    state.seen = state.seen || {};
    var next = {};
    for (var i = 0; i < (list || []).length; i++) {
      var a = list[i];
      if (!a || typeof a.lat !== "number" || typeof a.lon !== "number") continue;
      var id = String(a.uId != null ? a.uId : a.name || i);
      var altFt = (a.alt || 0) * M_TO_FT, prev = state.seen[id], gs = prev ? prev.gs : 0;
      if (prev && nowMs > prev.t) {
        var dt = (nowMs - prev.t) / 3600000, d = distNm(prev.lat, prev.lon, a.lat, a.lon);
        if (dt > 0 && dt < 0.01) gs = prev.gs ? prev.gs * 0.6 + (d / dt) * 0.4 : d / dt;   // smoothed knots
      }
      // the VATSIM pilot it is (kept while it stays close), else the nearest close one
      var match = null;
      if (prev && prev.cs) {
        for (var k = 0; k < pilots.length; k++) {
          if (pilots[k].callsign === prev.cs && distNm(a.lat, a.lon, pilots[k].latitude, pilots[k].longitude) < KEEP_NM) { match = pilots[k]; break; }
        }
      }
      if (!match) {
        var best = MATCH_NM;
        for (var j = 0; j < pilots.length; j++) {
          var p = pilots[j];
          if (used[p.callsign] || typeof p.latitude !== "number") continue;
          var dn = distNm(a.lat, a.lon, p.latitude, p.longitude);
          if (dn < best && Math.abs((p.altitude || 0) - altFt) < MATCH_FT) { best = dn; match = p; }
        }
      }
      if (match) used[match.callsign] = true;
      var name = typeof a.name === "string" ? a.name.replace(/[^A-Z0-9-]/gi, "").toUpperCase() : "";
      var cs = match ? match.callsign : (name || "TFC" + (id.replace(/\D/g, "").slice(-3) || String(i)));
      next[id] = { t: nowMs, lat: a.lat, lon: a.lon, gs: gs, cs: match ? match.callsign : null };
      out.push({
        callsign: cs, latitude: a.lat, longitude: a.lon, altitude: Math.round(altFt),
        groundspeed: Math.round(gs), heading: Math.round(((a.heading || 0) % 360 + 360) % 360),
        transponder: match ? match.transponder : "", flight_plan: match ? match.flight_plan : null
      });
    }
    state.seen = next;
    return out;
  }

  /**
   * Like VatflowFeed.poll, from whichever source TRAFFIC says (it can change while running).
   * Returns stop().
   */
  function poll(cfg, onData, onError) {
    var stopped = false, timer = null, state = {}, vatsim = { pilots: null, at: 0, busy: false, feed: null };
    function vatsimFeed(cb) {
      VatflowFeed.httpGet(cfg.feedUrl, function (err, text) {
        if (err) { cb(err); return; }
        try { cb(null, JSON.parse(text)); } catch (e) { cb(e); }
      });
    }
    var lastFetch = 0, lastSrc = null;
    function tick() {
      if (stopped) return;
      var src = source(), changed = src !== lastSrc, first = lastSrc === null;
      lastSrc = src;
      if (changed && !first) {
        // switching: clear the other source's targets straight away (none until the new one comes)
        onData({ updated: new Date().toISOString(), traffic: [], controllers: [], atis: null, arrivals: 0, departures: 0, source: src });
      }
      if (src === "VATSIM") {
        if (!changed && Date.now() - lastFetch < cfg.feedRefreshSec * 1000) { timer = setTimeout(tick, 1000); return; }
        lastFetch = Date.now();
        vatsimFeed(function (err, feed) {
          if (stopped) return;
          if (err) { if (onError) onError(err); }
          else if (source() === "VATSIM") {
            var s = VatflowFeed.summarize(feed, cfg);
            s.source = "VATSIM";
            onData(s);
          }
          timer = setTimeout(tick, 1000);
        });
        return;
      }
      // SIM: refresh the VATSIM pilots for the tags in the background (every feed period)
      var now = Date.now();
      if (!vatsim.busy && now - vatsim.at > cfg.feedRefreshSec * 1000) {
        vatsim.busy = true;
        vatsimFeed(function (err, feed) {
          vatsim.busy = false;
          vatsim.at = Date.now();
          if (!err) { vatsim.pilots = feed.pilots || []; vatsim.feed = feed; }
        });
      }
      if (typeof Coherent === "undefined" || !Coherent.call) {
        if (onError) onError(new Error("TRAFFIC NOT AVAILABLE OUTSIDE MSFS"));
        timer = setTimeout(tick, 2000);
        return;
      }
      if (!trafficListener()) {
        // the listener is still coming up (or this sim has none): try again shortly
        if (typeof RegisterViewListener !== "function" && onError) onError(new Error("NO TRAFFIC LISTENER IN THIS SIM"));
        else if (onError) onError(new Error("WAITING FOR THE SIM'S TRAFFIC LIST"));
        timer = setTimeout(tick, 500);
        return;
      }
      var done = false;
      function next() { if (!done) { done = true; if (!stopped) timer = setTimeout(tick, SIM_MS); } }
      try {
        Coherent.call("GET_AIR_TRAFFIC").then(function (list) {
          if (stopped) return;
          try {
            var feed = { general: { update_timestamp: new Date().toISOString() },
              pilots: toPilots(list, vatsim.pilots, state, Date.now()),
              controllers: vatsim.feed ? vatsim.feed.controllers : [], atis: vatsim.feed ? vatsim.feed.atis : [] };
            var s = VatflowFeed.summarize(feed, cfg);
            s.source = "SIM";
            onData(s);
          } catch (e) { if (onError) onError(e); }
          next();
        }, function (e) { if (onError) onError(shortError(e || "NO SIM TRAFFIC")); next(); });
      } catch (e) { if (onError) onError(shortError(e)); next(); }
      setTimeout(next, 5000);                 // never stall if the sim doesn't answer
    }
    tick();
    return function () { stopped = true; if (timer) clearTimeout(timer); };
  }

  return { poll: poll, source: source, setSource: setSource, toPilots: toPilots };
})();
