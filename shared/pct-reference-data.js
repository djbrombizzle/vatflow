/**
 * Potomac TRACON (PCT) quick reference for VATSIM: SIDs, STARs, short-haul
 * altitudes, gates and satellite airports for the three areas:
 *   SHD Shenandoah (IAD), CHP Chesapeake (BWI), MTV Mount Vernon (DCA).
 * Transcribed from "PCT Quick References VATSIM.pdf" that Matt supplied (Nov 2026).
 * Items the PDF marks amber ("verify") keep that flag: `verify: true`.
 *
 * Procedure entry:
 *   { ids: ["CLIPR", "SKILS"], name: "CLIPR3 · SKILS5", type: "SID" | "STAR",
 *     apts: ["KDCA"], area: "CHP", tag: "DCA → OJAAY",
 *     lines: ["text", { trans: ["IZZEE", "LRP"], text: "…" }],   // trans: shown bold when filed
 *     climb: [{ by: "SHD", alt: "100", to: "MTV LURAY" }],          // SIDs: who climbs it to what, then hands to whom
 *     fixes: { BAL: "@100 / 250 kt" },                               // map labels at these fixes
 *     notes: ["…"] }
 */

export const PCT_SOURCE = "PCT Quick References (VATSIM), Nov 2026";

export const AREAS = {
  SHD: { name: "Shenandoah", apt: "KIAD", label: "SHD · IAD" },
  CHP: { name: "Chesapeake", apt: "KBWI", label: "CHP · BWI" },
  MTV: { name: "Mount Vernon", apt: "KDCA", label: "MTV · DCA" },
};

export const PRIMARY = { KIAD: "SHD", KBWI: "CHP", KDCA: "MTV" };

