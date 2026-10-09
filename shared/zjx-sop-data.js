/**
 * ZJX SOP crossing restrictions — vZJX-ZJX 7110.65Y v1.4 (22 Jan 2026),
 * Chapters 4–9 sector "Descent Table"s, plus the few crossing/spacing rules
 * that only appear in a sector's General Procedures. Used by zjx-crossings.html.
 *
 * ROWS: [sector, for, qualifier, routing, restriction, to, note, speed, label]
 * The first six columns follow shared/zdc-sop-data.js so the ZDC matcher
 * (shared/zdc-sop-match.js matchFlight with ctx.rows) works unchanged:
 *   sector     — ZJX sector whose descent table lists the row
 *   for        — destination(s): "KMCO", "KORL/KISM", "ATL+" (plus satellites
 *                within 35 nm), "CLT SATS"; terminal areas are spelled out as
 *                their airports with "+" and `label` holds the SOP's wording
 *   qualifier  — "JET" / "TP" when the SOP limits a row to turbojets/turboprops
 *   routing    — STAR column: "#" = any revision, " / " = alternate routings,
 *                "[A/B]" = either fix, (..) = condition shown as a note;
 *                empty = every arrival to that destination through the sector
 *   restriction— altitude column as printed
 *   to         — sector or facility the row hands to / is measured against:
 *                "78" (Sector 78 BDRY / HO 78), "ZMA" (ARTCC BDRY),
 *                "TLH APP" (approach BDRY); "" when the SOP names none
 *   note, speed— the SOP's Note and Speed columns
 */

export const SOP_ID = "vZJX-ZJX 7110.65Y v1.4";
export const SOP_DATE = "2026-01-22";

/** Table 1 — ZJX operating positions: sector → [name, area, stratum]. */
export const SECTOR_INFO = {
  "16": ["Mayo", "Central", "High"], "17": ["Perry", "Central", "High"], "32": ["Ozark", "Central", "Ultra-high"],
  "33": ["Geneva", "Central", "High"], "34": ["Seminole", "Central", "High"], "85": ["Micanopy", "Central", "Ultra-high"],
  "86": ["Zephyr", "Central", "Ultra-high"],
  "47": ["Summer", "East", "High"], "48": ["Georgetown", "East", "Ultra-high"], "49": ["Moultrie", "East", "Ultra-high"],
  "50": ["Alma", "East", "High"], "65": ["Ridgeway", "East", "Ultra-high"], "66": ["Aiken", "East", "High"],
  "14": ["Cedar Key", "Gulf", "Low"], "15": ["Ocala", "Gulf", "Low"], "77": ["Taylor", "Gulf", "Low"],
  "78": ["Lake City", "Gulf", "High"], "87": ["Lawtey", "Gulf", "Ultra-high"], "88": ["Darbs", "Gulf", "Low"],
  "35": ["Torry", "North", "High"], "51": ["Knemo", "North", "Ultra-high"], "52": ["Metta", "North", "High"],
  "53": ["Brunswick", "North", "Low"], "54": ["Jekyll", "North", "Low"], "71": ["Florence", "North", "Low"],
  "72": ["Columbia", "North", "Low"], "73": ["Allendale", "North", "Low"], "74": ["Charleston", "North", "Low"],
  "57": ["St. Johns", "South", "Low"], "58": ["St. Augustine", "South", "High"], "67": ["Hunter", "South", "Ultra-high"],
  "68": ["States", "South", "High"], "75": ["Green Cove", "South", "High"], "76": ["Keystone", "South", "Ultra-high"],
  "10": ["Crestview", "West", "Low"], "11": ["Brewton", "West", "High"], "12": ["Albany", "West", "Low"],
  "21": ["Enterprise", "West", "Ultra-high"], "28": ["Tallahassee", "West", "Low"], "29": ["Waycross", "West", "Low"],
  "30": ["Nepta", "West", "High"], "31": ["St. George", "West", "Ultra-high"],
};

export const SECTORS = Object.fromEntries(Object.entries(SECTOR_INFO).map(([k, v]) => [k, v[0]]));
export const AREAS = ["Central", "East", "Gulf", "North", "South", "West"];

/** SOP section of each sector's descent table (or General Procedures when it has none). */
export const SECTOR_REF = {
  "16": "4.1.2", "17": "4.2.2", "32": "4.3.2", "33": "4.4.1", "34": "4.5.1", "85": "4.6.1", "86": "4.7.1",
  "47": "5.1.2", "48": "5.2.2", "49": "5.3.2", "50": "5.4.2", "65": "5.5.2", "66": "5.6.2",
  "14": "6.1.2", "15": "6.2.2", "77": "6.3.2", "78": "6.4.2", "87": "6.5.2", "88": "6.6.2",
  "35": "7.1.1", "51": "7.2.2", "52": "7.3.2", "53": "7.4.1", "54": "7.5.2", "71": "7.6.2",
  "72": "7.7.2", "73": "7.8.2", "74": "7.9.2",
  "57": "8.1.2", "58": "8.2.2", "67": "8.3.2", "68": "8.4.2", "75": "8.5.2", "76": "8.6.2",
  "10": "9.1.2", "11": "9.2.2", "12": "9.3.2", "21": "9.4.2", "28": "9.5.2", "29": "9.6.2",
  "30": "9.7.2", "31": "9.8.2",
};

