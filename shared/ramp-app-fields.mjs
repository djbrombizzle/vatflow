/**
 * Airport reference points and elevations for RampView.
 * Kept separate from ramp-app.js so the node build script can import it
 * without pulling in browser-only code (IndexedDB, canvas, fetch loops).
 */
export const FIELDS = {
  KATL: { ref: [33.6367, -84.4281], elevFt: 1026, name: "Hartsfield–Jackson Atlanta International" },
  KDFW: { ref: [32.8968, -97.0380], elevFt: 607, name: "Dallas/Fort Worth International" },
  KCLT: { ref: [35.2140, -80.9431], elevFt: 748, name: "Charlotte Douglas International" },
  KDTW: { ref: [42.2124, -83.3534], elevFt: 645, name: "Detroit Metropolitan Wayne County" },
  KMSP: { ref: [44.8820, -93.2218], elevFt: 841, name: "Minneapolis–St Paul International" },
  KSLC: { ref: [40.7884, -111.9778], elevFt: 4227, name: "Salt Lake City International" },
  KLAX: { ref: [33.9425, -118.4081], elevFt: 125, name: "Los Angeles International" },
  KSEA: { ref: [47.4490, -122.3093], elevFt: 433, name: "Seattle–Tacoma International" },
  KJFK: { ref: [40.6398, -73.7789], elevFt: 13, name: "John F. Kennedy International" },
  KBOS: { ref: [42.3643, -71.0052], elevFt: 20, name: "Boston Logan International" },
};
