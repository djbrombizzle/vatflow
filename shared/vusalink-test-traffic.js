/**
 * Synthetic traffic for vUSAlink TEST MODE.
 *
 * Lets a controller practise the board — clearances, CDR swaps, directs,
 * crossings, handoffs — without a VATSIM position or a CPDLC logon. Nothing
 * here ever reaches the hub: TEST MODE short-circuits sendCpdlc.
 *
 * Rows match the shape mapLive() produces from the live feed, and carry
 * source:'manual' so they pass the ACL filters the way a controller's own
 * strips do. They are kept out of the persisted manual[] array, so they never
 * survive a reload or leak into a live session.
 *
 * Most of the fleet sits on the ground at KATL, which has CDRs for every
 * destination used here, so the clearance panel has something real to chew on.
 */

const ATL = { lat: 33.6367, lon: -84.4281 };

/** Filed routes chosen to match real CDRs, so the picker shows ON FILE. */
const GROUND = [
  {
    cs: "DAL1234", type: "B739", dep: "KATL", arr: "KMCO",
    // ATLMCORP — swapping this to ATLMCOGA is the worked example in the docs.
    route: "SMLTZ3 WALET ZJAYX GRNCH5",
    squawk: "1200", assignedSquawk: "4517", alt: 0, gs: 0, hdg: 268,
    lat: ATL.lat + 0.004, lon: ATL.lon - 0.012,
  },
  {
    cs: "AAL892", type: "A321", dep: "KATL", arr: "KBOS",
    route: "PENCL3 PENCL SOT MOL BROSS JFUND4",
    squawk: "1200", assignedSquawk: "2371", alt: 0, gs: 0, hdg: 92,
    lat: ATL.lat - 0.003, lon: ATL.lon + 0.008,
  },
  {
    cs: "SWA455", type: "B738", dep: "KATL", arr: "KMDW",
    route: "HOBTT3 VARNM RMG NELLO BWG FITTE SHAIN3",
    squawk: "1200", assignedSquawk: "5124", alt: 0, gs: 12, hdg: 315,
    lat: ATL.lat + 0.009, lon: ATL.lon - 0.004,
  },
  {
    cs: "JBU701", type: "A320", dep: "KATL", arr: "KJFK",
    route: "SMLTZ3 JACCC SOT GVE JAMIE CAMRN4",
    squawk: "1200", assignedSquawk: "3046", alt: 0, gs: 4, hdg: 175,
    lat: ATL.lat - 0.007, lon: ATL.lon - 0.009,
  },
];

/** A couple airborne so the enroute side of the route menu is exercised too. */
const AIRBORNE = [
  {
    cs: "UAL219", type: "B752", dep: "KATL", arr: "KIAD",
    route: "KATL PENCL3 PENCL SOT LVL AML KIAD",
    squawk: "4231", assignedSquawk: "4231", alt: 340, gs: 448, hdg: 41,
    lat: 34.92, lon: -82.71,
  },
  {
    cs: "FDX1290", type: "B763", dep: "KMEM", arr: "KMIA",
    route: "KMEM ELVIS3 HLI MGM CTY LEESE4 KMIA",
    squawk: "6517", assignedSquawk: "6517", alt: 380, gs: 486, hdg: 148,
    lat: 32.14, lon: -85.03,
  },
];

function toRow(f, airborne) {
  const routeRaw = airborne ? f.route : `${f.dep} ${f.route} ${f.arr}`;
  return {
    cs: f.cs,
    type: f.type,
    alt: f.alt,
    hs: "/" + (f.gs || ""),
    cid: "",
    squawk: f.squawk,
    assignedSquawk: f.assignedSquawk,
    hdg: f.hdg,
    gs: f.gs,
    lat: f.lat,
    lon: f.lon,
    route: routeRaw.replace(/\s+/g, " ").trim(),
    _routeRaw: airborne ? f.route : `${f.dep} ${f.route} ${f.arr}`,
    routeFixes: null,
    cat: null,
    dep: f.dep,
    arr: f.arr,
    // Treated as a controller strip so the ACL filters let it through.
    source: "manual",
    onFreq: true,
    test: true,
  };
}

/** Every synthetic aircraft, ground first so departures sort to the top. */
export function makeTestFlights() {
  return GROUND.map((f) => toRow(f, false)).concat(AIRBORNE.map((f) => toRow(f, true)));
}

/** Callsigns in the synthetic fleet — used to mark them CPDLC-connected. */
export function testCallsigns() {
  return makeTestFlights().map((a) => a.cs);
}

/**
 * How a synthetic pilot answers an uplink. Mostly WILCO, with the occasional
 * STANDBY-then-WILCO and a rare UNABLE so the W box, the amber timeout and the
 * UNABLE path all get exercised rather than only the happy one.
 *
 * rand is injectable so tests are deterministic.
 */
export function simulateReply(message, rand) {
  const r = typeof rand === "function" ? rand() : Math.random();
  const msg = (message || "").toUpperCase();
  // A clearance the aircraft cannot take is the interesting failure to practise.
  if (/CLEARED TO THE/.test(msg) && r < 0.12) {
    return { reply: "UNABLE", delayMs: 4000 };
  }
  if (r < 0.2) return { reply: "STANDBY", delayMs: 2500, then: { reply: "WILCO", delayMs: 6000 } };
  return { reply: "WILCO", delayMs: 2000 + Math.floor(r * 4000) };
}
