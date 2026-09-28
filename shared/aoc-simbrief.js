/**
 * Dispatch Center: a pilot's latest SimBrief OFP (DOM-free, tested in
 * scripts/test-aoc-core.mjs).
 *
 * SimBrief's public fetcher returns the most recent OFP a user generated, as
 * JSON, with CORS open to any site and no API key:
 *   https://www.simbrief.com/api/xml.fetcher.php?username=<name>&json=1
 *   (…?userid=<number>&json=1 for the numeric pilot ID)
 * An unknown user comes back as HTTP 400 {fetch: {status: "Error: Unknown UserID"}}.
 *
 * It is the LATEST plan, not necessarily this flight's, so matchOfp() checks it
 * against the live flight (callsign, origin, destination, age).
 *
 * Field names are checked against open-source SimBrief readers (FlyByWire's
 * OFP import, simbrief helper scripts) and Navigraph's forum list of TLR
 * fields; the max_* weights, sched_* times and aircraft.icaocode are not, so
 * the parser treats every field as optional ("—" when missing).
 * Numbers arrive as strings; a list with one element arrives as a bare object.
 * Times are epoch seconds. The TLR (takeoff / landing report) is only there
 * when the pilot had "Runway Analysis" on in SimBrief.
 */

export const SIMBRIEF_URL = "https://www.simbrief.com/api/xml.fetcher.php";
/** An OFP generated longer ago than this is flagged as possibly for another flight. */
export const OFP_STALE_H = 18;

export function simbriefUrl(user) {
  const u = String(user || "").trim();
  const key = /^\d+$/.test(u) ? "userid" : "username";
  return `${SIMBRIEF_URL}?${key}=${encodeURIComponent(u)}&json=1`;
}

/** Fetch and parse; resolves to parseOfp()'s result ({ok:false, error} on any failure). */
export async function fetchOfp(user, fetchFn = fetch) {
  if (!String(user || "").trim()) return { ok: false, error: "Enter a SimBrief username or pilot ID." };
  let data = null;
  try {
    const res = await fetchFn(simbriefUrl(user), { cache: "no-store" });
    data = await res.json().catch(() => null);
    if (!data) return { ok: false, error: `SimBrief answered HTTP ${res.status}.` };
  } catch (e) {
    return { ok: false, error: `SimBrief could not be reached (${e.message || e}).` };
  }
  return parseOfp(data);
}

const num = v => {
  const n = Number(String(v ?? "").trim());
  return v === "" || v == null || !Number.isFinite(n) ? null : n;
};
const str = v => (v == null || typeof v === "object" ? "" : String(v).trim());
const list = v => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);
const sec = v => { const n = num(v); return n ? n * 1000 : null; };

/**
 * SimBrief JSON -> the fields a dispatcher uses. Weights and fuel stay in the
 * OFP's own units (`units`: "LBS" or "KGS").
 */