export const PROCS = [
  /* ---------------- IAD SIDs (SHD climbs, MTV/CHP takes them on) ---------------- */
  { ids: ["MCRAY"], name: "MCRAY2", type: "SID", apts: ["KIAD"], area: "SHD", tag: "RNAV jets",
    lines: ["HAYGR → MCRAY"], climb: [{ by: "SHD", alt: "110", to: "CHP BUFFR" }],
    notes: ["JERES# / MCRAY# (IAD): climb & maintain 170 (CHP)"] },
  { ids: ["JERES"], name: "JERES2", type: "SID", apts: ["KIAD"], area: "SHD", tag: "RNAV jets",
    lines: ["IDORE → JERES"], climb: [{ by: "SHD", alt: "110", to: "CHP BUFFR" }],
    notes: ["JERES# / MCRAY# (IAD): climb & maintain 170 (CHP)"] },
  { ids: ["WOOLY", "HIICH"], name: "WOOLY2 · HIICH2", type: "SID", apts: ["KIAD"], area: "SHD", tag: "props: WOOLY",
    lines: ["Jets ↑110 · TP ↑100 · Props AoB 70"], climb: [{ by: "SHD", alt: "110 (TP 100, P AoB 70)", to: "CHP WOOLY" }],
    notes: ["CHP-WOOLY altitude: maybe 100? (verify)"], verify: true },
  { ids: ["JCOBY"], name: "JCOBY4", type: "SID", apts: ["KIAD"], area: "SHD", tag: "RNAV jets",
    lines: [{ trans: ["SWANN", "AGARD"], text: "SWANN / AGARD (or WOOLY2)" }, { trans: ["COLIN", "SCOOB"], text: "COLIN / SCOOB" }],
    climb: [{ by: "SHD", alt: "100", to: "MTV KRANT" }],
    then: [
      { trans: ["SWANN", "SOOKI"], by: "MTV", alt: "FL190", to: "ZDC 17" },
      { trans: ["AGARD", "DQO", "DOCTR"], by: "MTV", alt: "170", to: "ZDC 12" },
      { trans: ["COLIN", "SCOOB"], by: "MTV", alt: "FL190", to: "ZDC 12" },
    ] },
  { ids: ["BUNZZ"], name: "BUNZZ3", type: "SID", apts: ["KIAD"], area: "SHD", tag: "RNAV jets",
    lines: ["via RAMAY"], climb: [{ by: "SHD", alt: "100", to: "MTV LURAY" }, { by: "MTV", alt: "170", to: "ZDC 05" }] },
  { ids: ["RNLDI"], name: "RNLDI4", type: "SID", apts: ["KIAD"], area: "SHD", tag: "RNAV jets",
    lines: ["via OTTTO"], climb: [{ by: "SHD", alt: "100", to: "MTV LURAY" }, { by: "MTV", alt: "170", to: "ZDC 05" }] },
  { ids: ["CLTCH"], name: "CLTCH3", type: "SID", apts: ["KIAD"], area: "SHD", tag: "RNAV jets",
    lines: ["MAULS / FLASK"], climb: [{ by: "SHD", alt: "100", to: "MTV TYSON" }, { by: "MTV", alt: "FL210", to: "ZDC 32" }] },
  { ids: ["SCRAM"], name: "SCRAM6", type: "SID", apts: ["KIAD"], area: "SHD", tag: "RNAV jets",
    lines: ["via GLANC"], climb: [{ by: "SHD", alt: "100", to: "MTV TYSON" }, { by: "MTV", alt: "FL210", to: "ZDC 32" }] },
  { ids: ["JDUBB"], name: "JDUBB4", type: "SID", apts: ["KIAD"], area: "SHD", tag: "RNAV jets",
    lines: ["RRSIN / MELTN"], climb: [{ by: "SHD", alt: "100", to: "MTV TYSON" }, { by: "MTV", alt: "FL210", to: "ZDC 32" }] },

  /* ---------------- IAD STARs ---------------- */
  { ids: ["PRIVO", "WAYNZ"], name: "PRIVO3 · WAYNZ2", type: "STAR", apts: ["KIAD"], area: "SHD", tag: "RNAV · ZNY",
    lines: ["via JARAF / PRIVO → DAFIX", "DAFIX @120"], fixes: { DAFIX: "@120" } },
  { ids: ["SEG", "PRTZL"], name: "SEG6 · PRTZL2", type: "STAR", apts: ["KIAD"], area: "SHD", tag: "ZNY",
    lines: [{ proc: "SEG", text: "SEG6 (Selinsgrove): all @80" }, { proc: "PRTZL", text: "PRTZL2: D/V RNAV" }] },
  { ids: ["HYPER", "DELRO"], name: "HYPER1 · DELRO5", type: "STAR", apts: ["KIAD"], area: "SHD", tag: "ZNY",
    lines: [{ proc: "HYPER", text: "HYPER1 @140" }, { proc: "DELRO", text: "DELRO5 jets @100 · props @80" }] },
  { ids: ["GIBBZ"], name: "GIBBZ6", type: "STAR", apts: ["KIAD"], area: "SHD", tag: "D/V RNAV",
    lines: ["Bottom 60 · ZDC 05/37", { trans: ["MGW", "SITTR", "JARLO"], text: "MGW · SITTR/JARLO trans" }] },
  { ids: ["WIGOL"], name: "WIGOL3", type: "STAR", apts: ["KIAD"], area: "SHD", tag: "RNAV · SWAP",
    lines: ["ATC assigned", "70 from JRV"] },
  { ids: ["CAVLR", "COATT"], name: "CAVLR7 · COATT5", type: "STAR", apts: ["KIAD"], area: "SHD", tag: "ZDC 20 · JRV",
    lines: [{ proc: "CAVLR", text: "CAVLR7 D/V RNAV" }, { proc: "COATT", text: "COATT5 all @100" }, "N 90 · S 40 (handwritten)"], verify: true },

  /* ---------------- BWI SIDs ---------------- */
  { ids: ["LINSE"], name: "LINSE2", type: "SID", apts: ["KBWI"], area: "CHP", tag: "RNAV jets",
    lines: ["JERES / MCRAY"], climb: [{ by: "CHP", alt: "170", to: "ZDC 05" }] },
  { ids: ["FOXHL"], name: "FOXHL1", type: "SID", apts: ["KBWI"], area: "CHP", tag: "RNAV jets",
    lines: ["RAMAY / OTTTO"], climb: [{ by: "CHP", alt: "170", to: "MTV TYSON" }, { by: "MTV", alt: "FL230", to: "ZDC 05" }] },
  { ids: ["TERPZ"], name: "TERPZ8", type: "SID", apts: ["KBWI"], area: "CHP", tag: "RNAV jets",
    lines: ["MAULS / FLASK · GLANC", "RRSIN / MELTN"], climb: [{ by: "CHP", alt: "170", to: "MTV TYSON" }, { by: "MTV", alt: "FL230", to: "ZDC 32" }],
    notes: ["ANTHM# / TERPZ# conflict. TERPZ: FPH until clear"] },
  { ids: ["FIXET"], name: "FIXET5", type: "SID", apts: ["KBWI"], area: "CHP", tag: "RNAV jets",
    lines: [{ trans: ["RAMAY", "OTTTO", "GLANC"], text: "RAMAY / OTTTO · GLANC" }, { trans: ["MAULS", "FLASK"], text: "MAULS / FLASK" }, { trans: ["RRSIN", "MELTN"], text: "RRSIN / MELTN" }],
    climb: [{ by: "CHP", alt: "140", to: "MTV KRANT" }, { by: "MTV KRANT", alt: "FL190", to: "MTV TYSON" }],
    then: [
      { trans: ["MAULS", "FLASK", "GLANC", "RRSIN", "MELTN"], by: "MTV TYSON", alt: "FL230", to: "ZDC 32" },
      { trans: ["RAMAY", "OTTTO"], by: "MTV TYSON", alt: "FL230", to: "ZDC 05" },
    ] },
  { ids: ["CONLE"], name: "CONLE5", type: "SID", apts: ["KBWI"], area: "CHP", tag: "RNAV jets",
    lines: ["via SCOOB (COLIN)"], climb: [{ by: "CHP", alt: "140", to: "MTV KRANT" }, { by: "MTV", alt: "FL190", to: "ZDC 12" }] },
  { ids: ["DUKPN"], name: "DUKPN1", type: "SID", apts: ["KBWI"], area: "CHP", tag: "RNAV jets",
    lines: [{ trans: ["SWANN", "BROSS", "BYEDN"], text: "SWN: SWANN · BROSS · BYEDN" }, { trans: ["SPEAK", "RADAM", "AJGON"], text: "AGA: SPEAK · RADAM · AJGON" }],
    climb: [{ by: "CHP", alt: "140", to: "ZDC 17" }] },

  /* ---------------- BWI STARs ---------------- */
  { ids: ["ANTHM"], name: "ANTHM5", type: "STAR", apts: ["KBWI"], area: "CHP", tag: "RNAV · from ZDC 05",
    lines: ["via BUBBI · Descend via", "If EMI#: DV, expect 120"], notes: ["ANTHM# / TERPZ# conflict. TERPZ: FPH until clear"] },
  { ids: ["EMI"], name: "EMI7", type: "STAR", apts: ["KBWI"], area: "CHP", tag: "non-RNAV / props",
    lines: ["via BUBBI / MUMSY", "150 from ZDC", "110 / 250 kt (E) @ RUANE"], fixes: { RUANE: "110 / 250 kt (E)" } },
  { ids: ["TRISH"], name: "TRISH5", type: "STAR", apts: ["KBWI"], area: "CHP", tag: "RNAV · ZNY/PHL",
    lines: [{ trans: ["IZZEE", "LRP"], text: "IZZEE/LRP via DRRES @100" }, { trans: ["NUGGY"], text: "NUGGY via TROYZ @120" }, { trans: ["BAINS"], text: "BAINS (PHL) @100" }],
    fixes: { DRRES: "@100", TROYZ: "@120", BAINS: "@100" } },
  { ids: ["RAVNN"], name: "RAVNN9", type: "STAR", apts: ["KBWI"], area: "CHP", tag: "from MTV-KRANT",
    lines: ["Descend via", "alt: RAVNN @60"], fixes: { RAVNN: "@60" },
    notes: ["Watch RAVNN#: stop IAD departures @150 (MTV)", "Watch RAVNN#: AMEEE# climbs into it, stop at 100 (MTV)"] },
  { ids: ["MIIDY"], name: "MIIDY4", type: "STAR", apts: ["KBWI"], area: "CHP", tag: "RNAV · from ZDC 51",
    lines: ["via CHOPS", "CHOPS @110 / 250 kt"], fixes: { CHOPS: "@110 / 250 kt" } },

  /* ---------------- DCA SIDs (MTV) ---------------- */
  { ids: ["HORTO"], name: "HORTO4", type: "SID", apts: ["KDCA"], area: "MTV", tag: "DCA",
    lines: ["JERES / BUFFR", "RNAV jets: AoA 100 ↑170 → CHP-BUFFR", "Props: AoA 100 ↑120 → CHP-BUFFR"],
    climb: [{ by: "MTV", alt: "170 (props 120)", to: "CHP BUFFR" }], notes: ["HORTO# (DCA via BUFFR): issue altimeter (CHP)"] },
  { ids: ["WYNGS"], name: "WYNGS5", type: "SID", apts: ["KDCA"], area: "MTV", tag: "DCA",
    lines: ["via RAMAY"], climb: [{ by: "MTV", alt: "170", to: "ZDC 05" }] },
  { ids: ["REBLL"], name: "REBLL5", type: "SID", apts: ["KDCA"], area: "MTV", tag: "DCA",
    lines: ["via OTTTO"], climb: [{ by: "MTV", alt: "170", to: "ZDC 05" }] },
  { ids: ["SOOKI"], name: "SOOKI6", type: "SID", apts: ["KDCA"], area: "MTV", tag: "DCA",
    lines: ["via SWANN"], climb: [{ by: "MTV", alt: "FL190", to: "ZDC 17" }] },
  { ids: ["DOCTR"], name: "DOCTR5", type: "SID", apts: ["KDCA"], area: "MTV", tag: "DCA",
    lines: ["AGARD / DQO"], climb: [{ by: "MTV", alt: "170", to: "ZDC 12" }] },
  { ids: ["CLTCH"], name: "CLTCH3", type: "SID", apts: ["KDCA"], area: "MTV", tag: "DCA + IAD",
    lines: ["MAULS / FLASK"], climb: [{ by: "MTV", alt: "FL210", to: "ZDC 32" }] },
  { ids: ["SCRAM"], name: "SCRAM6", type: "SID", apts: ["KDCA"], area: "MTV", tag: "DCA + IAD",
    lines: ["via GLANC"], climb: [{ by: "MTV", alt: "FL210", to: "ZDC 32" }] },
  { ids: ["JDUBB"], name: "JDUBB4", type: "SID", apts: ["KDCA"], area: "MTV", tag: "DCA + IAD",
    lines: ["RRSIN / MELTN"], climb: [{ by: "MTV", alt: "FL210", to: "ZDC 32" }] },
  { ids: ["AMEEE"], name: "AMEEE1", type: "SID", apts: ["KDCA"], area: "MTV", tag: "DCA",
    lines: ["COLIN / SCOOB"], climb: [{ by: "MTV", alt: "FL190", to: "ZDC 12" }],
    notes: ["Watch RAVNN#: AMEEE# climbs into it, stop at 100"] },

  /* ---------------- DCA STARs ---------------- */
  { ids: ["FRDMM"], name: "FRDMM7", type: "STAR", apts: ["KDCA"], area: "MTV", tag: "DCA STAR", lines: ["D/V: S 80 · N 60"] },
  { ids: ["TRUPS"], name: "TRUPS6", type: "STAR", apts: ["KDCA"], area: "MTV", tag: "DCA STAR", lines: ["D/V: S 80 · N 60"] },
  { ids: ["CAPSS"], name: "CAPSS4", type: "STAR", apts: ["KDCA"], area: "MTV", tag: "DCA STAR", lines: ["D/V: S 60 · N 90"] },
  { ids: ["CLIPR", "SKILS"], name: "CLIPR3 · SKILS5", type: "STAR", apts: ["KDCA"], area: "CHP", tag: "DCA → OJAAY",
    lines: ["BAL @100 / 250 kt", "OJAAY: turns to MEGGS ≤ BAL"], fixes: { BAL: "@100 / 250 kt" } },
  { ids: ["DEALE"], name: "DEALE3", type: "STAR", apts: ["KDCA"], area: "CHP", tag: "DCA → OJAAY",
    lines: ["via BILIT · BILIT @110", "next DEALE @100"], fixes: { BILIT: "@110", DEALE: "@100" } },
];

