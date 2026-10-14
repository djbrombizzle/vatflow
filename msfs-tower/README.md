# VATFLOW Tower Cab for MSFS 2024 (KDCA first)

A spawnable "aircraft" that is really the top of the Reagan National (KDCA)
tower. You load it in Microsoft Flight Simulator 2024 like a plane, a small
tool parks it on top of the sim's own DCA tower and freezes it there, and you
work VATSIM traffic from a real tower-cab viewpoint with live VATSIM traffic
outside the glass.

| Outside | Inside (standing eye point) |
| --- | --- |
| ![exterior](docs/exterior.jpg) | ![interior](docs/interior.jpg) |

Inside the cab there are two working screens fed by live data:

![screens](docs/preview_demo.png)

* **DBRITE** (hanging from the ceiling, front right): live VATSIM traffic
  within 15 nm, north up, with range rings, DCA's runways, history trails and
  STARS-style data blocks (callsign / altitude + speed, alternating with type +
  ARR/DEP). Positions are dead-reckoned between feed updates and repainted on a
  4.8 s radar sweep.
* **TWR INFO** (on the front-left console): Zulu time, the real KDCA METAR wind
  (magnetic) and altimeter, the VATSIM ATIS letter, who is online at DCA /
  Potomac / ZDC, arrivals inside 50 nm and departures on the ground. The sim's
  own wind and pressure at the cab are shown small for comparison.

Status: everything that can be built without the sim is built and tested here
(the Blender script runs in headless Blender, the screens run in a browser
preview, the placement tool runs against a mocked SimConnect). The parts that
can only be checked inside MSFS 2024 are listed in the
[SDK guide](SDK-GUIDE.md#things-only-the-sim-can-confirm).

## What's in here

| Path | What it is |
| --- | --- |
| [`SDK-GUIDE.md`](SDK-GUIDE.md) | **Start here.** Step-by-step: SDK, Blender, export, build, fly. |
| `blender/build_tower_cab.py` | Builds the cab in Blender from parameters (8 sides, leaning glass, catwalk, roof, antennas, consoles, screens). Run it, export, done. |
| `package/SimObjects/Airplanes/vatflow_tower_cab/common/model/` | `model.cfg` + LOD files that point at the exported cab. |
| `package/SimObjects/Airplanes/vatflow_tower_cab/common/panel/panel.cfg` | Puts the two HTML screens onto the screen materials. |
| `package/html_ui/Pages/VCockpit/Instruments/VatflowTower/` | The screens: `Dbrite/`, `TwrInfo/`, shared `common/airport.js` (all the KDCA specifics) and `common/vatsim-feed.js`. |
| `placement/tower_place.py` + `towers.json` | Windows tool: teleport + freeze on the tower, nudge it into place, save. |
| `preview/index.html` | Runs the screens in a normal browser (live or `?demo`). |

Tests for the screen logic: `node scripts/test-msfs-tower.mjs` (from the repo root).

## Can CRC (or a browser) go inside the cab?

Not CRC itself. MSFS can only draw its own instruments onto 3D screens: small
HTML/JavaScript pages run by the sim's built-in Coherent GT engine (that is how
every glass cockpit works). It cannot show another Windows program such as CRC,
and it is not a general web browser, so CRC or vatflow.io can't be mirrored
onto a cab screen.

What this project does instead:

1. **The DBRITE screen is a radar display built for the cab.** It reads the
   same VATSIM network data CRC shows, straight from the public data feed. The
   one difference: the public feed refreshes every ~15 s while CRC gets
   position updates every few seconds, so the DBRITE dead-reckons in between.
   That is fine for a tower DBRITE, but CRC stays your actual working scope.
2. **Work CRC beside the sim, as real tower controllers do with their
   displays.** Put CRC on a second monitor (or undock its windows) and keep MSFS
   as the out-the-window view. In VR, overlay tools that pin a desktop window
   into the headset (e.g. OpenKneeboard's window capture, or SteamVR overlay
   apps) can float CRC in front of you in the cab.

Anything else in the vatflow data (flow programs, departure lists, etc.) can
become another in-cab screen the same way: a page in
`html_ui/.../VatflowTower/` plus a `[VCockpit]` entry and a screen material
named to match.

## Another airport later

1. Copy `common/airport.js` values for the new field (ARP, runways from
   OurAirports, magnetic variation, ATC callsign patterns).
2. Change the parameters at the top of `build_tower_cab.py` (sides, size,
   glass lean, roof depth) to match the photo of that tower.
3. Add the tower to `placement/towers.json` (or just `capture` it in the sim).
