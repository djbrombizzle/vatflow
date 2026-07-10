/** US ARTCC center ids (same set as FCA TMU map). */
export const US_ARTCC = new Set([
  "ZAB", "ZAU", "ZBW", "ZDC", "ZDV", "ZFW", "ZHU", "ZID", "ZJX", "ZKC",
  "ZLA", "ZLC", "ZMA", "ZME", "ZMP", "ZNY", "ZOA", "ZOB", "ZSE", "ZTL",
  "ZAN", "ZHN", "ZUA", "ZAP",
]);

export const ARTCC_LIST = [...US_ARTCC].sort();
