/**
 * Ramp Management demo mode: scripted traffic for the selected airport that
 * runs in the browser, with no hub and no network. The fleet comes from the
 * airport file (data/ramp/<ICAO>.json "demo"), so each airport brings its own.
 *
 * It produces VATSIM-feed-shaped pilots, so the page derives states exactly as
 * it does from the live feed, and it keeps the shared state with the same
 * applyOp() reducer the hub mirrors. Telex "sends" go to the flight's message
 * log only. Simulated pilots answer: inbounds ask for a stand, parked
 * departures call for push, and an approved push actually pushes and taxis out.
 */
import {
  applyOp, emptyState, entrySpotFor, findLane, operatorFor, projectOnPolyline, chartHeading, queueOrder, PUSH,
} from "./ramp-core.js";

const TICK_MS = 1000;
/** Chart pixels per second (~1.7 m/px): push ~3 kt, taxi ~20 kt (sped up). */
const PUSH_PX = 2.5;
const TAXI_PX = 12;
/** Airborne time runs this much faster than real so arrivals land in minutes. */
const AIR_ACCEL = 8;

function lanePath(L, stand) {
  const spot = entrySpotFor(L, stand);
  const lane = findLane(L, stand.chart, stand.pushTo);
  if (!spot || !lane) return null;
  const a = projectOnPolyline(lane.pts, stand.x, stand.y);
  const b = projectOnPolyline(lane.pts, spot.x, spot.y);
  // Walk the lane polyline between the two projections.
  const pts = [[a.x, a.y]];
  if (a.seg < b.seg) for (let i = a.seg + 1; i <= b.seg; i++) pts.push(lane.pts[i]);
  else if (a.seg > b.seg) for (let i = a.seg; i > b.seg; i--) pts.push(lane.pts[i]);
  pts.push([b.x, b.y], [spot.x, spot.y]);
  return { spot, pts };
}

/** Advance along a polyline by `px`. Mutates ac.path; returns true when done. */
function advance(ac, px) {
  while (px > 0 && ac.path.length) {
    const [tx, ty] = ac.path[0];
    const d = Math.hypot(tx - ac.x, ty - ac.y);
    if (d > 0.01) ac.moveHdg = chartHeading(ac.x, ac.y, tx, ty);
    if (d <= px) {
      ac.x = tx;
      ac.y = ty;
      px -= d;
      ac.path.shift();
    } else {
      ac.x += ((tx - ac.x) * px) / d;
      ac.y += ((ty - ac.y) * px) / d;
      px = 0;
    }
  }
  return ac.path.length === 0;
}

