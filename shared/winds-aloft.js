/**
 * US winds aloft (Aviation Weather Center FB tables) for enroute ETA adjustment.
 * Fails safe to still air when data unavailable.
 */

const WIND_REGIONS = ["bos", "mia", "chi", "dfw", "slc", "sfo"];
const WIND_PROXIES = [
  u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  u => "https://corsproxy.io/?url=" + encodeURIComponent(u),
];

let windStations = {};
let windInfo = { status: "off", count: 0, time: null };
let windHwCache = {};
let lookupAirport = () => null;

export function bindWindAirportLookup(fn) {
  lookupAirport = fn || lookupAirport;
}

export function getWindInfo() { return { ...windInfo }; }

function rad(d) { return d * Math.PI / 180; }

function gcDist(la1, lo1, la2, lo2) {
  const R = 3440.065;
  const dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function decodeFB(g) {
  if (!g || !/^\d{4}/.test(g)) return null;
  if (g.slice(0, 4) === "9900") return { dir: null, spd: 0 };
  let dd = parseInt(g.slice(0, 2), 10), ss = parseInt(g.slice(2, 4), 10);
  if (isNaN(dd) || isNaN(ss)) return null;
  if (dd > 36) { dd -= 50; ss += 100; }
  return { dir: (dd * 10) % 360, spd: ss };
}

export function parseWindtemp(text) {
  const stations = {};
  const lines = String(text).split(/\r?\n/);
  let levels = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, " ");
    if (/\bFT\b/.test(line) && /\d{4,5}/.test(line)) {
      levels = [];
      let m; const re = /\d{4,5}/g;
      while ((m = re.exec(line))) levels.push({ alt: +m[0], center: m.index + m[0].length / 2 });
      continue;
    }
    if (!levels) continue;
    const idm = line.match(/^\s*([A-Z0-9]{3})\s/);
    if (!idm) continue;
    const lev = {};
    let m; const gre = /\S+/g;
    gre.lastIndex = idm[0].length - 1;
    while ((m = gre.exec(line))) {
      const tok = m[0], center = m.index + tok.length / 2;
      let best = null, bd = 1e9;
      for (const L of levels) {
        const d = Math.abs(L.center - center);
        if (d < bd) { bd = d; best = L; }
      }
      if (best) { const w = decodeFB(tok); if (w) lev[best.alt] = w; }
    }
    if (Object.keys(lev).length) stations[idm[1]] = { levels: lev };
  }
  return stations;
}

export function parseAltFt(a) {
  if (a == null) return 35000;
  const s = String(a).toUpperCase().replace(/[^0-9]/g, "");
  if (!s) return 35000;
  let n = parseInt(s, 10);
  if (n <= 600) n *= 100;
  return n < 1000 ? 35000 : n;
}

function bearingDeg(a1, o1, a2, o2) {
  const y = Math.sin(rad(o2 - o1)) * Math.cos(rad(a2));
  const x = Math.cos(rad(a1)) * Math.sin(rad(a2)) - Math.sin(rad(a1)) * Math.cos(rad(a2)) * Math.cos(rad(o2 - o1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function nearestWind(lat, lon, altFt) {
  let best = null, bd = 1e9;
  for (const id in windStations) {
    const s = windStations[id];
    const d = gcDist(lat, lon, s.lat, s.lon);
    if (d < bd) { bd = d; best = s; }
  }
  if (!best || bd > 600) return null;
  let lvl = null, ld = 1e9;
  for (const a in best.levels) {
    const d = Math.abs(+a - altFt);
    if (d < ld) { ld = d; lvl = best.levels[a]; }
  }
  return lvl;
}

/** Mean headwind (kt) along path; + = headwind. */
export function routeHeadwind(points, altFt) {
  if (!points || points.length < 2 || !Object.keys(windStations).length) return null;
  const key = points.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("|") + "|" + Math.round(altFt / 1000);
  if (key in windHwCache) return windHwCache[key];
  let sum = 0, cnt = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const course = bearingDeg(a[0], a[1], b[0], b[1]);
    const lat = (a[0] + b[0]) / 2, lon = (a[1] + b[1]) / 2;
    const w = nearestWind(lat, lon, altFt);
    if (w && w.dir != null && w.spd) { sum += w.spd * Math.cos(rad(w.dir - course)); cnt++; }
    else if (w && w.spd === 0) cnt++;
  }
  const v = cnt ? sum / cnt : null;
  windHwCache[key] = v;
  return v;
}

/** Headwind at a single point along a course (kt). */
export function pointHeadwind(lat, lon, courseDeg, altFt) {
  const w = nearestWind(lat, lon, altFt);
  if (!w || w.dir == null) return w && w.spd === 0 ? 0 : null;
  return w.spd * Math.cos(rad(w.dir - courseDeg));
}

export async function fetchWinds() {
  windInfo.status = "loading";
  const merged = {};
  let ok = 0;
  for (const reg of WIND_REGIONS) {
    const url = "https://aviationweather.gov/api/data/windtemp?region=" + reg + "&level=low";
    let text = null;
    for (const prox of WIND_PROXIES) {
      try {
        const r = await fetch(prox(url));
        if (r.ok) {
          text = await r.text();
          if (text && /\bFT\b/.test(text)) break;
          text = null;
        }
      } catch (e) { /* try next proxy */ }
    }
    if (text) { Object.assign(merged, parseWindtemp(text)); ok++; }
  }
  const out = {};
  let count = 0;
  for (const id in merged) {
    const pt = lookupAirport("K" + id) || lookupAirport("P" + id) || lookupAirport(id);
    if (pt) { out[id] = { lat: pt[0], lon: pt[1], levels: merged[id].levels }; count++; }
  }
  windStations = out;
  windHwCache = {};
  windInfo = { status: count > 0 ? "ok" : "error", count, time: Date.now() };
  return windInfo;
}

export function effectiveGs(tas, headwind) {
  if (headwind == null) return tas;
  return Math.max(tas * 0.4, Math.min(tas * 1.6, tas - headwind));
}
