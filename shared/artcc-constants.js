/** US ARTCC center ids (same set as FCA TMU map). */
export const US_ARTCC = new Set([
  "ZAB", "ZAU", "ZBW", "ZDC", "ZDV", "ZFW", "ZHU", "ZID", "ZJX", "ZKC",
  "ZLA", "ZLC", "ZMA", "ZME", "ZMP", "ZNY", "ZOA", "ZOB", "ZSE", "ZTL",
  "ZAN", "ZHN", "ZUA", "ZAP",
]);

/**
 * VAT-Spy / callsign-prefix aliases → canonical FAA ARTCC ids used in UI data.
 * Anchorage FIR is PAZA (prefix ANC); Honolulu FIR is PHZH (prefix HCF).
 */
export const ARTCC_ID_ALIASES = {
  PAZA: "ZAN",
  PHZH: "ZHN",
  TJZS: "ZUA",
  HCF: "ZHN",
  ANC: "ZAN",
};

/** Inverse: canonical → VAT-Spy boundary id (for hub ownership matching). */
export const ARTCC_TO_VATSPY = {
  ZAN: "PAZA",
  ZHN: "PHZH",
  ZUA: "TJZS",
};

/** Normalize hub/UI/VAT-Spy ids to the short FAA form (ZJX, ZAN, ZHN). */
export function normArtccId(id) {
  let s = String(id || "").toUpperCase().trim();
  if (!s) return "";
  if (ARTCC_ID_ALIASES[s]) return ARTCC_ID_ALIASES[s];
  s = s.replace(/^K(?=Z)/, "");
  return ARTCC_ID_ALIASES[s] || s;
}

export const ARTCC_LIST = [...US_ARTCC].sort();
