/*
 * Entry point for common/vatflow-ramp.js, the in-cab ramp list's copy of the VATFLOW
 * ramp logic (shared/ramp-core.js, the same code vatflow.io/gates.html runs), bundled
 * into one plain script with a global VatflowRamp. Rebuild after changing shared/:
 *
 *   node msfs-tower/tools/build_vatflow_bundles.mjs
 */
export {
  STATES, indexLayout, deriveFlights, autoAssignStands, standLabel, operatorFor, distNm,
  ptimeCountdown, INBOUND_MAX_NM, emptyState,
} from "../../shared/ramp-core.js";
