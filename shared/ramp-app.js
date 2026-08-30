/**
 * RampView — application wiring.
 *
 * Owns the airport model, the traffic store, the occupancy engine and the
 * assignment book, and drives the scope + side panels. Assignment is sticky:
 * it is drawn once when an inbound crosses the horizon and left alone unless
 * something actually invalidates it.
 */

import { makeProjection, applyOverrides, stampRamps, coverage } from "./ramp-airport.js";
import { parseOverpass, fetchOverpass } from "./ramp-osm.js";
import { TrafficStore, POLL_MS, etaMs } from "./ramp-traffic.js";
import { StandOccupancy } from "./ramp-stands.js";
import { assignStand, operatorOf } from "./ramp-alloc.js";
import { RampScope, fmtClock } from "./ramp-scope.js";
import { FIELDS } from "./ramp-app-fields.mjs";
import { declaredStand, fmtEta } from "./ramp-app-pure.mjs";

export { declaredStand, fmtEta };

export { FIELDS };

const CACHE_DB = "vatflow-ramp";
const CACHE_STORE = "airports";
const ASSIGN_HORIZON_NM = 40;
const RESERVE_LEAD_MS = 5 * 60000;

/* ---------------------------------------------------------------- cache --- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(key);
      tx.onsuccess = () => resolve(tx.result || null);
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) { return null; }
}

async function cachePut(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE).put(value, key);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) { /* cache is best effort */ }
}

/* ----------------------------------------------------------------- load --- */

/**
 * Resolve an airport's surface model.
 * 1. `data/ramp/<ICAO>.json` if the build has been run and committed.
 * 2. the browser's IndexedDB cache from a previous OSM fetch.
 * 3. nothing — the caller offers "fetch from OpenStreetMap".
 */
export async function loadAirport(icao, onStatus) {
  const field = FIELDS[icao];
  if (!field) throw new Error("Unknown field " + icao);
  const overrides = await fetchJson(`data/ramp/overrides/${icao}.json`);

  let model = await fetchJson(`data/ramp/${icao}.json`);
  let origin = "built";
  if (!model) {
    model = await cacheGet(icao);
    origin = model ? "cache" : null;
  }
  if (!model) return { model: null, overrides, origin: null, field };
  if (onStatus) onStatus(`Surface loaded (${origin})`);
  return { model: finalise(model, overrides), overrides, origin, field };
}

/** Fetch the surface live from Overpass, then cache it. */
export async function fetchAirportFromOsm(icao, overrides, onStatus) {
  const field = FIELDS[icao];
  const osm = await fetchOverpass(field.ref, onStatus);
  if (onStatus) onStatus("Parsing surface…");
  const model = parseOverpass(osm, { icao, ref: field.ref });
  await cachePut(icao, model);
  return finalise(model, overrides);
}

