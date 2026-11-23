/**
 * IAD / DCA / BWI departure SIDs: the altitude each SID is assigned after
 * takeoff and how it climbs out through Potomac TRACON (SHD, MTV, CHP areas)
 * to ZDC. Transcribed from the PCT area SID tables Matt supplied (Nov 2026):
 * "SHD SIDs", "MTV SIDs", "CHP SIDs" and "SHD/CHP SIDs" (into MTV).
 *
 * Each entry: { sid, trans?, init, steps: [{ fac, alt }], zdc: { sec, alt } | null, note? }
 *   init  — altitude assigned after takeoff ("100", "C/V 140" = climb via SID to 140)
 *   steps — TRACON areas the departure is handed through, with the altitude
 *   zdc   — ZDC sector it is handed to and the altitude ("" when the table leaves it blank)
 * A SID with several entries differs by transition (JCOBY AGARD / SWANN / SCOOB).
 */

export const SID_SOURCE = "PCT area SID tables (SHD, MTV, CHP), Nov 2026";

export const SID_AIRPORTS = {
  KIAD: { name: "Dulles", area: "SHD" },
  KDCA: { name: "Reagan National", area: "MTV" },
  KBWI: { name: "Baltimore/Washington", area: "CHP" },
};

export const SIDS = {
  KIAD: [
    { sid: "BUNZZ", init: "100", steps: [{ fac: "MTV LURAY", alt: "100" }], zdc: { sec: "05", alt: "170" } },
    { sid: "CLTCH", init: "100", steps: [{ fac: "MTV TYSON", alt: "100" }], zdc: { sec: "32", alt: "FL210" } },
    { sid: "CPTAL", init: "VARIOUS", steps: [], zdc: null, note: "Various (SHD table)" },
    { sid: "JCOBY", trans: "AGARD", init: "100", steps: [{ fac: "MTV KRANT", alt: "100" }], zdc: { sec: "17", alt: "170" } },
    { sid: "JCOBY", trans: "SWANN", init: "100", steps: [{ fac: "MTV KRANT", alt: "100" }], zdc: { sec: "17", alt: "FL190" } },
    { sid: "JCOBY", trans: "SCOOB", init: "100", steps: [{ fac: "MTV KRANT", alt: "100" }], zdc: { sec: "12", alt: "FL190" } },
    { sid: "JDUBB", init: "100", steps: [{ fac: "MTV TYSON", alt: "100" }], zdc: { sec: "32", alt: "FL210" } },
    { sid: "JERES", init: "110", steps: [{ fac: "CHP BUFFR", alt: "110" }], zdc: { sec: "05", alt: "170" } },
    { sid: "MCRAY", init: "110", steps: [{ fac: "CHP BUFFR", alt: "110" }], zdc: { sec: "05", alt: "170" } },
    { sid: "RNDLI", init: "100", steps: [{ fac: "MTV LURAY", alt: "100" }], zdc: { sec: "05", alt: "170" } },
    { sid: "SCRAM", init: "100", steps: [{ fac: "MTV TYSON", alt: "100" }], zdc: { sec: "32", alt: "FL210" } },
    { sid: "WOOLY", init: "100", steps: [{ fac: "CHP WOOLY", alt: "100" }], zdc: { sec: "17", alt: "150" } },
  ],
  KDCA: [
    { sid: "AMEEE", init: "FL190", steps: [], zdc: { sec: "12", alt: "FL190" } },
    { sid: "CLTCH", init: "FL210", steps: [], zdc: { sec: "32", alt: "FL210" } },
    { sid: "DOCTR", init: "170", steps: [], zdc: { sec: "17", alt: "170" } },
    { sid: "HORTO", init: "170", steps: [{ fac: "CHP BUFFR", alt: "170" }], zdc: { sec: "05", alt: "" } },
    { sid: "JDUBB", init: "FL210", steps: [], zdc: { sec: "32", alt: "FL210" } },
    { sid: "REBLL", init: "170", steps: [], zdc: { sec: "05", alt: "170" } },
    { sid: "SCRAM", init: "FL210", steps: [], zdc: { sec: "32", alt: "FL210" } },
    { sid: "SOOKI", init: "FL190", steps: [], zdc: { sec: "17", alt: "FL190" } },
    { sid: "WYNGS", init: "170", steps: [], zdc: { sec: "05", alt: "170" } },
  ],
  KBWI: [
    { sid: "CONLE", init: "C/V 140", steps: [{ fac: "MTV KRANT", alt: "140" }], zdc: { sec: "12", alt: "FL190" } },
    { sid: "DUKPN", init: "C/V 140", steps: [], zdc: { sec: "17", alt: "" } },
    { sid: "FIXET", init: "C/V 170", steps: [{ fac: "MTV KRANT", alt: "170" }], zdc: null, note: "No MTV → ZDC row in the tables" },
    { sid: "FOXHL", init: "C/V 170", steps: [{ fac: "MTV TYSON", alt: "170" }], zdc: { sec: "05", alt: "FL230" } },
    { sid: "LINSE", init: "C/V 160", steps: [], zdc: { sec: "05", alt: "170" } },
    { sid: "TERPZ", init: "C/V 170", steps: [{ fac: "MTV TYSON", alt: "170" }], zdc: { sec: "32", alt: "FL230" } },
  ],
};

const SID_TOKEN_RE = /^([A-Z]{3,5})(\d[A-Z]?)?$/;

/**
 * The SID a departure filed, from the first tokens of its route.
 * Returns { apt, sid, filed, trans, entries } or null when the airport is not
 * IAD/DCA/BWI. `entries` is empty when no known SID is filed; when the SID
 * splits by transition and the filed one matches, it holds just that entry.
 */
export function departureSid(dep, route) {
  const apt = String(dep || "").toUpperCase();
  const list = SIDS[apt];
  if (!list) return null;
  const toks = String(route || "").toUpperCase().replace(/\+/g, " ").split(/[\s.]+/)
    .map(t => t.split("/")[0]).filter(t => t && t !== "DCT" && !/^N\d{4}[AFM]/.test(t) && t !== apt && t !== apt.slice(1));
  for (let i = 0; i < Math.min(toks.length, 3); i++) {
    const m = toks[i].match(SID_TOKEN_RE);
    if (!m) continue;
    let entries = list.filter(e => e.sid === m[1]);
    if (!entries.length) continue;
    // "JCOBY4 JCOBY SWANN": skip the SID's own fix to reach the transition.
    const j = toks[i + 1] === m[1] ? i + 2 : i + 1;
    const trans = toks[j] || null;
    if (entries.length > 1 && trans) {
      const hit = entries.filter(e => e.trans === trans);
      if (hit.length) entries = hit;
    }
    return { apt, sid: m[1], filed: toks[i], trans, entries };
  }
  return { apt, sid: null, filed: toks[0] || "", trans: null, entries: [] };
}
