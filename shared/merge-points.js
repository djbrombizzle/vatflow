/**
 * Merge points: where arrival streams join upstream of an arrival gate, and how
 * much each stream (and each center feeding it) should give in trail so the
 * merged flow fits the gate's share of the rate.
 *
 * Why: at the KMCO FNO (Oct 9 2026) GTOUT ran at 20 an hour because ZDC's Q85
 * stream and ZTL's east traffic merged on it, while each center's own MIT looked
 * fine on its own. A gate total doesn't show that; the merge does.
 *
 * How: each inbound flight's filed route is expanded (shared/route-engine.js) and
 * walked back from its gate fix for MERGE_LOOKBACK_NM. Per gate, the walks form a
 * tree rooted at the gate fix; a node where two or more branches each carry
 * MIN_STREAM flights is a merge. The time a flight passes each fix is its gate
 * ETA minus the miles still to fly to the gate at STREAM_KT. Flow is counted in
 * the same rolling 60-minute windows as the rest of VATSMART and compared with
 * the gate's share of capacity in that window (calcGateMit's max-min fair slice).
 * The share is split across the branches the same max-min fair way, and each
 * branch's MIT is what that slice allows at MIT_NOMINAL_KT.
 */
import { calcGateMit, NO_GATE, MIT_NOMINAL_KT, GATE_MIT_STEP_NM, GATE_MIT_MAX_NM } from "./mit-monitor.js";

const MIN = 60000;
export const MERGE_LOOKBACK_NM = 250;   // walk this far back from the gate fix
export const STREAM_KT = 420;           // en route speed between a merge and the gate fix
export const MIN_STREAM = 2;            // a branch needs this many flights in the peak hour to count as a stream
export const MIN_MERGE_FLOW = 4;        // and the merge this many, before it is worth showing
export const CENTER_PROBE_NM = 40;      // which center owns a stream: where it is this far before the merge
export const BUNCH_FACTOR = 1.25;       // a 15-minute burst this far over a quarter of what the gate can take is "bunched"
export const GATE_MAX_HR = 30;          // one gate rarely delivers more than this (12 nm in trail at 360 kt)

