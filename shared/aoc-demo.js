/**
 * Dispatch Center demo mode: a scripted fleet for the watched operator that
 * runs in the browser, with no hub and no network.
 *
 * It produces VATSIM-feed-shaped pilots and prefiles, so the page derives
 * phases exactly as it does from the live feed, and keeps the shared state
 * with the same applyOp() reducer the hub mirrors. Flights push, taxi, fly
 * great circles (time in the air runs AIR_ACCEL times faster), land, park and
 * turn around. One holds, one diverts, one squawks 7700, one drops off the
 * network for two minutes, and two are not on Hoppie. Simulated pilots send
 * requests and answer telex that ask for a reply. Nothing leaves the browser.
 */
import { applyOp, bearing, distNm, emptyState, gcPoint, movePoint, zulu } from "./aoc-core.js";

const TICK_MS = 1000;
export const AIR_ACCEL = 8;

/** Where flights go when the operator file names no hubs (a code typed in). */
const US_AIRPORTS = ["KATL", "KDFW", "KORD", "KDEN", "KLAX", "KJFK", "KCLT", "KPHX", "KMIA", "KSEA", "KBOS", "KIAD", "KLAS",
  "KMCO", "KSFO", "KIAH", "KMSP", "KDTW", "KPHL", "KSLC", "KBWI", "KSAN", "KTPA", "KAUS", "KBNA", "KRDU", "KSTL", "KMCI", "KPDX", "KCVG"];
const GENERIC_FLEET = { mainline: ["A320", "B738", "A321", "B739", "E190"], regional: ["E175", "CRJ9"] };