export function parseOfp(d) {
  const status = str(d?.fetch?.status);
  if (!d || typeof d !== "object") return { ok: false, error: "Not a SimBrief reply." };
  if (status && !/^success/i.test(status)) {
    const error = /unknown user/i.test(status) ? "SimBrief has no user by that name or ID."
      : /no flight plan/i.test(status) ? "That SimBrief user has no flight plan on file."
      : `SimBrief: ${status.replace(/^error:\s*/i, "")}`;
    return { ok: false, error };
  }
  const g = d.general || {}, f = d.fuel || {}, w = d.weights || {}, t = d.times || {};
  const o = d.origin || {}, de = d.destination || {}, ac = d.aircraft || {}, atc = d.atc || {}, p = d.params || {};
  const altn = list(d.alternate)[0] || {};
  const units = /kg/i.test(str(p.units)) ? "KGS" : "LBS";
  const navlog = list(d.navlog?.fix).map(x => ({
    ident: str(x.ident), type: str(x.type), stage: str(x.stage),
    lat: num(x.pos_lat), lon: num(x.pos_long), alt: num(x.altitude_feet),
    timeTotal: num(x.time_total), fuelOnboard: num(x.fuel_plan_onboard),
  })).filter(x => x.ident);
  const ofp = {
    ok: true,
    generated: sec(p.time_generated),
    requestId: str(p.request_id),
    units,
    airline: str(g.icao_airline),
    flightNumber: str(g.flight_number),
    callsign: str(atc.callsign) || (str(g.icao_airline) + str(g.flight_number)),
    orig: str(o.icao_code), origRwy: str(o.plan_rwy),
    dest: str(de.icao_code), destRwy: str(de.plan_rwy),
    altn: str(altn.icao_code),
    type: str(ac.icaocode || ac.icao_code), reg: str(ac.reg), aircraftName: str(ac.name),
    route: str(g.route),
    initialAlt: num(g.initial_altitude),
    costIndex: str(g.costindex),
    distance: num(g.route_distance) ?? num(g.air_distance),
    fuel: {
      ramp: num(f.plan_ramp), taxi: num(f.taxi), trip: num(f.enroute_burn), contingency: num(f.contingency),
      alternate: num(f.alternate_burn), reserve: num(f.reserve), extra: num(f.extra),
      minTakeoff: num(f.min_takeoff), takeoff: num(f.plan_takeoff), landing: num(f.plan_landing),
    },
    weights: {
      pax: num(w.pax_count), bags: num(w.bag_count), cargo: num(w.cargo), payload: num(w.payload),
      zfw: num(w.est_zfw), tow: num(w.est_tow), ldw: num(w.est_ldw),
      maxZfw: num(w.max_zfw), maxTow: num(w.max_tow), maxLdw: num(w.max_ldw),
    },
    times: {
      schedOut: sec(t.sched_out), schedOff: sec(t.sched_off), schedOn: sec(t.sched_on), schedIn: sec(t.sched_in),
      estOut: sec(t.est_out), estOff: sec(t.est_off), estOn: sec(t.est_on), estIn: sec(t.est_in),
      eetMin: num(t.est_time_enroute) != null ? Math.round(num(t.est_time_enroute) / 60) : null,
      blockMin: num(t.est_block) != null ? Math.round(num(t.est_block) / 60) : null,
    },
    navlog,
    tlr: parseTlr(d.tlr, str(o.plan_rwy), str(de.plan_rwy)),
  };
  return ofp;
}

/** Takeoff for the planned departure runway, landing for the planned arrival runway; null without a TLR. */
function parseTlr(tlr, origRwy, destRwy) {
  if (!tlr || typeof tlr !== "object") return null;
  const pick = (rwys, want) => {
    const all = list(rwys);
    return all.find(r => str(r.identifier) === want) || all[0] || null;
  };
  const to = tlr.takeoff || {}, ld = tlr.landing || {};
  const toCond = to.conditions || {}, ldCond = ld.conditions || {};
  const tr = pick(to.runway, str(toCond.planned_runway) || origRwy);
  const takeoff = tr ? {
    runway: str(tr.identifier),
    weight: num(toCond.planned_weight),
    flaps: str(tr.flap_setting), thrust: str(tr.thrust_setting), bleed: str(tr.bleed_setting),
    flex: num(tr.flex_temperature),
    v1: num(tr.speeds_v1), vr: num(tr.speeds_vr), v2: num(tr.speeds_v2),
    limit: str(tr.limit_code), maxWeight: num(tr.max_weight),
  } : null;
  const dry = ld.distance_dry || {};
  const lr = pick(ld.runway, str(ldCond.planned_runway) || destRwy);
  const landing = (lr || num(dry.speeds_vref)) ? {
    runway: str(lr?.identifier) || str(ldCond.planned_runway) || destRwy,
    weight: num(ldCond.planned_weight) ?? num(dry.weight),
    flaps: str(dry.flap_setting) || str(ldCond.flap_setting),
    vref: num(dry.speeds_vref),
    distance: num(dry.factored_distance) ?? num(dry.actual_distance),
  } : null;
  return takeoff || landing ? { takeoff, landing } : null;
}

/**
 * Is this OFP for the live flight? {ok, issues: [text]}. A mismatch is a
 * warning for the dispatcher, not a block: pilots file under other callsigns.
 */
