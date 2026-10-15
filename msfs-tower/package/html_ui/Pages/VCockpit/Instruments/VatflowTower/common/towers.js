/*
 * VATFLOW Tower Cab - the shared tower list: tuned cab positions that ship with the cab.
 * The SETUP screen uses (first found): your saved spot, this list, the airport's
 * OpenStreetMap control tower (common/airports/ or site.js), else the airport centre.
 *   lat / lon      cab centre, degrees
 *   floorFtMsl     cab floor height, feet above sea level (the aircraft's altitude)
 *   headingTrue    which way the front window looks, degrees true
 * To add a tower: tune it on the SETUP screen, press SAVE, then read the numbers off the
 * screen (or press SHARE) and add a line here.
 */
var VATFLOW_TOWERS = {
  KDCA: { lat: 38.8545923, lon: -77.0437097, floorFtMsl: 215, headingTrue: 121, src: "VATFLOW tower list" }
};
