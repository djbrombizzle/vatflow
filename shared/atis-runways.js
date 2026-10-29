/**
 * Runways in use, read out of an ATIS broadcast.
 *
 * Split out of shared/vatsmart.js so pages that only need the runway reading —
 * IDST's departure config, the Taxi Sequencer — do not pull in the whole
 * VATSMART model (60 KB and its own dependency tree) to get it. vatsmart.js
 * re-exports these, so there is one implementation and one set of tests.
 */

const RWY_RE = /^(0?[1-9]|[12]\d|3[0-6])([LRC])?$/;
const normRwy = r => { const m = String(r || "").toUpperCase().match(RWY_RE); return m ? String(+m[1]).padStart(2, "0") + (m[2] || "") : ""; };
export { normRwy };

/**
 * Arrival and departure runways from an ATIS text, checked against the field's known
 * runway ends (data/nav/runways.json) so altimeters, times and frequencies never count.
 * A runway goes to whichever of landing / departing was said last before it; with
 * neither ("RWYS 27L 28R IN USE") it counts for both. Sentences about closures are skipped.
 */
export function runwaysFromAtis(text, known = []) {
  const ok = new Set(known.map(normRwy).filter(Boolean));
  const arr = new Set(), dep = new Set();
  const t = String(text || "").toUpperCase().replace(/\s+/g, " ");
  const ARR = /^(APCH|APCHS|APPROACH|APPROACHES|APP|APPS|LNDG|LDG|LANDING|LAND|ARRIVAL|ARRIVALS|ARR|ARRS|ARRIVING|ARVNG|ARRVG)$/;
  const DEP = /^(DEPG|DEPTG|DEPARTING|DEPARTURE|DEPARTURES|DEP|DEPS|DEPART|TKOF|TAKEOFF|TAKEOFFS)$/;
  const APPR = /^(ILS|RNAV|RNP|VISUAL|VIS|LOC|GPS|LDA|VOR)$/;
  const NEUTRAL = /^(SIMUL|SIMULTANEOUS|CONVERGING|PARALLEL|DEPENDENT|INDEPENDENT|IN|USE|EXPECT|EXP)$/;
  const RWYW = /^(RWY|RWYS|RY|RYS|RUNWAY|RUNWAYS)$/;
  const JOIN = /^(,|AND|Y|Z|X|W|-)$/;
  for (const sentence of t.split(/\.(?=\s|$)|\.\.\.|;/)) {
    if (/\b(CLSD|CLOSED|OTS|UNUSABLE|U\/S)\b/.test(sentence)) continue;
    const toks = sentence.replace(/[,/&()]/g, " , ").split(" ").map(w => w.replace(/\.+$/, "")).filter(Boolean);
    let mode = "", list = false, prevKw = "";
    const pending = [];
    const put = r => { if (mode === "arr" || mode === "both") arr.add(r); if (mode === "dep" || mode === "both") dep.add(r); if (!mode) pending.push(r); };
    for (const w of toks) {
      const kw = ARR.test(w) || APPR.test(w) ? "arr" : DEP.test(w) ? "dep" : "";
      if (kw) {
        /* "LANDING AND DEPARTING RWY 27" is both */
        mode = prevKw && prevKw !== kw ? "both" : kw;
        prevKw = kw; list = true;               // "ARR 6, DEP 1"
        continue;
      }
      if (RWYW.test(w)) { list = true; continue; }
      if (JOIN.test(w)) continue;
      prevKw = "";
      const r = normRwy(w);
      /* "RWYS 24 AND 25" at a field with 24L/24R and 25L/25R means both sides */
      const hits = !r ? [] : ok.has(r) ? [r] : /^\d\d$/.test(r) ? [...ok].filter(x => x.slice(0, 2) === r) : [];
      if (list && hits.length) { hits.forEach(put); continue; }
      if (!NEUTRAL.test(w)) list = false;
    }
    /* "RWYS 27L 28R IN USE": no landing or departing word in the sentence */
    if (/\b(IN USE|IN PROG|IN EFFECT|ACTIVE)\b/.test(sentence)) for (const r of pending) { arr.add(r); dep.add(r); }
  }
  const sort = s => [...s].sort();
  return { arr: sort(arr), dep: sort(dep) };
}
