/**
 * SWIM to vICE — turning a recorded live-traffic feed into a vice timetable.
 *
 * vice (github.com/mmp/vice) does not replay radar tracks. It flies aircraft
 * itself from flight plans, and the supported way to hand it real traffic is a
 * timetable: a six-column CSV of one row per flight, plus optional per-city-pair
 * routes in the scenario JSON. So the job here is not to keep a recording, it is
 * to boil one down to those six facts per flight.
 *
 * Nothing here knows the shape of any particular feed. A recording is walked for
 * objects that carry a callsign, the keys those objects use are reported back for
 * the operator to map, and everything downstream works off that mapping. A feed
 * that renames its fields, or a different feed entirely, needs no code change.
 *
 * No browser dependencies: the page and scripts/test-swim2vice.mjs share this.
 */

/** vice's timetable columns, in the order it writes them. */
export const TIMETABLE_COLUMNS = ["callsign", "origin", "destination", "aircraft_type", "time", "cargo"];

/**
 * How long vice considers a timetable flight to occupy its callsign: a departure
 * from its published pushback forward, an arrival back from its landing. Two
 * flights whose windows overlap on one callsign make the timetable invalid, so
 * the same check runs here, where it can be explained and fixed.
 * (vice sim/timetable_validate.go)
 */
export const DEPARTURE_ACTIVE_MINUTES = 45;
export const ARRIVAL_ACTIVE_MINUTES = 45;
const MINUTES_PER_DAY = 24 * 60;

/** Fields the operator maps a recording's keys onto. */
export const FIELDS = [
  { id: "callsign", label: "Callsign", required: true, hint: "ACID as the controller sees it, e.g. DAL1234" },
  { id: "origin", label: "Origin", required: true, hint: "Departure airport" },
  { id: "destination", label: "Destination", required: true, hint: "Arrival airport" },
  { id: "aircraftType", label: "Aircraft type", required: true, hint: "ICAO type, e.g. B738" },
  { id: "departureTime", label: "Departure time", required: false, hint: "Off/pushback time, if the feed carries one" },
  { id: "arrivalTime", label: "Arrival time", required: false, hint: "Landing time, if the feed carries one" },
  { id: "route", label: "Route", required: false, hint: "Filed route string — becomes traffic_routes" },
];

/**
 * Key names worth guessing at, most specific first. A feed that calls its field
 * "arrivalAirport" must not have it claimed by the looser destination pattern
 * after "arrivalTime" has already matched something else, hence the ordering
 * within each list and the one-key-one-field rule in guessFieldMapping.
 */
const KEY_PATTERNS = {
  callsign: [/^(acid|callsign|call_?sign|flight_?(id|number)|ident|aircraft_?id|cid)$/i, /(acid|callsign)/i],
  origin: [/^(origin|departure|dep|adep|from|orig)(_?(airport|icao|apt|fix|point))?$/i, /(departure|origin)_?(airport|icao|apt)/i, /^(dep|adep|orig)/i],
  destination: [/^(destination|arrival|dest|ades|to|arr)(_?(airport|icao|apt|fix|point))?$/i, /(arrival|destination)_?(airport|icao|apt)/i, /^(dest|ades|arr)/i],
  aircraftType: [/^(aircraft_?type|ac_?type|type|equipment|equip|actype)$/i, /(aircraft|ac)_?type/i, /equip/i],
  departureTime: [/^(off_?time|actual_?off|atd|etd|departure_?time|dep_?time|out_?time|pushback)$/i, /(off|dep|out)_?time/i, /^(etd|atd)/i],
  arrivalTime: [/^(on_?time|actual_?on|ata|eta|arrival_?time|arr_?time|in_?time|landing)$/i, /(on|arr|in)_?time/i, /^(eta|ata)/i],
  route: [/^(route|route_?string|filed_?route|nas_?route|full_?route)$/i, /route/i],
};

/** Keys that are never a flight field, however much their name looks like one. */
const KEY_DENYLIST = /^(id|_id|uuid|guid|hash|version|seq|sequence|index|count|timestamp|received|recorded_?at|source|topic|message_?type|schema)$/i;

