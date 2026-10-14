/*
 * VATFLOW Tower Cab - airport configuration shared by the in-cab displays.
 * Plain script (no modules) so it loads both in MSFS (Coherent GT) and in a
 * normal browser preview. To make a cab for another airport, copy this file
 * and change the values; nothing else in the gauges is airport-specific.
 */
var VATFLOW_TWR = {
  icao: "KDCA",
  name: "WASHINGTON NATIONAL",
  // Airport reference point (DBRITE center) and field elevation
  arp: { lat: 38.8521, lon: -77.0377 },
  elevFt: 15,
  // Magnetic variation, east positive (DCA ~10 W). Used to show wind as magnetic.
  magVarDeg: -10,
  // Tower position (OpenStreetMap node 13191471771)
  tower: { lat: 38.8545923, lon: -77.0437097 },
  // Runway thresholds from OurAirports (same source vatflow uses)
  runways: [
    { ids: ["01", "19"], a: [38.8424, -77.0368], b: [38.8612, -77.0387] },
    { ids: ["04", "22"], a: [38.8423, -77.0408], b: [38.8544, -77.0333] },
    { ids: ["15", "33"], a: [38.8617, -77.0438], b: [38.8503, -77.0327] }
  ],
  // VATSIM controller callsigns worth showing in the cab (DCA local, Potomac TRACON, ZDC)
  atcPatterns: [/^DCA_/, /^PCT_/, /^DC_(?:[A-Z0-9]+_)*CTR$/],
  atisCallsign: "KDCA_ATIS",
  feedUrl: "https://data.vatsim.net/v3/vatsim-data.json",
  metarUrl: "https://metar.vatsim.net/metar.php?id=KDCA",
  feedRefreshSec: 15,
  dbrite: {
    rangeNm: 15,
    ringNm: 5,
    minGroundspeedKt: 40,  // hide parked / taxiing traffic (that is the window's job)
    maxAltFt: 18000,
    historyDots: 5
  }
};