function finalise(model, overrides) {
  const merged = applyOverrides(stampRamps(model), overrides);
  merged.coverage = coverage(merged);
  return merged;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

/* ------------------------------------------------------------------ app --- */

export class RampApp {
  /**
   * @param {object} opts { canvas, icao, onRender, onStatus }
   */
  constructor(opts) {
    this.icao = opts.icao;
    this.onRender = opts.onRender || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.scope = new RampScope(opts.canvas, {
      onCursor: opts.onCursor,
      onPick: hit => this.onPick(hit),
    });
    this.model = null;
    this.traffic = null;
    this.occupancy = null;
    /** callsign -> { standId, source, confidence, pinned, byCid, atMs, etaText, ramp } */
    this.assignments = new Map();
    this.closures = new Set();
    this.myRamp = null;
    this.paused = false;
    this.lastFrameMs = performance.now();
    this.selected = null;
    this._raf = null;
    this._timer = null;
  }

  async start(icao) {
    if (icao) this.icao = icao;
    this.assignments.clear();
    const { model, overrides, origin, field } = await loadAirport(this.icao, this.onStatus);
    this.overrides = overrides;
    this.field = field;
    if (model) this.useModel(model);
    else this.onStatus("No surface data for " + this.icao + " — fetch it from OpenStreetMap.");
    this.origin = origin;
    this.startLoops();
    return !!model;
  }

  /** Pull the surface from Overpass in the browser and use it immediately. */
  async fetchSurface() {
    this.onStatus("Fetching surface from OpenStreetMap…");
    const model = await fetchAirportFromOsm(this.icao, this.overrides, this.onStatus);
    this.useModel(model);
    this.origin = "osm";
    this.onStatus(`Surface fetched — ${model.stands.length} stands, ${model.taxiways.length} taxiways.`);
    return model;
  }

  useModel(model) {
    this.model = model;
    this.scope.setModel(model);
    this.occupancy = new StandOccupancy(model.stands);
    this.traffic = new TrafficStore({
      icao: this.icao,
      proj: makeProjection(this.field.ref[0], this.field.ref[1]),
      ref: this.field.ref,
      elevFt: this.field.elevFt,
      horizonNm: ASSIGN_HORIZON_NM,
    });
  }

  startLoops() {
    if (this._timer) clearInterval(this._timer);
    this.pollNow();
    this._timer = setInterval(() => this.pollNow(), POLL_MS);
    if (!this._raf) this.frame();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._timer = this._raf = null;
  }

  async pollNow() {
    if (!this.traffic || this.paused) return;
    try {
      await this.traffic.poll();
      this.tick();
      this.onStatus(null);
    } catch (err) {
      this.onStatus("Datafeed error: " + err.message);
    }
  }

  /** One logic step: occupancy, then assignment, then panel data. */
  tick() {
    const nowMs = Date.now();
    const targets = [...this.traffic.targets.values()];
    this.occupancy.update(nowMs, targets.filter(t => t.onGround));
    for (const t of targets) t.standId = this.occupancy.standOf(t.callsign);
    this.reconcileAssignments(nowMs, targets);
    this.pushState(targets, nowMs);
    this.onRender(this.panels(nowMs));
  }

  /**
   * Draw a stand for every inbound inside the horizon that does not have one,
   * and redraw only when an existing assignment has actually become invalid.
   */
  reconcileAssignments(nowMs, targets) {
    const blocked = this.occupancy.blockedStands();
    const occupancySet = new Set(this.occupancy.occupied.keys());
    const reservations = new Map();
    for (const [cs, a] of this.assignments) {
      if (a.standId) reservations.set(a.standId, { callsign: cs });
    }

    for (const t of targets) {
      if (t.arr !== this.icao) continue;
      const parked = this.occupancy.standOf(t.callsign);
      if (parked) {
        // Observed beats everything — the assignment has served its purpose.
        this.assignments.delete(t.callsign);
        continue;
      }
      if ((t.distNm || 999) > ASSIGN_HORIZON_NM) continue;

      const eta = etaMs(t, nowMs);
      const existing = this.assignments.get(t.callsign);
      if (existing) {
        existing.etaText = fmtEta(eta);
        const stillValid = existing.pinned || (
          existing.standId &&
          !occupancySet.has(existing.standId) &&
          !this.closures.has(existing.standId) &&
          !blocked.has(existing.standId)
        );
        if (stillValid) continue;
        if (existing.pinned) { existing.conflict = occupancySet.has(existing.standId); continue; }
      }

      const declared = declaredStand(t, this.model);
      let res;
      if (declared) {
        res = { standId: declared, source: "pilot", confidence: "high" };
      } else {
        res = assignStand(
          { callsign: t.callsign, sizeCode: t.sizeCode, intl: t.intl },
          this.model.stands,
          {
            operatorBlocks: this.model.operatorBlocks,
            occupancy: occupancySet,
            closures: this.closures,
            blocked,
            reservations,
            nowMs,
            etaMs: eta,
            reserveLeadMs: RESERVE_LEAD_MS,
          }
        );
      }
      const stand = this.model.stands.find(s => s.id === res.standId);
      this.assignments.set(t.callsign, {
        ...res,
        etaText: fmtEta(eta),
        ramp: stand ? stand.ramp : null,
        atMs: nowMs,
        pinned: false,
      });
      if (res.standId) reservations.set(res.standId, { callsign: t.callsign });
    }

    // Drop assignments for flights that have gone.
    const live = new Set(targets.map(t => t.callsign));
    for (const cs of [...this.assignments.keys()]) {
      if (!live.has(cs)) this.assignments.delete(cs);
    }
  }

  /** Manual assignment from the controller — pinned, and never redrawn. */
  assignManual(callsign, standId) {
    const cs = String(callsign || "").toUpperCase();
    const stand = this.model.stands.find(s => s.id === String(standId || "").toUpperCase());
    if (!stand) return false;
    this.assignments.set(cs, {
      standId: stand.id,
      source: "controller",
      confidence: "high",
      pinned: true,
      ramp: stand.ramp,
      atMs: Date.now(),
      etaText: (this.assignments.get(cs) || {}).etaText || "",
    });
    this.tick();
    return true;
  }

  clearAssignment(callsign) {
    this.assignments.delete(String(callsign || "").toUpperCase());
    this.tick();
  }

  toggleClosure(standId) {
    const id = String(standId || "").toUpperCase();
    if (this.closures.has(id)) this.closures.delete(id);
    else this.closures.add(id);
    this.tick();
  }

  setMyRamp(ramp) {
    this.myRamp = ramp || null;
    this.tick();
  }

  onPick(hit) {
    this.selected = hit;
    if (hit && hit.kind === "target") {
      const t = hit.target;
      this.scope.goTo(t.dispX, t.dispY);
    }
    this.tick();
  }

  pushState(targets, nowMs) {
    this.scope.setState({
      targets,
      occupancy: this.occupancy.occupied,
      assignments: this.assignments,
      closures: this.closures,
      blocked: this.occupancy.blockedStands(),
      myRamp: this.myRamp,
      nowMs,
    });
  }

  /** Data for the side panels. */
  panels(nowMs) {
    const arrivals = this.traffic.arrivals(nowMs).map(t => {
      const a = this.assignments.get(t.callsign);
      return {
        callsign: t.callsign,
        type: t.type,
        distNm: t.distNm,
        eta: fmtEta(t.etaMs),
        stand: a ? a.standId : null,
        ramp: a ? a.ramp : null,
        source: a ? a.source : "unassigned",
        conflict: !!(a && a.conflict),
      };
    });
    const departures = this.traffic.departures().map(t => ({
      callsign: t.callsign,
      type: t.type,
      phase: t.phase,
      sid: t.sid,
      stand: t.standId,
      ramp: standRamp(this.model, t.standId),
    }));
    const ramps = (this.model.ramps || []).map(r => {
      const stands = this.model.stands.filter(s => s.ramp === r.id);
      const occupied = stands.filter(s => this.occupancy.occupied.has(s.id)).length;
      const inbound = arrivals.filter(a => a.ramp === r.id).length;
      return { id: r.id, label: r.label, freq: r.freq || null, stands: stands.length, occupied, inbound };
    });
    return {
      arrivals, departures, ramps,
      counts: {
        targets: this.traffic.targets.size,
        occupied: this.occupancy.occupied.size,
        stands: this.model.stands.length,
        unassigned: arrivals.filter(a => !a.stand).length,
      },
      selected: this.selected,
      lastFetchMs: this.traffic.lastFetchMs,
    };
  }

  frame() {
    const now = performance.now();
    const dt = now - this.lastFrameMs;
    this.lastFrameMs = now;
    if (this.traffic && !this.paused) this.traffic.extrapolate(dt);
    if (this.scope) this.scope.render();
    this._raf = requestAnimationFrame(() => this.frame());
  }
}

function standRamp(model, standId) {
  if (!standId) return null;
  const s = model.stands.find(x => x.id === standId);
  return s ? s.ramp : null;
}


export { fmtClock };