/* Short-haul altitudes, by departure airport. Turbojet / turboprop-prop; "—" = not listed. */
export const SHORT_HAUL = {
  KIAD: [
    { dest: ["KBWI", "KDCA", "KHEF"], jet: "4,000", prop: "4,000" },
    { dest: ["KEWR", "KTEB", "KLGA"], jet: "FL210", prop: "—" },
    { dest: ["KJFK"], jet: "17,000", prop: "—" },
    { dest: ["KORF"], jet: "14,000", prop: "—" },
    { dest: ["KPHL"], jet: "11,000", prop: "7,000" },
    { dest: ["KRIC"], jet: "14,000", prop: "10,000" },
  ],
  KBWI: [
    { dest: ["KDCA", "KIAD", "KHEF"], jet: "4,000", prop: "4,000" },
    { dest: ["KEWR", "KTEB", "KLGA"], jet: "FL210", prop: "—" },
    { dest: ["KJFK"], jet: "17,000", prop: "—" },
    { dest: ["KMTN"], jet: "3,000", prop: "3,000" },
    { dest: ["KORF"], jet: "14,000", prop: "—" },
    { dest: ["KPHL"], jet: "11,000", prop: "7,000" },
    { dest: ["KRIC"], jet: "14,000", prop: "10,000" },
  ],
  KDCA: [
    { dest: ["KBWI", "KIAD", "KHEF"], jet: "4,000", prop: "4,000" },
    { dest: ["KEWR", "KTEB", "KLGA"], jet: "FL210", prop: "—" },
    { dest: ["KJFK"], jet: "17,000", prop: "—" },
    { dest: ["KORF"], jet: "14,000", prop: "10,000" },
    { dest: ["KPHL"], jet: "11,000", prop: "7,000" },
    { dest: ["KRIC"], jet: "12,000", prop: "10,000" },
  ],
};