/* ------------------------------------------------------------------ *
 * Reading a recording
 * ------------------------------------------------------------------ */

/**
 * Parse the recorder's NDJSON. One frame per line: the recorder's own envelope
 * around whatever the feed sent. A truncated final line — the recording was
 * still going when the tab closed — is dropped rather than failing the load.
 *
 * @returns {{frames: Array, skipped: number}}
 */
export function parseRecording(text) {
  const frames = [];
  let skipped = 0;
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    if (frame && typeof frame === "object" && typeof frame.data === "string") frames.push(frame);
    else skipped++;
  }
  return { frames, skipped };
}

/**
 * Pull the flight-shaped objects out of a recording.
 *
 * A frame's payload may be a single record, an array of them, or records nested
 * under any number of envelope keys, so the payload is walked in full and every
 * object carrying something callsign-shaped is kept. Each record remembers the
 * time its frame was received, which is what stands in for a departure or
 * arrival time when the feed publishes none.
 *
 * @returns {{records: Array<{obj: Object, receivedMs: number}>, parseErrors: number}}
 */
export function extractRecords(frames) {
  const records = [];
  let parseErrors = 0;

  for (const frame of frames) {
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      parseErrors++;
      continue;
    }
    const receivedMs = Date.parse(frame.t);
    walk(payload, obj => {
      if (looksLikeFlight(obj)) records.push({ obj, receivedMs: Number.isFinite(receivedMs) ? receivedMs : NaN });
    });
  }
  return { records, parseErrors };
}

/** Depth-first walk over every object in a parsed payload. */
function walk(node, visit, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walk(value, visit, depth + 1);
  }
}

/**
 * A record is anything with a key that reads as a callsign and a scalar value
 * shaped like one. Requiring a plausible value as well as a plausible key keeps
 * out the envelope objects that merely carry a nested flight along.
 */
function looksLikeFlight(obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (KEY_DENYLIST.test(key)) continue;
    if (!KEY_PATTERNS.callsign.some(re => re.test(key))) continue;
    if (typeof value === "string" && /^[A-Z0-9]{2,10}$/i.test(value.trim())) return true;
  }
  return false;
}

/**
 * Every scalar key seen across the records, with how often it appeared and a few
 * example values. This is what the operator maps fields onto, and the examples
 * are what let them tell "DEN" from "KDEN" from "Denver Intl" at a glance.
 */
export function describeKeys(records, sampleLimit = 4) {
  const keys = new Map();
  for (const { obj } of records) {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined || typeof value === "object") continue;
      let entry = keys.get(key);
      if (!entry) keys.set(key, (entry = { key, count: 0, samples: [] }));
      entry.count++;
      const text = String(value).trim();
      if (text && entry.samples.length < sampleLimit && !entry.samples.includes(text)) entry.samples.push(text);
    }
  }
  return [...keys.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Best guess at which key is which field. Each key is claimed by at most one
 * field, and the guess only ever pre-fills the mapping UI — every choice stays
 * editable, because a wrong guess on an unseen feed is expected, not exceptional.
 */
export function guessFieldMapping(keyDescriptions) {
  const mapping = {};
  const claimed = new Set();
  const keys = keyDescriptions.map(k => k.key);

  for (const field of FIELDS) {
    for (const pattern of KEY_PATTERNS[field.id] || []) {
      const match = keys.find(k => !claimed.has(k) && !KEY_DENYLIST.test(k) && pattern.test(k));
      if (match) {
        mapping[field.id] = match;
        claimed.add(match);
        break;
      }
    }
  }
  return mapping;
}

/* ------------------------------------------------------------------ *
 * Codes and times
 * ------------------------------------------------------------------ */

/**
 * Normalize an airport to the ICAO code vice expects.
 *
 * Feeds identify US airports by FAA location identifier — DEN, not KDEN — and
 * for most of them the ICAO code is just K plus the identifier. The ones where
 * it is not (Alaska, Hawaii, the territories) come from the reference table.
 */
export function normalizeAirport(value, reference) {
  const code = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) return "";
  if (code.length === 4) return code;
  if (code.length === 3) {
    const mapped = reference?.lidToIcao?.[code];
    if (mapped) return mapped;
    return "K" + code;
  }
  return code;
}

