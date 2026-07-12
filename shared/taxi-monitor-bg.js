/**
 * Background taxi monitor — keeps timing active while navigating between VATFLOW pages.
 * Sessions live in sessionStorage; completed samples append to localStorage history.
 */
const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const TAXI_SESSIONS_KEY = "vatflow_taxi_sessions";
const TAXI_HISTORY_KEY = "vatflow_taxi_history";
const TAXI_MON_AIRPORTS_KEY = "vatflow_taxi_mon_airports";
const TAXI_POLL_MS = 20000;
const TAXI_GS_START = 7;
const TAXI_GS_STOP = 60;
const TAXI_ALT_CLIMB_FT = 100;
const TAXI_DEP_PROX_NM = 15;
const TAXI_MIN_SAMPLE_MS = 3000;
const TAXI_HISTORY_MAX = 200;
const TAXI_HISTORY_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const AIRPORTS = {
  KATL:[33.6367,-84.4281],KBOS:[42.3643,-71.0052],KORD:[41.9786,-87.9048],
  KJFK:[40.6398,-73.7789],KLGA:[40.7772,-73.8726],KEWR:[40.6925,-74.1687],
  KLAX:[33.9425,-118.408],KSFO:[37.619,-122.3749],KDEN:[39.8617,-104.6731],
  KDFW:[32.8968,-97.038],KIAH:[29.9844,-95.3414],KMIA:[25.7932,-80.2906],
  KMCO:[28.4294,-81.309],KSEA:[47.449,-122.3093],KPHX:[33.4343,-112.0116],
  KLAS:[36.0801,-115.1522],KCLT:[35.214,-80.9431],KPHL:[39.8719,-75.2411],
  KDCA:[38.8521,-77.0377],KIAD:[38.9445,-77.4558],KBWI:[39.1754,-76.6683],
  KSDF:[38.1744,-85.736],KCVG:[39.0488,-84.6678],KMSP:[44.882,-93.2218],
  KDTW:[42.2124,-83.3534],KSTL:[38.7487,-90.37],KMEM:[35.0424,-89.9767],
  KBNA:[36.1245,-86.6782],KAUS:[30.1945,-97.6699],KSAN:[32.7336,-117.1897],
  KPDX:[45.5887,-122.5975],KSLC:[40.7884,-111.9778],KTPA:[27.9755,-82.5332],
  KFLL:[26.0726,-80.1527],KPIT:[40.4915,-80.2329],KCLE:[41.4117,-81.8498],
  CYYZ:[43.6772,-79.6306],CYVR:[49.1939,-123.1844],CYUL:[45.4706,-73.7408],
  EGLL:[51.4775,-0.4614],LFPG:[49.0128,2.55],EHAM:[52.3086,4.7639],
  EDDF:[50.0333,8.5706],LIRF:[41.8003,12.2389],VHHH:[22.3089,113.9146],
  RJTT:[35.5523,139.7798],RKSI:[37.4692,126.4505],ZBAA:[40.0801,116.5846],
  YSSY:[-33.9461,151.1772],NZAA:[-37.0081,174.7917]
};

