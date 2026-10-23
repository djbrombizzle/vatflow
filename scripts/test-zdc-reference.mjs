#!/usr/bin/env node
/**
 * Regression tests for shared/zdc-reference-match.js and the generated
 * shared/zdc-reference-data.js.
 * Usage: node scripts/test-zdc-reference.mjs
 */
import assert from "node:assert/strict";
import { REF_DOCS, REF_ITEMS } from "../shared/zdc-reference-data.js";
import { ROWS, SECTORS, SECTOR_REF } from "../shared/zdc-sop-data.js";
import {
  matchReference, flightClass, acftFits, routeTokenSet, itemHaystack, matchesQuery, sopRowsAsItems,
} from "../shared/zdc-reference-match.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

const item = o => ({ doc: "T", cat: "Departure", title: "t", text: "t", live: true, dep: [], arr: [], fixes: [], ...o });
const fl = o => ({ callsign: "TST1", dep: "KIAD", arr: "KORD", route: "JCOBY4 JCOBY J149 ROD", type: "B738", altitude: "35000", rules: "I", ...o });
const ids = (f, items, opts) => matchReference(f, items, opts).map(m => m.item.title);

t("airport match is dep OR arr; role follows the hit", () => {
  const items = [item({ title: "d", dep: ["KIAD"] }), item({ title: "a", arr: ["KORD"] }), item({ title: "x", arr: ["KBWI"] })];
  assert.deepEqual(ids(fl(), items), ["d", "a"]);
  assert.equal(matchReference(fl(), items)[1].role, "arr");
});

t("both = city pair", () => {
  const items = [item({ title: "p", dep: ["KIAD"], arr: ["KBWI", "KMTN"], both: true })];
  assert.deepEqual(ids(fl(), items), []);
  assert.deepEqual(ids(fl({ arr: "KMTN" }), items), ["p"]);
  assert.deepEqual(ids(fl({ dep: "KDCA", arr: "KBWI" }), items), []);
});

t("fixes: any / all, SID-STAR base names, expanded fixes", () => {
  assert.deepEqual(ids(fl(), [item({ title: "sid", fixes: ["JCOBY"] })]), ["sid"]);
  assert.deepEqual(ids(fl(), [item({ title: "all", fixes: ["JCOBY", "SITTR"], fixMode: "all" })]), []);
  assert.deepEqual(ids(fl(), [item({ title: "any", fixes: ["JCOBY", "SITTR"] })]), ["any"]);
  assert.deepEqual(ids(fl(), [item({ title: "exp", fixes: ["HACKS"] })], { extraFixes: ["HACKS"] }), ["exp"]);
  assert.deepEqual(matchReference(fl(), [item({ fixes: ["J149", "Q72"] })])[0].hits, ["J149"]);
  assert.ok(routeTokenSet("KIAD/01C DCT MOL.SPIDR5").has("SPIDR"));
});

t("overflight items need a route hit; empty items never match", () => {
  assert.deepEqual(ids(fl(), [item({ title: "o", fixes: ["ROD"] })]), ["o"]);
  assert.deepEqual(ids(fl(), [item({ title: "none" })]), []);
  assert.deepEqual(ids(fl(), [item({ title: "off", dep: ["KIAD"], live: false })]), []);
});

