/**
 * ERAM Trainer — aircraft motion + FDB field state (CRC ERAM data block reference).
 */
import { bearing, gcLine, getAirport, loadAirports } from "./fca-metering.js";

const FIX_COORDS = new Map();
let fixesReady = null;

async function loadFixCoords(baseUrl = "") {
  if (fixesReady) return fixesReady;
  fixesReady = (async () => {
    try {
      const r = await fetch((baseUrl || "") + "data/nav/fixes.json");
      if (!r.ok) return;
      const j = await r.json();
      for (const [name, pts] of Object.entries(j)) {
        if (Array.isArray(pts) && pts[0] && pts[0].length >= 2) {
          FIX_COORDS.set(name.toUpperCase(), { lat: pts[0][0], lon: pts[0][1] });
        }
      }
    } catch (_) { /* offline */ }
  })();
  return fixesReady;
}

function fixCoord(name) {
  const n = String(name || "").toUpperCase();
  return FIX_COORDS.get(n) || null;
}

function destChar(icao) {
  const s = String(icao || "").toUpperCase();
  if (!s) return "—";
  return s.length >= 4 ? s[3] : s.slice(-1);
}

/**
 * CRC Field B line 2 — assigned/reported altitude with character 4 suffix.
 * @param {object} ac sim aircraft
 */
export function formatFieldB(ac) {
  const reported = Math.round(ac.alt || 0);
  const assigned = ac.assignedAlt != null ? Math.round(ac.assignedAlt) : null;
  const interim = ac.interimAlt != null ? Math.round(ac.interimAlt) : null;

  if (interim != null) {
    return `${String(interim).padStart(3, "0")}T${String(reported).padStart(3, "0")}`;
  }
  if (assigned == null) {
    return `${String(reported).padStart(3, "0")} `;
  }
  if (Math.abs(assigned - reported) <= 1 && !ac.climbing && !ac.descending) {
    return `${String(assigned).padStart(3, "0")}C`;
  }
  if (assigned > reported) {
    return `${String(assigned).padStart(3, "0")}↑${String(reported).padStart(3, "0")}`;
  }
  if (assigned < reported) {
    return `${String(assigned).padStart(3, "0")}↓${String(reported).padStart(3, "0")}`;
  }
  return `${String(assigned).padStart(3, "0")}C`;
}

/** Field C — reported altitude (hidden when at assigned per CRC; we show in Field B). */
export function formatFieldC(ac) {
  const b = formatFieldB(ac);
  if (b.endsWith("C") || /[↑↓]/.test(b)) return "";
  return String(Math.round(ac.alt || 0)).padStart(3, "0");
}

/** Field D — computer identification (3 digits). */
export function formatFieldD(ac) {
  const raw = String(ac.cid || "---").replace(/\D/g, "");
  const n = raw ? parseInt(raw.slice(-3), 10) : 0;
  return String(Number.isFinite(n) ? n : 0).padStart(3, "0");
}

/** Groundspeed for FDB line 3 (3 digits). */
export function formatGs(ac) {
  return String(Math.round(ac.gs || 0)).padStart(3, "0");
}

/** Field E — destination ID char + groundspeed. */
export function formatFieldE(ac) {
  const d = destChar(ac.arr);
  const gs = Math.round(ac.gs || 0);
  return `${d}${gs}`;
}

/** Field F — heading / speed / direct fix per CRC line 4. */
export function formatFieldF(ac) {
  const parts = [];
  if (ac.assignedHdg != null && ac.assignedHdg !== "PH") {
    parts.push(`H${String(ac.assignedHdg).padStart(3, "0")}`);
  }
  if (ac.assignedSpd != null) {
    parts.push(`S${ac.assignedSpd}`);
  }
  if (ac.directFix) {
    parts.push(ac.directFix);
  }
  return parts.join(" ");
}

export function hasHsf(ac) {
  return !!(ac.assignedHdg != null || ac.assignedSpd != null || ac.directFix);
}

/**
 * Initialize simulation fields on aircraft records (mutates in place).
 * @param {object[]} aircraft
 * @param {{ baseUrl?: string }} [opts]
 */
export async function initSimAircraft(aircraft, opts = {}) {
  await Promise.all([loadAirports(), loadFixCoords(opts.baseUrl || "")]);
  const list = aircraft || [];
  let i = 0;
  for (const ac of list) {
    if (ac.lat == null || ac.lon == null) {
      placeAlongRoute(ac, i / Math.max(1, list.length));
    }
    ac.assignedAlt = ac.assignedAlt != null ? ac.assignedAlt : ac.alt;
    ac.assignedHdg = ac.assignedHdg != null ? ac.assignedHdg : ac.hdg;
    ac.assignedSpd = ac.assignedSpd != null ? ac.assignedSpd : ac.gs;
    ac.interimAlt = ac.interimAlt ?? null;
    ac.directFix = ac.directFix || null;
    ac.directLat = ac.directLat ?? null;
    ac.directLon = ac.directLon ?? null;
    ac.climbing = false;
    ac.descending = false;
    ac.vci = ac.vci !== false;
    ac.cid = ac.cid || String(100 + (i % 900));
    ac.squawk = ac.squawk || String(1200 + (i % 7000));
    ac.fdbPos = ac.fdbPos || "NE";
    ac.leaderLen = ac.leaderLen ?? 2;
    ac.vecMin = ac.vecMin ?? 4;
    i++;
  }
  return list;
}

