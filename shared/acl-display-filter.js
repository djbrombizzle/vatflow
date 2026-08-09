/**
 * Shared ACL / aircraft-list visibility rules for classic + EDST.
 *
 * Modes:
 *   all    → entire sector / FIR list
 *   cpdlc  → CPDLC logged-on only (EDST may also require on-frequency)
 *   freq   → controller voice frequency match only
 *   auto   → legacy classic default: on-freq (+ CPDLC-active) when freq known,
 *            else CPDLC connected only
 */

export const ACL_FILTER_MODES = ["all", "cpdlc", "freq", "auto"];

export function normalizeAclFilter(settings) {
  const raw = settings && settings.aclFilter;
  const m = String(raw || "").toLowerCase();
  if (m === "all" || m === "cpdlc" || m === "freq" || m === "auto") return m;
  if (settings && settings.showAll === true) return "all";
  if (settings && settings.showCpdlcOnly === true) return "cpdlc";
  return "auto";
}

export function showAllAircraftEnabled(settings) {
  return normalizeAclFilter(settings) === "all";
}

export function freqsMatch(a, b) {
  return a != null && b != null && Math.abs(a - b) < 0.0015;
}

/** True when this callsign's transceiver list includes our voice freq. */
export function isTunedToFreq(pilotFreqs, cs, freqMhz) {
  if (freqMhz == null || !Number.isFinite(+freqMhz)) return false;
  const key = (cs || "").toUpperCase();
  const freqs = (pilotFreqs && typeof pilotFreqs.get === "function")
    ? (pilotFreqs.get(key) || [])
    : (pilotFreqs && pilotFreqs[key]) || [];
  return (freqs || []).some(f => freqsMatch(f, +freqMhz));
}

/**
 * @param {object[]} list board rows ({cs, source, ...})
 * @param {{ mode?: 'all'|'cpdlc'|'freq'|'auto',
 *           freqFilterOn?: boolean,
 *           cpdlcRequireFreq?: boolean,
 *           connected: Set<string>|string[],
 *           isTuned: (cs:string)=>boolean,
 *           isCpdlcActive?: (cs:string)=>boolean,
 *           handoffAwait?: Set<string>|string[] }} opts
 */
export function filterBoardList(list, opts = {}) {
  const mode = normalizeAclFilter({ aclFilter: opts.mode || "auto" });
  const freqOn = !!opts.freqFilterOn;
  const cpdlcRequireFreq = !!opts.cpdlcRequireFreq;
  const connected = opts.connected instanceof Set
    ? opts.connected
    : new Set(opts.connected || []);
  const handoffAwait = opts.handoffAwait instanceof Set
    ? opts.handoffAwait
    : new Set(opts.handoffAwait || []);
  const isTuned = typeof opts.isTuned === "function" ? opts.isTuned : () => false;
  const isCpdlc = typeof opts.isCpdlcActive === "function"
    ? opts.isCpdlcActive
    : (cs) => connected.has(cs);

  let out = Array.isArray(list) ? list.slice() : [];

  if (mode === "all") {
    // entire sector list
  } else if (mode === "cpdlc") {
    out = out.filter((a) => {
      if (!a) return false;
      if (a.source === "manual") return true;
      if (!connected.has(a.cs)) return false;
      if (cpdlcRequireFreq && freqOn) return isTuned(a.cs);
      return true;
    });
  } else if (mode === "freq") {
    if (freqOn) {
      out = out.filter((a) => a && (a.source === "manual" || isTuned(a.cs)));
    } else {
      // No controller freq yet — fall back to CPDLC connected
      out = out.filter((a) => a && (a.source === "manual" || connected.has(a.cs)));
    }
  } else {
    // auto (classic default)
    if (freqOn) {
      out = out.filter(
        (a) => a && (a.source === "manual" || isTuned(a.cs) || isCpdlc(a.cs)),
      );
    } else {
      out = out.filter((a) => a && (a.source === "manual" || connected.has(a.cs)));
    }
  }

  out = out.filter(
    (a) => a && (!handoffAwait.has(a.cs) || isTuned(a.cs) || isCpdlc(a.cs)),
  );
  return out;
}

export function freqFilterShouldRun({ monitorMode, mode, showAll, freqMhz, canFilter }) {
  const m = mode != null
    ? normalizeAclFilter({ aclFilter: mode })
    : (showAll === true ? "all" : "auto");
  return !monitorMode
    && m !== "all"
    && freqMhz != null
    && Number.isFinite(+freqMhz)
    && !!canFilter;
}
