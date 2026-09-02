#!/usr/bin/env node
/**
 * SWIM to vICE conversion: field discovery, flight folding, vice's own
 * timetable rules, and the CSV and traffic_routes output.
 *
 * The end-to-end case runs the shipped demo recording, which is built to look
 * like a feed rather than like the parser: nested envelopes, repeated position
 * updates, FAA identifiers, equipment suffixes, amendments, and traffic that
 * never touches the timetable's airport.
 *
 * Usage: node scripts/build-swim2vice-demo.mjs && node scripts/test-swim2vice.mjs
 */
import { readFileSync } from "node:fs";
import {
  parseRecording, extractRecords, describeKeys, guessFieldMapping,
  normalizeAirport, normalizeAircraftType, parseFeedTime, toLocalHhmm, looksLikeCargo,
  buildFlights, validateFlights, coverage, toTimetableCSV, toTrafficRoutes, hhmmToMinutes,
  suggestAirports,
} from "../shared/swim2vice-core.mjs";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
}
function equal(got, want, msg) {
  assert(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

/* ---- reference data ------------------------------------------------- */

const referenceSource = readFileSync(new URL("../data/vice/vice-reference.js", import.meta.url), "utf8");
const window = {};
new Function("window", referenceSource)(window);
const reference = window.VICE_REFERENCE;

assert(reference.aircraftTypes.includes("B738"), "reference carries vice's aircraft types");
assert(!reference.aircraftTypes.includes("E175"), "E175 is not a type vice knows");
equal(reference.aircraftSubs.E175, "E75L", "E175 substitutes to the type vice does know");
assert(reference.airports.includes("KDEN"), "reference carries vice's airports");

/* ---- codes and times ------------------------------------------------ */

equal(normalizeAirport("DEN", reference), "KDEN", "three-letter identifier gains its K");
equal(normalizeAirport("KDEN", reference), "KDEN", "ICAO code passes through");
equal(normalizeAirport("ANC", reference), "PANC", "Alaska comes from the identifier table, not a K");
equal(normalizeAirport("HNL", reference), "PHNL", "Hawaii likewise");
equal(normalizeAirport("", reference), "", "nothing in, nothing out");

equal(normalizeAircraftType("B738/L", reference), "B738", "equipment suffix dropped");
equal(normalizeAircraftType("e175", reference), "E75L", "unknown type substituted");
equal(normalizeAircraftType("H/B77W/L", reference), "H", "leading weight class is left for validation to catch");

const near = Date.UTC(2026, 6, 14, 12, 0, 0);
equal(parseFeedTime("2026-07-14T13:05:00Z", near), Date.UTC(2026, 6, 14, 13, 5), "ISO 8601");
equal(parseFeedTime(1768392300, near), 1768392300000, "epoch seconds");
equal(parseFeedTime(1768392300000, near), 1768392300000, "epoch milliseconds");
equal(parseFeedTime("1305", near), Date.UTC(2026, 6, 14, 13, 5), "bare HHMM lands on the recorded day");
equal(parseFeedTime("13:05Z", near), Date.UTC(2026, 6, 14, 13, 5), "HH:MM with a Z");
equal(parseFeedTime("2350", Date.UTC(2026, 6, 15, 0, 5)), Date.UTC(2026, 6, 14, 23, 50),
  "2350 seen just after midnight belongs to yesterday");
equal(parseFeedTime("", near), null, "empty time");
equal(parseFeedTime("not a time", near), null, "unparseable time");
equal(parseFeedTime("2599", near), null, "impossible clock time");

equal(toLocalHhmm(Date.UTC(2026, 6, 14, 12, 0), "America/Denver"), "06:00", "summer: Denver is UTC-6");
equal(toLocalHhmm(Date.UTC(2026, 0, 14, 12, 0), "America/Denver"), "05:00", "winter: Denver is UTC-7");
equal(toLocalHhmm(Date.UTC(2026, 6, 14, 12, 0), "America/Phoenix"), "05:00", "Phoenix does not shift");
equal(toLocalHhmm(Date.UTC(2026, 6, 14, 6, 30), "America/New_York"), "02:30", "past midnight stays on the clock");

assert(looksLikeCargo("FDX1234"), "FedEx is cargo");
assert(looksLikeCargo("UPS22"), "UPS is cargo");
assert(!looksLikeCargo("UAL1234"), "United is not");

/* ---- reading a recording -------------------------------------------- */

const messy = [
  JSON.stringify({ t: "2026-07-14T12:00:00Z", src: "ws", data: JSON.stringify({ messageType: "weather", payload: { station: "KDEN" } }) }),
  JSON.stringify({ t: "2026-07-14T12:00:05Z", src: "ws", data: "not json at all" }),
  "",
  "{ truncated because the tab closed",
].join("\n");
const messyParsed = parseRecording(messy);
equal(messyParsed.frames.length, 2, "blank line skipped, truncated line dropped");
equal(messyParsed.skipped, 1, "the truncated line is reported, not thrown");
equal(extractRecords(messyParsed.frames).parseErrors, 1, "a frame whose payload is not JSON is counted");
equal(extractRecords(messyParsed.frames).records.length, 0, "a weather frame yields no flights");

/* ---- end to end on the demo recording -------------------------------- */

const demo = readFileSync(new URL("../data/vice/swim2vice-demo.ndjson", import.meta.url), "utf8");
const { frames, skipped } = parseRecording(demo);
equal(skipped, 0, "demo recording parses cleanly");
assert(frames.length > 4000, "demo recording has the frames it should");

const { records } = extractRecords(frames);
assert(records.length > 4000, "records found inside the envelopes");

const keys = describeKeys(records);
const keyNames = keys.map(k => k.key);
assert(keyNames.includes("acid") && keyNames.includes("routeString"), "keys discovered for the mapping UI");
assert(keys[0].samples.length > 0, "each key carries example values");

const mapping = guessFieldMapping(keys);
equal(mapping.callsign, "acid", "callsign guessed");
equal(mapping.origin, "depApt", "origin guessed");
equal(mapping.destination, "destApt", "destination guessed");
equal(mapping.aircraftType, "actype", "aircraft type guessed");
equal(mapping.route, "routeString", "route guessed");
assert(!mapping.departureTime, "no departure time field to guess in this feed");

const built = buildFlights(records, mapping, {
  airport: "KDEN", timeZone: "America/Denver", reference, taxiOutMinutes: 12,
});
const { flights, dropped, cityPairs } = built;

assert(flights.length > 140, `folded to one row per flight (got ${flights.length} from ${records.length} records)`);
assert(flights.length <= 168, "no more flights than the recording contains");
equal(dropped.notAtAirport, 20, "traffic that never touches KDEN is dropped, and counted");
assert(flights.every(f => f.origin === "KDEN" || f.destination === "KDEN"), "every row is an operation at the airport");
assert(flights.every(f => f.timeSource === "observed"), "times come from when flights were seen");
assert(flights.some(f => f.operation === "departure") && flights.some(f => f.operation === "arrival"),
  "both departures and arrivals survive");

// Sorted by time, which is what makes the CSV readable and the review table honest.
for (let i = 1; i < flights.length; i++) {
  assert(flights[i - 1].epochMs <= flights[i].epochMs, "flights come out in time order");
}

// A departure's published time is its pushback; the recording sees it at
// wheels-up, so the taxi estimate has to come back off.
const firstDeparture = flights.find(f => f.operation === "departure");
const sameFlightRecords = records.filter(r => r.obj.acid === firstDeparture.callsign);
const firstSeen = Math.min(...sameFlightRecords.map(r => r.receivedMs));
equal(firstDeparture.time, toLocalHhmm(firstSeen - 12 * 60000, "America/Denver"),
  "departure time is first seen less the taxi estimate");

const noTaxi = buildFlights(records, mapping, { airport: "KDEN", timeZone: "America/Denver", reference, taxiOutMinutes: 0 });
const sameFlightNoTaxi = noTaxi.flights.find(f => f.callsign === firstDeparture.callsign);
equal(hhmmToMinutes(sameFlightNoTaxi.time) - hhmmToMinutes(firstDeparture.time), 12,
  "the taxi estimate moves departures and nothing else");

const suggested = suggestAirports(records, mapping, reference);
equal(suggested[0].airport, "KDEN", "the airport the recording is about is suggested first");
equal(suggested[0].flights, 168, "counted once per flight, not once per position update");
assert(suggested.length > 1 && suggested[1].flights < suggested[0].flights, "the other end of each pair trails it");

/* ---- vice's rules ---------------------------------------------------- */

const { errors, warnings } = validateFlights(flights, reference);
equal(errors.length, 0, `demo timetable is valid for vice (${errors.map(e => e.message).join("; ")})`);
equal(warnings.length, 0, `demo timetable raises no warnings (${warnings.map(w => w.message).join("; ")})`);

const withUnknownType = [{ ...flights[0], aircraft_type: "ZZZZ" }];
equal(validateFlights(withUnknownType, reference).errors[0].kind, "aircraft_type", "unknown type is an error");

const withUnknownAirport = [{ ...flights[0], destination: "ZZZZ", operation: "departure" }];
equal(validateFlights(withUnknownAirport, reference).warnings[0].kind, "airport", "unknown airport is a warning");

// vice holds a callsign for 45 minutes from a departure's pushback.
const overlapping = [
  { callsign: "UAL1", origin: "KDEN", destination: "KORD", aircraft_type: "B738", time: "08:00", cargo: false, operation: "departure", epochMs: 1 },
  { callsign: "UAL1", origin: "KDEN", destination: "KLAX", aircraft_type: "B738", time: "08:30", cargo: false, operation: "departure", epochMs: 2 },
];
equal(validateFlights(overlapping, reference).errors[0].kind, "callsign", "one callsign twice inside 45 minutes is an error");

const spaced = [overlapping[0], { ...overlapping[1], time: "08:46" }];
equal(validateFlights(spaced, reference).errors.length, 0, "the same callsign is fine once the window has passed");

const duplicated = [flights[0], { ...flights[0] }];
equal(validateFlights(duplicated, reference).errors.some(e => e.kind === "duplicate"), true, "exact duplicate rows are an error");

/* ---- coverage -------------------------------------------------------- */

const stats = coverage(flights);
equal(stats.total, flights.length, "coverage counts every flight");
equal(stats.departures + stats.arrivals, flights.length, "every flight is one or the other");
equal(stats.perHour.reduce((a, b) => a + b, 0), flights.length, "the hourly histogram accounts for all of them");
assert(stats.spanMinutes > 180 && stats.spanMinutes < 300, `four hours recorded reads as about four hours (${stats.spanMinutes} min)`);
assert(stats.populatedHours >= 4, "the recording covers the hours it ran for");

/* ---- output ---------------------------------------------------------- */

const csv = toTimetableCSV(flights);
const csvLines = csv.trim().split("\n");
equal(csvLines[0], "callsign,origin,destination,aircraft_type,time,cargo", "vice's header, in vice's order");
equal(csvLines.length, flights.length + 1, "one line per flight plus the header");
assert(csvLines.slice(1).every(l => /^[A-Z0-9]+,[A-Z0-9]{4},[A-Z0-9]{4},[A-Z0-9]+,\d{2}:\d{2},(true|false)$/.test(l)),
  "every row is shaped the way vice parses it");
assert(csv.endsWith("\n"), "file ends with a newline");

const routes = toTrafficRoutes(cityPairs, "KDEN");
assert(routes.KDEN.traffic_routes.departures.KORD, "departure routes are keyed by destination");
assert(routes.KDEN.traffic_routes.arrivals.KLAX, "arrival routes are keyed by origin");
assert(!/AMENDED/.test(JSON.stringify(routes)),
  "the route a pair normally files wins over a one-off amendment");
const departureKeys = Object.keys(routes.KDEN.traffic_routes.departures);
assert(departureKeys.every(k => k.length === 4), "route keys are ICAO codes");
assert(String(departureKeys) === String([...departureKeys].sort()), "routes come out sorted, so diffs stay readable");

console.log(`OK ${passed} assertions`);