const NMR = 3440.065;
const rad = d => d * Math.PI / 180;
function gcDist(a1, o1, a2, o2) {
  const dA = rad(a2 - a1), dO = rad(o2 - o1);
  const h = Math.sin(dA / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dO / 2) ** 2;
  return 2 * NMR * Math.asin(Math.min(1, Math.sqrt(h)));
}
function lookup(code) {
  const c = String(code || "").toUpperCase();
  return AIRPORTS[c] || null;
}
function fbKey(s) { return String(s).replace(/[.#$\[\]\/]/g, "_"); }
function taxiSessKey(field, callsign) { return field + "|" + callsign; }
function taxiSampleId(airport, callsign, endMs) {
  return fbKey(airport + "_" + callsign + "_" + endMs);
}

function loadMonAirports() {
  try {
    const saved = localStorage.getItem(TAXI_MON_AIRPORTS_KEY);
    if (saved) return JSON.parse(saved) || [];
    const one = localStorage.getItem("vatflow_taxi_mon_icao");
    return one ? [one] : [];
  } catch (e) { return []; }
}

function loadSessions() {
  try {
    const raw = sessionStorage.getItem(TAXI_SESSIONS_KEY);
    return raw ? JSON.parse(raw) || {} : {};
  } catch (e) { return {}; }
}

function saveSessions(sessions) {
  const o = {};
  for (const k in sessions) {
    const s = sessions[k];
    if (s && s.phase !== "done") o[k] = s;
  }
  try { sessionStorage.setItem(TAXI_SESSIONS_KEY, JSON.stringify(o)); } catch (e) {}
}

function pruneTaxiHistory(list) {
  const cutoff = Date.now() - TAXI_HISTORY_MAX_AGE;
  let out = list.filter(h => h.endMs >= cutoff);
  if (out.length > TAXI_HISTORY_MAX) out = out.slice(-TAXI_HISTORY_MAX);
  return out;
}

function loadTaxiHistory() {
  try {
    const raw = localStorage.getItem(TAXI_HISTORY_KEY);
    return raw ? pruneTaxiHistory(JSON.parse(raw) || []) : [];
  } catch (e) { return []; }
}

function saveTaxiHistory(list) {
  const pruned = pruneTaxiHistory(list);
  try { localStorage.setItem(TAXI_HISTORY_KEY, JSON.stringify(pruned)); } catch (e) {}
  return pruned;
}

function addTaxiSample(entry) {
  const id = taxiSampleId(entry.airport, entry.callsign, entry.endMs);
  const history = loadTaxiHistory();
  if (history.some(h => (h.id || taxiSampleId(h.airport, h.callsign, h.endMs)) === id)) return;
  const rec = { id, airport: entry.airport, callsign: entry.callsign,
    startMs: entry.startMs, endMs: entry.endMs, durationMs: entry.durationMs };
  history.push(rec);
  saveTaxiHistory(history);
  if (window.VFSync && window.VFSync.pushTaxiSample) window.VFSync.pushTaxiSample(id, rec);
}

function isDepartedForFinish(p, field, sess) {
  const fp = p.flight_plan;
  if (!fp || (fp.departure || "").toUpperCase() !== field) return false;
  const gs = p.groundspeed || 0;
  const alt = p.altitude || 0;
  if (sess && sess.baseAlt != null) {
    if (alt >= sess.baseAlt + TAXI_ALT_CLIMB_FT) return true;
    if (gs > TAXI_GS_STOP) return true;
  }
  return gs > TAXI_GS_STOP && alt > 500;
}

function isDepartureGround(p, field, sess) {
  const fp = p.flight_plan;
  if (!fp || (fp.departure || "").toUpperCase() !== field) return false;
  if (sess && sess.phase === "rolling" && isDepartedForFinish(p, field, sess)) return false;
  if (!sess && p.groundspeed > TAXI_GS_STOP && (p.altitude || 0) > 500) return false;
  const depPt = lookup(field);
  if (depPt && isFinite(p.latitude) && isFinite(p.longitude)) {
    if (gcDist(p.latitude, p.longitude, depPt[0], depPt[1]) > TAXI_DEP_PROX_NM) return false;
  }
  const dest = (fp.arrival || "????").toUpperCase();
  const destPt = lookup(dest);
  const distToDest = destPt ? gcDist(p.latitude, p.longitude, destPt[0], destPt[1]) : null;
  return !(p.groundspeed <= 60 && distToDest != null && distToDest < 5);
}

function newTaxiSession(field, now, gs, alt) {
  return { airport: field, phase: "watching", startMs: null,
    firstSeenMs: now, baseAlt: alt, lastGs: gs, lastAlt: alt };
}

function finishTaxiSession(sessions, key, sess, endMs) {
  if (!sess || sess.phase === "done") return;
  const sep = key.indexOf("|");
  const field = key.slice(0, sep);
  const cs = key.slice(sep + 1);
  if (sess.startMs == null) { sess.phase = "done"; return; }
  let startMs = sess.startMs;
  let durationMs = endMs - startMs;
  if (durationMs < TAXI_MIN_SAMPLE_MS && sess.firstSeenMs != null && sess.firstSeenMs < startMs) {
    startMs = sess.firstSeenMs;
    durationMs = endMs - startMs;
  }
  if (durationMs >= TAXI_MIN_SAMPLE_MS) {
    addTaxiSample({ airport: field, callsign: cs, startMs, endMs, durationMs });
  }
  sess.phase = "done";
}

function updateTaxiMonitor(sessions, airports, pilots) {
  if (!airports.length || !pilots) return sessions;
  const now = Date.now();
  const activeKeys = new Set();

  for (const field of airports) {
    for (const p of pilots) {
      const cs = p.callsign;
      const key = taxiSessKey(field, cs);
      const gs = p.groundspeed || 0;
      const alt = p.altitude || 0;
      let sess = sessions[key];
      if (!isDepartureGround(p, field, sess)) continue;
      activeKeys.add(key);

      if (!sess || sess.airport !== field || sess.phase === "done") {
        sessions[key] = newTaxiSession(field, now, gs, alt);
        sess = sessions[key];
      }

      if (sess.phase === "watching" && gs > TAXI_GS_START) {
        sess.phase = "rolling";
        sess.startMs = now;
        sess.baseAlt = alt;
      }

      if (sess.phase === "rolling" && sess.startMs != null && now > sess.startMs) {
        const climbed = alt >= sess.baseAlt + TAXI_ALT_CLIMB_FT;
        if (gs > TAXI_GS_STOP || climbed) finishTaxiSession(sessions, key, sess, now);
      }

      sess.lastGs = gs;
      sess.lastAlt = alt;
    }
  }

  for (const field of airports) {
    for (const p of pilots) {
      const key = taxiSessKey(field, p.callsign);
      const sess = sessions[key];
      if (!sess || sess.phase === "done") continue;
      if (sess.startMs != null && now <= sess.startMs) continue;
      if (isDepartedForFinish(p, field, sess)) finishTaxiSession(sessions, key, sess, now);
    }
  }

  for (const key of Object.keys(sessions)) {
    if (!activeKeys.has(key)) {
      const sess = sessions[key];
      if (sess && sess.phase !== "done") finishTaxiSession(sessions, key, sess, now);
    }
    if (!activeKeys.has(key) || sessions[key].phase === "done") delete sessions[key];
  }

  saveSessions(sessions);
  return sessions;
}

function isTbfmPage() {
  return /vatflow-tbfm/i.test(location.pathname) || /vatflow-tbfm/i.test(location.href);
}

async function taxiPollTick() {
  const airports = loadMonAirports();
  if (!airports.length) return;
  try {
    const r = await fetch(VATSIM_URL, { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    const sessions = loadSessions();
    updateTaxiMonitor(sessions, airports, data.pilots || []);
  } catch (e) { /* offline — retry next tick */ }
}

function startBackgroundTaxiMonitor() {
  if (isTbfmPage()) return;   /* CFR/TBFM page runs its own feed + taxi tick */
  const airports = loadMonAirports();
  if (!airports.length) return;
  taxiPollTick();
  setInterval(taxiPollTick, TAXI_POLL_MS);
}

startBackgroundTaxiMonitor();
