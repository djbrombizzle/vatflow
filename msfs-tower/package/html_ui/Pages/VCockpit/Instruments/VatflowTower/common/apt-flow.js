/*
 * VATFLOW Tower Cab - the arrival flow of vatflow.io's Airport TMU "APT Dashboard"
 * (vatflow-tbfm v2.html), for the TMU desk's DEMAND vs AAR and Aircraft List screens.
 *
 * A port of that page's computeFlow (ETAs: airborne by distance / groundspeed with the
 * climb blend and the descent pad; on the ground and prefiled by route length / filed TAS
 * + 14 min) and its two-tier metering scheduler (airborne keep their ETA unless the AAR
 * interval or same-gate in-trail needs a delay; ground and prefiled flights slot round
 * them), plus buildDemandBins, the program exclusions, gate colours and the REC WU cell.
 * The page lives inline in its HTML, so this copy follows it line by line; differences:
 * no winds aloft (the page's are optional; still air) and no FCA program columns.
 *
 * Programs (AAR, MIT / trail, gate rules, exclusions) come from the VATFLOW hub
 * (common/vatflow-hub.js) like on the page; with none the page plans against AAR 30.
 */
var VatflowAptFlow = (function () {
  var NO_GATE = "—";
  var GATE_PALETTE = ["#54b8e8", "#57d98a", "#f5a83d", "#c792ea", "#f07178"];
  var DEFAULT_RATE = { aar: 30, trail: 0, mit: 0, gates: [], excludeWake: [], excludeTypes: [], includeTypes: [], jetsOnly: false, unknownInclude: true };
  var CFR_THRESHOLD = 60000;
  var MIT_NOMINAL_KT = 360;
  var DEMAND_BIN_MIN = 15, DEMAND_BIN_COUNT = 8;
  var FALLBACK_AIRCRAFT_REF = {
    A10: "jet", A124: "jet", A19N: "jet", A20N: "jet", A21N: "jet", A306: "jet", A310: "jet", A318: "jet", A319: "jet", A320: "jet", A321: "jet", A332: "jet", A333: "jet", A339: "jet", A343: "jet", A359: "jet", A388: "jet",
    AT43: "turboprop", AT45: "turboprop", AT46: "turboprop", AT72: "turboprop", AT75: "turboprop", AT76: "turboprop",
    B712: "jet", B722: "jet", B732: "jet", B733: "jet", B734: "jet", B735: "jet", B736: "jet", B737: "jet", B738: "jet", B739: "jet",
    B742: "jet", B744: "jet", B748: "jet", B752: "jet", B753: "jet", B762: "jet", B763: "jet", B764: "jet", B772: "jet", B773: "jet", B77L: "jet", B77W: "jet", B788: "jet", B789: "jet", B78X: "jet",
    BE20: "turboprop", BE36: "piston", BE58: "piston", BE99: "turboprop", C152: "piston", C172: "piston", C182: "piston", C208: "turboprop", C25A: "jet", C25B: "jet", C510: "jet", C550: "jet", C56X: "jet", C680: "jet", C700: "jet", C750: "jet",
    CL30: "jet", CL35: "jet", CL60: "jet", CRJ2: "jet", CRJ7: "jet", CRJ9: "jet", CRJX: "jet",
    DA20: "piston", DA40: "piston", DA42: "piston", DC10: "jet", DC93: "jet", DH8A: "turboprop", DH8B: "turboprop", DH8C: "turboprop", DH8D: "turboprop",
    E110: "turboprop", E120: "turboprop", E135: "jet", E145: "jet", E170: "jet", E175: "jet", E190: "jet", E195: "jet", E290: "jet", E295: "jet", E35L: "jet", E50P: "turboprop", E55P: "jet", E75L: "jet", E75S: "jet",
    F16: "jet", F18: "jet", FA7X: "jet", FA8X: "jet", GALX: "jet", GLF4: "jet", GLF5: "jet", GLF6: "jet",
    H25B: "jet", HDJT: "jet", IL76: "jet", LJ35: "jet", LJ45: "jet", LJ60: "jet", MD11: "jet",
    PA28: "piston", PA31: "turboprop", PA34: "piston", PA44: "piston", PA46: "piston", PC12: "turboprop", PC24: "jet",
    RJ85: "jet", SB20: "turboprop", SF34: "turboprop", SF50: "jet", SR22: "piston", TBM9: "turboprop"
  };

  var rad = function (d) { return d * Math.PI / 180; };
  function gcDist(a1, o1, a2, o2) {
    var dA = rad(a2 - a1), dO = rad(o2 - o1);
    var h = Math.pow(Math.sin(dA / 2), 2) + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.pow(Math.sin(dO / 2), 2);
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function parseTAS(ct) {
    if (!ct) return 420;
    var s = String(ct).trim().toUpperCase();
    if (s.charAt(0) === "M") {
      var mach = parseInt(s.slice(1), 10) / 100;
      return isNaN(mach) ? 450 : Math.round(mach * 573);
    }
    var v = parseInt(s.replace(/^N0?/, ""), 10);
    return (isNaN(v) || v < 60) ? 420 : v;
  }
  function parseAlt(a) {
    if (a == null) return 35000;
    var s = String(a).toUpperCase().replace(/[^0-9]/g, "");
    if (!s) return 35000;
    var n = parseInt(s, 10);
    if (n <= 600) n *= 100;
    return n < 1000 ? 35000 : n;
  }
  function gateKey(name) {
    var s = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    var m = s.match(/^([A-Z]{3,5})\d[A-Z]?$/);
    return m ? m[1] : s;
  }
  function arrivalGate(route, arr) {
    if (!route) return NO_GATE;
    var toks = route.toUpperCase().split(/\s+/).map(function (t) { return t.split("/")[0].replace(/[^A-Z0-9]/g, ""); });
    for (var i = toks.length - 1; i >= 0; i--) {
      var t = toks[i];
      if (!t || t === "DCT" || t === arr) continue;
      if (/^[A-Z]{5}$/.test(t)) return t;
      if (/^[A-Z]{3}$/.test(t)) return t;
      if (/^[A-Z]{3,5}\d[A-Z]?$/.test(t)) return gateKey(t);
    }
    return NO_GATE;
  }
  function parseAircraftFromFp(fp) {
    var type = (fp.aircraft_short || fp.aircraft_faa || "ZZZZ").split("/")[0].toUpperCase();
    var wake = ((fp.aircraft || "").split("/")[0] || "").toUpperCase();
    return { type: type, wake: /^[LMHJ]$/.test(wake) ? wake : "" };
  }
  function list(v, re) {
    var arr = Array.isArray(v) ? v : String(v || "").split(/[,\s]+/);
    return arr.map(function (x) { return String(x).trim().toUpperCase(); }).filter(function (x) { return re.test(x); });
  }
  function normGates(g) {
    if (!g) return [];
    var arr = Array.isArray(g) ? g : Object.keys(g).map(function (k) { return g[k]; });
    return arr.filter(function (x) { return x && x.name != null; })
      .map(function (x) { return { name: gateKey(x.name), trail: +x.trail || 0, mit: +x.mit || 0 }; }).slice(0, 10);
  }
  /** A hub program (rates[ICAO]) the way the page normalises it. */
  function normRate(o) {
    return {
      aar: o.aar, trail: +o.trail || 0, mit: +o.mit || 0, gates: normGates(o.gates),
      excludeWake: list(o.excludeWake, /^[LMHJ]$/),
      excludeTypes: list(o.excludeTypes, /^[A-Z0-9]{2,4}$/),
      includeTypes: list(o.includeTypes, /^[A-Z0-9]{2,4}$/),
      jetsOnly: !!o.jetsOnly, unknownInclude: o.unknownInclude !== false
    };
  }
  function isExcludedFromProgram(f, rate) {
    if (!rate || rate === DEFAULT_RATE) return false;
    if (f.wake && rate.excludeWake && rate.excludeWake.indexOf(f.wake) >= 0) return true;
    if (rate.excludeTypes && rate.excludeTypes.length && rate.excludeTypes.indexOf(f.type) >= 0) return true;
    if (rate.includeTypes && rate.includeTypes.length && rate.includeTypes.indexOf(f.type) < 0) return true;
    if (rate.jetsOnly) {
      var eng = FALLBACK_AIRCRAFT_REF[String(f.type || "").toUpperCase()] || null;
      if (eng === "piston") return true;
      if (!eng && f.wake === "L") return true;
      if (!eng && !rate.unknownInclude) return true;
    }
    return false;
  }
  function isMetered(f) { return !f.vfr && !f.excluded; }
  function routeSpacingMs(rate, spacing) {
    var ri = rate.mit > 0 ? (rate.mit / MIT_NOMINAL_KT) * 3600000 : (rate.trail || 0) * 60000;
    return Math.round(Math.max(spacing, ri));
  }
  function gateSpacingFor(rate, spacing, gate) {
    if (gate && gate !== NO_GATE && rate.gates && rate.gates.length) {
      for (var i = 0; i < rate.gates.length; i++) {
        var g = rate.gates[i];
        if (g.name && gateKey(g.name) === gate) return routeSpacingMs({ trail: g.trail || 0, mit: g.mit || 0 }, spacing);
      }
    }
    return routeSpacingMs(rate, spacing);
  }
  function assign(o, extra) { for (var k in extra) o[k] = extra[k]; return o; }

  /**
   * computeFlow({ feed, target, program, edcts, lookup, now }):
   *   feed     the VATSIM data feed (pilots, prefiles)
   *   program  the hub's rates[target] (raw) or null
   *   edcts    the hub's edcts map (manually issued CFRs), or null
   *   lookup   ICAO -> [lat, lon] or null
   * -> { flights, demandHr, allGates, gateColors, arrPt, now, rate, hasProgram }
   */
  function computeFlow(o) {
    var target = o.target, now = o.now || Date.now(), lookup = o.lookup || function () { return null; };
    var hasProgram = !!o.program;
    var rate = hasProgram ? normRate(o.program) : DEFAULT_RATE;
    var issued = {};
    var ed = o.edcts || {};
    for (var k in ed) if (ed[k] && ed[k].cs && ed[k].t != null) issued[ed[k].cs] = ed[k];
    var arrPt = lookup(target);
    var flights = [];
    var feed = o.feed || {};

    function push(base) { base.excluded = hasProgram ? isExcludedFromProgram(base, rate) : false; flights.push(base); }
    function pilotPos(p, dep) {
      var lat = p.latitude, lon = p.longitude, posEst = false;
      if (!isFinite(lat) || !isFinite(lon)) {
        var d = lookup(dep);
        if (d) { lat = d[0]; lon = d[1]; posEst = true; } else { lat = null; lon = null; }
      }
      return { lat: lat, lon: lon, hdg: p.heading || 0, alt: p.altitude || 0, posEst: posEst };
    }
    function enroute(dep, fp, tas) {
      var depPt = lookup(dep), routeNm, est = false;
      if (depPt && arrPt) routeNm = gcDist(depPt[0], depPt[1], arrPt[0], arrPt[1]) * 1.12;
      else { routeNm = 300; est = true; }
      return { routeNm: routeNm, est: est, flightTimeMs: (routeNm / tas) * 3600000 + 14 * 60000 };   // still air
    }

    (feed.pilots || []).forEach(function (p) {
      var fp = p.flight_plan;
      if (!fp || (fp.arrival || "").toUpperCase() !== target) return;
      var tas = parseTAS(fp.cruise_tas);
      var vfr = /^V/i.test(fp.flight_rules || "");
      var gate = vfr ? "VFR" : arrivalGate(fp.route, target);
      var ac = parseAircraftFromFp(fp);
      var dep = (fp.departure || "????").toUpperCase();
      var distToArr = arrPt ? gcDist(p.latitude, p.longitude, arrPt[0], arrPt[1]) : null;
      var airborne = p.groundspeed > 60 && (p.altitude || 0) > 300;
      var arrived = !airborne && p.groundspeed <= 60 && distToArr != null && distToArr < 5;
      var base = { key: p.callsign, callsign: p.callsign, type: ac.type, wake: ac.wake, dep: dep, gate: gate, vfr: vfr };
      if (arrived) {
        push(assign(assign(base, { status: "ARRIVED", dist: distToArr, gs: p.groundspeed, eta: now, sta: now, delay: 0,
          flightTimeMs: null, est: false, arrived: true }), pilotPos(p, dep)));
      } else if (airborne && distToArr != null) {
        var gs = Math.max(p.groundspeed, 120);
        var cruiseAlt = parseAlt(fp.altitude);
        if (cruiseAlt > 6000 && (p.altitude || 0) < cruiseAlt - 2000 && distToArr > 60) gs = Math.max(gs, tas * 0.88);
        var pad = distToArr < 40 ? distToArr * 0.18 : Math.min(12, 6 + distToArr * 0.035);
        var eteMs = (distToArr / gs) * 3600000 + pad * 60000;
        push(assign(assign(base, { status: "AIRBORNE", dist: distToArr, gs: p.groundspeed, eta: now + eteMs, sta: now + eteMs,
          delay: 0, flightTimeMs: null, est: false }), pilotPos(p, dep)));
      } else {
        var e = enroute(dep, fp, tas);
        push(assign(assign(base, { status: "GROUND", dist: e.routeNm, gs: p.groundspeed, eta: now + e.flightTimeMs,
          sta: now + e.flightTimeMs, delay: 0, flightTimeMs: e.flightTimeMs, est: e.est }), pilotPos(p, dep)));
      }
    });

    (feed.prefiles || []).forEach(function (pf) {
      var fp = pf.flight_plan;
      if (!fp || (fp.arrival || "").toUpperCase() !== target) return;
      for (var i = 0; i < flights.length; i++) if (flights[i].callsign === pf.callsign) return;
      var tas = parseTAS(fp.cruise_tas);
      var vfr = /^V/i.test(fp.flight_rules || "");
      var ac = parseAircraftFromFp(fp);
      var dep = (fp.departure || "????").toUpperCase();
      var e = enroute(dep, fp, tas);
      var etd = now + 20 * 60000;
      if (/^\d{4}$/.test(fp.deptime || "")) {
        var d = new Date(now);
        d.setUTCHours(+fp.deptime.slice(0, 2), +fp.deptime.slice(2), 0, 0);
        var t = d.getTime();
        if (t < now - 2 * 3600000) t += 24 * 3600000;
        else if (t - now > 12 * 3600000) t -= 24 * 3600000;
        etd = Math.max(t, now + 20 * 60000);
      }
      var depPt = lookup(dep);
      push({ key: "P-" + pf.callsign, callsign: pf.callsign, type: ac.type, wake: ac.wake, dep: dep,
        gate: vfr ? "VFR" : arrivalGate(fp.route, target), vfr: vfr, status: "PROPOSED", dist: e.routeNm, gs: 0,
        eta: etd + e.flightTimeMs, sta: etd + e.flightTimeMs, delay: 0, flightTimeMs: e.flightTimeMs, est: e.est,
        lat: depPt ? depPt[0] : null, lon: depPt ? depPt[1] : null, hdg: 0, alt: 0, posEst: true });
    });

    // ---- metering: two-tier scheduler (as the page) ----
    var spacing = Math.round((3600 / Math.max(rate.aar, 1)) * 1000);
    var assigned = [];
    var airborneF = flights.filter(function (f) { return f.status === "AIRBORNE" && isMetered(f); }).sort(function (a, b) { return a.eta - b.eta; });
    var groundF = flights.filter(function (f) { return (f.status === "GROUND" || f.status === "PROPOSED") && isMetered(f); }).sort(function (a, b) { return a.eta - b.eta; });
    var prevSta = -Infinity, lastGateSta = {};
    airborneF.forEach(function (f) {
      var sta = Math.max(Math.round(f.eta), prevSta + spacing);
      if (f.gate !== NO_GATE && lastGateSta[f.gate] != null) sta = Math.max(sta, lastGateSta[f.gate] + gateSpacingFor(rate, spacing, f.gate));
      f.sta = sta; f.delay = sta - f.eta; prevSta = sta;
      if (f.gate !== NO_GATE) lastGateSta[f.gate] = sta;
      assigned.push({ t: sta, gate: f.gate });
    });
    var groundIssued = groundF.filter(function (f) { return f.status === "GROUND" && issued[f.callsign]; });
    var groundAuto = groundF.filter(function (f) { return !(f.status === "GROUND" && issued[f.callsign]); });
    groundIssued.forEach(function (f) {
      var rec = issued[f.callsign];
      f.edctIssued = true; f.wheelsUp = rec.t;
      f.sta = Math.round(f.wheelsUp + f.flightTimeMs);
      f.delay = Math.max(0, f.sta - f.eta);
      f.releaseNow = f.wheelsUp <= now + 60000;
      f.needsCfr = true;
      assigned.push({ t: f.sta, gate: f.gate });
    });
    groundAuto.forEach(function (f) {
      var cand = Math.round(f.eta), moved = true;
      while (moved) {
        moved = false;
        for (var i = 0; i < assigned.length; i++) {
          var s = assigned[i];
          var req = (s.gate !== NO_GATE && s.gate === f.gate) ? gateSpacingFor(rate, spacing, f.gate) : spacing;
          if (Math.abs(cand - s.t) < req) {
            var next = s.t + req;
            cand = next <= cand ? cand + 1 : next;
            moved = true;
          }
        }
      }
      f.sta = cand; f.delay = cand - f.eta;
      assigned.push({ t: cand, gate: f.gate });
      if (f.flightTimeMs != null) {
        f.edctIssued = false;
        f.wheelsUp = f.sta - f.flightTimeMs;
        f.needsCfr = f.wheelsUp > now + CFR_THRESHOLD;
        f.releaseNow = f.wheelsUp <= now + 60000;
      }
    });

    flights.sort(function (a, b) { return a.sta - b.sta; });
    flights.forEach(function (f, i) { f.seq = i + 1; });
    var demandHr = flights.filter(function (f) { return f.status !== "ARRIVED" && isMetered(f) && f.eta < now + 3600000; }).length;
    var gates = {};
    flights.forEach(function (f) { if (f.status !== "ARRIVED" && isMetered(f) && f.gate !== NO_GATE) gates[f.gate] = (gates[f.gate] || 0) + 1; });
    var allGates = Object.keys(gates).map(function (g) { return [g, gates[g]]; }).sort(function (a, b) { return b[1] - a[1]; });
    var gateColors = {};
    allGates.forEach(function (e, i) { gateColors[e[0]] = GATE_PALETTE[i % GATE_PALETTE.length]; });
    return { flights: flights, demandHr: demandHr, allGates: allGates, gateColors: gateColors, arrPt: arrPt, now: now,
      rate: rate, hasProgram: hasProgram };
  }

  /** 15-minute ETA bins from now (the page's buildDemandBins). */
  function buildDemandBins(flow, aar, binMin, binCount) {
    var step = binMin || DEMAND_BIN_MIN, n = binCount || DEMAND_BIN_COUNT;
    var counts = [];
    for (var i = 0; i < n; i++) counts.push(0);
    var windowMs = n * step * 60000;
    flow.flights.forEach(function (f) {
      if (f.status === "ARRIVED" || !isMetered(f)) return;
      var dt = f.eta - flow.now;
      if (dt < 0 || dt >= windowMs) return;
      var b = Math.floor(dt / (step * 60000));
      if (b >= 0 && b < n) counts[b]++;
    });
    return { counts: counts, binCap: Math.max(1, Math.round(aar / (60 / step))), binMin: step, binCount: n, aar: aar };
  }

  function fmtZ(ms) {
    if (!ms || !isFinite(ms)) return "----";
    var d = new Date(ms);
    return VatflowFeed.pad(d.getUTCHours(), 2) + VatflowFeed.pad(d.getUTCMinutes(), 2);
  }
  function fmtDelay(ms) { var m = Math.round(ms / 60000); return m <= 0 ? "0" : "+" + m; }
  function delayColor(ms) { return ms > 15 * 60000 ? "#d45c5c" : ms > 5 * 60000 ? "#d4923a" : "#4caf7a"; }
  function statusColor(f) {
    return f.status === "AIRBORNE" ? "#4caf7a" : f.status === "GROUND" ? "#d4923a" : f.status === "PROPOSED" ? "#5ba8c9" : "#5c6b78";
  }

  /** The REC WU (INFO) cell as text + colour (the page's cfrCell without FCA programs). */
  function recWu(f, flow, groundStop) {
    var now = flow.now;
    if (f.status === "ARRIVED") return { t: "Arrived", c: "#5c6b78" };
    if (f.vfr) return { t: "VFR - NO CFR", c: "#5ba8c9" };
    if (f.excluded) return { t: "Excluded - no CFR", c: "#5c6b78" };
    if (f.flightTimeMs == null) return { t: "Airborne", c: "#5c6b78" };
    if (f.status === "PROPOSED") return { t: "Pending - not connected", c: "#5ba8c9" };
    if (groundStop) return { t: "GS - " + groundStop, c: "#d45c5c" };
    if (!flow.hasProgram) return { t: "NO PROGRAM", c: "#5c6b78" };
    if (f.wheelsUp == null) return { t: "-", c: "#5c6b78" };
    if (f.wheelsUp <= now + CFR_THRESHOLD) return { t: "No delay", c: "#4caf7a" };
    return { t: "rec " + fmtZ(f.wheelsUp) + "Z (T-" + Math.max(0, Math.round((f.wheelsUp - now) / 60000)) + "m)", c: "#d4923a" };
  }

  /** A field-wide ground stop for the target from the hub, as "until" text, else null. */
  function groundStopFor(groundStops, target) {
    for (var k in groundStops || {}) {
      var g = groundStops[k];
      if (!g || !g.airport) continue;
      var a = String(g.airport).toUpperCase();
      if ((a === target || "K" + a === target) && !String(g.scope || "").trim()) {
        var u = String(g.until || "?").trim();
        return /z$/i.test(u) ? u.toUpperCase() : u + "Z";
      }
    }
    return null;
  }

  return { computeFlow: computeFlow, buildDemandBins: buildDemandBins, isMetered: isMetered, fmtZ: fmtZ,
    fmtDelay: fmtDelay, delayColor: delayColor, statusColor: statusColor, recWu: recWu, groundStopFor: groundStopFor,
    NO_GATE: NO_GATE, DEMAND_BIN_MIN: DEMAND_BIN_MIN, DEMAND_BIN_COUNT: DEMAND_BIN_COUNT };
})();