/* Departure gates. IAD lists high and low altitude gates with the departure position. */
export const GATES = {
  KIAD: [
    { gate: ["BUFFR"], dir: "NW", dep: "ASPER 125.05" },
    { gate: ["JERES"], dir: "N/NW", dep: "ASPER 125.05" },
    { gate: ["MCRAY"], dir: "NW", dep: "ASPER 125.05" },
    { gate: ["PALEO", "AGARD"], dir: "NE", dep: "ASPER 125.05" },
    { gate: ["SWANN"], dir: "NE", dep: "ASPER 125.05" },
    { gate: ["WOOLY"], dir: "NE", dep: "ASPER 125.05" },
    { gate: ["CLTCH"], dir: "SW", dep: "TILLY 126.65" },
    { gate: ["HANEY"], dir: "SW", dep: "TILLY 126.65" },
    { gate: ["JDUBB"], dir: "SW", dep: "TILLY 126.65" },
    { gate: ["OTTTO"], dir: "W", dep: "TILLY 126.65" },
    { gate: ["RAMAY"], dir: "W", dep: "TILLY 126.65" },
    { gate: ["SCRAM"], dir: "SW", dep: "TILLY 126.65" },
    { gate: ["WHINO", "COLIN"], dir: "S/SE", dep: "TILLY 126.65" },
    { gate: ["EMI"], dir: "N/NE", dep: "ASPER 125.05", low: true },
    { gate: ["MRB"], dir: "N/NW", dep: "TILLY 126.65", low: true },
    { gate: ["BRV"], dir: "S", dep: "TILLY 126.65", low: true },
    { gate: ["CSN", "LDN"], dir: "W/SW", dep: "TILLY 126.65", low: true },
    { gate: ["GVE"], dir: "S/SW", dep: "TILLY 126.65", low: true },
    { gate: ["PXT"], dir: "SE", dep: "TILLY 126.65", low: true },
  ],
  KBWI: [
    { gate: ["BUFFR"], dir: "NW" }, { gate: ["CLTCH"], dir: "SW" }, { gate: ["DAILY", "COLIN"], dir: "S/SE" },
    { gate: ["JERES"], dir: "N/NE" }, { gate: ["JDUBB"], dir: "SW" }, { gate: ["OTTTO"], dir: "W" },
    { gate: ["PALEO"], dir: "NE" }, { gate: ["RAMAY"], dir: "W" }, { gate: ["SCRAM"], dir: "SW" },
    { gate: ["SWANN"], dir: "NE" }, { gate: ["WOOLY"], dir: "NE" },
    { gate: ["CSN"], dir: "W/SW", low: true }, { gate: ["EMI"], dir: "N/NE", low: true }, { gate: ["GVE"], dir: "S/SW", low: true },
    { gate: ["MRB"], dir: "N/NW", low: true }, { gate: ["PXT"], dir: "SE", low: true },
  ],
  KDCA: [
    { gate: ["BUFFR"], dir: "NW" }, { gate: ["CLTCH"], dir: "SW" }, { gate: ["COLIN"], dir: "S/SE" },
    { gate: ["JERES"], dir: "N/NE" }, { gate: ["JDUBB"], dir: "SW" }, { gate: ["OTTTO"], dir: "W" },
    { gate: ["PALEO"], dir: "NE" }, { gate: ["RAMAY"], dir: "W" }, { gate: ["SCRAM"], dir: "SW" },
    { gate: ["SWANN"], dir: "NE" }, { gate: ["WOOLY"], dir: "NE" },
    { gate: ["CSN"], dir: "W/SW", low: true }, { gate: ["EMI"], dir: "N/NE", low: true }, { gate: ["GVE"], dir: "S/SW", low: true },
    { gate: ["MRB"], dir: "N/NW", low: true }, { gate: ["PXT"], dir: "SE", low: true },
  ],
};