export function matchOfp(ofp, row, now = Date.now()) {
  const issues = [];
  if (!ofp || !ofp.ok) return { ok: false, issues: ["No OFP"] };
  const cs = String(row?.callsign || "").toUpperCase();
  if (ofp.callsign && cs && ofp.callsign.toUpperCase() !== cs) issues.push(`OFP callsign ${ofp.callsign}, flying as ${cs}`);
  if (ofp.orig && row?.dep && ofp.orig !== row.dep) issues.push(`OFP from ${ofp.orig}, filed from ${row.dep}`);
  if (ofp.dest && row?.arr && ofp.dest !== row.arr) issues.push(`OFP to ${ofp.dest}, filed to ${row.arr}`);
  if (ofp.generated && now - ofp.generated > OFP_STALE_H * 3600000) {
    issues.push(`OFP generated ${Math.round((now - ofp.generated) / 3600000)} h ago`);
  }
  return { ok: issues.length === 0, issues };
}

/** 158900 -> "158.9" (thousands, one decimal): how loadsheets print weights. */
export function kilo(n) {
  return n == null ? "-" : (Math.round(n / 100) / 10).toFixed(1);
}

/**
 * A SimBrief-shaped OFP for a demo flight (the demo's "DEMO" username), so the
 * panel and telex can be tried without a real pilot. Rough numbers for an
 * A320-class aircraft, scaled by distance.
 */
export function demoOfpJson(row, now = Date.now()) {
  const dist = Math.round(row.distTotal || 600);
  const eetSec = Math.round((dist / 440) * 3600 + 20 * 60);
  const trip = Math.round(dist * 11.5 + 1800);
  const pax = 150 + (dist % 30);
  const zfw = 104000 + pax * 200 + 3000;
  const ramp = trip + 5000 + 2200 + 1200 + 500;
  const tow = zfw + ramp - 500;
  const out = (row.std || now) / 1000;
  return {
    fetch: { status: "Success" },
    params: { request_id: "DEMO" + row.callsign, time_generated: String(Math.round(now / 1000 - 3600)), units: "lbs" },
    general: { icao_airline: row.callsign.replace(/\d.*$/, ""), flight_number: row.callsign.replace(/^[A-Z]+/, ""),
      route: row.route || "DCT", initial_altitude: String(row.filedAlt || 35000), costindex: "30", route_distance: String(dist) },
    atc: { callsign: row.callsign },
    origin: { icao_code: row.dep, plan_rwy: "18L" },
    destination: { icao_code: row.arr, plan_rwy: "26R" },
    alternate: { icao_code: row.altn || "" },
    aircraft: { icaocode: row.type || "A321", reg: "N" + (100 + (dist % 800)) + "AA", name: row.type || "A321" },
    fuel: { plan_ramp: String(ramp), taxi: "500", enroute_burn: String(trip), contingency: "1200", alternate_burn: "2200",
      reserve: "5000", extra: "0", min_takeoff: String(ramp - 500), plan_takeoff: String(ramp - 500), plan_landing: String(ramp - 500 - trip) },
    weights: { pax_count: String(pax), bag_count: String(pax), cargo: "4200", payload: String(pax * 200 + 4200),
      est_zfw: String(zfw), est_tow: String(tow), est_ldw: String(tow - trip),
      // Demo limits a little above the plan, so nothing reads as overweight.
      max_zfw: String(Math.round(zfw * 1.08)), max_tow: String(Math.round(tow * 1.08)), max_ldw: String(Math.round((tow - trip) * 1.08)) },
    times: { sched_out: String(Math.round(out)), sched_off: String(Math.round(out + 900)), sched_on: String(Math.round(out + 900 + eetSec)),
      sched_in: String(Math.round(out + 1500 + eetSec)), est_time_enroute: String(eetSec), est_block: String(eetSec + 1500) },
    navlog: { fix: [] },
    tlr: {
      takeoff: { conditions: { planned_runway: "18L", planned_weight: String(tow) },
        runway: [{ identifier: "18L", flap_setting: "CONF 1+F", thrust_setting: "FLEX", flex_temperature: "52",
          speeds_v1: "143", speeds_vr: "145", speeds_v2: "149", limit_code: "" }] },
      landing: { conditions: { planned_runway: "26R", planned_weight: String(tow - trip) },
        distance_dry: { flap_setting: "CONF FULL", speeds_vref: "137", factored_distance: "5940" } },
    },
  };
}
