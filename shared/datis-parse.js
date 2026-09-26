/**
 * Digital ATIS parsing — split an FAA D-ATIS broadcast into its parts so the
 * NOTAMs / field advisories can be highlighted instead of blending into one
 * wall of text.
 *
 * Segment kinds:
 *   header   — "JFK ATIS INFO S 1551Z"
 *   weather  — the METAR body (wind, vis, clouds, temp, altimeter, remarks)
 *   runways  — approach / landing / departure runway in use
 *   notam    — everything else the pilot must notice (closures, wind shear,
 *              cranes, birds, NAVAID outages, readback requirements, ...)
 *   closing  — "...ADVS YOU HAVE INFO S"
 */

/** Categories for NOTAM segments, checked in order — first match wins. */
export const NOTAM_CATEGORIES = [
  { id: "rwy-closed", label: "RWY CLOSURE", re: /\b(RWY|RY|RUNWAY)\b.*\b(CLSD|CLOSED)\b|\b(CLSD|CLOSED)\b.*\b(RWY|RY|RUNWAY)\b/ },
  { id: "twy-closed", label: "TWY CLOSURE", re: /\b(TWY|TWYS|TAXIWAY|TAXIWAYS|TL|TAXILANE)\b.*\b(CLSD|CLOSED)\b/ },
  { id: "closed", label: "CLOSURE", re: /\b(CLSD|CLOSED)\b/ },
  { id: "wx-hazard", label: "WX HAZARD", re: /\bWIND ?SHEAR\b|\bLLWS\b|\bWS\b|\bMICROBURST\b|\bTSTM|\bTHUNDERSTORM|\bSIGMET\b|\bCONVECTIVE\b|\bICING\b|\bTURB/ },
  { id: "rwy-cond", label: "RWY CONDITION", re: /\bBRAKING\b|\bFICON\b|\bRCC\b|\bRWY COND|\bRUNWAY COND|\bSNOW\b|\bICE\b|\bSLUSH\b|\bSHORTENED\b|\bDISPLACED\b|\bTORA\b|\bLDA\b|\bAVBL LEN|\bLENGTH\b/ },
  { id: "obstruction", label: "OBSTRUCTION", re: /\bCRANES?\b|\bOBST|\bTOWER\b.*\bFT\b|\bUNLGTD\b/ },
  { id: "navaid", label: "NAVAID / LGT", re: /\bOTS\b|\bU\/S\b|\bUNUSABLE\b|\bUNSERVICEABLE\b|\bOUT OF SERVICE\b|\bINOP\b|\bUNMONITORED\b|\bGPS\b.*\b(UNRELIABLE|OUTAGE|JAMMING|INTERFERENCE)\b|\bGLIDE ?SLOPE\b|\bGS\b|\bLOC\b.*\b(OTS|UNUSABLE)\b|\bPAPI\b|\bVASI\b|\bALS\b|\bMALSR\b|\bREIL\b|\bLGT|\bLIGHT/ },
  { id: "construction", label: "CONSTRUCTION", re: /\bCONST|\bWIP\b|\bWORK IN PROGRESS\b|\bMEN AND EQUIP|\bEQUIPMENT\b|\bVEHICLES?\b/ },
  { id: "wildlife", label: "WILDLIFE", re: /\bBIRDS?\b|\bWILDLIFE\b|\bDEER\b|\bCOYOTE/ },
  { id: "procedure", label: "PROCEDURE", re: /\bREADBACK\b|\bREAD BACK\b|\bHOLD SHORT\b|\bCTC\b|\bCONTACT\b|\bMONITOR\b|\bFREQ\b|\bCLNC\b|\bCLEARANCE\b|\bPDC\b|\bSQUAWK\b|\bXPDR\b|\bTRANSPONDER\b|\bADVISE\b|\bADZ\b|\bREQUEST\b/ },
  { id: "general", label: "ADVISORY", re: /./ },
];

