// Sorting and filtering for the Ramp page lists and the Gate list (shared/table-tools.js).
import { sortFilterRows } from "../shared/table-tools.js";

let passed = 0;
function assert(c, m) { if (!c) throw new Error("FAIL: " + m); passed++; }

const rows = [
  { cs: "UAL12", stand: "B10", eta: 12, type: "B738" },
  { cs: "DAL5", stand: "A2", eta: null, type: "A321" },
  { cs: "AAL300", stand: "B9", eta: 4, type: "B738" },
  { cs: "SWA7", stand: "", eta: 30, type: "B38M" },
];
const cols = {
  cs: r => r.cs,
  stand: r => r.stand,
  eta: { sort: r => r.eta, text: r => (r.eta == null ? "" : `${r.eta} min`) },
  type: r => r.type,
};
const ids = l => l.map(r => r.cs).join();

assert(ids(sortFilterRows(rows, cols, {})) === "UAL12,DAL5,AAL300,SWA7", "no sort keeps the list's order");
assert(ids(sortFilterRows(rows, cols, { sort: "cs", dir: 1 })) === "AAL300,DAL5,SWA7,UAL12", "callsign A-Z");
assert(ids(sortFilterRows(rows, cols, { sort: "cs", dir: -1 })) === "UAL12,SWA7,DAL5,AAL300", "callsign Z-A");
// Stand labels sort as people read them (B9 before B10); blanks last either way.
assert(ids(sortFilterRows(rows, cols, { sort: "stand", dir: 1 })) === "DAL5,AAL300,UAL12,SWA7", "stands in natural order, blank last");
assert(ids(sortFilterRows(rows, cols, { sort: "stand", dir: -1 })) === "UAL12,AAL300,DAL5,SWA7", "stands reversed, blank still last");
assert(ids(sortFilterRows(rows, cols, { sort: "eta", dir: 1 })) === "AAL300,UAL12,SWA7,DAL5", "ETA by minutes, none last");
// Ties keep the list's order.
assert(ids(sortFilterRows(rows, cols, { sort: "type", dir: 1 })) === "DAL5,SWA7,UAL12,AAL300", "stable on ties (UAL12 before AAL300)");
// Filters: text in each column, any case, every filter must match.
assert(ids(sortFilterRows(rows, cols, { filters: { type: "b738" } })) === "UAL12,AAL300", "filter by type");
assert(ids(sortFilterRows(rows, cols, { filters: { type: "B738", stand: "b1" } })) === "UAL12", "two filters combine");
assert(ids(sortFilterRows(rows, cols, { filters: { eta: "min" } })) === "UAL12,AAL300,SWA7", "filter matches the shown text");
assert(ids(sortFilterRows(rows, cols, { filters: { cs: "  ", nope: "x" } })) === "UAL12,DAL5,AAL300,SWA7", "blank and unknown filters ignored");
assert(ids(sortFilterRows(rows, cols, { sort: "cs", dir: 1, filters: { type: "B7" } })) === "AAL300,UAL12", "filter then sort");
assert(sortFilterRows(rows, cols, {}) !== rows, "returns a new array");

console.log(`test-table-tools: ${passed} passed`);
