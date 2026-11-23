#!/usr/bin/env node
/** Tests for shared/pct-reference-data.js. Usage: node scripts/test-pct-reference.mjs */
import { filedSid, filedStar, procLines, climbChain, shortHaul, departureGate, PROCS } from "../shared/pct-reference-data.js";

let n = 0;
function t(name, fn) { fn(); n++; console.log("ok ", name); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

t("IAD JCOBY4 SWANN: SHD 100 to KRANT, then MTV FL190 to ZDC 17", () => {
  const m = filedSid("KIAD", "JCOBY4 JCOBY SWANN J42 RBV");
  eq(m.proc.name, "JCOBY4", "proc"); eq(m.trans, "SWANN", "trans");
  eq(climbChain(m.proc, m.tokens).map(s => `${s.by} ${s.alt} ${s.to}`), ["SHD 100 MTV KRANT", "MTV FL190 ZDC 17"], "chain");
  eq(procLines(m.proc, m.filed, m.tokens).map(l => l.hit), [true, false], "hit line");
});
t("same SID name differs by airport (CLTCH IAD vs DCA)", () => {
  eq(filedSid("KIAD", "CLTCH3 MAULS").proc.climb[0].alt, "100", "IAD");
  eq(filedSid("KDCA", "CLTCH3 MAULS").proc.climb[0].alt, "FL210", "DCA");
});
t("STAR with transition: TRISH5 via NUGGY", () => {
  const m = filedStar("KBWI", "N0450F350 SIE V1 NUGGY TRISH5");
  eq(m.proc.name, "TRISH5", "proc"); eq(m.trans, "NUGGY", "trans");
  eq(procLines(m.proc, m.filed, m.tokens).filter(l => l.hit).map(l => l.text), ["NUGGY via TROYZ @120"], "hit");
});
t("combined card picks the filed STAR's line (DELRO5 vs HYPER1)", () => {
  const m = filedStar("KIAD", "LRP DELRO5");
  eq(procLines(m.proc, m.filed, m.tokens).filter(l => l.hit).map(l => l.text), ["DELRO5 jets @100 · props @80"], "hit");
});
t("EMI the VOR is not the EMI7 STAR", () => {
  eq(filedStar("KBWI", "J6 EMI"), null, "bare navaid");
  eq(filedStar("KBWI", "MUMSY EMI7").proc.name, "EMI7", "filed STAR");
});
t("short-haul and gates", () => {
  eq(shortHaul("KDCA", "KRIC"), { dest: ["KRIC"], jet: "12,000", prop: "10,000" }, "DCA→RIC");
  eq(shortHaul("KIAD", "KATL"), null, "not short-haul");
  eq(departureGate("KIAD", "BUNZZ3 RAMAY J149 ROD").dep, "TILLY 126.65", "RAMAY gate");
});
t("every procedure has ids, apts and lines", () => {
  for (const p of PROCS) if (!p.ids.length || !p.apts.length || !p.lines.length) throw new Error(p.name);
});
console.log(`\n${n} passed`);
