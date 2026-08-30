/**
 * RampView — application wiring.
 *
 * Owns the airport model, the traffic store, the occupancy engine and the
 * assignment book, and drives the scope + side panels. Assignment is sticky:
 * it is drawn once when an inbound crosses the horizon and left alone unless
 * something actually invalidates it.
 */

import { makeProjection, applyOverrides, stampRamps, coverage, fitStandBoxes } from "./ramp-airport.js";
import { parseOverpass, fetchOverpass } from "./ramp-osm.js";
import { TrafficStore, POLL_MS, etaMs } from "./ramp-traffic.js";
import { StandOccupancy } from "./ramp-stands.js";
import { assignStand, operatorOf } from "./ramp-alloc.js";
import { groundInbounds, entrySpot } from "./ramp-ground.js";
import { departureSpot, sideForSid, mergeSidSides, sidKey } from "./ramp-sid.js";
import { RampScope, fmtClock } from "./ramp-scope.js";
import { FIELDS } from "./ramp-app-fields.mjs";
import { declaredStand, fmtEta } from "./ramp-app-pure.mjs";

export { declaredStand, fmtEta };

/** Departure phases the ramp still owns. */
const DEPARTURE_PHASES = new Set(["IN_BLOCK", "TURN", "PUSHBACK", "TAXI_OUT", "HOLDING"]);

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

/** The two surfaces a field can have, kept side by side rather than replacing each other. */
export const SOURCE_SCHEMATIC = "schematic";
export const SOURCE_OSM = "osm";

const osmKey = icao => icao + ":osm";

/**
 * Resolve an airport's surface model.
 *
 * Both surfaces are independent: the committed schematic (clean gate labels and
 * face-level ramp ownership) and the OSM fetch (real taxiway geometry). Loading
 * one never discards the other, so a controller can switch back and forth.
 *
 * @param {string} icao
 * @param {{ source?: string, onStatus?: Function }} [opts]
 */
export async function loadAirport(icao, opts = {}) {
  const field = FIELDS[icao];
  if (!field) throw new Error("Unknown field " + icao);
  const onStatus = opts.onStatus;
  const overrides = await fetchJson(`data/ramp/overrides/${icao}.json`);
  const want = opts.source || null;

  const schematic = want === SOURCE_OSM ? null : await fetchJson(`data/ramp/${icao}.json`);
  // A committed OSM surface means nobody has to fetch anything: export one from
  // the page and drop it in as <ICAO>.osm.json.
  const osm = want === SOURCE_SCHEMATIC
    ? null
    : (await fetchJson(`data/ramp/${icao}.osm.json`)) || (await cacheGet(osmKey(icao)));

  let model = null;
  let origin = null;
  if (want === SOURCE_OSM && osm) { model = osm; origin = SOURCE_OSM; }
  else if (want === SOURCE_SCHEMATIC && schematic) { model = schematic; origin = SOURCE_SCHEMATIC; }
  else if (!want) {
    // No preference: real geometry wins. The schematic is the fallback that
    // keeps the page usable before the first fetch and when Overpass is down.
    if (osm) { model = osm; origin = SOURCE_OSM; }
    else if (schematic) { model = schematic; origin = SOURCE_SCHEMATIC; }
  }

  if (!model) return { model: null, overrides, origin: null, field, hasOsm: !!osm, hasSchematic: !!schematic };
  if (onStatus) onStatus(`Surface loaded (${origin})`);
  return {
    model: finalise(model, overrides),
    overrides, origin, field,
    hasOsm: !!osm,
    hasSchematic: !!schematic,
  };
}

/** Is an OSM surface available for this field, committed or cached? */
export async function hasOsmSurface(icao) {
  if (await cacheGet(osmKey(icao))) return true;
  return !!(await fetchJson(`data/ramp/${icao}.osm.json`));
}

/** Fetch the surface live from Overpass, then cache it. */
export async function fetchAirportFromOsm(icao, overrides, onStatus) {
  const field = FIELDS[icao];
  const osm = await fetchOverpass(field.ref, onStatus);
  if (onStatus) onStatus("Parsing surface…");
  const model = parseOverpass(osm, { icao, ref: field.ref });
  await cachePut(osmKey(icao), model);
  return finalise(model, overrides);
}

