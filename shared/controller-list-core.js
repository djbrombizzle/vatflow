/**
 * Controller list: the vNAS live controller feed shaped like CRC's controller
 * list (sector ID, callsign, frequency, position), grouped by ARTCC and facility.
 *
 * Feed: https://live.env.vnas.vatsim.net/data-feed/controllers.json (CORS open).
 * Same sector-label rules as format_vnas_sector_label in vUSAlink-hub/server.py.
 */

export const VNAS_FEED_URL = "https://live.env.vnas.vatsim.net/data-feed/controllers.json";

export const ARTCC_NAS_IDS = {
  ZBW: "B", ZNY: "N", ZDC: "W", ZOB: "C", ZID: "I",
  ZTL: "T", ZJX: "J", ZMA: "R", ZHU: "H", ZME: "M",
  ZKC: "K", ZAU: "G", ZMP: "P", ZDV: "D", ZAB: "A",
  ZLA: "L", ZOA: "O", ZSE: "S", ZLC: "U", ZFW: "F",
};

/** Position kinds in CRC list order (center first, delivery last). */
export const KINDS = ["CTR", "APP", "TWR", "GND", "DEL", "FSS", "OBS"];

const FACILITY_TYPE_KIND = {
  Center: "CTR", ApproachDeparture: "APP", Tower: "TWR", Ground: "GND",
  Delivery: "DEL", FlightServiceStation: "FSS", Observer: "OBS",
};

const SUFFIX_KIND = { CTR: "CTR", APP: "APP", DEP: "APP", TWR: "TWR", GND: "GND", DEL: "DEL", RMP: "GND", FSS: "FSS", OBS: "OBS" };

/** 124950000 (Hz) -> "124.950"; observers' 199.998 and blanks -> "". */
export function fmtFreq(hz) {
  const n = Number(hz);
  if (!n) return "";
  const mhz = n >= 1e6 ? n / 1e6 : n;
  if (mhz >= 199.99) return "";
  return mhz.toFixed(3);
}

export function primaryPosition(ctrl) {
  const ps = ctrl?.positions || [];
  return ps.find(p => p.isPrimary && p.isActive) || ps.find(p => p.isActive) || ps.find(p => p.isPrimary) || ps[0] || null;
}

/** CRC sector code: ERAM "I83" (NAS letter + sector) or STARS "1E" (subset + sector). */
export function sectorCode(pos, artccId) {
  if (!pos) return "";
  const eram = pos.eramData?.sectorId;
  if (eram != null && String(eram).trim()) {
    const nas = ARTCC_NAS_IDS[String(artccId || "").toUpperCase()] || "";
    return nas + String(eram).trim();
  }
  const stars = pos.starsData;
  const sid = stars?.sectorId != null ? String(stars.sectorId).trim() : "";
  if (sid && stars.subset != null && stars.subset !== "") return `${stars.subset}${sid}`;
  return sid;
}

export function controllerKind(ctrl) {
  if (ctrl?.isObserver || ctrl?.role === "Observer") return "OBS";
  const vd = ctrl?.vatsimData || {};
  const byType = FACILITY_TYPE_KIND[vd.facilityType];
  if (byType && byType !== "OBS") return byType;
  const suf = String(vd.callsign || "").toUpperCase().split("_").pop();
  if (SUFFIX_KIND[suf]) return SUFFIX_KIND[suf];
  const pt = primaryPosition(ctrl)?.positionType;
  return pt === "Artcc" ? "CTR" : pt === "Tracon" ? "APP" : byType || "TWR";
}

/** "Student3" -> "S3", "Controller1" -> "C1", "Instructor3" -> "I3", "Supervisor" -> "SUP". */
export function shortRating(r) {
  const s = String(r || "");
  const m = s.match(/^(Student|Controller|Instructor|Senior ?Controller)(\d)$/i);
  if (m) return m[1][0].toUpperCase() + m[2];
  const map = { Observer: "OBS", Supervisor: "SUP", Administrator: "ADM", SeniorController: "C3" };
  return map[s] || s;
}

