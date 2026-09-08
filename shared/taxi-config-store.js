/**
 * Per-airport departure configuration for taxi-time estimation.
 *
 * What a controller sets: which runways are departing, and any SID that should
 * override the published runway transitions. Everything else has a default that
 * works untouched — an unconfigured field still estimates, just from geometry
 * and the nearest runway rather than a known departure flow.
 *
 * Storage is localStorage, per airport. Deliberately behind load/save so a
 * shared backend (the Firebase taximon/* nodes, or a Supabase table) can be
 * dropped in later without touching callers.
 */
import { normalizeRunway, sidBase } from "./taxi-estimate.js";

const KEY_PREFIX = "vatflow.taxiConfig.v1.";

export const DEFAULT_CONFIG = {
  activeRunways: [],   // [] = infer from geometry rather than assume a flow
  sidRules: {},        // SID base name -> runway, overriding published transitions
  spoolSec: null,      // null = use the estimator default
  taxiKt: null,
  rwyIntervalSec: null,
};

function key(icao) {
  return KEY_PREFIX + String(icao || "").toUpperCase();
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

/** Config for one airport. Always returns a usable object. */
export function loadTaxiConfig(icao) {
  try {
    const raw = localStorage.getItem(key(icao));
    return sanitize(raw ? JSON.parse(raw) : null);
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

/** Merge a patch into one airport's config and persist it. Returns the result. */
export function saveTaxiConfig(icao, patch) {
  const merged = sanitize({ ...loadTaxiConfig(icao), ...(patch || {}) });
  try {
    localStorage.setItem(key(icao), JSON.stringify(merged));
  } catch (e) { /* private mode / quota — config stays in memory for this render */ }
  return merged;
}

/** Toggle one runway in or out of the active departure set. */
export function toggleActiveRunway(icao, runway) {
  const id = normalizeRunway(runway);
  if (!id) return loadTaxiConfig(icao);
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
  if (!s) return loadTaxiConfig(icao);
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

export function clearTaxiConfig(icao) {
  try { localStorage.removeItem(key(icao)); } catch (e) {}
  return { ...DEFAULT_CONFIG };
}