function finalise(model, overrides) {
  const merged = applyOverrides(stampRamps(model), overrides);
  // Fit on load, not only at build time: a surface cached before this existed
  // would otherwise keep drawing its overlapping nominal boxes forever.
  fitStandBoxes(merged.stands);
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
    /** SID name -> NORTH | SOUTH. Shipped defaults merged with local edits. */
    this.sidSides = {};
    /** callsign -> { gate, ramp, sid, side, spot } for departures on the surface. */
    this.depRouting = new Map();
    /** SID names seen in traffic that nobody has given a side yet. */
    this.unmappedSids = new Set();
    this.myRamp = null;
    this.paused = false;
    this.lastFrameMs = performance.now();
    this.selected = null;
    this._raf = null;
    this._timer = null;
  }

  async start(icao, source) {
    if (icao) this.icao = icao;
    this.assignments.clear();
    const { model, overrides, origin, field, hasOsm } =
      await loadAirport(this.icao, { source: source || this.source, onStatus: this.onStatus });
    this.hasOsm = hasOsm;
    this.overrides = overrides;
    this.sidSides = mergeSidSides(overrides && overrides.sidSides, this.localSidSides || {});
    this.field = field;
    if (model) this.useModel(model);
    else this.onStatus("No surface data for " + this.icao + " — fetch it from OpenStreetMap.");
    this.origin = origin;
    this.source = origin;
    this.startLoops();
    if (this.autoFetchOsm !== false && origin === SOURCE_SCHEMATIC && !hasOsm) {
      // First visit to this field: pull the real geometry in the background and
      // switch to it when it lands. The schematic keeps the page working in the
      // meantime, and a failure is silent — there is a working surface already.
      this.backgroundFetch();
    }
    return !!model;
  }

  /**
   * Pull the surface from Overpass and switch to it.
   *
   * A failure here leaves whatever is already loaded exactly as it was — losing
   * a working map because a rate-limited mirror said no is not an acceptable
   * outcome mid-session.
   */
  async fetchSurface() {
    this.onStatus("Fetching surface from OpenStreetMap…");
    const model = await fetchAirportFromOsm(this.icao, this.overrides, this.onStatus);
    this.useModel(model);
    this.origin = SOURCE_OSM;
    this.source = SOURCE_OSM;
    this.hasOsm = true;
    this.onStatus(`OpenStreetMap surface — ${model.stands.length} stands, ${model.taxiways.length} taxiways.`);
    return model;
  }

  /** One quiet attempt at the real geometry, without blocking the page. */
  async backgroundFetch() {
    if (this._bgFetch) return;
    this._bgFetch = true;
    this.onStatus("Fetching OpenStreetMap surface in the background…");
    try {
      await this.fetchSurface();
      if (this.onSurfaceChange) this.onSurfaceChange();
    } catch (err) {
      this.onStatus("Showing the schematic — OpenStreetMap fetch failed (" + err.message + ").");
    }
  }

  /** Switch between the committed schematic and the cached OSM surface. */
  async setSurface(source) {
    if (source === this.source) return this.model;
    const { model, origin } = await loadAirport(this.icao, { source });
    if (!model) {
      this.onStatus(source === SOURCE_OSM
        ? "No OpenStreetMap surface cached yet — fetch it first."
        : "No built surface for " + this.icao + ".");
      return null;
    }
    this.assignments.clear();
    this.depRouting.clear();
    this.useModel(model);
    this.source = origin;
    this.origin = origin;
    this.onStatus(`Switched to the ${origin === SOURCE_OSM ? "OpenStreetMap" : "schematic"} surface — ` +
      `${model.stands.length} stands.`);
    this.tick();
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
    this.routeDepartures(targets);
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
      depRouting: this.depRouting,
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

    // Refresh the entry spot every tick: it is chosen from where the aircraft
    // actually is, so it flips end as an arrival rolls out the other way.
    for (const t of targets) {
      const a = this.assignments.get(t.callsign);
      if (!a || !a.standId) continue;
      const stand = this.model.stands.find(s => s.id === a.standId);
      const entry = stand && stand.ramp
        ? entrySpot({ x: t.dispX ?? t.x, y: t.dispY ?? t.y }, stand.ramp, this.model.spots)
        : null;
      a.spot = entry ? entry.spot.id : null;
      a.ramp = stand ? stand.ramp : null;
    }

    // Drop assignments for flights that have gone.
    const live = new Set(targets.map(t => t.callsign));
    for (const cs of [...this.assignments.keys()]) {
      if (!live.has(cs)) this.assignments.delete(cs);
    }
  }

  /**
   * Work out which end of its ramp each departure leaves through.
   *
   * The gate gives the ramp, the filed SID gives the side, and the two together
   * give the spot. Computed while the aircraft still has a stand and then held,
   * because the stand is released the moment it taxis clear.
   */
  routeDepartures(targets) {
    const live = new Set();
    for (const t of targets) {
      if (t.dep !== this.icao || t.arr === this.icao) continue;
      if (!DEPARTURE_PHASES.has(t.phase)) continue;
      live.add(t.callsign);

      if (t.sidBase && !this.sidSides[t.sidBase]) this.unmappedSids.add(t.sidBase);

      const gate = t.standId || (this.depRouting.get(t.callsign) || {}).gate || null;
      const stand = gate ? this.model.stands.find(s => s.id === gate) : null;
      const ramp = stand ? stand.ramp : null;
      const side = sideForSid(t.sidBase, this.sidSides);
      const entry = ramp ? departureSpot(ramp, side, this.model.spots) : null;

      this.depRouting.set(t.callsign, {
        gate, ramp, side,
        sid: t.sid || "",
        sidBase: t.sidBase || "",
        spot: entry ? entry.spot.id : null,
        spotExact: entry ? entry.exact : false,
      });
    }
    for (const cs of [...this.depRouting.keys()]) {
      if (!live.has(cs)) this.depRouting.delete(cs);
    }
  }

  /** Set or clear the side a SID departs through; persists locally. */
  setSidSide(sid, side) {
    const merged = mergeSidSides(this.sidSides, { [sid]: side });
    if (side === null) delete merged[sid];
    this.sidSides = merged;
    this.unmappedSids.delete(sidKey(sid));
    if (this.onSidSidesChange) this.onSidSidesChange(this.sidSides);
    this.tick();
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
      depRouting: this.depRouting,
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
        confidence: a ? a.confidence : null,
        conflict: !!(a && a.conflict),
      };
    });
    const departures = this.traffic.departures().map(t => {
      const r = this.depRouting.get(t.callsign) || {};
      return {
        callsign: t.callsign,
        type: t.type,
        phase: t.phase,
        sid: r.sid || t.sid,
        sidBase: r.sidBase || t.sidBase,
        stand: r.gate || t.standId,
        ramp: r.ramp || standRamp(this.model, t.standId),
        side: r.side || null,
        spot: r.spot || null,
      };
    });
    const ramps = (this.model.ramps || []).map(r => {
      const stands = this.model.stands.filter(s => s.ramp === r.id);
      const occupied = stands.filter(s => this.occupancy.occupied.has(s.id)).length;
      const inbound = arrivals.filter(a => a.ramp === r.id).length;
      return { id: r.id, label: r.label, freq: r.freq || null, stands: stands.length, occupied, inbound };
    });
    const ground = groundInbounds({
      targets: [...this.traffic.targets.values()],
      assignments: this.assignments,
      model: this.model,
      nowMs,
    });

    return {
      arrivals, departures, ramps, ground,
      counts: {
        targets: this.traffic.targets.size,
        occupied: this.occupancy.occupied.size,
        stands: this.model.stands.length,
        unassigned: arrivals.filter(a => !a.stand).length,
      },
      selected: this.selected,
      unmappedSids: [...this.unmappedSids].sort(),
      sidSides: this.sidSides,
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