/** Feed controller -> flat row for display. */
export function parseController(ctrl) {
  const vd = ctrl.vatsimData || {};
  const artcc = String(ctrl.artccId || "").toUpperCase();
  const pos = primaryPosition(ctrl);
  const kind = controllerKind(ctrl);
  const positions = (ctrl.positions || []).map(p => ({
    facilityId: p.facilityId || "",
    facilityName: p.facilityName || "",
    name: p.positionName || "",
    radioName: p.radioName || "",
    callsign: p.defaultCallsign || "",
    freq: fmtFreq(p.frequency),
    sector: sectorCode(p, artcc),
    isPrimary: !!p.isPrimary,
    isActive: !!p.isActive,
    tcps: p.starsData?.assumedTcps || [],
  }));
  return {
    cid: String(vd.cid || ""),
    name: vd.realName || "",
    rating: shortRating(vd.userRating),
    callsign: String(vd.callsign || pos?.defaultCallsign || "").toUpperCase(),
    artcc,
    facilityId: pos?.facilityId || ctrl.primaryFacilityId || "",
    facilityName: pos?.facilityName || "",
    position: pos?.positionName || "",
    radioName: pos?.radioName || "",
    freq: fmtFreq(pos?.frequency) || fmtFreq(vd.primaryFrequency),
    sector: sectorCode(pos, artcc),
    kind,
    observer: kind === "OBS",
    active: !!ctrl.isActive,
    loginTime: ctrl.loginTime ? Date.parse(ctrl.loginTime) : null,
    info: String(vd.controllerInfo || "").replace(/\r\n?/g, "\n").trim(),
    positions,
  };
}

export function parseFeed(data) {
  return (data?.controllers || []).map(parseController);
}

/** Minutes online -> "1:23". */
export function fmtOnline(loginMs, nowMs = Date.now()) {
  if (!loginMs) return "";
  const m = Math.max(0, Math.floor((nowMs - loginMs) / 60000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** ARTCC set for a selection: one ARTCC, optionally plus its neighbors; null = all. */
export function artccScope(artcc, withNeighbors, neighbors = {}) {
  if (!artcc) return null;
  const set = new Set([artcc]);
  if (withNeighbors) for (const n of neighbors[artcc] || []) set.add(n);
  return set;
}

/**
 * @param {ReturnType<typeof parseController>[]} rows
 * @param {{ scope?: Set<string>|null, kinds?: Set<string>, showObs?: boolean, q?: string }} f
 */
export function filterRows(rows, { scope = null, kinds = null, showObs = true, q = "" } = {}) {
  const needle = String(q || "").trim().toUpperCase();
  return rows.filter(r => {
    if (scope && !scope.has(r.artcc)) return false;
    if (r.observer && !showObs) return false;
    if (!r.observer && kinds && !kinds.has(r.kind)) return false;
    if (!needle) return true;
    const hay = [r.callsign, r.name, r.cid, r.freq, r.sector, r.position, r.radioName, r.facilityId, r.facilityName, r.artcc]
      .join(" ").toUpperCase();
    return hay.includes(needle);
  });
}

/**
 * ARTCC -> facility -> rows, CRC order: ARTCC alphabetical (home first), facilities
 * with a center position first, rows by kind then sector code.
 */
export function groupRows(rows, homeArtcc = "") {
  const rank = k => { const i = KINDS.indexOf(k); return i < 0 ? 99 : i; };
  const byArtcc = new Map();
  for (const r of rows) {
    const a = r.artcc || "—";
    if (!byArtcc.has(a)) byArtcc.set(a, new Map());
    const facs = byArtcc.get(a);
    const fid = r.facilityId || "—";
    if (!facs.has(fid)) facs.set(fid, { id: fid, name: r.facilityName, rows: [] });
    const fac = facs.get(fid);
    if (!fac.name && r.facilityName) fac.name = r.facilityName;
    fac.rows.push(r);
  }
  const cmpRow = (x, y) => rank(x.kind) - rank(y.kind)
    || x.sector.localeCompare(y.sector, undefined, { numeric: true })
    || x.callsign.localeCompare(y.callsign);
  const facRank = f => Math.min(...f.rows.map(r => rank(r.kind)));
  return [...byArtcc.entries()]
    .sort(([a], [b]) => (b === homeArtcc) - (a === homeArtcc) || a.localeCompare(b))
    .map(([artcc, facs]) => ({
      artcc,
      count: [...facs.values()].reduce((n, f) => n + f.rows.filter(r => !r.observer).length, 0),
      facilities: [...facs.values()]
        .map(f => ({ ...f, rows: f.rows.sort(cmpRow) }))
        .sort((x, y) => facRank(x) - facRank(y) || x.id.localeCompare(y.id)),
    }));
}