const HEADER_RE = /\b(ATIS|ARR INFO|DEP INFO|INFO(RMATION)?)\b.*\b(INFO(RMATION)?\s+[A-Z]\b|[0-9]{4}Z)/;
const CLOSING_RE = /\bADVS?\b.*\bHAVE\b|\bADVISE\b.*\bHAVE\b|\bON INITIAL CONTACT\b.*\bINFO|\bYOU HAVE INFO/;
// METAR tokens: wind (03020G32KT / VRB05KT), altimeter (A2976), temp/dew (14/13, M02/M05), vis (10SM), clouds.
const WX_TOKEN_RE = /\b(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT\b|\bA\d{4}\b|\b(M?\d{2})\/(M?\d{2})\b|\b\d+(\s\d\/\d)?SM\b|\b(FEW|SCT|BKN|OVC|VV)\d{3}\b|\bCLR\b|\bSKC\b|\bRMK\b|\bSLP\d{3}\b|\bT[01]\d{7}\b|\bALTM|\bALTIMETER\b|\bWIND\s+\d{3}/;
const RUNWAY_WORD = /\b(RWY|RY|RWYS|RUNWAYS?|RYS)\b|\bILS\b|\bRNAV\b|\bVISUAL\b|\bRNP\b|\bLOC\b|\bVOR\b/;
const RUNWAY_USE_RE = /\b(APCH|APCHS|APPROACH(ES)?|LNDG|LANDING|LAND|ARRIVALS?|ARR|DEPG|DEPARTING|DEPARTURES?|DEP|DEPTG|IN USE|EXPECT|SIMUL|SIMULTANEOUS|CONVERGING|PARALLEL)\b/;

/** Normalize whitespace and uppercase. */
export function normalizeAtis(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Split into sentences on periods that end a phrase ("TWY F CLSD. BIRD ..."),
 * keeping "..." leaders with the sentence that follows and leaving decimals
 * ("1.5 SM") alone.
 */
export function splitSentences(text) {
  const t = normalizeAtis(text);
  if (!t) return [];
  const out = [];
  let buf = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    buf += c;
    if (c !== ".") continue;
    const prev = t[i - 1] || "";
    const next = t[i + 1] || "";
    // "..." leader/ellipsis: absorb all dots and split before it if the buffer has text.
    if (next === "." || prev === ".") continue;
    if (/\d/.test(prev) && /\d/.test(next)) continue; // decimal
    if (next !== "" && next !== " ") continue; // "U.S" etc.
    pushSentence(out, buf);
    buf = "";
  }
  pushSentence(out, buf);
  // Split on "..." separators inside a sentence (common on some fields:
  // "NOTAMS... TWY B CLSD... BIRD ACTIVITY").
  const res = [];
  for (const s of out) {
    const parts = s.split(/\s*\.{2,}\s*/).map(p => p.trim()).filter(Boolean);
    for (const p of parts) res.push(p.replace(/\.$/, "").trim());
  }
  return res.filter(Boolean);
}

function pushSentence(out, buf) {
  const s = buf.trim();
  if (s && s.replace(/\./g, "").trim()) out.push(s);
}

/**
 * A sentence listing several closures ("TWY F TURNOFF CLSD, TWY FA TURNOFF CLSD")
 * is split into one NOTAM per clause when each clause stands alone.
 */
export function splitNotamClauses(sentence) {
  const parts = sentence.split(/\s*[,;]\s*/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return [sentence];
  const standalone = parts.every(p =>
    /^(TWY|TWYS|TAXIWAY|RWY|RY|RUNWAY|ILS|LOC|GS|PAPI|VASI|ALS|RAMP|APRON|GATE|TAXILANE|TL)\b/.test(p) &&
    /\b(CLSD|CLOSED|OTS|U\/S|UNUSABLE|INOP|OUT OF SERVICE)\b/.test(p));
  return standalone ? parts : [sentence];
}

/** @returns {{ id: string, label: string }} */
export function classifyNotam(text) {
  const t = normalizeAtis(text);
  for (const c of NOTAM_CATEGORIES) {
    if (c.re.test(t)) return { id: c.id, label: c.label };
  }
  return { id: "general", label: "ADVISORY" };
}

function isWeather(s) {
  const hits = s.match(new RegExp(WX_TOKEN_RE.source, "g"));
  return !!hits && hits.length >= 2;
}

function isRunwayUse(s) {
  if (/\b(CLSD|CLOSED|OTS|U\/S|UNUSABLE|INOP)\b/.test(s)) return false;
  return RUNWAY_WORD.test(s) && RUNWAY_USE_RE.test(s);
}

/**
 * Parse a D-ATIS text into ordered segments.
 * @param {string} text
 * @returns {{ kind: "header"|"weather"|"runways"|"notam"|"closing", text: string,
 *             category?: string, categoryLabel?: string, notamIndex?: number }[]}
 */
export function parseAtis(text) {
  const sentences = splitSentences(text);
  const segs = [];
  let notamIndex = 0;
  sentences.forEach((raw, i) => {
    // Strip a leading "NOTAMS" / "NOTICE TO AIR MISSIONS" label.
    let s = raw.replace(/^(NOTAMS?|NOTICES? TO (AIRMEN|AIR MISSIONS))\s*[.:]*\s*/, "").trim();
    if (!s) return;
    if (i === 0 && HEADER_RE.test(s)) {
      // Some stations run the METAR straight on after the header without a period.
      const m = s.match(/^(.*?\b\d{4}Z)\s+(.+)$/);
      if (m && isWeather(m[2])) {
        segs.push({ kind: "header", text: m[1] });
        segs.push({ kind: "weather", text: m[2] });
      } else {
        segs.push({ kind: "header", text: s });
      }
      return;
    }
    if (CLOSING_RE.test(s)) { segs.push({ kind: "closing", text: s }); return; }
    if (isWeather(s)) { segs.push({ kind: "weather", text: s }); return; }
    if (isRunwayUse(s)) { segs.push({ kind: "runways", text: s }); return; }
    for (const clause of splitNotamClauses(s)) {
      const cat = classifyNotam(clause);
      segs.push({ kind: "notam", text: clause, category: cat.id, categoryLabel: cat.label, notamIndex: notamIndex++ });
    }
  });
  return segs;
}

/** Info letter and time from the header, e.g. { letter: "S", time: "1551Z" }. */
export function atisInfo(text) {
  const t = normalizeAtis(text);
  const letter = (t.match(/\bINFO(?:RMATION)?\s+([A-Z])\b/) || [])[1] || null;
  const time = (t.match(/\b(\d{4}Z)\b/) || [])[1] || null;
  return { letter, time };
}