/* Satellite airports with a PDF info box. */
export const SATELLITES = {
  KHGR: { name: "Hagerstown Rgnl / Richard A Henson", area: "SHD", lines: ["Initial: 3,000 (verify)", "TRSTN4 arrival", "Departures: [cut off on original]", "Rwys 9/27 · 2/20"], verify: true },
  KMRB: { name: "Eastern WV Rgnl / Shepherd", area: "SHD", lines: ["Initial: 3,000", "HYPER, PRIVO, TRSTN arrivals", "CLTCH, JDUBB, SCRAM, TRIXY deps", "Rwy 8/26"] },
  KFDK: { name: "Frederick Muni", area: "SHD", lines: ["Initial: 3,000 (verify)", "TRSTN arrival", "CONLE, FOXHL, LINSE, TERPZ deps", "Rwys 5/23 · 12/30"], verify: true },
  KHEF: { name: "Manassas Rgnl / Harry P Davis", area: "SHD", lines: ["Initial: 3,000 (verify)", "GIBBZ, HYPER, PRIVO, TIKEE, TRSTN arrivals", "ARSNL, GABBE, HIICH departures", "Rwys 16L/34R · 16R/34L"], verify: true },
  KNYG: { name: "Quantico MCAF (Turner)", area: "SHD", lines: ["Initial: 3,000 (verify)", "HYPER, PRIVO, TIKEE arrivals", "Rwy 2/20"], verify: true },
};

