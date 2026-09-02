#!/usr/bin/env node
/**
 * Build the demo recording the SWIM to vICE converter loads when you press
 * "Load demo recording", so the whole path — parse, map, review, export — can be
 * walked before you have captured anything of your own, and so the node tests
 * have a fixture that looks like a real feed rather than like the parser.
 *
 * The shape is deliberately awkward in the ways live feeds are: records nested
 * under an envelope, position updates repeating a flight hundreds of times, an
 * equipment suffix on the type, FAA identifiers rather than ICAO codes, an
 * amended route arriving after the original, weather frames carrying no flights
 * at all, and traffic that never touches the timetable's airport.
 *
 * Usage: node scripts/build-swim2vice-demo.mjs
 */
import { writeFileSync } from "node:fs";

const OUT = new URL("../data/vice/swim2vice-demo.ndjson", import.meta.url);
const FEED = "wss://swim.example.org/eram/scope";

// 1200Z on a summer Tuesday: 0600 local at Denver, the start of the first bank.
const START_MS = Date.UTC(2026, 6, 14, 12, 0, 0);
const RECORDING_MINUTES = 240;

const DEPARTURE_ROUTES = {
  ORD: "PLAIN3 HGO J114 ONL J148 DBQ WYNDE4",
  LAX: "ZAINE2 RSK J60 HEC BASET3",
  DFW: "PLAIN3 LAA J38 PNH SEEVR5",
  ATL: "FLATI2 LAA J102 MEM RMG WEEDR4",
  SEA: "TEHRU2 CHE J148 BOI HUMPP CHINS6",
  PHX: "ZAINE2 RSK J102 SSO EAGUL6",
  MSP: "PLAIN3 AKO J146 ONL KKILR3",
  JFK: "FLATI2 HCT J24 ONL J34 DJB LENDY8",
};
const ARRIVAL_ROUTES = {
  ORD: "OBK J146 DBQ ONL HGO ANCHR2",
  LAX: "OROSZ2 DAG J146 RSK BAYLR6",
  DFW: "AKUNA4 TXO J38 LAA SAYGE4",
  ATL: "HUSKY4 RMG MEM LAA QUAIL2",
  SEA: "SUMMA3 BOI CHE TOMSN4",
  PHX: "BROOK1 SSO RSK FLATI2",
  MSP: "KKILR3 ONL AKO ANCHR2",
  JFK: "GREKI3 DJB ONL HCT SAYGE4",
};

const FLEET = [
  ["UAL", "B738/L"], ["UAL", "A320/L"], ["UAL", "B739/L"], ["UAL", "E75L/L"],
  ["SWA", "B737/L"], ["SWA", "B38M/L"], ["FFT", "A20N/L"], ["AAL", "A321/L"],
  ["DAL", "B752/L"], ["SKW", "CRJ7/L"], ["SKW", "E75L/L"], ["JBU", "A320/L"],
  ["ASA", "B739/L"], ["FDX", "B763/L"], ["UPS", "A306/L"], ["NKS", "A20N/L"],
];

let seed = 20260714;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick(list) {
  return list[Math.floor(random() * list.length) % list.length];
}

/** One flight's worth of feed traffic, spread over the minutes it is on scope. */
function buildFlight(index) {
  const departure = index % 2 === 0;
  const other = pick(Object.keys(DEPARTURE_ROUTES));
  const [airline, type] = pick(FLEET);
  const callsign = airline + (100 + ((index * 37) % 899));

  // Departures come to life on the scope around wheels-up; arrivals stop
  // updating when they land. The converter has to work back from both.
  const activeMinutes = 8 + Math.floor(random() * 10);
  const startMinute = Math.floor(random() * (RECORDING_MINUTES - activeMinutes - 5));

  return {
    callsign,
    type,
    dep: departure ? "DEN" : other,
    dest: departure ? other : "DEN",
    route: departure ? DEPARTURE_ROUTES[other] : ARRIVAL_ROUTES[other],
    startMinute,
    endMinute: startMinute + activeMinutes,
    departure,
  };
}

const frames = [];
function emit(minute, second, payload) {
  frames.push({
    t: new Date(START_MS + minute * 60000 + second * 1000).toISOString(),
    src: "ws",
    url: FEED,
    data: JSON.stringify(payload),
  });
}

const flights = Array.from({ length: 168 }, (_, i) => buildFlight(i));

for (const flight of flights) {
  // The flight plan, then an amendment for a few of them: the converter should
  // end up with the amended route, not the original.
  emit(flight.startMinute, 0, {
    messageType: "flightPlan",
    payload: {
      flight: {
        acid: flight.callsign,
        actype: flight.type,
        depApt: flight.dep,
        destApt: flight.dest,
        routeString: flight.route,
        beaconCode: 1000 + Math.floor(random() * 6000),
        requestedAltitude: 330,
      },
    },
  });
  if (flight.callsign.endsWith("7")) {
    emit(flight.startMinute + 2, 30, {
      messageType: "flightPlanAmendment",
      payload: {
        flight: {
          acid: flight.callsign,
          actype: flight.type,
          depApt: flight.dep,
          destApt: flight.dest,
          routeString: flight.route + " /AMENDED",
        },
      },
    });
  }

  // Position updates, the bulk of any feed: the same flight over and over.
  // Thinned to twice a minute so the fixture stays a sensible size to ship.
  for (let minute = flight.startMinute; minute <= flight.endMinute; minute++) {
    for (const second of [11, 41]) {
      emit(minute, second, {
        messageType: "trackUpdate",
        payload: {
          tracks: [{
            acid: flight.callsign,
            actype: flight.type,
            depApt: flight.dep,
            destApt: flight.dest,
            latitude: +(39.86 + (random() - 0.5)).toFixed(4),
            longitude: +(-104.67 + (random() - 0.5)).toFixed(4),
            altitude: 5000 + Math.floor(random() * 30000),
            groundspeed: 250 + Math.floor(random() * 200),
          }],
        },
      });
    }
  }
}

// Traffic that has nothing to do with the timetable's airport, which the
// converter is expected to count and discard rather than write out.
for (let i = 0; i < 20; i++) {
  const minute = Math.floor(random() * RECORDING_MINUTES);
  emit(minute, 11, {
    messageType: "trackUpdate",
    payload: {
      tracks: [{
        acid: "OVR" + (100 + i),
        actype: "B738/L",
        depApt: "SFO",
        destApt: "BOS",
        latitude: 40.1,
        longitude: -105.2,
        altitude: 37000,
      }],
    },
  });
}

// Frames with no flights in them at all.
for (let minute = 0; minute < RECORDING_MINUTES; minute += 20) {
  emit(minute, 45, {
    messageType: "weather",
    payload: { station: "KDEN", altimeter: 29.92, wind: { direction: 170, speed: 12 } },
  });
}

frames.sort((a, b) => a.t.localeCompare(b.t));
writeFileSync(OUT, frames.map(f => JSON.stringify(f)).join("\n") + "\n");
console.log(`${frames.length} frames, ${flights.length} flights -> ${OUT.pathname}`);