t("aircraft class, filed altitude and flight rules", () => {
  assert.equal(flightClass("H/B744/L"), "jet");
  assert.equal(flightClass("EC35"), "heli");
  assert.equal(flightClass("C172"), "piston");
  assert.deepEqual(acftFits("prop", "turboprop"), { ok: true, unknown: false });
  assert.deepEqual(acftFits("jet", null), { ok: true, unknown: true });
  assert.equal(acftFits("heli", null).ok, false);
  const items = [item({ title: "jet", dep: ["KIAD"], acft: "jet" }), item({ title: "prop", dep: ["KIAD"], acft: "prop" })];
  assert.deepEqual(ids(fl(), items), ["jet"]);
  assert.deepEqual(ids(fl({ type: "DH8D" }), items), ["prop"]);
  assert.equal(matchReference(fl({ type: "ZZZZ" }), items)[0].typeUnknown, true);
  const hi = [item({ title: "hi", dep: ["KIAD"], minAlt: 10001 }), item({ title: "lo", dep: ["KIAD"], maxAlt: 10000 })];
  assert.deepEqual(ids(fl(), hi), ["hi"]);
  assert.deepEqual(ids(fl({ altitude: "8000" }), hi), ["lo"]);
  assert.deepEqual(ids(fl({ altitude: "FL090" }), hi), ["lo"]);
  const vfr = [item({ title: "v", dep: ["KIAD"], fr: "VFR" })];
  assert.deepEqual(ids(fl(), vfr), []);
  assert.deepEqual(ids(fl({ rules: "V" }), vfr), ["v"]);
});

t("LOA rules need a route through every ARTCC they name", () => {
  const items = [
    item({ title: "zid-arr", arr: ["KBWI"], from: "ZID", to: "ZDC" }),
    item({ title: "ztl-dep", dep: ["KIAD"], from: "ZDC", to: "ZTL" }),
    item({ title: "pct", arr: ["KBWI"], from: "PCT", to: "BWI ATCT" }),
  ];
  const f = fl({ dep: "KIAD", arr: "KBWI" });
  assert.deepEqual(ids(f, items, { viaArtcc: id => id === "ZID" || id === "ZDC" }), ["zid-arr", "pct"]);
  assert.deepEqual(ids(f, items, { viaArtcc: id => id === "ZTL" || id === "ZDC" }), ["ztl-dep", "pct"]);
  assert.deepEqual(ids(f, items, { viaArtcc: id => id === "ZID" }), ["pct"]);
  assert.deepEqual(ids(f, items, { viaArtcc: () => null }), ["zid-arr", "ztl-dep", "pct"]);
});

t("search: every word must hit; airports also match without K", () => {
  const it = item({ title: "Runway 1C departures", text: "Jets use 1C.", dep: ["KIAD"], fixes: ["JCOBY"] });
  const hay = itemHaystack(it, { title: "IAD ATCT SOP", id: "IAD-SOP" });
  assert.ok(matchesQuery(hay, "IAD JCOBY"));
  assert.ok(matchesQuery(hay, "kiad 1c"));
  assert.ok(!matchesQuery(hay, "IAD BWI"));
});

t("ZDC SOP rows become searchable, non-live items", () => {
  const items = sopRowsAsItems(ROWS, SECTORS, SECTOR_REF);
  assert.equal(items.length, ROWS.length);
  assert.ok(items.every(i => !i.live && i.doc === "ZDC-SOP" && i.restr));
  assert.ok(items.some(i => matchesQuery(itemHaystack(i), "ANTHM KBWI")));
});

t("generated data is well formed", () => {
  const docIds = new Set(REF_DOCS.map(d => d.id));
  assert.ok(REF_DOCS.length >= 10, "documents present");
  for (const d of REF_DOCS) assert.ok(REF_ITEMS.some(i => i.doc === d.id), "items for " + d.id);
  for (const i of REF_ITEMS) {
    assert.ok(docIds.has(i.doc), "known doc " + i.doc);
    assert.ok(i.title && i.text && i.cat, "title/text/cat " + i.title);
    if (i.live) assert.ok((i.dep || []).length || (i.arr || []).length || (i.fixes || []).length, "live item has a constraint: " + i.title);
  }
});

t("real data: an IAD jet departure picks up IAD SOP rules", () => {
  const m = matchReference(fl({ route: "JCOBY4 JCOBY J149 ROD" }), REF_ITEMS);
  assert.ok(m.some(x => x.item.doc === "IAD-SOP" && x.role === "dep"));
  assert.ok(!m.some(x => x.item.doc === "BWI-SOP"));
});

console.log(`\n${passed} passed`);
