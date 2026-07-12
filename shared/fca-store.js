/**
 * Shared Supabase FCA store — load/subscribe, normalize, push, membership lookup.
 */
import {
  explainFcaExclusion, computeSequence, getRelease, fpFields,
} from "./fca-metering.js";

export const SUPABASE_URL = "https://qoaipsfcidpymboojfwa.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_6Pj7jeRN0AQBcjl44MoCNA_zjsvFs79";
export const LS_FCAS = "fcaBuilder.fcas.v1";
export const FCAS_CHANGED = "vatflow-fcas-changed";

let sb = null;
let fcas = [];
let canPushFn = () => false;
let ready = false;

export function normalizeFca(f) {
  if (!f) return null;
  if (!f.id) f.id = "fca_" + Date.now();
  if (!Array.isArray(f.points)) f.points = [];
  if (!Array.isArray(f.order)) f.order = [];
  if (!f.releases || typeof f.releases !== "object" || Array.isArray(f.releases)) f.releases = {};
  if (f.enabled == null) f.enabled = true;
  return f;
}

export function getFcas() { return fcas; }

export function vatsimToMeterPilot(p) {
  const fp = p && p.flight_plan;
  if (!fp || typeof p.latitude !== "number" || typeof p.longitude !== "number") return null;
  const f = fpFields(fp);
  const gs = p.groundspeed || 0;
  return {
    callsign: p.callsign,
    lat: p.latitude,
    lon: p.longitude,
    alt: p.altitude || 0,
    gs,
    hdg: p.heading || 0,
    phase: gs < 50 ? "gnd" : "air",
    ...f,
  };
}

export function meterPilotsFromVatsim(vatsim) {
  if (!vatsim) return [];
  return (vatsim.pilots || []).map(vatsimToMeterPilot).filter(Boolean);
}

/**
 * First enabled FCA program that includes this pilot in its ground sequence.
 */
export function fcaMembershipForPilot(pilot, pilots, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  if (!pilot || !pilot.callsign) return null;
  const list = pilots && pilots.length ? pilots : [pilot];
  for (const fca of fcas) {
    if (!fca.enabled || !fca.points || fca.points.length < 2) continue;
    const gate = explainFcaExclusion(fca, pilot);
    if (!gate.included) continue;
    const seq = computeSequence(fca, list, [], { includeEdct: true, nowMs });
    const item = seq.items.find(it => it.p && it.p.callsign === pilot.callsign && it.phase === "gnd");
    if (item) {
      return { fca, item, release: getRelease(fca, pilot.callsign) };
    }
  }
  return null;
}

function persistLocalFcas() {
  try { localStorage.setItem(LS_FCAS, JSON.stringify(fcas)); } catch (_) {}
}

export function cloudPushFca(fca, opts = {}) {
  persistLocalFcas();
  if (!canPushFn() || !sb || !fca) return;
  sb.from("fcas").upsert({ id: fca.id, data: fca, updated_at: new Date().toISOString() })
    .then(({ error }) => { if (error) console.warn("fca push:", error); });
}

function setFcas(arr) {
  fcas = (arr || []).map(normalizeFca).filter(Boolean);
  persistLocalFcas();
  window.dispatchEvent(new CustomEvent(FCAS_CHANGED, { detail: { fcas } }));
}

function loadLocalFcas() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_FCAS) || "[]");
    if (Array.isArray(arr) && arr.length) fcas = arr.map(normalizeFca).filter(Boolean);
  } catch (_) {}
}

/**
 * @param {{ canPush?: () => boolean }} opts
 */
export async function init(opts = {}) {
  canPushFn = opts.canPush || (() => false);
  loadLocalFcas();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) {
    ready = true;
    return;
  }
  try { sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); }
  catch (e) { console.warn(e); ready = true; return; }
  const { data, error } = await sb.from("fcas").select("*");
  if (!error && data) setFcas(data.map(r => r.data || {}));
  sb.channel("fca-store-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "fcas" }, () => {
      sb.from("fcas").select("*").then(({ data: rows }) => {
        if (rows) setFcas(rows.map(r => r.data || {}));
      });
    })
    .subscribe();
  ready = true;
}

export function isFcaStoreReady() { return ready; }
