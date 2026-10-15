/*
 * Entry point for common/vatflow-metering.js, the in-cab IDST screen's copy of the
 * VATFLOW release engine. It is the same code the IDST web page uses
 * (shared/fca-metering.js and friends), bundled into one plain script because
 * MSFS gauges load scripts, not ES modules. Rebuild after changing shared/:
 *
 *   node msfs-tower/tools/build_vatflow_bundles.mjs
 */
import {
  loadAirports, seedAirports, getAirport, fpFields, computeTowerDepartures, markReady, clearReady,
  mergeRemoteFca, getRelease, fmtZulu, COMPLIANCE_EARLY_MS, COMPLIANCE_LATE_MS,
} from "../../shared/fca-metering.js";
import { loadNavData } from "../../shared/route-engine.js";
import { fetchWinds, bindWindAirportLookup } from "../../shared/winds-aloft.js";
import { fetchArtccBoundaries } from "../../shared/artcc-scope.js";
import { verifyTowerAtc } from "../../shared/tower-atc-auth.js";

// esbuild --global-name turns these exports into a plain global `var VatflowMetering`
// (MSFS's instrument browser has no globalThis).
export {
  loadAirports, seedAirports, getAirport, fpFields, computeTowerDepartures, markReady, clearReady,
  mergeRemoteFca, getRelease, fmtZulu, COMPLIANCE_EARLY_MS, COMPLIANCE_LATE_MS,
  loadNavData, fetchWinds, bindWindAirportLookup, fetchArtccBoundaries, verifyTowerAtc,
};