/**
 * Sectors missing from the repo's sector polygons (data/artcc-sectors-*.geojson,
 * PERTI/vIFF), approximated by the sectors they sit over on the SOP's
 * Ultra-High chart (3.3). Used only to decide whether a route crosses them.
 */
export const SECTOR_FALLBACK = {
  "21": ["11"], "31": ["30"], "32": ["33", "34"], "48": ["47"], "51": ["52", "35"], "67": ["68"],
};

export const FACILITY_NAMES = {
  ZDC: "Washington ARTCC", ZHU: "Houston ARTCC", ZMA: "Miami ARTCC", ZTL: "Atlanta ARTCC",
  A80: "Atlanta TRACON", F11: "Central Florida TRACON", "JAX APP": "Jacksonville TRACON",
};

// Terminal areas the SOP names as a group.
const F11 = "MCO/ORL/SFB/ISM+";
const JAX = "JAX/CRG/NIP/VQQ/NRB/HEG/SGJ+";
const TPA = "TPA/PIE/MCF/TPF+";
const MSY = "MSY/NEW/NBG+";
const GPT = "GPT/BIX+";

export const ROWS = [
  // 4.1.2 Sector 16 Mayo
  ["16", "KDAB", "", "", "FL270", "", "Descend upon entering airspace", ""],
  ["16", "KJAX", "", "TEBOW#", "FL270", "", "Descend upon entering airspace", ""],
  ["16", "KTLH", "", "", "Sector 17 BDRY @ FL270", "88", "Handoff 88", ""],
  ["16", "KPBI", "", "TTYLR#", "PIE @ FL270", "", "", ""],
  ["16", "KPBI", "", "VUUDU#", "MOLIE @ FL270", "", "", ""],
  ["16", "KRSW", "", "JOSFF#", "BDRY @ FL270", "ZMA", "ZMA BDRY", ""],
  ["16", "KRSW", "", "TYNEE#", "OGGER @ FL270", "", "", ""],
  ["16", "KRSW", "", "SHFTY#", "INPIN AOB FL310", "", "", ""],
  ["16", "KPGD", "", "LUBBR#", "BATTN AOB FL270", "", "", ""],
  ["16", "KAPF", "", "ZEILR#", "PIE AOB FL310", "ZMA", "ZMA BDRY", ""],

  // 4.2.2 Sector 17 Perry
  ["17", "KDAB", "", "GNV", "45 NM NW of GNV @ FL240", "", "", ""],
  ["17", "KMCO", "", "GRNCH# / JAFAR#", "BDRY AOB FL270", "78", "Sector 78 BDRY", ""],
  ["17", "KSFB", "", "BITTE SHREK# / OCF V159 LEESE#", "BDRY AOB FL240", "16", "Sector 16 BDRY", ""],
  ["17", "KPIE", "", "BANGZ#", "LALAA @ FL270", "", "", ""],
  ["17", "KSRQ", "", "BANGZ#", "LALAA @ FL270", "", "", ""],
  ["17", "KRSW", "", "TYNEE#", "BDRY AOB FL350", "ZMA", "ZMA BDRY", ""],
  ["17", "KTPA", "", "MAATY#", "LEGGT @ FL270", "", "", ""],
  ["17", "KPGD", "", "LUBBR#", "AOB FL310", "16", "Sector 16 BDRY", ""],
  ["17", "KPGD", "", "PIKKR#", "BDRY @ FL270", "88", "Sector 88 BDRY", ""],

  // 4.3.2 Sector 32 Ozark
  ["32", "KTPA", "", "DADES#", "FL370", "", "Descend as soon as practical", ""],
  ["32", "KMCO", "", "", "FL370", "", "Descend as soon as practical", ""],
  ["32", "KPNS/KVPS", "", "", "FL370", "", "Descend as soon as practical", ""],

  // 4.4.1 Sector 33 Geneva
  ["33", "KDAB", "", "GNV", "BDRY AOB FL240", "78", "Sector 78 BDRY", ""],
  ["33", "KGNV", "", "", "BDRY AOB FL240", "78", "Sector 78 BDRY", ""],
  ["33", "KSFB", "", "BITTE SHREK# / OCF V159 LEESE#", "BDRY AOB FL240", "78", "Sector 78 BDRY", ""],
  ["33", "KJAX", "", "MARQO#", "ZOOSS @ FL240", "", "", ""],
  ["33", "KMCO", "", "GRNCH#", "ISSZZ @ FL290", "", "", ""],
  ["33", "KORL", "", "JAFAR# / LEESE#", "BDRY @ FL270", "17", "Sector 17 BDRY", ""],
  ["33", "KISM", "", "JAFAR# / LEESE#", "BDRY @ FL270", "17", "Sector 17 BDRY", ""],
  ["33", "KTPA", "JET", "DADES#", "BDRY AOB FL310", "78", "Sector 78 BDRY", ""],
  ["33", "KTPA", "TP", "DADES#", "BDRY AOB FL270", "78", "Sector 78 BDRY", ""],

  // 4.5.1 Sector 34 Seminole
  ["34", "KDAB", "", "GNV", "BDRY AOB FL240", "78", "Sector 78 BDRY", ""],
  ["34", "KSFB", "", "BITTE SHREK# / OCF V159 LEESE#", "BDRY AOB FL240", "78", "Sector 78 BDRY", ""],
  ["34", "KMCO/KORL/KISM", "", "GRNCH# / JAFAR#", "BDRY AOB FL270", "17", "Sector 17 BDRY", ""],
  ["34", "KPNS/KVPS", "", "", "BDRY AOB FL240", "11", "Sector 11 BDRY", ""],
  ["34", "KPNS", "", "DEFUN", "BDRY AOB FL300", "11", "Sector 11 BDRY", ""],
  ["34", "KATL", "", "GNDLF# / HOBTT#", "BDRY AOB FL340", "ZTL", "ZTL BDRY", ""],

  // 5.1.2 Sector 47 Summer
  ["47", "KJAX", "", "ESENT LUNNI#", "BDRY AOB FL300", "68", "Sector 68 BDRY", ""],
  ["47", "KCLT", "", "CRVET STOCR# / CRVET RASLN#", "CRVET @ FL240", "", "", ""],
  ["47", "KCLT", "", "CHRGR STOCR# / CHRGR RASLN#", "CHRGR @ FL240", "", "", ""],
  ["47", "KCLT", "", "SHLBI STOCR# / SHLBI RASLN#", "SHLBI @ FL240", "", "", ""],
  ["47", "KCLT", "", "STOCR# / RASLN#", "40 NM S of FLO @ FL240", "", "", ""],
  ["47", "CLT SATS", "", "RASLN#", "BDRY AOB FL240", "", "", "", "CLT satellites"],
  // 7.9.1 (Charleston general procedures)
  ["47", "SAV/SVN", "", "", "20 NM out of CHS @ FL240", "74", "Clear via CHS..LGRHD..SOOOP direct destination; normally handoff to Charleston low (7.9.1)", ""],

  // 5.2.2 Sector 48 Georgetown
  ["48", "KCLT", "", "STOCR# / RASLN#", "FL350", "47", "Descend upon entering airspace, HO 47", ""],
  ["48", "KMCO", "", "", "GTOUT#/SNFLD# per flow", "", "Route via the correct STAR for the airport's landing direction", ""],

  // 5.3.2 Sector 49 Moultrie
  ["49", "KMCO", "", "GRNCH# / LEESE#", "FL350", "50", "Descend upon entering airspace, HO 50", ""],
  ["49", "KMCO", "", "HUNKR BRKWL JAFAR#", "FL350", "50", "Descend upon entering airspace, HO 50", ""],
  ["49", "KMLB", "", "OMN BITHO#", "FL350", "50", "Descend upon entering airspace, HO 50", ""],
  ["49", "KSFB", "", "MMOSS SHREK#", "FL350", "50", "Descend upon entering airspace, HO 50", ""],
  ["49", "KSFB", "", "CYNTA OCF V159 LEESE#", "FL350", "50", "Descend upon entering airspace, HO 50", ""],
  ["49", "KSFB", "", "KYLEG TTHOR#", "FL350", "50", "Descend upon entering airspace, HO 50", ""],
  ["49", "ATL+", "", "", "BDRY AOB FL350", "ZTL", "Route via the advertised directional STAR where practical", "", "ATL and satellites"],
  ["49", "SRQ/VNC/LAL", "", "KYYUU LUBBR# / GNV VARZE BREKR", "BDRY AOB FL380", "", "", ""],

  // 5.4.2 Sector 50 Alma
  ["50", "KDAB", "", "KYLEG TTHOR#", "KYLEG @ FL240", "", "", ""],
  ["50", "KJAX", "", "OHDEA#", "ILTAC @ FL240", "", "", ""],
  ["50", "KMCO", "", "GRNCH# / LEESE#", "BDRY AOB FL340", "78", "Sector 78 BDRY", ""],
  ["50", "KMCO", "", "HUNKR BRKWL JAFAR#", "BDRY AOB FL300", "78", "Sector 78 BDRY", ""],
  ["50", "KMLB", "", "OMN BITHO#", "BDRY AOB FL340", "75", "Sector 75 BDRY", ""],
  ["50", "KORL/KISM", "", "HUNKR BRKWL JAFAR#", "BDRY AOB FL300", "78", "Sector 78 BDRY", ""],
  ["50", "KORL/KISM", "", "KYLEG TTHOR#", "KYLEG @ FL240", "", "", ""],
  ["50", "KSFB", "", "MMOSS SHREK#", "BDRY AOB FL260", "78", "Sector 78 BDRY", ""],
  ["50", "KSFB", "", "CYNTA OCF V159 LEESE#", "BDRY AOB FL260", "78", "Sector 78 BDRY", ""],
  ["50", "KSFB", "", "KYLEG TTHOR#", "KYLEG @ FL240", "", "", ""],
  ["50", "ATL+", "", "", "BDRY AOB FL350", "ZTL", "Route via the advertised directional STAR where practical", "", "ATL and satellites"],
  ["50", "KTPA", "TP", "", "BDRY AOB FL260", "78", "Turboprops only; Sector 78 BDRY", ""],
  // 5.4.1 (Alma general procedures)
  ["50", F11, "", "", "7 MIT", "78", "In trail to Lake City regardless of altitude; release turns and descent within 15 NM of the boundary (5.4.1)", "", "F11 complex"],

  // 5.5.2 Sector 65 Ridgeway
  ["65", "KJAX", "", "LUNNI#", "FL350", "66", "Descend upon entering airspace, HO 66", ""],
  ["65", "KMCO", "", "", "GTOUT#/SNFLD# per flow", "", "Route via the correct STAR for landing direction", ""],
  ["65", "KSAV", "", "CANTR PLZZZ", "FL350", "66", "Descend upon entering airspace, HO 66", ""],
  ["65", "RDU+", "", "DMSTR#", "FL350", "66", "Descend upon entering airspace, HO 66", "", "RDU and satellites"],
  ["65", "RDU+", "", "BUZZY#", "FL350", "66", "Descend upon entering airspace, HO 66", "", "RDU and satellites"],
  ["65", "KATL", "", "JJEDI# / SITTH#", "AOB FL360", "ZTL", "Even altitude", ""],

  // 5.6.2 Sector 66 Aiken
  ["66", "KJAX", "", "LUNNI#", "BDRY AOB FL300", "68", "Sector 68 BDRY", ""],
  ["66", "KMCO", "", "", "GTOUT#/SNFLD# per flow", "", "Route via the correct STAR for landing direction", ""],
  ["66", "KSAV", "", "CANTR PLZZZ", "CANTR @ FL240", "", "", ""],
  ["66", "RDU+", "", "DMSTR#", "20 NM S of JURDI @ FL240", "71", "Sector 71 descends to the ZDC BDRY: turbojets AOB FL210, turboprops AOB 170", "", "RDU and satellites"],
  ["66", "RDU+", "", "BUZZY#", "20 NM S of TENNI @ FL240", "71", "Sector 71 descends to the ZDC BDRY: turbojets AOB FL210, turboprops AOB 170", "", "RDU and satellites"],
  ["66", "KATL", "", "JJEDI# / SITTH#", "AOB FL360", "ZTL", "Even altitude", ""],

  // 6.1.2 Sector 14 Cedar Key
  ["14", F11, "", "BITTE JAFAR#", "Descend via", "", "Assigned coordinated direction of arrival", "", "F11 arrivals"],
  ["14", F11, "", "BITTE SHREK#", "WANDD @ 11,000", "JAX APP", "Handoff to JAX VITTS sector", "", "F11 arrivals"],

  // 6.2.2 Sector 15 Ocala
  ["15", F11, "", "GRNCH#", "Descend via", "", "Assigned coordinated direction of arrival", "", "F11 arrivals"],
  ["15", F11, "", "JAFAR#", "Descend via", "", "Assigned coordinated direction of arrival", "", "F11 arrivals"],
  ["15", F11, "", "LEESE#", "SHIMM @ 11,000", "", "", "South ops 250 kt", "F11 arrivals"],
  ["15", F11, "", "[BIGDE/BITTE] SHREK#", "WANDD @ 11,000", "JAX APP", "Transfer to JAX_APP for further descent", "", "F11 arrivals"],
  ["15", F11, "", "MMOSS SHREK#", "GRTNT @ 11,000", "JAX APP", "Transfer to JAX_APP for further descent", "", "F11 arrivals"],
  ["15", JAX, "", "TEBOW#", "MCFIE @ 12,000", "", "", "", "JAX TRACON"],
  ["15", JAX, "", "", "BDRY @ 11,000", "JAX APP", "", "", "JAX TRACON"],
  ["15", "KSRQ", "JET", "LUBBR#", "LUBBR @ 13,000", "", "Turbojets", ""],
  ["15", "KSRQ", "TP", "LUBBR#", "LUBBR @ 11,000", "", "Turboprops", ""],
  ["15", "KSRQ", "JET", "VARZE BREKR", "TPA BDRY AOB 13,000", "TPA APP", "Turbojets", ""],
  ["15", "KSRQ", "TP", "VARZE BREKR", "TPA BDRY AOB 11,000", "TPA APP", "Turboprops", ""],
  ["15", "KTPA/KPIE", "JET", "DADES#", "OLENE @ 13,000", "", "Turbojets", ""],
  ["15", "KPIE", "TP", "DADES#", "OLENE @ 9,000", "", "Turboprops", ""],
  ["15", "KTPA", "TP", "DADES#", "OLENE @ 11,000", "", "Turboprops", ""],
  ["15", "KTPA/KPIE", "JET", "DADES", "BDRY @ 13,000", "TPA APP", "DADES direct; turbojets", ""],
  ["15", "KPIE", "TP", "DADES", "BDRY @ 9,000", "TPA APP", "DADES direct; turboprops", ""],
  ["15", "KTPA", "TP", "DADES", "BDRY @ 11,000", "TPA APP", "DADES direct; turboprops", ""],
  ["15", "KPGD", "", "BREKR LUBBR#", "BREKR AOB FL210", "", "", ""],

  // 6.3.2 Sector 77 Taylor
  ["77", JAX, "", "MARQO#", "COROE @ 11,000", "", "", "", "JAX TRACON"],
  ["77", "KTLH", "", "", "BDRY @ 11,000", "TLH APP", "TLH APP BDRY", ""],
  ["77", "KVLD", "", "", "BDRY @ 11,000", "VAD APP", "VAD APP BDRY", ""],

  // 6.4.2 Sector 78 Lake City
  ["78", "KMCO", "", "JAFAR#", "BDRY AOB FL250", "15", "Sector 15 BDRY", ""],
  ["78", "KMCO", "", "GRNCH#", "ELITE @ FL260", "", "Must provide mandatory in-trail spacing to the F11 complex", ""],
  ["78", "KMCO", "", "LEESE#", "AOB FL270", "15", "Sector 15 BDRY", ""],
  ["78", "KMCO/KSFB", "TP", "SHREK#", "AOB FL240 descending to FL190", "15", "Sector 77/15 BDRY (turboprops)", ""],
  ["78", "KSFB", "", "SHREK# / OCF V159 LEESE#", "BDRY descending to FL240", "15", "Sector 15 BDRY", ""],
  ["78", "KATL", "", "", "BDRY AOB FL370", "", "Route via the advertised STAR where practical", ""],
  ["78", "KPGD", "", "LUBBR#", "Abeam BATTN AOB FL270", "", "Released for turns and descents", ""],
  ["78", "KSRQ", "", "LUBBR# / GNV VARZE BREKR", "Abeam SSPAZ/GNV @ FL270", "", "Released for turns and descents", ""],
  ["78", TPA, "", "DADES# / LZARD#", "Over or abeam CAPOH @ FL270", "", "", "", "TPA complex"],

  // 6.5.2 Sector 87 Lawtey
  ["87", "KPGD", "", "LUBBR#", "FL350", "78", "Descend upon entering airspace, HO 78", ""],

  // 6.6.2 Sector 88 Darbs
  ["88", JAX, "", "", "BDRY @ 11,000", "JAX APP", "JAX TRACON border", "", "JAX VITTS sector arrivals"],
  ["88", "KPIE", "JET", "BANGZ# / BANGZ", "BANGZ @ 10,000 / BDRY @ 10,000", "", "Turbojets", ""],
  ["88", "KPIE", "TP", "BANGZ# / BANGZ", "CORRL @ 9,000 / BDRY @ 9,000", "", "Turboprops", ""],
  ["88", "KSRQ", "JET", "BANGZ# / BANGZ", "BANGZ @ 13,000 / BDRY @ 13,000", "", "Turbojets", ""],
  ["88", "KSRQ", "TP", "BANGZ# / BANGZ", "CORRL @ 11,000 / BDRY @ 11,000", "", "Turboprops", ""],
  ["88", "KTPA", "JET", "MAATY#", "MAATY @ 11,000", "", "Turbojets", ""],
  ["88", "KTPA", "TP", "MAATY#", "MAATY AOB 9,000", "", "Turboprops", ""],
  ["88", "KPGD", "", "PIKKR#", "WHITL AOB FL230", "", "", ""],

  // 7.2.2 Sector 51 Knemo (7.2.1: CLT turbojets via PITRW.STOCR#)
  ["51", "KCLT", "", "PITRW STOCR#", "FL350", "52", "Descend upon entering airspace, HO 52", ""],
  ["51", "KRDU", "", "(via GARIC/BDRY)", "FL350", "52", "Descend upon entering airspace, HO 52", ""],

  // 7.3.2 Sector 52 Metta
  ["52", "KCLT", "", "PITRW STOCR#", "PITRW AOB FL310", "", "Turbojets must be cleared via PITRW.STOCR# (7.3.1)", ""],
  ["52", "KRDU", "", "(via GARIC/BDRY)", "FL290", "ZDC", "ZDC BDRY; released for descent to FL240 20 NM from the boundary", ""],

  // 7.5.2 Sector 54 Jekyll
  ["54", "VQQ/NIP/SGJ/HEG", "", "HOTAR#", "BDRY AOB 16,000", "JAX APP", "JAX APP has control for descent to 10,000", "", "JAX TRACON (VQQ, NIP, SGJ, HEG)"],
  ["54", "CRG/NRB", "", "HOTAR#", "BDRY AOB 10,000", "JAX APP", "JAX_APP BDRY", "", "JAX TRACON (CRG, NRB)"],
  ["54", JAX, "", "LUNNI#", "LUNNI @ 8,000", "", "West operations", "", "JAX TRACON"],
  ["54", JAX, "", "LUNNI#", "LUNNI @ 10,000", "", "East operations", "", "JAX TRACON"],
  ["54", "KSAV", "", "", "BDRY @ 10,000", "SAV APP", "SAV APP border", ""],

  // 7.6.2 Sector 71 Florence
  ["71", "KFLO", "", "", "BDRY @ 11,000", "FLO APP", "FLO APP BDRY", ""],
  ["71", "KMYR", "", "", "BDRY @ 11,000", "MYR APP", "MYR APP BDRY", ""],
  ["71", "KSSC", "", "", "BDRY @ 11,000", "SSC APP", "SSC APP BDRY", ""],
  ["71", "KCLT", "", "STOCR#", "Descend via", "", "Assign coordinated direction of arrival", ""],
  ["71", "KCLT", "", "MLLET#", "MLLET @ 12,000", "", "North ops", ""],
  ["71", "KCLT", "", "MLLET#", "MLLET @ 14,000", "", "South ops", ""],
  ["71", "KCLT", "JET", "RASLN#", "RASLN @ 12,000", "", "Turbojets only; north ops", "250 kt"],
  ["71", "KCLT", "JET", "RASLN#", "RASLN @ 14,000", "", "Turbojets only; south ops", "250 kt"],
  ["71", "KCLT", "TP", "RASLN#", "RASLN @ 8,000", "", "Turboprops only; north ops", "250 kt"],
  ["71", "KCLT", "TP", "RASLN#", "RASLN @ 10,000", "", "Turboprops only; south ops", "250 kt"],
  ["71", "RDU+", "JET", "DMSTR# / BUZZY#", "BDRY AOB FL210", "ZDC", "Turbojets only", "", "RDU"],
  ["71", "RDU+", "TP", "DMSTR# / BUZZY#", "BDRY AOB 17,000", "ZDC", "Turboprops only", "", "RDU"],

  // 7.7.2 Sector 72 Columbia
  ["72", "KCAE", "", "", "BDRY @ 11,000", "CAE APP", "CAE APP BDRY", ""],
  ["72", "KCHS", "", "OSPRI#", "TRTLS @ 11,000", "", "", ""],
  ["72", "KNBC", "", "", "BDRY @ 11,000", "73", "Sector 73 BDRY", ""],
  ["72", "KSSC", "", "", "BDRY @ 11,000", "SSC APP", "SSC APP BDRY", ""],
  ["72", "KAGS", "", "STWRT#", "STWRT @ 11,000", "", "", "250 kt"],

  // 7.8.2 Sector 73 Allendale
  ["73", "KCAE", "", "", "BDRY @ 11,000", "CAE APP", "CAE APP BDRY", ""],
  ["73", "KCHS", "", "BAGGY#", "DREWE @ 11,000", "", "", ""],
  ["73", "KNBC", "", "", "BDRY @ 11,000", "", "Sector 73 BDRY", ""],
  ["73", "KSAV", "", "[LOTTS/PLZZZ/SOOOP]", "LOTTS/PLZZZ/SOOOP @ 11,000", "", "", ""],
  ["73", "KAGS", "", "STUGE#", "STUGE AOB 12,000", "", "", "250 kt"],

  // 7.9.2 Sector 74 Charleston
  ["74", "KCAE", "", "", "BDRY @ 11,000", "CAE APP", "CAE APP BDRY", ""],
  ["74", "KCHS", "", "AMYLU#", "CRAWW @ 11,000", "", "", ""],
  ["74", "KFLO", "", "", "BDRY @ 11,000", "FLO APP", "FLO APP BDRY", ""],
  ["74", "KMYR", "", "", "BDRY @ 11,000", "MYR APP", "MYR APP BDRY", ""],
  ["74", "KSSC", "", "", "BDRY @ 11,000", "SSC APP", "SSC APP BDRY", ""],
  ["74", "KFAY", "", "", "BDRY @ 11,000", "FAY APP", "FAY APP BDRY", ""],
  ["74", "KILM", "", "", "BDRY @ 11,000", "ILM APP", "ILM APP BDRY", ""],

  // 8.1.2 Sector 57 St. Johns
  ["57", "KDAB", "", "", "BDRY @ 12,000", "DAB APP", "DAB APP BDRY", ""],
  ["57", "KJAX", "", "POGIE#", "BASSS @ 13,000", "", "", "250 kt"],
  ["57", "KJAX", "", "QUBEN#", "BASSS @ 13,000", "", "", ""],
  ["57", JAX, "", "", "BDRY @ 11,000", "JAX APP", "JAX APP BDRY", "", "JAX TRACON"],

  // 8.2.2 Sector 58 St. Augustine
  ["58", "KDAB", "", "TTHOR#", "Descend via", "", "Released for descent within 10 NM of the States BDRY", ""],
  ["58", "KDAB", "", "(20 NM N of OMN)", "BDRY @ 12,000", "DAB APP", "DAB APP BDRY", ""],
  ["58", "KMCO", "", "GTOUT# / SNFLD#", "Descend via", "", "Released for descent within 10 NM of the States BDRY", ""],
  ["58", "KMCO", "", "[GRDON/WOPNR] ALYNA#", "TIMIE @ 12,000", "", "F11 approval required before using the ALYNA STAR via TIMIE", "250 kt if MCO south"],
  ["58", "KORL/KSFB", "", "TTHOR#", "Descend via", "", "Released for descent within 10 NM of the States BDRY", ""],
  ["58", "KPBI", "", "KENLL CPTAN#", "JOEYY AOB FL280", "", "", ""],
  ["58", "KPBI", "", "JESTR#", "DEBRL AOB FL240", "", "", ""],
  ["58", "KPBI", "", "MLB# / STOOP#", "MLB AOB FL240", "", "", ""],
  ["58", "KTPA/KPIE", "", "DADES#", "NICCK @ 17,000", "F11", "Handoff to F11", ""],

  // 8.3.2 Sector 67 Hunter
  ["67", "KMCO", "", "", "GTOUT#/SNFLD# per flow", "", "Route via the correct STAR per airport configuration", ""],

  // 8.4.2 Sector 68 States
  ["68", "KDAB", "", "", "BDRY AOB FL300 descending to FL260", "", "", ""],
  ["68", "KJAX", "", "LUNNI#", "BENTZ @ FL260", "", "", ""],
  ["68", "KMCO", "", "", "BDRY AOB FL340", "", "Route via the correct STAR (SNFLD#/GTOUT#) for landing direction", ""],
  ["68", "KORL/KSFB", "", "", "BDRY AOB FL300 descending to FL260", "", "", ""],
  ["68", "KSAV", "", "", "FL240 (issued by Green Cove)", "54", "Handoff to Jekyll", ""],
  ["68", "KCLT", "", "STOCR#", "BDRY AOB FL290", "47", "Sector 47 BDRY", ""],

  // 8.5.2 Sector 75 Green Cove
  ["75", "KCHS", "", "", "BDRY AOB FL330", "68", "BDRY with Sector 68", ""],
  ["75", "KSAV", "", "", "BDRY @ FL240", "68", "Sector 68 BDRY; handoff to 68", ""],
  ["75", "KATL", "", "", "AOB FL350 (F11 deps) / FL330 (DAB deps)", "", "F11 complex departures capped at FL350, DAB complex at FL330", ""],

  // 8.6.2 Sector 76 Keystone
  ["76", "KCHS", "", "", "FL350", "75", "Descend upon entering airspace, HO 75", ""],
  ["76", "KATL", "", "", "AOB FL350 (F11 deps) / FL330 (DAB deps)", "", "F11 complex departures capped at FL350, DAB complex at FL330", ""],

  // 9.1.2 Sector 10 Crestview
  ["10", "KPNS", "", "", "BDRY @ 11,000", "PNS APP", "North side of P31", ""],
  ["10", "KTLH", "", "", "BDRY @ 11,000", "TLH APP", "TLH APP BDRY", ""],
  ["10", "KVPS", "", "", "BDRY @ 11,000", "VPS APP", "VPS APP BDRY", ""],
  ["10", "KOZR", "", "", "BDRY @ 11,000", "OZR APP", "OZR APP BDRY", ""],
  ["10", "KMGM", "", "", "BDRY AOB FL230 descending to 11,000", "ZTL", "ZTL BDRY", ""],

  // 9.2.2 Sector 11 Brewton
  ["11", "KDAB/KGNV/KJAX/KSFB", "", "(Over/South of CABLO)", "BDRY AOB FL350", "17/34", "Sectors 17/34 have control for descent 20 NM from the common boundary", ""],
  ["11", "KPNS/KVPS", "", "", "HO 10", "10", "Crestview has control for turns and descents", ""],
  ["11", "KATL", "", "HOBTT# / GNDLF#", "BDRY AOB FL340", "ZTL", "ZTL BDRY; departures west of TLH AOB FL270", ""],
  ["11", GPT, "", "", "BDRY AOB FL300 descending to FL240", "ZHU", "ZHU BDRY", "", "GPT"],
  ["11", "KJAN", "", "", "BDRY AOB FL340", "ZHU", "ZHU BDRY", ""],
  ["11", "KMGM", "", "", "BDRY AOB FL230 descending to 11,000", "10", "Handoff to Crestview for further descent; ZTL BDRY", ""],
  ["11", MSY, "", "SJI / GPT MNSTR#", "BDRY AOB FL320", "ZHU", "ZHU BDRY", "", "MSY / NEW / NBG"],

  // 9.3.2 Sector 12 Albany
  ["12", "KCSG/KMCN", "", "", "BDRY AOB FL230 descending to 11,000", "A80", "A80 BDRY", ""],
  ["12", "KLCQ", "", "", "BDRY AOB 11,000", "", "JAX 29/77/79 BDRY", ""],
  ["12", "KOZR", "", "", "BDRY @ 11,000", "OZR APP", "OZR APP BDRY", ""],
  ["12", "KPAM", "", "", "BDRY @ 11,000", "PAM APP", "PAM APP BDRY", ""],
  ["12", "KTLH", "", "", "BDRY @ 11,000", "TLH APP", "TLH APP BDRY", ""],
  ["12", "KVLD", "", "", "BDRY @ 11,000", "VAD APP", "VAD APP BDRY", ""],
  ["12", "KABY", "", "", "BDRY @ 11,000", "", "Sector 12 BDRY", ""],

  // 9.4.2 Sector 21 Enterprise
  ["21", "KDAB/KGNV/KJAX/KSFB", "", "(Over/South of CABLO)", "BDRY AOB FL350", "17/34", "Sectors 17/34 have control for descent 20 NM from the common boundary", ""],
  ["21", "KATL", "", "HOBTT# / GNDLF#", "BDRY AOB FL340", "ZTL", "ZTL BDRY; departures west of TLH AOB FL270", ""],
  ["21", GPT, "", "", "BDRY AOB FL300 descending to FL240", "11", "ZHU BDRY AOB FL300; descend to FL350, HO 11", "", "GPT"],
  ["21", "KJAN", "", "", "BDRY AOB FL340", "11", "ZHU BDRY AOB FL320; descend to FL350, HO 11", ""],
  ["21", MSY, "", "SJI / GPT MNSTR#", "BDRY AOB FL320", "11", "ZHU BDRY AOB FL320; descend to FL350, HO 11", "", "MSY / NEW / NBG"],

  // 9.5.2 Sector 28 Tallahassee
  ["28", "KLCQ", "", "", "BDRY @ 11,000", "77", "Sector 77 BDRY", ""],
  ["28", "KTLH", "", "", "BDRY @ 11,000", "TLH APP", "TLH APP BDRY", ""],
  ["28", "KVLD", "", "", "BDRY @ 11,000", "VAD APP", "VAD APP BDRY", ""],

  // 9.6.2 Sector 29 Waycross
  ["29", "KJAX", "", "OHDEA#", "OHDEA @ 12,000", "", "", ""],
  ["29", "KLCQ", "", "", "BDRY @ 11,000", "77", "Sector 77 border", ""],
  ["29", "KSAV", "", "", "BDRY @ 11,000", "SAV APP", "SAV APP BDRY", ""],
  ["29", "KTLH", "", "", "BDRY @ 11,000", "TLH APP", "TLH APP BDRY", ""],
  ["29", "KVLD", "", "", "BDRY @ 11,000", "VAD APP", "VAD APP BDRY", ""],
  ["29", "KMCN", "", "", "BDRY AOB FL230 descending to 11,000", "A80", "A80 border", ""],

  // 9.7.2 Sector 30 Nepta
  ["30", "KMCO", "", "PRICY#", "Descend via", "", "ZMA offline only; advise airport ops", ""],
  ["30", MSY, "", "", "BDRY AOB FL320", "ZHU", "ZHU BDRY", "", "MSY complex"],
  ["30", GPT, "", "", "BDRY AOB FL300 descending to FL240", "ZHU", "ZHU BDRY", "", "GPT complex"],
  ["30", TPA, "", "", "BDRY AOB FL330", "ZMA", "ZMA BDRY", "", "TPA complex"],

  // 9.8.2 Sector 31 St. George
  ["31", "KMCO", "", "PRICY#", "Descend via", "30", "ZMA offline only; advise airport ops. Descend FL370, HO 30", ""],
  ["31", MSY, "", "", "BDRY AOB FL320", "30", "ZHU BDRY; descend FL370, HO 30", "", "MSY complex"],
  ["31", GPT, "", "", "BDRY AOB FL300 descending to FL240", "30", "ZHU BDRY; descend FL370, HO 30", "", "GPT complex"],
  ["31", TPA, "", "", "BDRY AOB FL330", "30", "ZMA BDRY; descend FL370, HO 30", "", "TPA complex"],
];
