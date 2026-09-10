/**
 * Per-airport departure configuration for taxi-time estimation.
 *
 * Shared, not per-browser: the config lives on vatflow-hub so that a field set
 * up by whoever is running the flow is the same config every other controller's
 * estimate uses. A ZDC controller configuring KIAD's runways is what KIAD_TWR
 * sees, and what an unsigned observer sees.
 *
 * Reads are synchronous against an in-memory cache, because the estimator asks
 * for a field's config on every render pass. syncTaxiConfigs() refreshes that
 * cache from the hub; localStorage is a mirror so a reload still has yesterday's
 * flow while the first fetch is in flight, and so the page keeps working if the
 * hub is unreachable.
 *
 * Writes are optimistic: the local cache updates immediately so the UI does not
 * lag a round trip, then the hub call either confirms it or reports why not.
 * The hub is the authority on permission — it re-checks every write against the
 * whitelist and the live controller feed, so a client that guesses wrong just
 * gets a 403.
 */
import { normalizeRunway, sidBase } from "./taxi-estimate.js";
import { getAccessApiBase } from "./vatflow-access-api.js";
import { getStoredToken } from "./vatflow-auth.js";

const KEY_PREFIX = "vatflow.taxiConfig.v1.";
/** How long a synced snapshot is treated as fresh enough to skip a refetch. */
const SYNC_TTL_MS = 60000;

export const DEFAULT_CONFIG = {
  activeRunways: [],   // [] = infer from geometry rather than assume a flow
  sidRules: {},        // SID base name -> runway, overriding published transitions
  spoolSec: null,      // null = use the estimator default
  taxiKt: null,
  rwyIntervalSec: null,
};

/** ICAO -> config, the synchronous read path. */
const cache = new Map();
/** ICAO -> { via } for fields this user may write; empty until checked. */
const writable = new Map();
let lastSyncAt = 0;
let syncInflight = null;
let signedIn = false;

function hubBase() {
  return getAccessApiBase().replace(/\/+$/, "");
}
function key(icao) {
  return KEY_PREFIX + String(icao || "").toUpperCase();
}
function icaoOf(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function sanitize(raw) {
  const cfg = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== "object") return cfg;

  cfg.activeRunways = Array.isArray(raw.activeRunways)
    ? [...new Set(raw.activeRunways.map(normalizeRunway).filter(Boolean))]
    : [];

  cfg.sidRules = {};
  if (raw.sidRules && typeof raw.sidRules === "object") {
    for (const [sid, rwy] of Object.entries(raw.sidRules)) {
      const s = sidBase(sid);
      const r = normalizeRunway(rwy);
      if (s && r) cfg.sidRules[s] = r;
    }
  }

  const posNum = (v, min, max) => {
    const n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) && n >= min && n <= max ? n : null;
  };
  cfg.spoolSec = posNum(raw.spoolSec, 0, 900);
  cfg.taxiKt = posNum(raw.taxiKt, 3, 40);
  cfg.rwyIntervalSec = posNum(raw.rwyIntervalSec, 20, 600);
  return cfg;
}

function readMirror(icao) {
  try {
    const raw = localStorage.getItem(key(icao));
    return raw ? sanitize(JSON.parse(raw)) : null;
  } catch (e) {
    return null;
  }
}

function writeMirror(icao, cfg) {
  try { localStorage.setItem(key(icao), JSON.stringify(cfg)); } catch (e) { /* quota / private mode */ }
}

/**
 * Config for one airport. Always returns a usable object — an unconfigured
 * field estimates from geometry rather than failing.
 */
export function loadTaxiConfig(icao) {
  const id = icaoOf(icao);
  if (cache.has(id)) return cache.get(id);
  const mirrored = readMirror(id);
  const cfg = mirrored || { ...DEFAULT_CONFIG };
  cache.set(id, cfg);
  return cfg;
}

/** True once a hub snapshot has landed — lets the UI distinguish empty from unknown. */
export function isTaxiConfigSynced() {
  return lastSyncAt > 0;
}

/** Fields this user may currently write, as ICAO -> { via }. */
export function writableFields() {
  return new Map(writable);
}

export function canEditTaxiConfig(icao) {
  return writable.has(icaoOf(icao));
}

export function taxiConfigSignedIn() {
  return signedIn;
}

/**
 * Pull every airport's config from the hub into the cache.
 * Resolves to false when the hub is unreachable — callers keep the mirrored
 * values rather than blanking a controller's setup mid-session.
 */
