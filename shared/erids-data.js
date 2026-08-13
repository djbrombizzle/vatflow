/**
 * ERIDS live-data adapters — METAR fetch + thin wrappers around EdstNotams / EdstSigmets.
 */
const DEFAULT_HUB = "https://web-production-3d9fe.up.railway.app";
const METAR_URL = "https://aviationweather.gov/api/data/metar?format=json&ids=";
const CORS_PROXIES = [
  (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
];
const FETCH_TIMEOUT_MS = 5000;

function hubBase() {
  return DEFAULT_HUB.replace(/\/+$/, "");
}

function abortPair(ms) {
  if (typeof AbortController === "undefined") {
    return { signal: undefined, cancel() {} };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => {
    try {
      ctrl.abort();
    } catch (_) {}
  }, ms || FETCH_TIMEOUT_MS);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

export function normalizeIcao(icao) {
  let id = String(icao || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (id.length === 3 && /^[A-Z]{3}$/.test(id)) {
    if (id[0] === "Y") return "C" + id;
    return "K" + id;
  }
  return id;
}

export function flightCategory(raw) {
  const m = String(raw || "");
  let vis = 10;
  if (/\bP?\d+SM\b/.test(m) || /\b10\+?SM\b/.test(m)) {
    const vm = m.match(/\b(\d{1,2})SM\b/);
    if (vm) vis = parseInt(vm[1], 10);
  }
  if (/\bM?1\/\dSM\b/.test(m) || /\b\d\/\dSM\b/.test(m)) vis = Math.min(vis, 0.75);
  let ceil = 99999;
  const re = /\b(BKN|OVC|VV)(\d{3})\b/g;
  let mm;
  while ((mm = re.exec(m))) ceil = Math.min(ceil, parseInt(mm[2], 10) * 100);
  if (ceil < 500 || vis < 1) return "LIFR";
  if (ceil < 1000 || vis < 3) return "IFR";
  if (ceil <= 3000 || vis <= 5) return "MVFR";
  return "VFR";
}

async function fetchJsonProxied(url) {
  let last = new Error("metar fetch failed");
  for (const prox of CORS_PROXIES) {
    const ab = abortPair(FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(prox(url), {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        signal: ab.signal,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (_) {
        const line = (text || "")
          .trim()
          .split(/\n/)
          .map((s) => s.trim())
          .find((s) => /^METAR\b|^SPECI\b|[A-Z]{4}\s+\d{6}Z/.test(s));
        if (line) {
          return [
            {
              rawOb: line,
              icaoId: (line.match(/\b([A-Z]{4})\b/) || [])[1] || "",
            },
          ];
        }
        throw new Error("non-JSON METAR response");
      }
    } catch (err) {
      last = err;
    } finally {
      ab.cancel();
    }
  }
  throw last;
}

async function fetchMetarViaHub(icao) {
  const ab = abortPair(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(hubBase() + "/hub/metar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icao }),
      signal: ab.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      throw new Error("hub returned non-JSON");
    }
    if (!data || typeof data !== "object") throw new Error("hub returned empty response");
    if (!data.ok) throw new Error(data.error || "HTTP " + res.status);
    if (!data.raw) throw new Error("no metar for " + icao);
    return {
      icao: normalizeIcao(data.icao || icao),
      text: String(data.raw).trim(),
      fltCat: String(data.fltCat || flightCategory(data.raw) || "").toUpperCase(),
      source: "hub",
    };
  } finally {
    ab.cancel();
  }
}

/** @returns {Promise<{icao:string,text:string,fltCat:string,source:string}>} */
export async function fetchMetar(icaoRaw) {
  const icao = normalizeIcao(icaoRaw);
  if (!/^[A-Z]{4}$/.test(icao)) throw new Error("Invalid airport ICAO");
  try {
    return await fetchMetarViaHub(icao);
  } catch (_) {
    /* hub may be down — fall through */
  }
  const data = await fetchJsonProxied(METAR_URL + encodeURIComponent(icao));
  const list = Array.isArray(data) ? data : data ? [data] : [];
  const hit =
    list.find((o) => String(o.icaoId || "").toUpperCase() === icao) || list[0];
  const raw = (hit && (hit.rawOb || hit.raw || hit.rawMetar)) || "";
  if (!String(raw).trim()) throw new Error("No METAR for " + icao);
  return {
    icao,
    text: String(raw).trim(),
    fltCat: String((hit && hit.fltCat) || flightCategory(raw) || "").toUpperCase(),
    source: "awc",
  };
}

function edstNotams() {
  return typeof window !== "undefined" ? window.EdstNotams : null;
}

function edstSigmets() {
  return typeof window !== "undefined" ? window.EdstSigmets : null;
}

export async function fetchArtccNotams(artcc) {
  const api = edstNotams();
  if (!api || typeof api.fetchNotamsForArtcc !== "function") {
    return {
      artcc: String(artcc || ""),
      entries: [],
      error: "EdstNotams module not loaded",
      fetchedAt: new Date(),
    };
  }
  const result = await api.fetchNotamsForArtcc(artcc);
  return Object.assign({ fetchedAt: new Date() }, result);
}

export async function fetchArtccSigmets(artcc) {
  const api = edstSigmets();
  if (!api || typeof api.fetchSigmetsForArtcc !== "function") {
    return {
      artcc: String(artcc || ""),
      entries: [],
      error: "EdstSigmets module not loaded",
      fetchedAt: new Date(),
    };
  }
  const result = await api.fetchSigmetsForArtcc(artcc);
  return Object.assign({ fetchedAt: new Date() }, result);
}

export function formatSigmetEntry(entry) {
  const api = edstSigmets();
  if (!entry) return "";
  if (entry.text) return String(entry.text);
  if (entry.raw && api && typeof api.firstParagraph === "function") {
    return api.firstParagraph(entry.raw) || String(entry.raw).slice(0, 280);
  }
  if (entry.fullText) return String(entry.fullText).slice(0, 280);
  if (entry.hazard) return String(entry.hazard);
  return JSON.stringify(entry).slice(0, 200);
}

export function formatNotamEntry(entry) {
  if (!entry) return "";
  const id = entry.id || entry.notamId || entry.number || "";
  const loc = entry.location || entry.icao || entry.facility || "";
  const text =
    entry.text ||
    entry.message ||
    entry.raw ||
    entry.condition ||
    "";
  const head = [id, loc].filter(Boolean).join(" · ");
  return (head ? head + "\n" : "") + String(text).trim();
}

export function formatUtcClock(d = new Date()) {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return hh + ":" + mm + ":" + ss + "Z";
}

export function formatUpdatedStamp(d) {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return formatUtcClock(dt);
}