function gcNm(a, b, c, d) {
  const r = x => x * Math.PI / 180, R = 3440.065;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const mitFor = rate => rate > 0
  ? Math.min(GATE_MIT_MAX_NM, Math.max(GATE_MIT_STEP_NM, Math.ceil(MIT_NOMINAL_KT / rate / GATE_MIT_STEP_NM) * GATE_MIT_STEP_NM))
  : GATE_MIT_MAX_NM;

/**
 * The route back from a flight's gate fix, nearest the gate first:
 * { fixes: [{ name, ll, via, t, back }], fromOrigin } where back = nm before the gate
 * fix, t = when the flight passes it (in the past for fixes already behind it), and
 * fromOrigin = the route starts inside the lookback (a departure from nearby).
 * gateIdx is the gate fix's index in anchors; tGate when the flight crosses it.
 */
export function upstreamWalk(anchors, gateIdx, tGate, kt = STREAM_KT) {
  const fixes = [{ name: anchors[gateIdx].name, ll: anchors[gateIdx].ll, via: anchors[gateIdx].via || "", t: tGate, back: 0 }];
  let back = 0, fromOrigin = false;
  for (let i = gateIdx - 1; i >= 0; i--) {
    const a = anchors[i], b = anchors[i + 1];
    if (!a.ll || !b.ll) break;
    if (a.kind === "apt") { fromOrigin = true; break; }
    back += gcNm(a.ll[0], a.ll[1], b.ll[0], b.ll[1]);
    if (back > MERGE_LOOKBACK_NM) break;
    if (a.name === fixes[fixes.length - 1].name) continue;
    fixes.push({ name: a.name, ll: a.ll, via: a.via || b.via || "", t: tGate - back / kt * 60 * MIN, back });
  }
  return { fixes, fromOrigin };
}

function newNode(fix) { return { name: fix.name, ll: fix.ll, via: fix.via, back: fix.back, passes: [], starts: [], kids: new Map() }; }

/** Per gate, a tree of the upstream walks rooted at the gate fix. */
export function buildStreamTrees(walks) {
  const trees = new Map();
  for (const w of walks) {
    if (!w.fixes.length) continue;
    const key = w.gate + "|" + w.fixes[0].name;
    if (!trees.has(key)) trees.set(key, { gate: w.gate, root: newNode(w.fixes[0]) });
    let node = trees.get(key).root;
    node.passes.push({ cs: w.cs, t: w.fixes[0].t, eta: w.eta, dep: w.dep, status: w.status });
    for (let i = 1; i < w.fixes.length; i++) {
      const f = w.fixes[i];
      if (!node.kids.has(f.name)) node.kids.set(f.name, newNode(f));
      node = node.kids.get(f.name);
      node.passes.push({ cs: w.cs, t: f.t, eta: w.eta, dep: w.dep, status: w.status });
    }
    if (w.fromOrigin) node.starts.push(w.cs);
  }
  return [...trees.values()];
}

/* the main line up a branch: follow the busiest child until probeNm upstream of the merge */
function branchProbe(node, mergeBack, probeNm) {
  let n = node;
  while (n.back - mergeBack < probeNm && n.kids.size) {
    n = [...n.kids.values()].sort((a, b) => b.passes.length - a.passes.length)[0];
  }
  return n;
}
/* a short name for a stream: the airway or STAR it arrives on and the first fix of it */
function branchLabel(node) {
  let n = node, via = node.via;
  for (let k = 0; k < 4 && !via && n.kids.size; k++) {
    n = [...n.kids.values()].sort((a, b) => b.passes.length - a.passes.length)[0];
    via = n.via;
  }
  return via && via !== node.name ? `${via} (${node.name})` : node.name;
}

/**
 * Merge points for one field.
 *   flights   VATSMART live flights: { callsign, gate, gateEta, eta, status, dep, excluded }
 *   routeOf   callsign -> pilot { dep, arr, route, ... } (for the route) or null
 *   anchorsFor  pilot -> expanded anchors (route-engine buildRouteAnchors(p).anchors), cached by the caller
 *   gateIndex   (anchors, gate) -> index of the gate fix in anchors, or -1
 *   artccFor  (lat, lon) -> center id or null
 *   originCenter  departure ICAO -> center id or null (where each stream's traffic comes from)
 *   windows   rollingGateDemand(...).windows; capacity = rate those windows are planned against
 * Returns [{ gate, fix, ll, nmToField, peak: { start, end, n, i, atFix: [first, last] passing the fix }, share, mergedMit, over, bunch, status,
 *   firstOver, branches: [{ label, center, n, mit, slice, callsigns }], centers: [{ id, n, mit, labels }] }],
 * worst first (status "over", then "bunched", then "ok").
 */
export function buildMergePoints({ flights = [], routeOf, anchorsFor, gateIndex, artccFor = () => null, originCenter = () => null, aptLL, windows = [], capacity = 0, now = Date.now() }) {
  if (!windows.length || !capacity) return [];
  const walks = [];
  for (const f of flights) {
    if (f.excluded || !f.gate || f.gate === NO_GATE || !(f.gateEta > now)) continue;
    const p = routeOf(f.callsign);
    if (!p) continue;
    let anchors;
    try { anchors = anchorsFor(p); } catch (_) { anchors = null; }
    if (!anchors || !anchors.length) continue;
    const gi = gateIndex(anchors, f.gate);
    if (gi < 0) continue;
    walks.push({ cs: f.callsign, gate: f.gate, eta: f.eta, dep: f.dep || "", status: f.status, ...upstreamWalk(anchors, gi, f.gateEta) });
  }

  /* each gate's share of capacity in every window */
  const shares = windows.map(w => {
    const out = {};
    for (const r of calcGateMit(capacity, w.entries, w.unassigned, MIT_NOMINAL_KT).rows) out[r.gate] = r.slice;
    return out;
  });

  const merges = [];
  for (const tree of buildStreamTrees(walks)) {
    const visit = node => {
      const kids = [...node.kids.values()];
      for (const k of kids) visit(k);
      /* a node is a merge when 2+ branches feed it; departures from nearby whose route starts here are a branch too */
      const startHere = node.passes.filter(p => node.starts.includes(p.cs));
      const branches = kids.map(k => ({ node: k, passes: k.passes }));
      if (startHere.length) branches.push({ node: null, passes: startHere, deps: [...new Set(startHere.map(p => p.dep).filter(Boolean))] });
      if (branches.length < 2) return;
      /* flights are counted by landing hour, like the gate's share, and only while they still have the merge ahead */
      const inWin = (passes, w) => passes.filter(p => p.eta >= w.start && p.eta < w.end && p.t >= now);
      let best = null;
      windows.forEach((w, i) => {
        const counts = branches.map(b => inWin(b.passes, w).length);
        const streams = counts.filter(n => n >= MIN_STREAM).length;
        const n = counts.reduce((a, b) => a + b, 0);
        const share = shares[i][tree.gate] || 0;
        if (streams < 2 || n < MIN_MERGE_FLOW) return;
        const over = n - share;
        if (!best || over > best.over + 1e-9 || (Math.abs(over - best.over) < 1e-9 && n > best.n)) best = { i, w, n, share, over, counts };
      });
      if (!best) return;
      const w = best.w;
      /* the busiest 15 minutes inside the peak hour */
      let burst = 0;
      const peakPasses = branches.flatMap(b => inWin(b.passes, w));
      const ts = peakPasses.map(p => p.t).sort((a, b) => a - b);
      for (let a = 0, b = 0; b < ts.length; b++) { while (ts[b] - ts[a] >= 15 * MIN) a++; burst = Math.max(burst, b - a + 1); }
      const share = best.share;
      /* what the gate could take this hour: the rate left after the other gates, at most what one gate delivers */
      const others = w.total - ((w.entries.find(([g]) => g === tree.gate) || [])[1] || 0);
      const room = Math.max(share, Math.min(GATE_MAX_HR, capacity - others));
      const bunched = burst > room / 4 * BUNCH_FACTOR && burst >= 3;
      const status = best.over >= 1 ? "over" : bunched ? "bunched" : "ok";
      const firstOver = windows.findIndex((ww, i) => branches.reduce((a, b) => a + inWin(b.passes, ww).length, 0) > (shares[i][tree.gate] || 0) + 0.5);

      /* split the share across branches (max-min fair), then per center */
      const rows = branches.map((b, k) => {
        const probe = b.node ? branchProbe(b.node, node.back, CENTER_PROBE_NM) : node;
        const inPeak = inWin(b.passes, w);
        const from = {};
        for (const p of inPeak) { const c = originCenter(p.dep) || "?"; from[c] = (from[c] || 0) + 1; }
        return {
          from: Object.entries(from).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])),
          key: "b" + k, label: b.node ? branchLabel(b.node) : "departures from " + (b.deps.slice(0, 3).join(", ") || "nearby"),
          center: probe.ll ? artccFor(probe.ll[0], probe.ll[1]) || "" : "",
          n: best.counts[k], callsigns: inPeak.sort((x, y) => x.t - y.t).map(p => p.cs),
        };
      }).filter(r => r.n > 0);
      /* over: max-min fair, so a stream already under its part runs free. bunched (the hour fits, a burst
         doesn't): no stream is over its part, so the merged flow gets one MIT over the fix (mergedMit) */
      const calc = calcGateMit(Math.max(share, 0.5), rows.map(r => [r.key, r.n]), 0, MIT_NOMINAL_KT);
      for (const r of rows) {
        const c = calc.rows.find(x => x.gate === r.key);
        r.slice = c.slice; r.mit = status === "over" && c.limited ? mitFor(c.slice) : 0;
      }
      rows.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
      const centers = {};
      for (const r of rows) {
        const id = r.center || "?";
        const c = centers[id] = centers[id] || { id, n: 0, slice: 0, labels: [] };
        c.n += r.n; c.slice += r.slice; c.labels.push(r.label);
      }
      const centerRows = Object.values(centers).map(c => ({ ...c, mit: status !== "over" || c.slice >= c.n - 1e-9 ? 0 : mitFor(c.slice) })).sort((a, b) => b.n - a.n);
      merges.push({
        gate: tree.gate, fix: node.name, ll: node.ll, back: Math.round(node.back),
        nmToField: aptLL && node.ll ? Math.round(gcNm(node.ll[0], node.ll[1], aptLL[0], aptLL[1])) : null,
        peak: { start: w.start, end: w.end, n: best.n, i: best.i, atFix: ts.length ? [ts[0], ts[ts.length - 1]] : null }, share: Math.round(share * 10) / 10,
        over: Math.round(best.over * 10) / 10, burst, status, mergedMit: status === "ok" ? 0 : mitFor(share),
        firstOver: firstOver >= 0 ? windows[firstOver].start : null,
        branches: rows, centers: centerRows,
      });
    };
    visit(tree.root);
  }
  /* worst first; among equals the merge where the second stream is biggest (a real join, not a stream picking up
     a straggler). A merge that is mostly the same flights as one already kept on that gate adds nothing. */
  const rank = { over: 0, bunched: 1, ok: 2 };
  const second = m => (m.branches[1] || { n: 0 }).n;
  merges.sort((a, b) => rank[a.status] - rank[b.status] || b.over - a.over || second(b) - second(a) || b.peak.n - a.peak.n || a.back - b.back);
  const kept = [];
  for (const m of merges) {
    const cs = m.branches.flatMap(b => b.callsigns);
    const dup = kept.some(k => {
      if (k.gate !== m.gate) return false;
      const ks = new Set(k.branches.flatMap(b => b.callsigns));
      return cs.filter(c => ks.has(c)).length >= cs.length * 0.8;
    });
    if (!dup) kept.push(m);
  }
  return kept;
}