/* Departure procedures and tables per primary airport (reference view). */
export const DEPARTURES = {
  KIAD: {
    clearance: [
      ["IFR RNAV jet", "3,000", "RNAV SID"], ["IFR non-RNAV jet", "3,000", "CPTAL#"], ["IFR prop", "3,000", "CPTAL#"],
      ["VFR jet", "3,000", "VFR AoB"], ["VFR prop", "2,500", "VFR AoB"], ["VFR helo", "1,300", "VFR AoB"],
    ],
    text: ["Missed approach / releases: runway heading · 2,000", "Auto releases suspended until released by PCT"],
  },
  KBWI: {
    text: [
      "IFR SID: climb via · Other: 4,000 & 10 min after",
      "VFR: jet AoB 3,500 · prop & helo AoB 2,000",
      "E / SE departures: GRACO · 1G · 124.55",
      "SW / W / N departures: WOOLY · 1W · 128.70",
      "Release: \"Climbing to ___, released\"",
    ],
  },
  KDCA: {
    text: [
      "IFR RNAV SID: climb via · Other: NATNL# 5,000 & 10 min after",
      "VFR: fixed wing AoB 2,500 · helo AoB 1,500",
      "North / East departures: KRANT · 1K · 125.65",
      "South / West departures: TYSON · 1Y · 118.95",
      "N op: S of DCA VOR/DME hold 2,000 until over airport",
    ],
  },
};