/** Strip the equipment suffix ATC data often carries: "B738/L" is a B738. */
export function normalizeAircraftType(value, reference) {
  const raw = String(value ?? "").trim().toUpperCase();
  const base = raw.split("/")[0].replace(/[^A-Z0-9]/g, "");
  if (!base) return "";
  return reference?.aircraftSubs?.[base] || base;
}

/**
 * Read a time from a feed, in whatever form it arrives: epoch seconds or
 * milliseconds, ISO 8601, or the bare HHMM that ATC systems favour. A bare HHMM
 * has no date, so it is placed on the day of `nearMs` — within twelve hours of
 * it, which is what makes a 2350 recorded at 0005Z yesterday rather than today.
 *
 * @returns {number|null} epoch ms
 */
export function parseFeedTime(value, nearMs) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" && Number.isFinite(value)) return epochToMs(value);

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d{9,13}$/.test(text)) return epochToMs(Number(text));

  if (/^\d{4}Z?$/i.test(text)) {
    const hour = Number(text.slice(0, 2));
    const minute = Number(text.slice(2, 4));
    if (hour > 23 || minute > 59) return null;
    return placeNear(hour, minute, nearMs);
  }
  if (/^\d{2}:\d{2}(:\d{2})?Z?$/i.test(text)) {
    const [hour, minute] = text.replace(/z$/i, "").split(":").map(Number);
    if (hour > 23 || minute > 59) return null;
    return placeNear(hour, minute, nearMs);
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Epoch seconds and epoch milliseconds are told apart by magnitude. */
function epochToMs(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1e11 ? value * 1000 : value;
}

/** Put a bare HH:MM on whichever day puts it closest to `nearMs`. */
function placeNear(hour, minute, nearMs) {
  const anchor = Number.isFinite(nearMs) ? nearMs : Date.now();
  const day = new Date(anchor);
  const base = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  const dayMs = 24 * 3600 * 1000;
  let best = base;
  for (const candidate of [base - dayMs, base, base + dayMs]) {
    if (Math.abs(candidate - anchor) < Math.abs(best - anchor)) best = candidate;
  }
  return best;
}

/**
 * Local time at the timetable's airport, as vice wants it: HH:MM, 24-hour.
 * Intl does the zone arithmetic so daylight saving is right for the actual date
 * recorded rather than for today.
 */
export function toLocalHhmm(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(epochMs));
  const hour = parts.find(p => p.type === "hour")?.value ?? "00";
  const minute = parts.find(p => p.type === "minute")?.value ?? "00";
  return `${hour === "24" ? "00" : hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/** Cargo callsigns get held back when the operator thins the traffic in vice. */
const CARGO_PREFIXES = new Set([
  "FDX", "UPS", "GTI", "CKS", "ABX", "ATN", "CAO", "CLX", "GEC", "BOX", "MPH", "SQC", "CJT", "KYE",
  "NCA", "CPA", "ACX", "AJT", "FFT_CARGO", "SWFT", "MRA", "AAY_CARGO", "PAC", "TAY", "AEY", "LTG",
]);

/** True when the callsign's airline flies boxes, not people. */
export function looksLikeCargo(callsign) {
  const prefix = String(callsign || "").toUpperCase().match(/^[A-Z]{3}/);
  return prefix ? CARGO_PREFIXES.has(prefix[0]) : false;
}

/* ------------------------------------------------------------------ *
 * Building the timetable
 * ------------------------------------------------------------------ */

/**
 * Fold a recording's records into one row per flight.
 *
 * A feed repeats a flight many times over — a track update every few seconds,
 * an amended plan, a fresh copy on reconnect — so records are grouped by
 * callsign and city pair and merged, last non-empty value winning, which is what
 * makes a route amendment supersede the route it amended.
 *
 * Times come from the feed when the operator mapped a time field, and otherwise
 * from when the flight was seen: a departure is first seen around the time it
 * comes to life on the scope, an arrival around the time it lands. Those two
 * approximations are what `taxiOutMinutes` and `arrivalLeadMinutes` correct for,
 * since vice reads a departure's published time as pushback and adds the taxi
 * itself.
 *
 * @param {Array} records         from extractRecords
 * @param {Object} mapping        field id -> recording key
 * @param {Object} options
 * @param {string} options.airport        the timetable's airport, ICAO
 * @param {string} options.timeZone       IANA zone of that airport
 * @param {Object} options.reference      window.VICE_REFERENCE
 * @param {number} [options.taxiOutMinutes=12]    subtracted from a first-seen departure
 * @param {number} [options.arrivalLeadMinutes=0] subtracted from a last-seen arrival
 * @returns {{flights: Array, dropped: Object, cityPairs: Map}}
 */
export function buildFlights(records, mapping, options) {
  const {
    airport, timeZone, reference,
    taxiOutMinutes = 12, arrivalLeadMinutes = 0,
  } = options;
  const icao = String(airport || "").trim().toUpperCase();

  const merged = new Map();
  const dropped = { noCallsign: 0, noAirports: 0, noType: 0, notAtAirport: 0, noTime: 0 };

  for (const { obj, receivedMs } of records) {
    const callsign = String(obj[mapping.callsign] ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(callsign)) {
      dropped.noCallsign++;
      continue;
    }
    const origin = normalizeAirport(obj[mapping.origin], reference);
    const destination = normalizeAirport(obj[mapping.destination], reference);

    // A flight is keyed on its whole city pair, so a callsign flown twice in one
    // recording — the same tail turning around, or an airline reusing a number —
    // stays two flights instead of collapsing into a contradictory one.
    const key = `${callsign}|${origin}|${destination}`;
    let flight = merged.get(key);
    if (!flight) {
      merged.set(key, (flight = {
        callsign, origin, destination,
        aircraftType: "", route: "",
        departureMs: null, arrivalMs: null,
        firstSeenMs: Infinity, lastSeenMs: -Infinity,
        observations: 0,
      }));
    }
    flight.observations++;
    if (Number.isFinite(receivedMs)) {
      flight.firstSeenMs = Math.min(flight.firstSeenMs, receivedMs);
      flight.lastSeenMs = Math.max(flight.lastSeenMs, receivedMs);
    }

    const type = normalizeAircraftType(obj[mapping.aircraftType], reference);
    if (type) flight.aircraftType = type;

    const route = String(obj[mapping.route] ?? "").trim().toUpperCase();
    if (route) flight.route = route.replace(/\s+/g, " ");

    if (mapping.departureTime) {
      const ms = parseFeedTime(obj[mapping.departureTime], receivedMs);
      if (ms !== null) flight.departureMs = ms;
    }
    if (mapping.arrivalTime) {
      const ms = parseFeedTime(obj[mapping.arrivalTime], receivedMs);
      if (ms !== null) flight.arrivalMs = ms;
    }
  }

  const flights = [];
  const cityPairs = new Map();

  for (const flight of merged.values()) {
    if (!flight.origin || !flight.destination) {
      dropped.noAirports++;
      continue;
    }
    // vice reads a timetable row as an operation at the timetable's airport;
    // a flight that touches it at neither end — an overflight, or traffic at a
    // neighbouring field — has nothing to contribute and makes the CSV invalid.
    const isDeparture = flight.origin === icao && flight.destination !== icao;
    const isArrival = flight.destination === icao && flight.origin !== icao;
    if (!isDeparture && !isArrival) {
      dropped.notAtAirport++;
      continue;
    }
    if (!flight.aircraftType) {
      dropped.noType++;
      continue;
    }

    let ms;
    if (isDeparture) {
      ms = flight.departureMs ?? (Number.isFinite(flight.firstSeenMs)
        ? flight.firstSeenMs - taxiOutMinutes * 60000 : null);
    } else {
      ms = flight.arrivalMs ?? (Number.isFinite(flight.lastSeenMs)
        ? flight.lastSeenMs - arrivalLeadMinutes * 60000 : null);
    }
    if (ms === null || !Number.isFinite(ms)) {
      dropped.noTime++;
      continue;
    }

    const row = {
      callsign: flight.callsign,
      origin: flight.origin,
      destination: flight.destination,
      aircraft_type: flight.aircraftType,
      time: toLocalHhmm(ms, timeZone),
      cargo: looksLikeCargo(flight.callsign),
      // Kept for the review table and the routes block, not written to the CSV.
      operation: isDeparture ? "departure" : "arrival",
      epochMs: ms,
      route: flight.route,
      observations: flight.observations,
      timeSource: (isDeparture ? flight.departureMs : flight.arrivalMs) !== null ? "feed" : "observed",
    };
    flights.push(row);

    if (flight.route) {
      const other = isDeparture ? flight.destination : flight.origin;
      const bucket = isDeparture ? "departures" : "arrivals";
      const pairKey = `${bucket}|${other}`;
      let pair = cityPairs.get(pairKey);
      if (!pair) cityPairs.set(pairKey, (pair = { bucket, airport: other, routes: new Map() }));
      pair.routes.set(flight.route, (pair.routes.get(flight.route) || 0) + 1);
    }
  }

  flights.sort((a, b) => a.epochMs - b.epochMs || a.callsign.localeCompare(b.callsign));
  return { flights, dropped, cityPairs };
}

/**
 * The airports a recording saw most of, busiest first.
 *
 * A timetable belongs to one airport, and the one worth building is whichever
 * the recording actually covers — which the recording knows and the operator
 * would otherwise have to guess at. Counted per flight rather than per record so
 * a single aircraft sitting on frequency for an hour does not outvote a bank.
 */
export function suggestAirports(records, mapping, reference, limit = 8) {
  const perAirport = new Map();
  const seen = new Set();

  for (const { obj } of records) {
    const callsign = String(obj[mapping.callsign] ?? "").trim().toUpperCase();
    if (!callsign) continue;
    for (const field of ["origin", "destination"]) {
      const airport = normalizeAirport(obj[mapping[field]], reference);
      if (!airport) continue;
      const key = `${callsign}|${airport}`;
      if (seen.has(key)) continue;
      seen.add(key);
      perAirport.set(airport, (perAirport.get(airport) || 0) + 1);
    }
  }

  return [...perAirport.entries()]
    .map(([airport, flights]) => ({ airport, flights }))
    .sort((a, b) => b.flights - a.flights || a.airport.localeCompare(b.airport))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Validation — the same rules vice applies when it loads the file
 * ------------------------------------------------------------------ */

/** Minutes after local midnight, from an HH:MM string. */
export function hhmmToMinutes(hhmm) {
  const [hour, minute] = String(hhmm).split(":").map(Number);
  return hour * 60 + minute;
}

/** The window a row holds its callsign for, as vice computes it. */
function activeWindow(row) {
  const minute = hhmmToMinutes(row.time);
  return row.operation === "departure"
    ? [minute, minute + DEPARTURE_ACTIVE_MINUTES]
    : [minute - ARRIVAL_ACTIVE_MINUTES, minute];
}

/**
 * Check a set of rows the way vice will, so a bad timetable is caught here with
 * an explanation rather than at launch with a line number.
 *
 * Errors are what vice refuses to load: an unknown aircraft type, a duplicate
 * row, one callsign flying two overlapping flights. Warnings are what will load
 * but disappoint: an airport vice has never heard of, a suspiciously thin
 * recording. Each error names the row so the UI can offer to drop it.
 *
 * @returns {{errors: Array, warnings: Array}}
 */
export function validateFlights(flights, reference) {
  const errors = [];
  const warnings = [];
  const knownTypes = new Set(reference?.aircraftTypes || []);
  const knownAirports = new Set(reference?.airports || []);

  const seenRows = new Map();
  const byCallsign = new Map();

  flights.forEach((row, index) => {
    if (knownTypes.size && !knownTypes.has(row.aircraft_type)) {
      errors.push({
        index, kind: "aircraft_type",
        message: `${row.callsign}: vice does not know the aircraft type ${row.aircraft_type}`,
      });
    }
    for (const which of ["origin", "destination"]) {
      if (knownAirports.size && !knownAirports.has(row[which])) {
        warnings.push({
          index, kind: "airport",
          message: `${row.callsign}: ${row[which]} is not in vice's airport list (${which})`,
        });
      }
    }

    const identity = `${row.callsign}|${row.origin}|${row.destination}|${row.aircraft_type}|${row.time}|${row.cargo}`;
    if (seenRows.has(identity)) {
      errors.push({
        index, kind: "duplicate",
        message: `${row.callsign}: identical to an earlier row; vice rejects exact duplicates`,
      });
    } else {
      seenRows.set(identity, index);
    }

    const uses = byCallsign.get(row.callsign) || [];
    const [start, end] = activeWindow(row);
    for (const prior of uses) {
      // vice compares windows on the raw minute-of-day, without wrapping, so
      // this comparison matches it exactly rather than being cleverer.
      if (prior.start < end && start < prior.end) {
        errors.push({
          index, kind: "callsign",
          message: `${row.callsign} is already flying at ${flights[prior.index].time}; `
            + `vice needs ${DEPARTURE_ACTIVE_MINUTES} minutes between uses of one callsign`,
        });
        break;
      }
    }
    uses.push({ index, start, end });
    byCallsign.set(row.callsign, uses);
  });

  return { errors, warnings };
}

