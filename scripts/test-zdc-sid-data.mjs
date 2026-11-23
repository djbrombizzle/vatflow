// node scripts/test-zdc-sid-data.mjs
import assert from "node:assert/strict";
import { SIDS, departureSid } from "../shared/zdc-sid-data.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok ", name); };

t("JCOBY splits by transition", () => {
  const d = departureSid("KIAD", "JCOBY4 SWANN DQO J6 ARD");
  assert.equal(d.sid, "JCOBY");
  assert.equal(d.trans, "SWANN");
  assert.deepEqual(d.entries.map(e => [e.zdc.sec, e.zdc.alt]), [["17", "FL190"]]);
  assert.equal(departureSid("KIAD", "JCOBY4 JCOBY SCOOB Q80").entries[0].zdc.sec, "12");
  assert.equal(departureSid("KIAD", "JCOBY4 JCOBY DCT KONGO").entries.length, 3);
});

t("same SID name, different airport", () => {
  assert.equal(departureSid("KIAD", "CLTCH3 CLTCH Q75").entries[0].init, "100");
  assert.equal(departureSid("KDCA", "CLTCH3 CLTCH Q75").entries[0].init, "FL210");
});

t("route forms: dotted, speed/alt token, DCT first", () => {
  assert.equal(departureSid("KBWI", "N0450F350 TERPZ8.TERPZ J211").sid, "TERPZ");
  assert.equal(departureSid("KDCA", "DCT SOOKI6 SOOKI").sid, "SOOKI");
  assert.equal(departureSid("KBWI", "TERPZ8").entries[0].init, "C/V 170");
});

t("no SID / other airport", () => {
  assert.equal(departureSid("KJFK", "DEEZZ5 CANDR"), null);
  const d = departureSid("KIAD", "LDN J149 ESL");
  assert.equal(d.sid, null);
  assert.deepEqual(d.entries, []);
});

t("every entry has an init altitude", () => {
  for (const list of Object.values(SIDS)) for (const e of list) assert.ok(e.init, e.sid);
});

console.log(`\n${n} passed`);
