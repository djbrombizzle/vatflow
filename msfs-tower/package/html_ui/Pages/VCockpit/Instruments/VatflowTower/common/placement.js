/*
 * VATFLOW Tower Cab - puts the cab in the tower from inside the sim (no Python tool).
 *
 * place(pos): moves the aircraft to pos {lat, lon, floorFtMsl, headingTrue} and freezes it
 * there (position, height, attitude), turns the engine off and the ceiling lights on.
 * Two ways to move it, tried in order:
 *   direct  sets PLANE LATITUDE / LONGITUDE / ALTITUDE / HEADING (if the sim lets
 *           instrument pages set them; checked by reading the position back)
 *   slew    slew mode, steered onto the spot by the slew axes (always allowed)
 * L:VATFLOW_PLACED: 0 not yet (new flight), 1 in the tower, 2 released by you.
 * L:VATFLOW_PLACE_METHOD: 1 direct, 2 slew (shown on the SETUP screen).
 */
var VatflowPlace = (function () {
  var M_PER_DEG = 111320;
  var FREEZE = ["K:FREEZE_LATITUDE_LONGITUDE_SET", "K:FREEZE_ALTITUDE_SET", "K:FREEZE_ATTITUDE_SET"];
  var job = null;        // the move in progress
  var listeners = [];

  function sim() { return typeof SimVar !== "undefined"; }
  function setK(ev, v) { try { SimVar.SetSimVarValue(ev, "number", v); } catch (e) { /* keep going */ } }
  function getL(name) { return sim() ? SimVar.GetSimVarValue("L:" + name, "number") || 0 : 0; }
  function setL(name, v) { if (sim()) SimVar.SetSimVarValue("L:" + name, "number", v); }

  /** pos moved relative to its own heading (flat earth, fine for meters). */
  function move(pos, fwdM, rightM, upFt, turnDeg) {
    var h = pos.headingTrue * Math.PI / 180;
    var north = (fwdM || 0) * Math.cos(h) - (rightM || 0) * Math.sin(h);
    var east = (fwdM || 0) * Math.sin(h) + (rightM || 0) * Math.cos(h);
    return {
      lat: round(pos.lat + north / M_PER_DEG, 8),
      lon: round(pos.lon + east / (M_PER_DEG * Math.cos(pos.lat * Math.PI / 180)), 8),
      floorFtMsl: round(pos.floorFtMsl + (upFt || 0), 1),
      headingTrue: round((((pos.headingTrue + (turnDeg || 0)) % 360) + 360) % 360, 1)
    };
  }

  function round(v, n) { var k = Math.pow(10, n); return Math.round(v * k) / k; }

  /** Error from where the cab is to pos: meters ahead / right (in the cab's own frame), feet up, degrees right. */
  function error(cur, pos) {
    var k = Math.cos(cur.lat * Math.PI / 180);
    var north = (pos.lat - cur.lat) * M_PER_DEG, east = (pos.lon - cur.lon) * M_PER_DEG * k;
    var h = cur.headingTrue * Math.PI / 180;
    return {
      fwd: north * Math.cos(h) + east * Math.sin(h),
      right: -north * Math.sin(h) + east * Math.cos(h),
      up: pos.floorFtMsl - cur.floorFtMsl,
      turn: ((pos.headingTrue - cur.headingTrue) % 360 + 540) % 360 - 180,
      distM: Math.sqrt(north * north + east * east)
    };
  }

  function here() {
    if (!sim()) return null;
    return {
      lat: SimVar.GetSimVarValue("PLANE LATITUDE", "degrees"),
      lon: SimVar.GetSimVarValue("PLANE LONGITUDE", "degrees"),
      floorFtMsl: SimVar.GetSimVarValue("PLANE ALTITUDE", "feet"),
      headingTrue: SimVar.GetSimVarValue("PLANE HEADING DEGREES TRUE", "degrees")
    };
  }

  /**
   * True while the flight is really running: the sim clock moves and the camera is a flight
   * camera (cockpit / external / drone ...), not the loading screen or a menu. Placing the
   * cab during loading (when the sim doesn't answer yet) could send it off at slew speed.
   */
  var clock = { t: null, at: 0, live: false };
  function live() {
    if (!sim()) return false;
    var t = SimVar.GetSimVarValue("E:SIMULATION TIME", "seconds"), cam = SimVar.GetSimVarValue("CAMERA STATE", "number");
    var now = Date.now();
    if (clock.t === null || now - clock.at >= 900) {
      clock.live = clock.t !== null && typeof t === "number" && t > clock.t;
      clock.t = t;
      clock.at = now;
    }
    var camOk = !cam || (cam >= 2 && cam <= 6);
    return clock.live && camOk;
  }

  function freeze(on) { for (var i = 0; i < FREEZE.length; i++) setK(FREEZE[i], on ? 1 : 0); }
  function frozen() { return sim() && !!SimVar.GetSimVarValue("IS LATITUDE LONGITUDE FREEZE ON", "bool"); }

  function cabinReady() {
    setK("K:ENGINE_AUTO_SHUTDOWN", 0);
    setK("K:MIXTURE_SET", 0);
    setK("K:CABIN_LIGHTS_SET", 1);
    setK("K:CABIN_LIGHTS_ON", 1);
    setK("K:PARKING_BRAKE_SET", 1);
  }

  function setDirect(pos) {
    try {
      SimVar.SetSimVarValue("A:PLANE LATITUDE", "degrees", pos.lat);
      SimVar.SetSimVarValue("A:PLANE LONGITUDE", "degrees", pos.lon);
      SimVar.SetSimVarValue("A:PLANE ALTITUDE", "feet", pos.floorFtMsl);
      SimVar.SetSimVarValue("A:PLANE HEADING DEGREES TRUE", "degrees", pos.headingTrue);
      SimVar.SetSimVarValue("A:PLANE PITCH DEGREES", "degrees", 0);
      SimVar.SetSimVarValue("A:PLANE BANK DEGREES", "degrees", 0);
    } catch (e) { /* not allowed: slew does it */ }
  }

  function close(cur, pos, tolM, tolFt, tolDeg) {
    var e = error(cur, pos);
    return e.distM <= tolM && Math.abs(e.up) <= tolFt && Math.abs(e.turn) <= tolDeg;
  }

  function notify(state, msg) {
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](state, msg); } catch (e) { /* ignore */ } }
  }

  function done(method) {
    freeze(true);
    cabinReady();
    setL("VATFLOW_PLACED", 1);
    setL("VATFLOW_PLACE_METHOD", method === "direct" ? 1 : 2);
    job = null;
    notify("placed", method === "direct" ? "IN THE TOWER (MOVED DIRECTLY)" : "IN THE TOWER (MOVED BY SLEW)");
  }

  /**
   * Moves the cab to pos and freezes it. small: a nudge (a few meters) - same methods,
   * tighter tolerances. Progress / result go to onState listeners.
   */
  function place(pos, small) {
    if (!sim()) { notify("error", "ONLY IN THE SIM"); return; }
    stop();
    var me = job = { pos: pos, t0: Date.now() };
    if (!live()) {                                  // still loading or paused: wait for the flight
      notify("moving", "WAITING FOR THE FLIGHT TO START...");
      (function wait() {
        if (job !== me) return;
        if (!live()) { setTimeout(wait, 1000); return; }
        job = null;
        place(pos, small);
      })();
      return;
    }
    var method = getL("VATFLOW_PLACE_METHOD");     // remembered for this flight once known
    notify("moving", "MOVING...");
    if (method === 2) { slew(me); return; }
    freeze(true);
    var n = 0;
    (function push() {
      if (job !== me) return;
      setDirect(pos);
      if (++n < 6) { setTimeout(push, 150); return; }
      setTimeout(function () {
        if (job !== me) return;
        var cur = here();
        if (cur && close(cur, pos, 3, 5, 1)) done("direct");
        else slew(me);
      }, 800);
    })();
  }

  /**
   * Slew mode steering: each axis is calibrated first (which sign moves which way), then
   * driven in proportion to the remaining error until the cab is on the spot.
   */
  function slew(me) {
    freeze(false);
    setK("K:SLEW_ON", 1);
    var axes = {
      fwd: { ev: "K:AXIS_SLEW_AHEAD_SET", sign: -1, tol: 0.4 },
      right: { ev: "K:AXIS_SLEW_SIDEWAYS_SET", sign: 1, tol: 0.4 },
      up: { ev: "K:AXIS_SLEW_ALT_SET", sign: -1, tol: 0.8 },
      turn: { ev: "K:AXIS_SLEW_HEADING_SET", sign: 1, tol: 0.3 }
    };
    var names = ["fwd", "right", "up", "turn"], cal = 0, calStart = null, still = 0, start = null;
    notify("moving", "MOVING BY SLEW...");
    function allZero() { for (var i = 0; i < names.length; i++) setK(axes[names[i]].ev, 0); }
    function abort(msg) {                           // stop where it is, frozen, and say why
      allZero();
      setK("K:SLEW_OFF", 1);
      freeze(true);
      job = null;
      notify("error", msg);
    }
    (function step() {
      if (job !== me) { allZero(); return; }
      var cur = here();
      if (!cur) { setTimeout(step, 100); return; }
      if (!live()) { allZero(); calStart = null; setTimeout(step, 500); return; }   // paused: hold still
      var e = error(cur, me.pos);
      if (!start) start = { d: e.distM, up: Math.abs(e.up) };
      // safety: never let it run away (wrong direction, or the sim doing something else)
      if (e.distM > start.d + 300 || Math.abs(e.up) > start.up + 500) {
        abort("STOPPED: THE CAB WAS MOVING AWAY FROM THE SPOT. PRESS PLACE IN TOWER TO TRY AGAIN");
        return;
      }
      // calibrate one axis at a time: push it gently, see which way the error moved
      if (cal < names.length) {
        var ax = axes[names[cal]];
        if (!calStart) { calStart = { e: e, t: Date.now() }; setK(ax.ev, ax.sign * 6000); }
        else if (Date.now() - calStart.t > 700) {
          var moved = e[names[cal]] - calStart.e[names[cal]];
          // the error shrinks when the cab moves toward the spot: positive command must reduce a positive error
          if (Math.abs(moved) > 0.01) ax.sign = moved < 0 ? ax.sign : -ax.sign;
          else still++;
          setK(ax.ev, 0);
          cal++;
          calStart = null;
          if (cal === names.length && still === names.length) {
            abort("SLEW DID NOT MOVE THE CAB. USE THE PLACEMENT TOOL (placement\\3-place) OR TRY AGAIN");
            return;
          }
        }
        setTimeout(step, 50);
        return;
      }
      var all = true;
      for (var i = 0; i < names.length; i++) {
        var a = axes[names[i]], v = e[names[i]];
        if (Math.abs(v) <= a.tol) { setK(a.ev, 0); continue; }
        all = false;
        var gain = names[i] === "turn" ? 600 : names[i] === "up" ? 120 : 200;
        var cmd = Math.max(-16383, Math.min(16383, v * gain));
        if (Math.abs(cmd) < 1500) cmd = cmd < 0 ? -1500 : 1500;
        setK(a.ev, a.sign * cmd);
      }
      if (all || Date.now() - me.t0 > 180000) {
        allZero();
        setK("K:SLEW_OFF", 1);
        setTimeout(function () { if (job === me) done("slew"); }, 300);
        return;
      }
      setTimeout(step, 100);
    })();
  }

  function stop() {
    if (job) job = null;
  }

  function release() {
    stop();
    freeze(false);
    setL("VATFLOW_PLACED", 2);
    notify("released", "RELEASED - THE CAB CAN MOVE");
  }

  /**
   * Where the cab should go at airport icao: {pos, src, kind} with kind
   * "saved" | "list" | "osm" | "centre". site: VatflowSite.current(); data: its loadData().
   */
  function target(icao, site, data) {
    var saved = typeof VatflowStore !== "undefined" ? VatflowStore.get("TOWER_" + icao, null) : null;
    if (saved && saved.lat) return { pos: saved, src: "YOUR SAVED SPOT" + (saved.savedAt ? " (" + saved.savedAt + ")" : ""), kind: "saved" };
    var list = typeof VATFLOW_TOWERS !== "undefined" ? VATFLOW_TOWERS[icao] : null;
    if (list) return { pos: list, src: (list.src || "TOWER LIST").toUpperCase(), kind: "list" };
    var t = data && data.tower;
    if (t) return { pos: { lat: t.lat, lon: t.lon, floorFtMsl: t.floorFtMsl, headingTrue: t.headingTrue }, src: String(t.src || "OPENSTREETMAP").toUpperCase(), kind: "osm" };
    if (site && site.arp && site.arp.lat) {
      return { pos: { lat: site.arp.lat, lon: site.arp.lon, floorFtMsl: (site.elevFt || 0) + 100, headingTrue: 0 },
        src: "AIRPORT CENTRE - NO TOWER KNOWN, MOVE IT ONTO THE TOWER", kind: "centre" };
    }
    return null;
  }

  function save(icao, pos) {
    var d = new Date();
    var p = { lat: round(pos.lat, 8), lon: round(pos.lon, 8), floorFtMsl: round(pos.floorFtMsl, 1),
      headingTrue: round(pos.headingTrue, 1), savedAt: d.getUTCDate() + " " + ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getUTCMonth()] };
    VatflowStore.set("TOWER_" + icao, p);
    return p;
  }

  function forget(icao) { VatflowStore.set("TOWER_" + icao, null); }

  /**
   * When a flight starts at an airport with a known tower spot (saved, tower list or
   * OpenStreetMap) and AUTO PLACE is on: goes there by itself after a few seconds.
   * Run by one always-present screen (TWR INFO).
   */
  function autoPlace() {
    if (!sim()) return;
    var t0 = Date.now();
    VatflowSite.resolve(function (site) {
      VatflowSite.loadData(function (data) {
        var since = 0;
        (function check() {
          // the flight has to have been running for a few seconds (not the loading screen)
          if (!live()) since = 0;
          else if (!since) since = Date.now();
          if (Date.now() - t0 < 6000 || !since || Date.now() - since < 8000) { setTimeout(check, 1000); return; }
          if (getL("VATFLOW_PLACED") !== 0 || job) return;
          if (typeof VatflowStore !== "undefined" && VatflowStore.get("AUTO_PLACE", true) === false) return;
          var t = target(site.icao, site, data);
          if (t && t.kind !== "centre") place(t.pos);
        })();
      });
    });
  }

  function onState(fn) { listeners.push(fn); }
  function busy() { return !!job; }
  function state() { return getL("VATFLOW_PLACED"); }
  function method() { return getL("VATFLOW_PLACE_METHOD"); }

  return {
    move: move, error: error, place: place, release: release, target: target, save: save, forget: forget,
    here: here, frozen: frozen, live: live, onState: onState, autoPlace: autoPlace, busy: busy, state: state, method: method, stop: stop
  };
})();