/**
 * How much of the day the timetable actually covers.
 *
 * vice anchors a timetable's 24-hour cycle to the sim's start time and flies
 * only the flights the recording holds, so the hours with nothing in them are
 * hours of empty scope. The span is what tells an operator whether they recorded
 * long enough for the session they mean to run.
 */
export function coverage(flights) {
  const perHour = new Array(24).fill(0);
  for (const row of flights) perHour[Math.floor(hhmmToMinutes(row.time) / 60)]++;

  const busiest = perHour.indexOf(Math.max(...perHour, 0));
  const populated = perHour.filter(n => n > 0).length;
  const departures = flights.filter(f => f.operation === "departure").length;

  let spanMinutes = 0;
  if (flights.length > 1) {
    const times = flights.map(f => f.epochMs).sort((a, b) => a - b);
    spanMinutes = Math.round((times[times.length - 1] - times[0]) / 60000);
  }

  return {
    total: flights.length,
    departures,
    arrivals: flights.length - departures,
    perHour,
    populatedHours: populated,
    busiestHour: flights.length ? busiest : null,
    busiestHourCount: flights.length ? perHour[busiest] : 0,
    spanMinutes,
  };
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

/** The timetable CSV, exactly as vice parses it. */
export function toTimetableCSV(flights) {
  const lines = [TIMETABLE_COLUMNS.join(",")];
  for (const row of flights) {
    lines.push([
      row.callsign, row.origin, row.destination, row.aircraft_type, row.time, row.cargo ? "true" : "false",
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * The "traffic_routes" block for the airport in the scenario JSON.
 *
 * A timetable says where each flight went, not how, and left alone vice invents
 * a route from its own databases. The recording knows what was really filed, and
 * this is where that knowledge goes: the most-filed route per city pair wins,
 * since a recording catches amendments and one-off reroutes alongside the route
 * the pair normally flies.
 */
export function toTrafficRoutes(cityPairs, airport) {
  const departures = {};
  const arrivals = {};

  for (const pair of cityPairs.values()) {
    let bestRoute = "";
    let bestCount = 0;
    for (const [route, count] of pair.routes) {
      if (count > bestCount) {
        bestRoute = route;
        bestCount = count;
      }
    }
    if (!bestRoute) continue;
    (pair.bucket === "departures" ? departures : arrivals)[pair.airport] = bestRoute;
  }

  const block = {};
  if (Object.keys(departures).length) block.departures = sortedKeys(departures);
  if (Object.keys(arrivals).length) block.arrivals = sortedKeys(arrivals);
  return { [String(airport).toUpperCase()]: { traffic_routes: block } };
}

function sortedKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));
}