export function createDemoStore(L) {
  const FLEET = (L.demo && L.demo.fleet) || [];
  /** Simulated pilots whose ACARS client is not on Hoppie, to show the ping check. */
  const NOT_ON_HOPPIE = new Set(FLEET.filter(f => f.offHoppie).map(f => f.cs));
  /** Where an inbound with no stand yet waits after landing, by operator group. */
  const HOLD_SPOT = (L.demo && L.demo.holdSpots) || {};
  const FALLBACK_SPOT = (L.callSpots[0] || {}).id;
  const ME = `${L.icao}_RMP`;
  const state = emptyState(L.icao);
  const planes = new Map();
  const listeners = new Set();
  const t0 = Date.now();
  let timer = null;
  let nextCallAt = t0 + 40000;

  function seed() {
    for (const f of FLEET) {
      const ac = { ...f, phase: "parked", x: 0, y: 0, chart: null, gs: 0, moveHdg: 0, path: [], air: null };
      if (f.stand) {
        const s = L.standById.get(f.stand);
        Object.assign(ac, { chart: s.chart, x: s.x, y: s.y, moveHdg: s.noseHdg || 0 });
        if (f.dep === L.icao) applyOp(state, { op: "assign", callsign: f.cs, stand: f.stand }, "DEMO", t0);
        if (f.push) {
          applyOp(state, { op: "push", callsign: f.cs, push: PUSH.REQ }, "TELEX", t0 - f.callAgo * 1000);
          applyOp(state, { op: "msg", callsign: f.cs, dir: "dn", text: "REQ PUSH" }, "TELEX", t0 - f.callAgo * 1000);
          if (f.push === PUSH.HELD) applyOp(state, { op: "push", callsign: f.cs, push: PUSH.HELD }, "DEMO", t0 - 60000);
        }
      } else {
        ac.phase = "air";
        ac.air = { dist: f.distNm, brg: f.brg, gs: f.distNm > 30 ? 280 : f.distNm > 10 ? 190 : 140 };
        if (f.assigned) applyOp(state, { op: "assign", callsign: f.cs, stand: f.assigned }, "DEMO", t0);
      }
      planes.set(f.cs, ac);
    }
    state.log = [];
    addLog(`Demo started: ${L.icao}, ${FLEET.length} aircraft`);
  }

  /** The hub's automatic answer to a push request (vUSAlink-hub ramp.py push_reply_text). */
  function autoAck(cs, t) {
    const pos = queueOrder(state).indexOf(cs) + 1;
    if (!pos) return;
    const hold = state.settings.holdAll || state.flights[cs].push === PUSH.HELD;
    applyOp(state, { op: "msg", callsign: cs, dir: "up",
      text: `${L.icao} RAMP: PUSH REQUEST RECEIVED, NUMBER ${pos}.${hold ? " EXPECT DELAY." : ""} MONITOR THE APPROPRIATE RAMP FREQUENCY FOR PUSH CLEARANCE.` }, "AUTO", t);
  }

  function addLog(text) {
    state.logSeq += 1;
    state.log.push({ id: state.logSeq, t: Date.now(), by: "DEMO", text });
  }

  function pilotSays(cs, text, delayMs = 2500) {
    setTimeout(() => {
      if (!planes.has(cs)) return;
      applyOp(state, { op: "msg", callsign: cs, dir: "dn", text }, "TELEX", Date.now());
      emit();
    }, delayMs);
  }

  function tick() {
    const now = Date.now();
    const dt = TICK_MS / 1000;
    for (const ac of [...planes.values()]) {
      const e = state.flights[ac.cs];
      if (ac.phase === "air") {
        ac.air.dist -= (ac.air.gs / 3600) * dt * AIR_ACCEL;
        if (ac.air.dist < 40 && !e?.stand && !ac.askedStand) {
          ac.askedStand = true;
          applyOp(state, { op: "reqStand", callsign: ac.cs }, "TELEX", now);
          applyOp(state, { op: "msg", callsign: ac.cs, dir: "dn", text: "REQ STAND" }, "TELEX", now);
        }
        if (ac.air.dist < 12) ac.air.gs = 140;
        if (ac.air.dist <= 0) {
          // Landed: roll to the entry spot for its ramp and wait for a stand.
          const stand = e?.stand ? L.standById.get(e.stand) : null;
          const spotId = stand ? (entrySpotFor(L, stand) || {}).id : HOLD_SPOT[operatorFor(L, ac.cs, ac.rmk).group] || FALLBACK_SPOT;
          const spot = L.spotById.get(spotId);
          Object.assign(ac, { phase: "spot", chart: spot.chart, x: spot.x, y: spot.y, gs: 0 });
          addLog(`${ac.cs} landed, at spot ${spot.id}`);
        }
      } else if (ac.phase === "spot") {
        ac.gs = 0;
        if (e?.stand) {
          const stand = L.standById.get(e.stand);
          const lp = lanePath(L, stand);
          if (lp && stand.chart === ac.chart) {
            ac.path = [...lp.pts].reverse().slice(1).concat([[stand.x, stand.y]]);
            ac.phase = "taxiIn";
          }
        }
      } else if (ac.phase === "taxiIn") {
        ac.gs = 18;
        if (advance(ac, TAXI_PX * dt)) {
          ac.phase = "parked";
          ac.gs = 0;
          addLog(`${ac.cs} parked`);
        }
      } else if (ac.phase === "parked") {
        ac.gs = 0;
        if (e?.push === PUSH.APPROVED && ac.dep === L.icao) {
          const stand = L.standById.get(e.stand || ac.stand);
          const lp = stand && lanePath(L, stand);
          if (lp) {
            // First leg (stand -> lane) is the push; the rest is taxi to the spot.
            ac.path = [lp.pts[0]];
            ac.taxiPath = lp.pts.slice(1);
            ac.noseHdg = stand.noseHdg;
            ac.phase = "pushing";
            ac.pushWaitUntil = now + 3000;
          }
        }
      } else if (ac.phase === "pushing") {
        if (now < ac.pushWaitUntil) continue;
        ac.gs = 4;
        if (advance(ac, PUSH_PX * dt)) {
          ac.phase = "taxiOut";
          ac.path = ac.taxiPath;
          ac.noseHdg = null;
          ac.gs = 0;
          ac.taxiWaitUntil = now + 4000;
        }
      } else if (ac.phase === "taxiOut") {
        if (now < ac.taxiWaitUntil) continue;
        ac.gs = 18;
        if (advance(ac, TAXI_PX * dt)) {
          ac.phase = "gone";
          ac.gs = 0;
          ac.goneAt = now;
          addLog(`${ac.cs} at spot, handed off`);
        }
      } else if (ac.phase === "gone" && now - ac.goneAt > 8000) {
        planes.delete(ac.cs);
        applyOp(state, { op: "remove", callsign: ac.cs }, "DEMO", now);
      }
    }
    // Every ~40-70 s another parked departure calls for push.
    if (now >= nextCallAt) {
      nextCallAt = now + 40000 + Math.random() * 30000;
      const ready = [...planes.values()].filter(a => a.phase === "parked" && a.dep === L.icao && !state.flights[a.cs]?.push);
      const ac = ready[Math.floor(Math.random() * ready.length)];
      if (ac) {
        applyOp(state, { op: "push", callsign: ac.cs, push: PUSH.REQ }, "TELEX", now);
        applyOp(state, { op: "msg", callsign: ac.cs, dir: "dn", text: "REQ PUSH" }, "TELEX", now);
        autoAck(ac.cs, now + 2000);
      }
    }
    emit();
  }

  function pilots() {
    const out = [];
    for (const ac of planes.values()) {
      let lat;
      let lon;
      let alt = L.field.elevFt;
      let hdg = ac.noseHdg ?? ac.moveHdg ?? 0;
      if (ac.phase === "air") {
        const b = (ac.air.brg * Math.PI) / 180;
        lat = L.field.lat + (ac.air.dist / 60) * Math.cos(b);
        lon = L.field.lon + ((ac.air.dist / 60) * Math.sin(b)) / Math.cos((lat * Math.PI) / 180);
        alt = Math.max(L.field.elevFt + 400, Math.min(35000, ac.air.dist * 320));
        hdg = (ac.air.brg + 180) % 360;
      } else {
        const g = L.proj[ac.chart].toLatLon(ac.x, ac.y);
        lat = g.lat;
        lon = g.lon;
      }
      out.push({
        callsign: ac.cs, latitude: lat, longitude: lon, altitude: alt, heading: hdg,
        groundspeed: ac.phase === "air" ? ac.air.gs : ac.gs,
        flight_plan: { departure: ac.dep, arrival: ac.arr, aircraft_short: ac.type, remarks: ac.rmk || "" },
      });
    }
    return out;
  }

  function emit() {
    for (const fn of listeners) fn();
  }

  return {
    mode: "demo",
    me: { canWrite: true, callsign: ME, reason: "" },
    status: { ok: true, text: "Demo traffic (simulated, nothing leaves this browser)" },
    getState: () => state,
    getPilots: pilots,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Seed the fleet without starting the timer (tests). */
    seed() {
      if (!planes.size) seed();
    },
    start() {
      if (!planes.size) seed();
      if (!timer) timer = setInterval(tick, TICK_MS);
      emit();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    /** One simulation step; the page runs it on a timer, tests call it directly. */
    tick,
    async op(o) {
      const res = applyOp(state, o, ME, Date.now());
      emit();
      return res;
    },
    getHoppie() {
      const out = {};
      for (const cs of planes.keys()) out[cs] = !NOT_ON_HOPPIE.has(cs);
      return out;
    },
    async sendTelex(cs, text, { force = false } = {}) {
      const t = String(text || "").trim().toUpperCase();
      if (!t) return { ok: false, error: "empty message" };
      const offline = NOT_ON_HOPPIE.has(cs);
      if (offline && !force) {
        return { ok: false, offline: true, error: `${cs} is not connected to Hoppie right now, so the telex would not reach them. Tell them by voice, or send anyway.` };
      }
      applyOp(state, { op: "msg", callsign: cs, dir: "up", text: t }, ME, Date.now());
      state.flights[cs].sent = [...(state.flights[cs].sent || []), { t: Date.now(), text: t }];
      if (!offline) pilotSays(cs, "ROGER");
      emit();
      return { ok: true, dryRun: true };
    },
  };
}