/* Static tables for the reference view: [title, headers, rows, area]. */
export const TABLES = [
  ["IAD runway selection", ["Depart", "Arrive", "Wind"], [
    ["1C · 1R", "1L · 1C · 1R", "North > 15 kt"], ["30 · 1R", "1L · 1C · 1R (verify)", "North < 15 kt"],
    ["19C · 19L", "19L · 19C · 19R", "South > 15 kt"], ["30 · 19L", "19L · 19C · 19R", "South < 15 kt"],
    ["19L · 19C", "12", "RWY 12 > 20 kt"], ["30", "30", "RWY 30 > 25 kt"]], "SHD"],
  ["IAD departure headings", ["Runways", "Sector", "Heading"], [
    ["1L · 1C · 1R · 30", "ASPER", "300–010"], ["", "TILLY", "245–300"],
    ["19L · 19R · 19C · 30", "ASPER", "280–320"], ["", "TILLY", "190–280"],
    ["w/ ILS · North", "ASPER 300–310", "TILLY 280–300"], ["w/ ILS · South", "ASPER 300", "TILLY 300–250"]], "SHD"],
  ["BWI departure headings · West op", ["", "WOOLY (SW/W/N)", "GRACO (E/SE)"], [
    ["Turbojets", "270–290 (28)", "150 (28)"], ["Props", "310–330 (33R)", "360–030 (33R)"]], "CHP"],
  ["BWI departure headings · East op", ["", "WOOLY (SW/W/N)", "GRACO (E/SE)"], [
    ["Turbojets", "330 (15R)", "120–150 (15R)"], ["Props", "040–120 (15L)", "100–120 (15L)"]], "CHP"],
  ["BWI missed approach", ["Runway", "Alt", "Hdg"], [["10 / 33L", "2,000", "200"], ["15L / 33R", "2,000", "060"], ["Other", "2,000", "RH"]], "CHP"],
  ["DCA IFR departure headings · North op", ["", "TYSON", "KRANT"], [["Turbojets", "320", "320"], ["Props", "280", "090"]], "MTV"],
  ["DCA IFR departure headings · South op", ["", "TYSON", "KRANT"], [["Turbojets", "190", "190"], ["Props", "230 (verify)", "150"]], "MTV"],
  ["DCA missed approach / go-around", ["Operation", "Altitude", "Heading"], [["North", "3,000 (verify)", "320"], ["South", "3,000", "185 or RH"]], "MTV"],
  ["DCA VFR departure headings", ["Op · direction", "Instructions", ""], [
    ["North · north / east", "Heading 090", ""], ["North · south / west", "Northwest over the river", ""], ["South · all", "South over the river", ""]], "MTV"],
];