function placeAlongRoute(ac, t) {
  const dep = getAirport(ac.dep);
  const arr = getAirport(ac.arr);
  if (dep && arr) {
    const path = gcLine(dep, arr);
    const idx = Math.min(path.length - 1, Math.max(0, Math.floor(t * (path.length - 1))));
    ac.lat = path[idx][0];
    ac.lon = path[idx][1];
    ac.hdg = Math.round(bearing(dep[0], dep[1], arr[0], arr[1]));
    return;
  }
  if (dep) {
    ac.lat = dep[0] + (Math.random() - 0.5) * 0.4;
    ac.lon = dep[1] + (Math.random() - 0.5) * 0.4;
    ac.hdg = ac.hdg || 270;
    return;
  }
  ac.lat = 38.5 + (Math.random() - 0.5) * 2;
  ac.lon = -77.5 + (Math.random() - 0.5) * 2;
  ac.hdg = ac.hdg || 270;
}

/**
 * Apply a successfully parsed MCA command to aircraft sim state.
 * @param {object} ac
 * @param {object} parsed — parseMcaCommand success result
 */
export function applyCommandToAircraft(ac, parsed) {
  if (!ac || !parsed || !parsed.ok) return ac;
  const p = parsed.payload;
  const verb = parsed.verb;

  if (verb === "QZ" || verb === "QQ") {
    if (verb === "QQ") {
      ac.interimAlt = p.fl;
    } else {
      ac.interimAlt = null;
      ac.assignedAlt = p.fl;
    }
    if (p.fl > ac.alt) {
      ac.climbing = true;
      ac.descending = false;
    } else if (p.fl < ac.alt) {
      ac.descending = true;
      ac.climbing = false;
    }
  }

  if (verb === "QU" && p.fix) {
    ac.directFix = p.fix;
    const fc = fixCoord(p.fix);
    if (fc) {
      ac.directLat = fc.lat;
      ac.directLon = fc.lon;
      ac.assignedHdg = Math.round(bearing(ac.lat, ac.lon, fc.lat, fc.lon));
    }
  }

  if (verb === "QS") {
    if (p.type === "spd") {
      ac.assignedSpd = p.kt;
    } else if (p.type === "hdg") {
      if (p.mode === "PH") {
        ac.assignedHdg = Math.round(ac.hdg || 0) || 360;
      } else {
        ac.assignedHdg = p.hdg;
      }
      ac.directFix = null;
    }
  }
  return ac;
}

function turnToward(current, target, rateDeg) {
  let c = ((current % 360) + 360) % 360;
  let t = ((target % 360) + 360) % 360;
  let diff = t - c;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  if (Math.abs(diff) <= rateDeg) return t;
  return c + Math.sign(diff) * rateDeg;
}

function advancePosition(ac, dtSec) {
  const gs = ac.gs || 0;
  if (!gs || ac.lat == null || ac.lon == null) return;
  const nm = (gs / 3600) * dtSec;
  const distDeg = nm / 60;
  const h = ((ac.hdg || 0) * Math.PI) / 180;
  const lat = ac.lat + distDeg * Math.cos(h);
  const lon = ac.lon + (distDeg * Math.sin(h)) / Math.cos((ac.lat * Math.PI) / 180);
  ac.lat = lat;
  ac.lon = lon;
}

/**
 * Advance simulation one tick.
 * @param {object[]} aircraft
 * @param {number} dtMs
 */
export function tickSimulation(aircraft, dtMs) {
  const dt = dtMs / 1000;
  const turnRate = 2.5 * dt * 60;
  const altRate = (1800 / 60) * dt;

  for (const ac of aircraft || []) {
    if (ac.directLat != null && ac.directLon != null) {
      const brg = bearing(ac.lat, ac.lon, ac.directLat, ac.directLon);
      ac.hdg = turnToward(ac.hdg || 0, brg, turnRate);
      const dist = Math.hypot(ac.lat - ac.directLat, ac.lon - ac.directLon);
      if (dist < 0.08) {
        ac.directFix = null;
        ac.directLat = null;
        ac.directLon = null;
      }
    } else if (ac.assignedHdg != null) {
      ac.hdg = turnToward(ac.hdg || 0, ac.assignedHdg, turnRate);
    }

    if (ac.assignedSpd != null) {
      const diff = ac.assignedSpd - (ac.gs || 0);
      ac.gs = (ac.gs || 0) + Math.sign(diff) * Math.min(Math.abs(diff), 40 * dt);
    }

    const targetAlt = ac.interimAlt != null ? ac.interimAlt : ac.assignedAlt;
    if (targetAlt != null) {
      const diff = targetAlt - (ac.alt || 0);
      if (Math.abs(diff) <= altRate) {
        ac.alt = targetAlt;
        ac.climbing = false;
        ac.descending = false;
      } else if (diff > 0) {
        ac.alt = (ac.alt || 0) + altRate;
        ac.climbing = true;
        ac.descending = false;
      } else {
        ac.alt = (ac.alt || 0) - altRate;
        ac.descending = true;
        ac.climbing = false;
      }
    }

    advancePosition(ac, dt);
  }
}
