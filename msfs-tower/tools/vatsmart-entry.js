/*
 * Entry point for common/vatflow-smart.js, the TMU desk VATSMART screen's copy of
 * vatflow.io/vatsmart.html's analysis: shared/vatsmart.js (buildSituation: capacity,
 * demand, queue, TMI call, gate MIT plan, landing slots, recommendations) on the same
 * MIT monitor, weather, arrival tracking and FCA-engine ETA code the page uses, bundled
 * as one plain script (global VatflowSmart). Rebuild after changing shared/:
 *
 *   node msfs-tower/tools/build_vatflow_bundles.mjs
 */
export {
  buildSituation, landingSlots, fmtZ, HORIZON_MIN, windFromMetar, NO_GATE, TAXI_SLOW_MIN,
} from "../../shared/vatsmart.js";
export { normPrograms, wakeFromFp } from "../../shared/mit-monitor.js";
export { gridWindow } from "../../shared/event-planner.js";
export { createArrivalState, updateArrivals, holdingNow, landingRate } from "../../shared/arrival-track.js";
export { loadAirports, getAirport, fpFields } from "../../shared/fca-metering.js";
export { loadNavData, isNavReady } from "../../shared/route-engine.js";
export { gateEtaFor } from "../../shared/gate-eta.js";
export { fetchWinds, bindWindAirportLookup, getWindInfo } from "../../shared/winds-aloft.js";
