/**
 * FAA D-ATIS fetch, shared by the D-ATIS page (datis.html) and VATSMART's runway config.
 */
// D-ATIS sources, tried in order: atis.info's public API, then datis.clowd.io.
// Neither is guaranteed to send CORS headers, so each is tried direct and then
// through public CORS proxies (corsproxy.io last since it now wants an API key).
// The source + route that last worked is tried first.
const SOURCES = [
  { name: "atis.info", base: "https://atis.info/api/" },
  { name: "clowd.io", base: "https://datis.clowd.io/api/" },
];
const ROUTES = [
  { name: "direct", url: u => u },
  { name: "allorigins", url: u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u) },
  { name: "codetabs", url: u => "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(u) },
  { name: "corsproxy.io", url: u => "https://corsproxy.io/?url=" + encodeURIComponent(u) },
];
const COMBOS = SOURCES.flatMap((src, si) => ROUTES.map((route, ri) => ({ si, ri, src, route })));
const FETCH_TIMEOUT_MS = 8000;
let goodCombo = 0;

function comboLabel(c) {
  return c.route.name === "direct" ? c.src.name : `${c.src.name} via ${c.route.name}`;
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, data, text };
  } finally {
    clearTimeout(t);
  }
}

// Errors that come from a proxy (API key, quota, blocked) rather than from a D-ATIS API.
const PROXY_ERROR_RE = /api key|corsproxy|proxy|rate.?limit|quota|forbidden|unauthori[sz]ed|too many/i;

/**
 * Normalize a D-ATIS response to [{ type, datis, time }]. Both APIs return an
 * array of { airport, type: "combined"|"arr"|"dep", datis, time, updatedAt };
 * a single object or { data: [...] } wrapper is accepted too.
 */
export function normalizeDatis(data) {
  let list = data;
  if (list && !Array.isArray(list)) list = Array.isArray(list.data) ? list.data : [list];
  if (!Array.isArray(list)) return [];
  return list
    .map(d => d && typeof d === "object" ? {
      type: String(d.type || d.kind || "combined").toLowerCase(),
      datis: d.datis || d.text || d.atis || "",
      time: d.updatedAt || d.time || null,
    } : null)
    .filter(d => d && typeof d.datis === "string" && d.datis.trim());
}

/** D-ATIS entries for an airport, trying every source and route. */
export async function fetchDatis(icao) {
  const order = [goodCombo, ...COMBOS.keys()].filter((v, i, a) => a.indexOf(v) === i);
  const tried = [];
  let apiError = null;
  for (const i of order) {
    const c = COMBOS[i];
    let r;
    try { r = await fetchJson(c.route.url(c.src.base + encodeURIComponent(icao))); } catch (e) {
      tried.push(`${comboLabel(c)}: ${e.name === "AbortError" ? "timed out" : "blocked / network error"}`);
      continue;
    }
    const entries = normalizeDatis(r.data);
    if (r.ok && entries.length) { goodCombo = i; lastDiag = ""; return entries; }
    const err = r.data && typeof r.data.error === "string" ? r.data.error : null;
    tried.push(`${comboLabel(c)}: HTTP ${r.status} ${err || String(r.text || "").replace(/\s+/g, " ").slice(0, 80) || "(empty)"}`);
    // An API's own "no D-ATIS here" is remembered; a proxy's own error just moves on.
    if (err && !PROXY_ERROR_RE.test(err)) apiError = apiError || err;
  }
  lastDiag = tried.join("\n");
  if (apiError) throw new Error(`No D-ATIS for ${icao} (${apiError})`);
  throw new Error("Could not reach a D-ATIS source (atis.info and clowd.io, direct and via proxies)");
}

/** Airport list from atis.info /stations, through whichever route last worked. */
export async function fetchStations() {
  const c = COMBOS[goodCombo];
  if (c.src.name !== "atis.info") return null;
  try {
    const r = await fetchJson(c.route.url(c.src.base + "stations"));
    const list = Array.isArray(r.data) ? r.data : null;
    if (!list) return null;
    return list.map(x => typeof x === "string" ? x : (x && (x.airport || x.icao || x.id)))
      .filter(x => typeof x === "string" && /^[A-Z0-9]{3,4}$/i.test(x))
      .map(x => x.toUpperCase());
  } catch { return null; }
}
let lastDiag = "";

/** Where the last successful fetch came from, e.g. "atis.info" or "clowd.io via allorigins". */
export function datisSourceLabel() { return comboLabel(COMBOS[goodCombo]); }
/** What was tried when the last fetch failed, one line per source and route ("" after a success). */
export function datisDiag() { return lastDiag; }