export function syncTaxiConfigs(opts = {}) {
  if (!opts.force && Date.now() - lastSyncAt < SYNC_TTL_MS) return Promise.resolve(true);
  if (syncInflight) return syncInflight;
  syncInflight = fetch(`${hubBase()}/taxi/config`, {
    method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
  })
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      if (!data || !data.ok || !data.configs) return false;
      for (const [icao, raw] of Object.entries(data.configs)) {
        const id = icaoOf(icao);
        const cfg = sanitize(raw);
        cache.set(id, cfg);
        writeMirror(id, cfg);
      }
      lastSyncAt = Date.now();
      return true;
    })
    .catch(() => false)
    .finally(() => { syncInflight = null; });
  return syncInflight;
}

/**
 * Ask the hub which of these fields this user may configure.
 * Never throws — on any failure the user is simply treated as read-only.
 */
export function syncTaxiPermissions(icaos) {
  const list = [...new Set((icaos || []).map(icaoOf).filter(Boolean))];
  const token = getStoredToken();
  if (!token || !list.length) {
    signedIn = false;
    writable.clear();
    return Promise.resolve(writable);
  }
  return fetch(`${hubBase()}/taxi/permissions?icao=${encodeURIComponent(list.join(","))}`, {
    method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
    headers: { authorization: `Bearer ${token}` },
  })
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      writable.clear();
      signedIn = !!(data && data.signedIn);
      for (const f of (data && data.fields) || []) {
        if (f && f.icao) writable.set(icaoOf(f.icao), { via: f.via || "" });
      }
      return writable;
    })
    .catch(() => { writable.clear(); return writable; });
}

/**
 * Merge a patch into one airport's config, apply it locally, and push to the hub.
 * @returns {Promise<{ok: boolean, error?: string, config: object}>}
 */
export function saveTaxiConfig(icao, patch) {
  const id = icaoOf(icao);
  const merged = sanitize({ ...loadTaxiConfig(id), ...(patch || {}) });
  cache.set(id, merged);
  writeMirror(id, merged);

  const token = getStoredToken();
  if (!token) return Promise.resolve({ ok: false, error: "auth_required", config: merged });

  return fetch(`${hubBase()}/taxi/config`, {
    method: "POST", mode: "cors", credentials: "omit",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ icao: id, config: merged }),
  })
    .then(r => r.json().then(d => ({ status: r.status, d })).catch(() => ({ status: r.status, d: {} })))
    .then(({ status, d }) => {
      if (status === 200 && d && d.ok) {
        const confirmed = sanitize(d.config || merged);
        cache.set(id, confirmed);
        writeMirror(id, confirmed);
        return { ok: true, config: confirmed, via: d.via };
      }
      return { ok: false, error: (d && d.error) || ("http_" + status), config: merged };
    })
    .catch(() => ({ ok: false, error: "hub_unreachable", config: merged }));
}

/** Toggle one runway in or out of the active departure set. */
export function toggleActiveRunway(icao, runway) {
  const id = normalizeRunway(runway);
  if (!id) return Promise.resolve({ ok: false, error: "bad_runway", config: loadTaxiConfig(icao) });
  const cfg = loadTaxiConfig(icao);
  const active = cfg.activeRunways.includes(id)
    ? cfg.activeRunways.filter(r => r !== id)
    : [...cfg.activeRunways, id];
  return saveTaxiConfig(icao, { activeRunways: active });
}

/**
 * Pin a SID to a runway; a blank runway clears the rule.
 * Keyed on the base name, so pinning BANNG3 also pins BANNG4.
 */
export function setSidRule(icao, sid, runway) {
  const s = sidBase(sid);
  if (!s) return Promise.resolve({ ok: false, error: "bad_sid", config: loadTaxiConfig(icao) });
  const cfg = loadTaxiConfig(icao);
  const rules = { ...cfg.sidRules };
  const r = normalizeRunway(runway);
  if (r) rules[s] = r; else delete rules[s];
  return saveTaxiConfig(icao, { sidRules: rules });
}

/** Drop a pinned SID rule entirely. */
export function removeSidRule(icao, sid) {
  return setSidRule(icao, sid, "");
}

/** Seed the cache directly — tests and offline demo. */
export function seedTaxiConfig(icao, cfg) {
  cache.set(icaoOf(icao), sanitize(cfg));
}

export function clearTaxiConfig(icao) {
  const id = icaoOf(icao);
  cache.set(id, { ...DEFAULT_CONFIG });
  try { localStorage.removeItem(key(id)); } catch (e) {}
  return cache.get(id);
}