/** The procedure for a filed name ("ANTHM5", "CLIPR3") at one of its airports. */
export function procFor(token, apt, type) {
  const m = String(token || "").toUpperCase().match(/^([A-Z]{2,5})(\d[A-Z]?)$/);  // digit required: EMI7, not the EMI VOR
  if (!m) return null;
  return PROCS.find(p => p.type === type && p.apts.includes(apt) && p.ids.includes(m[1])) || null;
}

function routeTokens(route) {
  return String(route || "").toUpperCase().replace(/\+/g, " ").split(/[\s.]+/)
    .map(t => t.split("/")[0]).filter(t => t && t !== "DCT" && !/^N\d{4}[AFM]/.test(t) && !/^[KN]\d{4}/.test(t));
}

/**
 * The PDF SID filed out of IAD/DCA/BWI: { proc, filed, trans } or null.
 * Looks at the first three route tokens; `trans` is the token after the SID
 * (skipping the SID's own fix: "JCOBY4 JCOBY SWANN").
 */
export function filedSid(dep, route) {
  const apt = String(dep || "").toUpperCase();
  const toks = routeTokens(route).filter(t => t !== apt && t !== apt.slice(1));
  for (let i = 0; i < Math.min(toks.length, 3); i++) {
    const proc = procFor(toks[i], apt, "SID");
    if (!proc) continue;
    const base = toks[i].replace(/\d[A-Z]?$/, "");
    const j = toks[i + 1] === base ? i + 2 : i + 1;
    return { proc, filed: toks[i], trans: toks[j] || null, tokens: toks };
  }
  return null;
}

/** The PDF STAR filed into IAD/DCA/BWI: { proc, filed, trans } (trans = token before the STAR) or null. */
export function filedStar(arr, route) {
  const apt = String(arr || "").toUpperCase();
  const toks = routeTokens(route).filter(t => t !== apt && t !== apt.slice(1));
  for (let i = toks.length - 1; i >= Math.max(0, toks.length - 3); i--) {
    const proc = procFor(toks[i], apt, "STAR");
    if (!proc) continue;
    const base = toks[i].replace(/\d[A-Z]?$/, "");
    const prev = toks[i - 1] && toks[i - 1] !== base ? toks[i - 1] : toks[i - 2] || null;
    return { proc, filed: toks[i], trans: prev, tokens: toks };
  }
  return null;
}

/** Card lines for a filed procedure: each { text, hit } where hit = this line's transition or STAR was filed. */
export function procLines(proc, filed, tokens) {
  const set = new Set(tokens || []);
  const base = String(filed || "").replace(/\d[A-Z]?$/, "");
  return proc.lines.map(l => {
    if (typeof l === "string") return { text: l, hit: false };
    const hit = (l.trans && l.trans.some(t => set.has(t))) || (l.proc && l.proc === base);
    return { text: l.text, hit: !!hit };
  });
}

/** The climb / hand-off chain, with the `then` step that matches the filed transition. */
export function climbChain(proc, tokens) {
  const out = (proc.climb || []).slice();
  if (proc.then) {
    const set = new Set(tokens || []);
    const hit = proc.then.find(t => t.trans.some(x => set.has(x)));
    if (hit) out.push(hit);
  }
  return out;
}

/** Short-haul altitude for a departure: { jet, prop } or null. */
export function shortHaul(dep, arr) {
  const rows = SHORT_HAUL[String(dep || "").toUpperCase()];
  return rows ? rows.find(r => r.dest.includes(String(arr || "").toUpperCase())) || null : null;
}

/** Departure gate from the route (first gate fix or navaid named): the GATES row or null. */
export function departureGate(dep, route) {
  const rows = GATES[String(dep || "").toUpperCase()];
  if (!rows) return null;
  for (const t of routeTokens(route).slice(0, 8)) {
    const hit = rows.find(r => r.gate.includes(t));
    if (hit) return hit;
  }
  return null;
}
