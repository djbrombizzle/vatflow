/**
 * Lightweight ARTCC ownership helpers (browser).
 * Mirrors vatflow-hub/artcc-access.js for client ACL without loading geo/navdata.
 */
export const US_ARTCC = [
  "ZAB", "ZAU", "ZBW", "ZDC", "ZDV", "ZFW", "ZHU", "ZID", "ZJX", "ZKC",
  "ZLA", "ZLC", "ZMA", "ZME", "ZMP", "ZNY", "ZOA", "ZOB", "ZSE", "ZTL",
  "ZAN", "ZHN", "ZUA", "ZAP",
];

const US_ARTCC_SET = new Set(US_ARTCC);

/** Major US airports → primary ARTCC. */
export const AIRPORT_ARTCC = {
  KPHX: "ZAB", KABQ: "ZAB", KTUS: "ZAB",
  KORD: "ZAU", KMDW: "ZAU", KMKE: "ZAU", KMSN: "ZAU",
  KBOS: "ZBW", KBDL: "ZBW", KPVD: "ZBW", KMHT: "ZBW", KBGR: "ZBW",
  KDCA: "ZDC", KIAD: "ZDC", KBWI: "ZDC", KRIC: "ZDC", KORF: "ZDC", KRDU: "ZDC",
  KDEN: "ZDV", KCOS: "ZDV", KSLC: "ZLC",
  KDFW: "ZFW", KDAL: "ZFW", KAUS: "ZHU", KIAH: "ZHU", KHOU: "ZHU", KMSY: "ZHU",
  KSAT: "ZHU", KCRP: "ZHU",
  KIND: "ZID", KCVG: "ZID", KCMH: "ZID", KDAY: "ZID",
  KMCO: "ZJX", KJAX: "ZJX", KTLH: "ZJX", KCHS: "ZJX", KSAV: "ZJX",
  KMCI: "ZKC", KSTL: "ZKC", KICT: "ZKC", KOMA: "ZMP",
  KLAX: "ZLA", KSAN: "ZLA", KSNA: "ZLA", KBUR: "ZLA", KLGB: "ZLA", KPSP: "ZLA",
  KLAS: "ZLA", KRNO: "ZOA",
  KMIA: "ZMA", KFLL: "ZMA", KTPA: "ZMA", KPBI: "ZMA", KRSW: "ZMA", KEYW: "ZMA",
  KMEM: "ZME", KBNA: "ZME", KLIT: "ZME",
  KMSP: "ZMP", KDSM: "ZMP",
  KEWR: "ZNY", KLGA: "ZNY", KJFK: "ZNY", KPHL: "ZNY", KALB: "ZNY", KBUF: "ZNY",
  KSFO: "ZOA", KOAK: "ZOA", KSJC: "ZOA", KSMF: "ZOA",
  KCLE: "ZOB", KDTW: "ZOB", KPIT: "ZOB",
  KSEA: "ZSE", KPDX: "ZSE", KGEG: "ZSE",
  KATL: "ZTL", KCLT: "ZTL", KBHM: "ZTL", KTRI: "ZTL",
  PANC: "ZAN", PAFA: "ZAN", PAPG: "ZAN",
  PHNL: "ZHN", PHOG: "ZHN",
  TJSJ: "ZUA", TIST: "ZUA",
};

export function normalizeArtccId(id) {
  const raw = String(id || "").toUpperCase().trim();
  if (raw === "*") return "*";
  const s = raw.replace(/[^A-Z0-9]/g, "");
  if (US_ARTCC_SET.has(s)) return s;
  return null;
}

export function primaryAirportArtcc(icao) {
  const code = String(icao || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) return null;
  if (AIRPORT_ARTCC[code]) return AIRPORT_ARTCC[code];
  if (code.length === 3 && AIRPORT_ARTCC["K" + code]) return AIRPORT_ARTCC["K" + code];
  return null;
}
