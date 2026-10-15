/*
 * VATFLOW Tower Cab - airport configuration shared by the in-cab displays.
 * Plain script (no modules) so it loads both in MSFS (Coherent GT) and in a
 * normal browser preview.
 *
 * The cab works at any airport: common/site.js finds the airport the cab is at and
 * rewrites the airport fields below (icao ... dbrite.finals) for it. The values here
 * are KDCA's, used until then and in the browser preview. Hand-tuned settings for one
 * airport go in VATFLOW_TWR_OVERRIDES at the end of this file.
 */
var VATFLOW_TWR = {
  icao: "KDCA",
  lid: "DCA",
  name: "WASHINGTON NATIONAL",
  // Airport reference point (DBRITE center) and field elevation
  arp: { lat: 38.8521, lon: -77.0377 },
  elevFt: 15,
  // Magnetic variation, east positive (DCA ~10 W). Used to show wind as magnetic.
  magVarDeg: -10,
  // The cab's heading (true) in placement/towers.json: the front window looks this way.
  // Only used outside the sim (the browser preview); in the sim the screens read it.
  cabHeadingTrue: 121,
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
    minGroundspeedKt: 40,  // hide parked / taxiing traffic (that is the ASDE-X's job)
    maxAltFt: 18000,
    historyDots: 5,
    // Altimeter/wind lines in the top-left list (STARS "altimeter" list)
    altimeterStations: ["KDCA", "KADW", "KDAA"],
    towerLabel: "DCA TOWER",
    // Extended final approach courses drawn on the scope, from the landing threshold outward.
    // courseMag: inbound course (magnetic); without it the line follows the runway centerline.
    finals: [
      { rwy: "01", lengthNm: 10 },
      { rwy: "19", courseMag: 147, lengthNm: 10 }   // offset final down the river
    ]
  },
  // In-cab IDST (VATFLOW release times). Same data as vatflow.io/idst.html.
  idst: {
    // Your VATSIM CID: typed in on the cab's SETUP screen and kept in the sim's storage
    // (common/store.js), never in this file. Issuing or cancelling a release is only
    // allowed while this CID is connected as a controller on VATSIM.
    cid: "",
    supabaseUrl: "https://qoaipsfcidpymboojfwa.supabase.co",
    supabaseKey: "sb_publishable_6Pj7jeRN0AQBcjl44MoCNA_zjsvFs79",
    siteBase: "https://vatflow.io/",       // nav data + ARTCC boundaries for route expansion
    fcaRefreshSec: 15,
    feedRefreshSec: 30
  },
  asdex: {
    maxAglFt: 2000,        // show arrivals on short final and departures just off
    maxDistNm: 4,
    marginPx: 30
  }
};

// Hand-tuned per-airport settings, applied over the generic ones (common/site.js).
var VATFLOW_TWR_OVERRIDES = {
  KDCA: {
    magVarDeg: -10,
    atcPatterns: [/^DCA_/, /^PCT_/, /^DC_(?:[A-Z0-9]+_)*CTR$/],
    dbrite: {
      altimeterStations: ["KDCA", "KADW", "KDAA"],
      towerLabel: "DCA TOWER",
      finals: [
        { rwy: "01", lengthNm: 10 },
        { rwy: "19", courseMag: 147, lengthNm: 10 }   // offset final down the river
      ]
    }
  },
  KATL: {
    magVarDeg: -5
  }
};
