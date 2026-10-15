/*
 * VATFLOW Tower Cab - flight strip bays: the shared model.
 *
 * Three bays (TMU, ground, local by default), each split into sections by up to six
 * separator strips. A departure strip prints into the "new strips" bay / section when a
 * pilot with a flight plan out of this airport is on the ground here; it drops by itself
 * once airborne (AUTO DROP) or when the controller deletes it. Strips are picked up and
 * put down again, between bays too.
 *
 * Everything lives in the sim's storage per airport, so the three bay screens, their
 * signs and the STRIP BAYS screen share it:
 *   STRIPCFG_<ICAO>   bay names, positions (console face + slide) and separators
 *   STRIPS_<ICAO>     the strips and their order
 * After a change the writer bumps L:VATFLOW_STRIPS_REV; the other screens reload.
 */
var VatflowStrips = (function () {
  var MAX_SEPS = 6, BAYS = 3, NM_PER_DEG = 60;
  // console faces (45 degrees apart, counter-clockwise from the front; 4 = stairs, no console)
  var FACES = [0, 1, 2, 3, 5, 6, 7];
  var FACE_NAMES = { 0: "FRONT", 1: "FRONT-LEFT", 2: "LEFT", 3: "BACK-LEFT", 5: "BACK-RIGHT", 6: "RIGHT", 7: "FRONT-RIGHT" };
  var SLIDE_MAX = 1.2;

  function defaults() {
    return {
      bays: [
        { name: "TMU", face: 3, slide: 0.4, seps: ["PROPOSED", "RELEASED"] },
        { name: "GROUND", face: 7, slide: -0.5, seps: ["PROPOSED", "CLEARED", "TAXI"] },
        { name: "LOCAL", face: 0, slide: 0.55, seps: ["HOLD SHORT", "RUNWAY", "DEPARTED"] }
      ],
      newBay: 1, newSec: 0, autoDrop: true
    };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function config(icao) {
    var c = VatflowStore.get("STRIPCFG_" + icao, null);
    return c && c.bays && c.bays.length === BAYS ? c : defaults();
  }

  function emptyState() { return { strips: {}, bays: [[[]], [[]], [[]]], held: null, dismissed: {} }; }

  function state(icao) {
    var s = VatflowStore.get("STRIPS_" + icao, null);
    return s && s.bays ? s : emptyState();
  }

  /** Sections per bay = its separators (one unnamed section when it has none). */
  function normalize(st, cfg) {
    for (var b = 0; b < BAYS; b++) {
      var want = Math.max(1, cfg.bays[b].seps.length), secs = st.bays[b] || [[]];
      while (secs.length < want) secs.push([]);
      while (secs.length > want) { var extra = secs.pop(); secs[secs.length - 1] = secs[secs.length - 1].concat(extra); }
      // drop ids that lost their strip, and duplicates
      var seen = {};
      for (var s = 0; s < secs.length; s++) {
        secs[s] = secs[s].filter(function (id) { if (!st.strips[id] || seen[id]) return false; seen[id] = true; return true; });
      }
      st.bays[b] = secs;
    }
    if (st.held && !st.strips[st.held]) st.held = null;
    return st;
  }

  function rev() {
    if (typeof SimVar === "undefined") return VatflowStore.get("STRIPS_REV", 0);
    return SimVar.GetSimVarValue("L:VATFLOW_STRIPS_REV", "number") || 0;
  }

  function bump() {
    var r = (rev() + 1) % 1000000;
    if (typeof SimVar === "undefined") VatflowStore.set("STRIPS_REV", r);
    else SimVar.SetSimVarValue("L:VATFLOW_STRIPS_REV", "number", r);
    return r;
  }

  function saveConfig(icao, cfg) { VatflowStore.set("STRIPCFG_" + icao, cfg); bump(); }

  /** Read, change, write, in one go (fn(state, cfg) returns false to leave it untouched). */
  function update(icao, fn) {
    var cfg = config(icao), st = normalize(state(icao), cfg);
    if (fn(st, cfg) === false) return st;
    normalize(st, cfg);
    VatflowStore.set("STRIPS_" + icao, st);
    bump();
    return st;
  }

  // ---- strip contents (FAA terminal departure strip) -------------------------------

  function lidOf(icao) { return /^K[A-Z0-9]{3}$/.test(icao || "") ? icao.slice(1) : (icao || ""); }

  /** Requested altitude box: hundreds of feet, VFR plans "VFR" or "VFR/055". */
  function altBox(fp) {
    var a = String(fp.altitude || "").toUpperCase().replace(/^FL/, ""), vfr = fp.flight_rules === "V";
    var n = parseInt(a, 10);
    if (!isNaN(n) && n > 0) {
      var h = n >= 1000 ? Math.round(n / 100) : n;
      var s = (h < 100 ? "0" : "") + (h < 10 ? "0" : "") + h;
      return vfr ? "VFR/" + s : s;
    }
    return vfr ? "VFR" : "";
  }

  function fromPilot(p, now) {
    var fp = p.flight_plan || {};
    var bcn = String(fp.assigned_transponder || "");
    return {
      id: p.callsign, cs: p.callsign,
      type: String(fp.aircraft_faa || fp.aircraft_short || fp.aircraft || "").toUpperCase(),
      cid: String(p.cid || "").slice(-3), rev: fp.revision_id || 0,
      bcn: /^0+$/.test(bcn) ? "" : bcn,
      ptime: fp.deptime ? "P" + String(fp.deptime).slice(0, 4) : "",
      alt: altBox(fp), vfr: fp.flight_rules === "V",
      dep: lidOf(fp.departure), dest: lidOf(fp.arrival),
      route: String(fp.route || "").replace(/\s+/g, " ").trim().toUpperCase(),
      rmk: remarks(fp.remarks),
      seen: now
    };
  }

  /** Remarks box: the free-text part (after RMK/) and a text-only / receive-only voice flag. */
  function remarks(r) {
    r = String(r || "").toUpperCase();
    var voice = /\/T\//.test(r) ? "/T/ " : /\/R\//.test(r) ? "/R/ " : "";
    var m = /(?:^|\s)RMK\/(.*)$/.exec(r), text = m ? m[1] : (/^[A-Z]+\/\S/.test(r) ? "" : r);
    text = text.replace(/\/[VTR]\//g, " ").replace(/\bSIMBRIEF\b/g, " ").replace(/\s+/g, " ").trim();
    return (voice + text).trim();
  }

  function distNm(a, lat, lon) {
    var x = (lon - a.lon) * NM_PER_DEG * Math.cos(a.lat * Math.PI / 180), y = (lat - a.lat) * NM_PER_DEG;
    return Math.sqrt(x * x + y * y);
  }

  /**
   * Feed -> strips. site: {icao, arp, elevFt}. New departures on the ground here print into
   * the "new strips" bay / section; airborne or long-gone ones drop (AUTO DROP).
   * Returns true when something changed.
   */
  function ingest(st, cfg, pilots, site, now) {
    var changed = false, here = {};
    for (var i = 0; i < (pilots || []).length; i++) {
      var p = pilots[i], fp = p.flight_plan;
      if (!fp || String(fp.departure || "").toUpperCase() !== site.icao) continue;
      var d = distNm(site.arp, p.latitude, p.longitude), agl = (p.altitude || 0) - (site.elevFt || 0);
      var onGround = d < 5 && agl < 300 && (p.groundspeed || 0) < 60;
      var airborne = agl > 800 || d > 6;
      var cur = st.strips[p.callsign];
      here[p.callsign] = true;
      if (cur) {
        var fresh = fromPilot(p, now);
        if (airborne && cfg.autoDrop) { remove(st, p.callsign, false); changed = true; continue; }
        fresh.cocked = cur.cocked;
        fresh.printed = cur.printed;
        fresh.amended = cur.amended || fresh.rev !== cur.rev;
        if (JSON.stringify(cleanForCompare(fresh)) !== JSON.stringify(cleanForCompare(cur))) changed = true;
        st.strips[p.callsign] = fresh;
        continue;
      }
      if (!onGround) continue;
      var rv = fp.revision_id || 0;
      if (st.dismissed[p.callsign] === rv) continue;           // deleted by the controller (this revision)
      var s = fromPilot(p, now);
      s.printed = now;
      st.strips[p.callsign] = s;
      var b = Math.min(BAYS - 1, Math.max(0, cfg.newBay)), sec = st.bays[b] || (st.bays[b] = [[]]);
      var k = Math.min(sec.length - 1, Math.max(0, cfg.newSec));
      sec[k].push(p.callsign);
      changed = true;
    }
    // gone from the network: drop after 3 minutes
    for (var cs in st.strips) {
      if (!here[cs] && cfg.autoDrop && now - (st.strips[cs].seen || 0) > 180000) { remove(st, cs, false); changed = true; }
    }
    return changed;
  }

  function cleanForCompare(s) { var c = clone(s); delete c.seen; return c; }

  function where(st, id) {
    for (var b = 0; b < st.bays.length; b++) {
      for (var s = 0; s < st.bays[b].length; s++) {
        var i = st.bays[b][s].indexOf(id);
        if (i >= 0) return { bay: b, sec: s, idx: i };
      }
    }
    return null;
  }

  function take(st, id) {
    var w = where(st, id);
    if (w) st.bays[w.bay][w.sec].splice(w.idx, 1);
    return w;
  }

  /** Deleted by the controller (dismiss: it doesn't print again until its plan is amended). */
  function remove(st, id, dismiss) {
    take(st, id);
    if (dismiss && st.strips[id]) st.dismissed[id] = st.strips[id].rev;
    delete st.strips[id];
    if (st.held === id) st.held = null;
  }

  /** Puts strip id at bay b, section sec, before position idx (-1 = at the end). */
  function place(st, id, b, sec, idx) {
    var from = take(st, id);
    var list = st.bays[b][sec];
    if (from && from.bay === b && from.sec === sec && idx > from.idx) idx--;   // its own slot moved up
    if (idx < 0 || idx > list.length) idx = list.length;
    list.splice(idx, 0, id);
  }

  function cock(st, id) { if (st.strips[id]) st.strips[id].cocked = !st.strips[id].cocked; }

  /** L: var values that put bay n (0..2) where its config says. */
  function poseVars(bayCfg) {
    var slide = Math.max(-SLIDE_MAX, Math.min(SLIDE_MAX, bayCfg.slide || 0));
    return { deg: (45 * (bayCfg.face || 0)) % 360, slide: Math.round(130 + slide * 100) };
  }

  function applyPose(n, bayCfg) {
    if (typeof SimVar === "undefined") return;
    var v = poseVars(bayCfg);
    SimVar.SetSimVarValue("L:VATFLOW_BAY_" + (n + 1) + "_DEG", "number", v.deg);
    SimVar.SetSimVarValue("L:VATFLOW_BAY_" + (n + 1) + "_SLIDE", "number", v.slide);
  }

  return {
    MAX_SEPS: MAX_SEPS, BAYS: BAYS, FACES: FACES, FACE_NAMES: FACE_NAMES, SLIDE_MAX: SLIDE_MAX,
    defaults: defaults, config: config, saveConfig: saveConfig, state: state, emptyState: emptyState,
    normalize: normalize, update: update, rev: rev, bump: bump, ingest: ingest, fromPilot: fromPilot, altBox: altBox,
    remarks: remarks, where: where, place: place, remove: remove, cock: cock, poseVars: poseVars, applyPose: applyPose
  };
})();