function rnd(a, b) {
  return a + Math.random() * (b - a);
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function hhmm(ms) {
  return zulu(ms).slice(0, 4);
}
function minToHhmm(min) {
  min = Math.max(1, Math.round(min));
  return String(Math.floor(min / 60)).padStart(2, "0") + String(min % 60).padStart(2, "0");
}

/**
 * @param W watch (makeWatch)
 * @param info the operator's entry in operators.json, or null
 * @param A icao -> {lat, lon} | null
 */
export function createDemoStore(W, info, A) {
  const code = W.code || "DMO";
  const hubs = ((info && info.hubs) || []).filter(A);
  const hubList = hubs.length ? hubs : US_AIRPORTS.filter(A).slice(0, 8);
  const pool = [...new Set([...hubList, ...US_AIRPORTS.filter(A)])];
  const fleet = (info && info.fleet) || GENERIC_FLEET;
  const regionals = [...W.family].filter(([, f]) => !f.shared).map(([p]) => p);
  const sharedRegional = [...W.family].find(([, f]) => f.shared);

  let state = emptyState(code);
  const listeners = new Set();
  const acs = [];
  const hist = {};
  const replies = [];
  const scripted = [];
  let timer = null;
  let t0 = Date.now();

  const store = {
    mode: "demo",
    me: { canWrite: true, callsign: "DEMO DISPATCH", reason: "" },
    status: { ok: true, text: `Demo · telex station ${W.station || code + "OPS"} (local only)` },
    station: W.station || `${code}OPS`,
    dryRun: true,
    getState: () => state,
    getFeed,
    getHistory: () => hist,
    getHoppie,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start,
    stop,
    op,
    sendTelex,
  };

  function emit() {
    for (const fn of listeners) fn();
  }

  /* ---------- fleet ---------- */

  function newCallsign(i) {
    // A few flights on the regional partners, the rest mainline.
    if (regionals.length && i % 5 === 3) return { cs: `${pick(regionals)}${3000 + Math.floor(rnd(0, 2000))}`, reg: true, rmk: "" };
    if (sharedRegional && i === 8) return { cs: `${sharedRegional[0]}${5000 + Math.floor(rnd(0, 900))}`, reg: true, rmk: `OPR/${code}` };
    return { cs: `${code}${100 + i * 37 + Math.floor(rnd(0, 30))}`, reg: false, rmk: "" };
  }

  function pickRoute(reg) {
    for (let k = 0; k < 40; k++) {
      const dep = Math.random() < 0.55 ? pick(hubList) : pick(pool);
      const arr = hubList.includes(dep) ? pick(pool) : pick(hubList);
      if (dep === arr) continue;
      const d = distNm(A(dep).lat, A(dep).lon, A(arr).lat, A(arr).lon);
      if (d < 150 || d > (reg ? 900 : 2600)) continue;
      return { dep, arr, dist: d };
    }
    return { dep: hubList[0], arr: pool.find(x => x !== hubList[0]), dist: 500 };
  }

  function altnFor(arr) {
    let best = null, bd = Infinity;
    for (const a of pool) {
      if (a === arr) continue;
      const d = distNm(A(arr).lat, A(arr).lon, A(a).lat, A(a).lon);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  function cruiseFor(dist) {
    return dist < 300 ? 24000 : dist < 600 ? 32000 : pick([34000, 36000, 38000]);
  }

  function makeAc(i) {
    const { cs, reg, rmk } = newCallsign(i);
    const { dep, arr, dist } = pickRoute(reg);
    const type = pick(reg ? fleet.regional || fleet.mainline : fleet.mainline);
    const eetMin = (dist / 440) * 60 + 20;
    return {
      cs, cid: 1500000 + i, type, dep, arr, altn: altnFor(arr), cruise: cruiseFor(dist), dist,
      rmk: `/V/ ${rmk}`.trim(), eet: minToHhmm(eetMin), fuel: minToHhmm(eetMin + 75), deptime: "",
      stage: "gate", until: 0, lat: A(dep).lat, lon: A(dep).lon, hdg: 0, alt: 500, gs: 0, sq: String(1000 + Math.floor(rnd(0, 6000))).replace(/[89]/g, "1"),
      from: null, to: null, d: 0, total: 0, hidden: 0, special: "",
    };
  }

  function atGate(ac) {
    const p = movePoint(A(ac.dep).lat, A(ac.dep).lon, rnd(0, 360), rnd(0.2, 0.7));
    ac.lat = p.lat; ac.lon = p.lon; ac.gs = 0; ac.alt = 500; ac.hdg = Math.floor(rnd(0, 360));
  }

  function setLeg(ac, dist = null) {
    ac.from = { lat: ac.lat, lon: ac.lon };
    ac.to = A(ac.arr);
    ac.d = 0;
    ac.total = dist ?? distNm(ac.lat, ac.lon, ac.to.lat, ac.to.lon);
  }

  /** Put an airborne flight a fraction f of the way along its leg, with a matching altitude and speed. */
  function placeAirborne(ac, f) {
    ac.lat = A(ac.dep).lat; ac.lon = A(ac.dep).lon;
    setLeg(ac);
    ac.d = ac.total * f;
    const p = gcPoint(ac.from, ac.to, f);
    ac.lat = p.lat; ac.lon = p.lon;
    ac.alt = targetAlt(ac);
    ac.gs = targetGs(ac);
    ac.hdg = headingOn(ac);
    ac.stage = "air";
  }

  function targetAlt(ac) {
    const r = ac.total - ac.d;
    return Math.max(500, Math.min(ac.cruise, 1000 + ac.d * 330, 500 + r * 320));
  }

  function targetGs(ac) {
    const r = ac.total - ac.d;
    if (r < 12) return 150;
    if (ac.alt < 10000) return 250;
    return Math.round(250 + ((ac.alt - 10000) / Math.max(1, ac.cruise - 10000)) * 210);
  }

  function headingOn(ac) {
    const a = gcPoint(ac.from, ac.to, Math.min(1, ac.d / ac.total));
    const b = gcPoint(ac.from, ac.to, Math.min(1, (ac.d + 2) / ac.total));
    return Math.round(bearing(a.lat, a.lon, b.lat, b.lon)) || ac.hdg;
  }

  function seed() {
    const now = Date.now();
    t0 = now;
    const N = 36;
    for (let i = 0; i < N; i++) {
      const ac = makeAc(i);
      const leg = `${ac.dep}-${ac.arr}`;
      const eetMs = (ac.dist / 440) * 3600000;
      if (i < 5) {
        // Filed, not connected yet.
        ac.stage = "pre";
        ac.until = now + rnd(40, 360) * 1000;
        ac.deptime = hhmm(now + rnd(20, 50) * 60000);
      } else if (i < 11) {
        ac.stage = "gate";
        atGate(ac);
        ac.until = now + rnd(20, 300) * 1000;
        // Two of them already well past their departure time.
        ac.deptime = hhmm(now + (i < 7 ? -rnd(20, 30) : rnd(-5, 20)) * 60000);
      } else if (i < 14) {
        ac.stage = "taxi";
        atGate(ac);
        ac.gs = 15;
        ac.until = now + rnd(30, 100) * 1000;
        const out = now - rnd(4, 10) * 60000;
        ac.deptime = hhmm(out - rnd(-5, 15) * 60000);
        hist[ac.cs] = { leg, out };
      } else if (i < 30) {
        const f = i === 14 ? 0.8 : i === 15 ? 0.35 : i === 17 ? 0.25 : rnd(0.05, 0.95);
        placeAirborne(ac, f);
        const off = now - (ac.d / 440) * 3600000 - 60000;
        const out = off - rnd(10, 20) * 60000;
        ac.deptime = hhmm(out - rnd(-5, 30) * 60000);
        hist[ac.cs] = { leg, out, off, arr: ac.arr };
        if (i === 14) ac.special = "hold";
        if (i === 15) ac.special = "divert";
        if (i === 16) ac.sq = "7700";
        if (i === 17) ac.special = "lost";
        if (i === 18 || i === 24) ac.offHoppie = true;
        if (i === 19) {
          // Tight on fuel.
          const fuelMin = ((now - off) + (ac.total - ac.d) / ac.gs * 3600000) / 60000 + 35;
          ac.fuel = minToHhmm(fuelMin);
        }
      } else if (i < 33) {
        ac.stage = "taxiin";
        ac.lat = A(ac.arr).lat + rnd(-0.01, 0.01); ac.lon = A(ac.arr).lon + rnd(-0.01, 0.01);
        ac.gs = 14;
        ac.until = now + rnd(40, 120) * 1000;
        const on = now - rnd(1, 3) * 60000;
        const off = on - eetMs;
        ac.deptime = hhmm(off - rnd(10, 30) * 60000);
        hist[ac.cs] = { leg, out: off - 15 * 60000, off, on, arr: ac.arr };
      } else {
        ac.stage = "parked";
        ac.lat = A(ac.arr).lat + rnd(-0.01, 0.01); ac.lon = A(ac.arr).lon + rnd(-0.01, 0.01);
        ac.until = now + rnd(60, 400) * 1000;
        const inn = now - rnd(3, 20) * 60000;
        const on = inn - 6 * 60000;
        const off = on - eetMs;
        ac.deptime = hhmm(off - rnd(10, 30) * 60000);
        hist[ac.cs] = { leg, out: off - 15 * 60000, off, on, in: inn, arr: ac.arr };
      }
      acs.push(ac);
    }
    // Pilot requests, a little after the start.
    const air = acs.filter(a => a.stage === "air" && !a.special && !a.offHoppie);
    const gate = acs.filter(a => a.stage === "gate");
    if (air[0]) scripted.push({ at: now + 25000, cs: air[0].cs, text: "REQ GATE" });
    if (air[1]) scripted.push({ at: now + 55000, cs: air[1].cs, text: `REQ WX ${air[1].arr}` });
    if (gate[0]) scripted.push({ at: now + 100000, cs: gate[0].cs, text: "DELAY 20 MIN MX ISSUE WILL ADVISE" });
  }

  /* ---------- simulation ---------- */

  function tick() {
    const now = Date.now();
    for (const ac of acs) step(ac, now, TICK_MS / 1000);
    while (scripted.length && scripted[0].at <= now) {
      const s = scripted.shift();
      if (acs.find(a => a.cs === s.cs && !a.hidden && a.stage !== "pre")) applyOp(state, { op: "msg", callsign: s.cs, dir: "dn", text: s.text }, s.cs, now);
    }
    for (let i = replies.length - 1; i >= 0; i--) {
      if (replies[i].at > now) continue;
      const r = replies.splice(i, 1)[0];
      applyOp(state, { op: "msg", callsign: r.cs, dir: "dn", text: r.text }, r.cs, now);
    }
    emit();
  }

  function step(ac, now, dt) {
    if (ac.hidden && now >= ac.hidden) ac.hidden = 0;
    switch (ac.stage) {
      case "pre":
        if (now >= ac.until) {
          ac.stage = "gate";
          atGate(ac);
          ac.until = now + rnd(90, 240) * 1000;
        }
        break;
      case "gate":
        if (now >= ac.until) {
          ac.stage = "taxi";
          ac.until = now + rnd(60, 150) * 1000;
          ac.hdg = Math.floor(rnd(0, 360));
        }
        break;
      case "taxi": {
        ac.gs = 15;
        ac.hdg = (ac.hdg + rnd(-4, 4) + 360) % 360;
        const p = movePoint(ac.lat, ac.lon, ac.hdg, (ac.gs * dt) / 3600);
        ac.lat = p.lat; ac.lon = p.lon;
        if (now >= ac.until) {
          ac.stage = "air";
          ac.gs = 160;
          ac.alt = 900;
          setLeg(ac);
        }
        break;
      }
      case "air":
        fly(ac, now, dt);
        break;
      case "hold": {
        ac.gs = 220;
        ac.alt += Math.max(-50, Math.min(50, 8000 - ac.alt));
        ac.hdg = (ac.hdg + 2.2 * dt) % 360;
        const p = movePoint(ac.lat, ac.lon, ac.hdg, (ac.gs * AIR_ACCEL * dt) / 3600);
        ac.lat = p.lat; ac.lon = p.lon;
        if (now >= ac.until) {
          ac.stage = "air";
          ac.special = "";
          setLeg(ac);
        }
        break;
      }
      case "rollout": {
        ac.gs = Math.max(20, ac.gs - 8 * dt);
        const p = movePoint(ac.lat, ac.lon, ac.hdg, (ac.gs * dt) / 3600);
        ac.lat = p.lat; ac.lon = p.lon;
        if (ac.gs <= 20) {
          ac.stage = "taxiin";
          ac.until = now + rnd(60, 120) * 1000;
        }
        break;
      }
      case "taxiin": {
        ac.gs = 14;
        ac.hdg = (ac.hdg + rnd(-6, 6) + 360) % 360;
        const p = movePoint(ac.lat, ac.lon, ac.hdg, (ac.gs * dt) / 3600);
        ac.lat = p.lat; ac.lon = p.lon;
        if (now >= ac.until) {
          ac.stage = "parked";
          ac.gs = 0;
          ac.until = now + rnd(240, 420) * 1000;
        }
        break;
      }
      case "parked":
        ac.gs = 0;
        if (now >= ac.until) turnaround(ac, now);
        break;
    }
  }

  function fly(ac, now, dt) {
    const v = (ac.gs * AIR_ACCEL * dt) / 3600;
    ac.d = Math.min(ac.total, ac.d + v);
    const r = ac.total - ac.d;
    const want = targetAlt(ac);
    const rate = (3000 * AIR_ACCEL * dt) / 60;
    ac.alt += Math.max(-rate, Math.min(rate, want - ac.alt));
    const gsWant = targetGs(ac);
    ac.gs += Math.max(-6 * dt, Math.min(6 * dt, gsWant - ac.gs));
    const p = gcPoint(ac.from, ac.to, ac.total ? ac.d / ac.total : 1);
    ac.lat = p.lat; ac.lon = p.lon;
    ac.hdg = headingOn(ac);
    const frac = ac.total ? 1 - r / ac.total : 1;
    if (ac.special === "hold" && r < 35) {
      ac.stage = "hold";
      ac.until = now + 200000;
      return;
    }
    if (ac.special === "divert" && frac > 0.45 && ac.altn) {
      // Diverts to its alternate: the flight plan's arrival changes in flight.
      ac.special = "";
      ac.arr = ac.altn;
      ac.altn = "";
      setLeg(ac);
      replies.push({ at: now + 2000, cs: ac.cs, text: `DIVERTING TO ${ac.arr} MEDICAL ON BOARD` });
      return;
    }
    if (ac.special === "lost" && frac > 0.32) {
      ac.special = "";
      ac.hidden = now + 120000;
    }
    if (r < 0.3) {
      ac.stage = "rollout";
      ac.gs = 130;
      ac.alt = 500;
    }
  }

  function turnaround(ac, now) {
    // Next leg back where it came from.
    const back = ac.dep;
    ac.dep = ac.arr;
    ac.arr = back;
    ac.altn = altnFor(ac.arr);
    ac.dist = distNm(A(ac.dep).lat, A(ac.dep).lon, A(ac.arr).lat, A(ac.arr).lon);
    ac.cruise = cruiseFor(ac.dist);
    const eetMin = (ac.dist / 440) * 60 + 20;
    ac.eet = minToHhmm(eetMin);
    ac.fuel = minToHhmm(eetMin + 75);
    ac.deptime = hhmm(now + rnd(8, 15) * 60000);
    ac.stage = "gate";
    ac.until = now + rnd(150, 300) * 1000;
  }

  /* ---------- feed ---------- */

  function fp(ac) {
    return {
      flight_rules: "I", aircraft_short: ac.type, departure: ac.dep, arrival: ac.arr, alternate: ac.altn || "",
      deptime: ac.deptime, enroute_time: ac.eet, fuel_time: ac.fuel, altitude: String(ac.cruise),
      route: "DCT", remarks: ac.rmk,
    };
  }

  function getFeed() {
    const pilots = [], prefiles = [];
    for (const ac of acs) {
      if (ac.stage === "pre") { prefiles.push({ callsign: ac.cs, flight_plan: fp(ac) }); continue; }
      if (ac.hidden) continue;
      pilots.push({
        callsign: ac.cs, cid: ac.cid, latitude: ac.lat, longitude: ac.lon, altitude: Math.round(ac.alt),
        groundspeed: Math.round(ac.gs), heading: Math.round(ac.hdg), transponder: ac.sq, flight_plan: fp(ac),
      });
    }
    return { pilots, prefiles };
  }

  function getHoppie() {
    const out = {};
    for (const ac of acs) if (ac.stage !== "pre" && !ac.hidden) out[ac.cs] = !ac.offHoppie;
    return out;
  }

  /* ---------- ops and telex ---------- */

  async function op(o) {
    return applyOp(state, o, store.me.callsign, Date.now());
  }

  async function sendTelex(to, text, { force = false } = {}) {
    const ac = acs.find(a => a.cs === to);
    if (!ac || ac.stage === "pre" || ac.hidden) return { ok: false, error: `${to} is not connected.` };
    if (ac.offHoppie && !force) return { ok: false, offline: true, error: `${to} is not connected to Hoppie. A telex will not reach them.` };
    const now = Date.now();
    applyOp(state, { op: "msg", callsign: to, dir: "up", text }, store.me.callsign, now);
    if (!ac.offHoppie) {
      const reply = pilotReply(ac, text.toUpperCase(), now);
      if (reply) replies.push({ at: now + rnd(6, 14) * 1000, cs: to, text: reply });
    }
    emit();
    return { ok: true, dryRun: true };
  }

  /** What the simulated pilot answers. A DIVERT instruction is flown. */
  function pilotReply(ac, text, now) {
    const div = text.match(/\bDIVERT ([A-Z]{4})\b/);
    if (div && A(div[1]) && (ac.stage === "air" || ac.stage === "hold")) {
      ac.arr = div[1];
      ac.stage = "air";
      ac.special = "";
      setLeg(ac);
      const eta = now + ((ac.total / Math.max(200, ac.gs)) * 3600000) / AIR_ACCEL;
      return `WILCO DIVERTING ${ac.arr} ETA ${zulu(eta)} FUEL ${rnd(5, 9).toFixed(1)}`;
    }
    if (/REQUEST ETA|ADVISE ETA|ADVISE FUEL/.test(text)) {
      const r = ac.total ? ac.total - ac.d : 0;
      const eta = now + ((r / Math.max(200, ac.gs)) * 3600000) / AIR_ACCEL;
      return `ETA ${ac.arr} ${zulu(eta)} FUEL ${rnd(5, 11).toFixed(1)}`;
    }
    if (/REPLY WILCO/.test(text)) return "WILCO";
    if (/RELEASE/.test(text)) return "ROGER THANKS";
    return Math.random() < 0.5 ? "ROGER" : null;
  }

  function start() {
    if (!acs.length) seed();
    timer ||= setInterval(tick, TICK_MS);
    tick();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return store;
}
