/**
 * Shared ACL / aircraft-list visibility rules for classic + EDST.
 *
 * SHOW ALL A/C unchecked:
 *   - voice freq known → only aircraft tuned to that freq (or CPDLC-active)
 *   - otherwise → CPDLC connected only
 * SHOW ALL A/C checked → entire sector list
 */

export function showAllAircraftEnabled(settings) {
  return !!(settings && settings.showAll === true);
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
 * @param {{ showAll: boolean,
 *           freqFilterOn: boolean,
 *           connected: Set<string>|string[],
 *           isTuned: (cs:string)=>boolean,
 *           isCpdlcActive: (cs:string)=>boolean,
 *           handoffAwait?: Set<string>|string[] }} opts
 */
export function filterBoardList(list, opts = {}) {
  const showAll = opts.showAll === true;
  const freqOn = !!opts.freqFilterOn;
  const connected = opts.connected instanceof Set
    ? opts.connected
    : new Set(opts.connected || []);
  const handoffAwait = opts.handoffAwait instanceof Set
    ? opts.handoffAwait
    : new Set(opts.handoffAwait || []);
  const isTuned = typeof opts.isTuned === "function" ? opts.isTuned : () => false;
  const isCpdlc = typeof opts.isCpdlcActive === "function" ? opts.isCpdlcActive : () => false;

  const onFreq = (cs) => isCpdlc(cs) || isTuned(cs);

  let out = Array.isArray(list) ? list.slice() : [];
  if (!showAll) {
    if (freqOn) {
      // Live on-freq check — never trust a stale row.onFreq flag.
      out = out.filter(a => a && (a.source === "manual" || onFreq(a.cs)));
    } else {
      out = out.filter(a => a && connected.has(a.cs));
    }
  }
  out = out.filter(a => a && (!handoffAwait.has(a.cs) || onFreq(a.cs)));
  return out;
}

export function freqFilterShouldRun({ monitorMode, showAll, freqMhz, canFilter }) {
  return !monitorMode
    && showAll !== true
    && freqMhz != null
    && Number.isFinite(+freqMhz)
    && !!canFilter;
}
