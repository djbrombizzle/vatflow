/**
 * Validates the built data/cdr shards and the lookup contract the vUSAlink
 * clearance tab relies on:
 *   RCode -> index.prefix[code[0:3]] -> <origin>.json -> scan destinations
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CDR = join(ROOT, "data", "cdr");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const index = JSON.parse(readFileSync(join(CDR, "index.json"), "utf8"));
assert(index.prefix && typeof index.prefix === "object", "index has a prefix map");
assert(index.routes > 0, "index records a route count");

const shardFiles = readdirSync(CDR).filter((f) => f.endsWith(".json") && f !== "index.json");
const shards = new Map(shardFiles.map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(CDR, f), "utf8"))]));

// Every origin named by the prefix map has a shard, and vice versa.
const origins = new Set(Object.values(index.prefix));
assert(origins.size === shards.size, `prefix map covers ${origins.size} origins, ${shards.size} shards on disk`);
for (const orig of origins) assert(shards.has(orig), `missing shard for ${orig}`);

const allCodes = new Map(); // code -> {orig, dest}
let total = 0;
let longestRoute = { code: "", len: 0 };

for (const [orig, dests] of shards) {
  for (const [dest, rows] of Object.entries(dests)) {
    assert(/^[A-Z]{4}$/.test(dest), `${orig}: destination "${dest}" is not an ICAO`);
    for (const row of rows) {
      assert(row.length === 6, `${orig}->${dest}: row has ${row.length} fields, want 6`);
      const [code, , route] = row;
      assert(/^[A-Z0-9]{8}$/.test(code), `"${code}" is not an 8-character RCode`);
      assert(!allCodes.has(code), `duplicate RCode ${code}`);
      allCodes.set(code, { orig, dest });

      // The prefix must route this code back to the shard it lives in.
      assert(index.prefix[code.slice(0, 3)] === orig, `${code} prefix does not resolve to ${orig}`);

      // Origin/destination are implied by the shard path, not repeated in the route.
      const tokens = route.split(" ").filter(Boolean);
      assert(tokens[0] !== orig, `${code}: route still starts with ${orig}`);
      assert(tokens[tokens.length - 1] !== dest, `${code}: route still ends with ${dest}`);

      if (route.length > longestRoute.len) longestRoute = { code, len: route.length };
      total++;
    }
  }
}

assert(total === index.routes, `counted ${total} routes, index claims ${index.routes}`);

// The lookup the client performs, exercised against a spread of real codes.
function lookup(code) {
  const orig = index.prefix[code.slice(0, 3)];
  if (!orig) return null;
  const shard = shards.get(orig);
  if (!shard) return null;
  for (const dest of Object.keys(shard)) {
    const hit = shard[dest].find((r) => r[0] === code);
    if (hit) return { code, orig, dest, depFix: hit[1], route: hit[2] };
  }
  return null;
}

const sample = [...allCodes.keys()].filter((_, i) => i % 997 === 0);
assert(sample.length > 20, "sampled enough codes to be meaningful");
for (const code of sample) {
  const got = lookup(code);
  const want = allCodes.get(code);
  assert(got, `lookup failed for ${code}`);
  assert(got.orig === want.orig && got.dest === want.dest, `${code} resolved to the wrong pair`);
}

// Suffixes repeat across destinations, which is why full codes are stored —
// guard the property that made that necessary.
let suffixCollisions = 0;
for (const [, dests] of shards) {
  const bySuffix = new Map();
  for (const [dest, rows] of Object.entries(dests)) {
    for (const row of rows) {
      const s = row[0].slice(6);
      const set = bySuffix.get(s) || bySuffix.set(s, new Set()).get(s);
      set.add(dest);
    }
  }
  for (const set of bySuffix.values()) if (set.size > 1) suffixCollisions++;
}
assert(suffixCollisions > 0, "expected suffix reuse across destinations");

// Spot-check a known pair end to end.
const atlmco = lookup("ATLMCOGA");
assert(atlmco, "ATLMCOGA resolves");
assert(atlmco.orig === "KATL" && atlmco.dest === "KMCO", "ATLMCOGA is KATL->KMCO");
assert(atlmco.route === "GAIRY2 IRQ FISHO Q93 GIPPL Q85 LPERD SNFLD3", "ATLMCOGA route matches");
assert(lookup("ZZZZZZZZ") === null, "unknown code returns null");

console.log(`ok — ${total} CDRs across ${shards.size} origins`);
console.log(`   longest route: ${longestRoute.code} (${longestRoute.len} chars)`);
console.log(`   suffix collisions handled: ${suffixCollisions}`);
