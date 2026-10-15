# VATFLOW Tower Cab for MSFS 2024

A spawnable "aircraft" that is really a tower cab, modelled on the Reagan National
(KDCA) tower. You load it in Microsoft Flight Simulator 2024 like a plane at any
airport, it moves itself up onto the sim's own tower and freezes there, and you work
VATSIM traffic from a real tower-cab viewpoint with live VATSIM traffic outside the glass.

* **Any airport**: the cab finds the airport it is at (`common/site.js`) and sets every
  screen up for it: METAR, ATIS, ATC, DBRITE and ASDE-X maps, IDST, VATSMART and the APT
  dashboard. KDCA and KATL ship with their data (`common/airports/`, built by
  `tools/build_airport_data.py`); any other airport gets it from OpenStreetMap the first
  time (`common/osm-airport.js`) and keeps it in the sim's storage. KDCA also has its
  hand-tuned settings (`VATFLOW_TWR_OVERRIDES` in `common/airport.js`) and the ramp screens.
* **Into the tower from inside the sim**: the **TOWER SETUP** screen (any screen's MENU)
  places the cab, moves it with on-screen buttons (forward / back / left / right / up /
  down / turn, three step sizes) and saves the spot for that airport. With AUTO PLACE on
  (the default) the cab goes up by itself a few seconds after a flight starts. Spots come
  from your saved one, else the tower list (`common/towers.js`), else the airport's
  control tower in OpenStreetMap, else the airport centre. `common/placement.js` moves the
  aircraft directly if the sim lets an instrument page set its position, otherwise it
  steers it there in slew mode; then it freezes it, turns the engine off and the ceiling
  lights on. The old Python tool in `placement/` still works as a backup.
* **Screen menu**: every 1024x768 screen runs the screen host (`Screen/`): a MENU tab in its
  bottom-right corner picks the app it shows (DBRITE, ASDE-X, IDST, VATSMART, demand vs
  AAR, aircraft list, the KDCA ramp list and maps, TOWER SETUP). Each screen remembers its
  choice. While the cab isn't in the tower, a banner on the screens leads to TOWER SETUP.
* **Your VATSIM CID** is typed on the TOWER SETUP screen and kept in the sim's storage
  (per user), never in the files, so the package can be shared.

| Outside | Inside (standing eye point) |
| --- | --- |
| ![exterior](docs/exterior.jpg) | ![interior](docs/interior.jpg) |

Inside the cab there are two working screens fed by live data:

![screens](docs/preview_demo.png)

* **DBRITE** (hanging from the ceiling, front right): STARS-style tower
  radar. Live VATSIM traffic within 15 nm, north up, grey range rings, an
  olive video map (runways of every airport in range, airport/heliport/navaid
  symbols), green altimeter list for DCA/ADW/DAA from the METARs, history
  trails and data blocks (callsign / altitude + speed, alternating with type +
  ARR/DEP). Positions are dead-reckoned between feed updates and repainted on a
  4.8 s radar sweep.
* **Overhead monitors** hang in square-tube yokes (side knobs, handle bar) from
  trolleys on a circular ceiling track, like the real DCA cab, and are built to travel
  all the way round the cab: grab the screen with the mouse and drag left/right. Drag
  the handle bar under it up/down to raise or lower it (telescoping post, 15 cm up to
  25 cm down), and a side knob left/right to swivel it (up to 50 degrees each way). Every window has a roll-down shade: drag the shade to set its height, click its roller to raise or lower it fully (each shade is 20 strips shown or hidden by its position, no animation) (behaviors in `common/model/tower_cab_interior.xml`, built on the SDK templates `ASOBO_GT_Anim_Code` and `ASOBO_GT_Interaction_DraggingXAxis_Code`).
* **ASDE-X** (hanging from the ceiling, front left; landscape 4:3 like the DBRITE, turned so
  its top is the view out of the window it hangs in front of, following it round the
  track and its swivel): the DCA surface in ASDE-X
  colours (teal water, grey field, dark movement area, black runways, light
  terminals, from OpenStreetMap) with every VATSIM aircraft on the field and
  arrivals/departures below 2,000 ft as heading arrows with callsign/type.
* **TWR INFO** (on the front-left console, amber like the IDS): **AW**, the actual
  wind, in big type: the sim's own wind at the cab (2-minute average, magnetic,
  gusts when the 10-minute peak is 10 kt or more above it). Also the altimeter,
  Zulu time, the VATSIM ATIS letter, the real KDCA METAR, who is online at DCA /
  Potomac / ZDC, arrivals inside 50 nm and departures on the ground.
* **IDST** (fixed to the console right of TWR INFO): VATFLOW release times for DCA
  departures in an active FCA program, the same data and release engine as
  vatflow.io/idst.html (`common/vatflow-metering.js` is a bundle of
  `shared/fca-metering.js`, rebuilt with `node msfs-tower/tools/build_vatflow_bundles.mjs`).
  Click an aircraft (or use the four keys next to the keyboard: up, down, issue,
  cancel) and ISSUE RELEASE. Writing needs `idst.cid` in `common/airport.js` set to
  your VATSIM CID, connected as a controller (the web page's rule).
* **Brightness**: the four knobs on the console's knob panel (left to right: all
  screens, DBRITE, ASDE-X, console screens). Drag right for brighter, left for dimmer;
  the screen shows its brightness while you turn (`common/dimmer.js`).
* **Ceiling lights**: five recessed light panels (softly self-lit) with cabin lights at
  the same spots in `common/config/systems.cfg` (`LIGHT_ASOBO_CabinBounceLarge`), switched on
  by the placement tool.
* **TMU desk** in the back-left corner, after the DCA TMU position: three monitors on
  the console (VATSMART, APT Dashboard demand vs AAR, APT Dashboard aircraft list) with keyboards,
  and an oak-edged desk running from the console corner diagonally into the room,
  separating the corner, with the red LED clock and flight strip bays on it.
* **VATSMART** (TMU desk, left screen, `Vatsmart/`): vatflow.io's VATSMART for KDCA
  run in the cab (bundled from the site's own modules into `common/vatflow-smart.js`):
  capacity, demand, queue and TMI tiles, arrivals by landing time per gate, the
  recommendations and the gate MIT plan. Live VATSIM feed, VATFLOW programs (hub),
  NWS forecast and the METAR.
* **APT Dashboard** (TMU desk, middle and right screens, `AptDash/`): the demand vs AAR
  chart (15-minute bins against the program AAR) and the aircraft list (metered order,
  gate, status, ETA / STA, delay and recommended wheels-up) from vatflow.io's APT
  Dashboard for DCA, computed in the cab by `common/apt-flow.js` from the VATSIM feed and
  the VATFLOW program rates (`common/vatflow-hub.js`, read-only).
* **Ramp maps**: three screens with the map part of vatflow.io's ramp management page,
  one view each, on the console facing that part of the terminal: E / D (left of the
  ramp list), C / B and A / Hangars (right of the IDST, front window), each turned so its
  top is the view out of that window (cab heading from the sim; north arrow). A canvas port of
  ramp.html's map (`RampMap/`), same live data as the ramp list (`common/ramp-data.js`).
* **Ramp list** computer left of the clock (right-hand end of the front-left window):
  the vatflow.io gates page for KDCA (inbound gate proposals, departures on the ground),
  from `shared/ramp-core.js` bundled into `common/vatflow-ramp.js` plus the KDCA layout.
* **Console equipment** round those two, after the DCA local position: voice switch
  panel (keys light while that position is online on VATSIM), red LED Zulu clock,
  keypad, trackball, keyboard, knob panel, speaker. The ceiling is black, like the real cab.
* **Sound**: no aircraft sounds at all: `common/sound/sound.xml` is empty (no Wwise
  packages), and the installer moves the sample aircraft's sound folders to
  `backup-sound\` in the project (`tools/silence-sounds.ps1`). The Python tool's
  `3-place-KDCA.bat` can still loop a quiet fan sound (`placement/cab_fan.wav`, made by
  `tools/make_fan_sound.py`).

## ARTCC video maps (the maps CRC shows)

The DBRITE and ASDE-X can show the ARTCC's own vNAS video maps instead of the built-in ones.
They live in a separate Community package, `vatflow-towercab-maps` (`maps-package/`), so
updating the cab never touches them:

1. Put the ARTCC file (e.g. `ZTL.json`, the vNAS ARTCC configuration) in its
   `ARTCC files` folder, or let `update-maps.bat` download it from vNAS (type `ZTL`).
2. Double-click `update-maps.bat`: it puts the file where the cab reads it
   (`html_ui/.../VatflowTower/facilities/`) and rebuilds the package's `layout.json`.
3. In the cab, the **MAPS** tab (next to MENU) on the DBRITE lists the TRACON's STARS maps by
   number plus the tower cab maps: tap to turn them on / off. Presets are named after the
   facility's runway configurations (WEST, EAST ...): SAVE, then a preset, stores what is on;
   a preset switches to its maps. The ASDE-X uses the facility's ASDE-X map by default
   (MAPS picks another). Choices are kept per airport.

Only the ARTCC file is installed; the map drawings are downloaded live from vNAS
(`common/vnas.js`) when a screen shows them. ARTCC files are not kept in this repo, and the
tester zips go out without them: each tester adds their own. The installer copies the package into Community
(`maps-package/install-maps-package.ps1`, which finds the folder from the sim's `UserCfg.opt`).

## Sharing it with friends (Community folder)

1. In MSFS open the project, **Clean All**, **Build All**.
2. Double-click `distribution\make-community-zip.bat` in the project. It takes the built
   package from `Packages\`, checks there is no VATSIM CID in it, names it
   `vatflow-towercab` (title "VATFLOW Tower Cab (test)") and writes
   `vatflow-towercab-test.zip` with install instructions to your Desktop.
3. Friends unzip it into their Community folder, pick the aircraft "VATFLOW Tower Cab"
   and start at a parking spot at their airport. No SDK, Python or tools needed.

Don't install the zip on the PC where the project is open in the editor: the sim would
see the cab twice.

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
| `package/SimObjects/Airplanes/vatflow_tower_cab/common/panel/panel.cfg` | Puts the HTML screens onto the screen materials: the screen host (`Screen/S_<id>.html`) on every 1024x768 screen, plus TWR INFO, the clocks and the voice switch. |
| `package/html_ui/Pages/VCockpit/Instruments/VatflowTower/` | The screens. `Screen/` the screen host and its app list, `Setup/` TOWER SETUP, the apps (`Dbrite/`, `Asdex/`, `Idst/`, `Vatsmart/`, `AptDash/`, `Ramp/`, `RampMap/`), `TwrInfo/`, `Clock/`, `Vscs/`; `common/` the shared code: `airport.js` (defaults + per-airport overrides), `site.js` (which airport), `airports/` (bundled airport data), `osm-airport.js`, `towers.js`, `placement.js`, `store.js`, `vatsim-feed.js` ... |
| `placement/` | The older Windows tool (Python + SimConnect): teleport + freeze on the tower, nudge it into place, save. Not needed any more (TOWER SETUP does it in the sim); kept as a backup. |
| `distribution/` | `make-community-zip.bat` / `.ps1`: the Community-folder zip for friends. |
| `tools/make_textures.py` | Generates the interior textures (carpet tiles, black ceiling grid, console laminate, light oak, keypad, keyboard, speaker grille) into `common/texture/`, with the `.png.xml` MSFS compiles them from. |
| `tools/build_vatflow_bundles.mjs` | Bundles VATFLOW code from `shared/` for the screens: the release engine (`common/vatflow-metering.js`, IDST) and the ramp logic (`common/vatflow-ramp.js`) plus `common/ramp-kdca.js` from `data/ramp/KDCA.json`. |
| `tools/make_fan_sound.py` | Writes `placement/cab_fan.wav`, the seamless quiet fan loop. |
| `tools/build_airport_data.py` | Builds `common/airports/<ICAO>.js` (runways, control tower, ASDE-X and DBRITE maps) from OpenStreetMap and OurAirports, for airports bundled with the cab. Add one: `python tools/build_airport_data.py KJFK <ourairports-dir> package/html_ui/Pages/VCockpit/Instruments/VatflowTower/common/airports`, then add it to `tools/build_screens.py` (SCRIPTS) and the TWR INFO / VSCS pages. |
| `tools/build_screens.py` | Writes the screen host pages `Screen/S_<id>.html` / `.js` (which screens exist, their default app, which window they look out of). |
| `tools/export_interior_gltf.py` | Builds the cab with the Blender script (headless) and writes `tower_cab_interior.gltf/.bin` directly: static interior plus each overhead monitor as its own node with a `<NODE>_TRACK` 360-degree track animation, materials already set the way the sim needs them. No Blender export or MSFS material panel needed for the interior. |
| `preview/index.html` | Runs the screens in a normal browser with live data, through the same screen host (`?apt=KATL` picks the airport). |

Tests for the screen logic: `node scripts/test-msfs-tower.mjs` (from the repo root).

## Can CRC (or a browser) go inside the cab?

Not CRC itself. MSFS can only draw its own instruments onto 3D screens: small
HTML/JavaScript pages run by the sim's built-in Coherent GT engine (that is how
every glass cockpit works). It cannot show another Windows program such as CRC,
and it is not a general web browser, so CRC can't be mirrored onto a cab screen
(the vatflow.io pages in the cab are rebuilt as instruments from the site's own code).

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

## Another airport

Nothing to do: spawn the cab at a parking spot there. The cab finds the airport, the
screens set themselves up, and TOWER SETUP places it on the airport's OpenStreetMap
control tower (or the airport centre if none is mapped): nudge it onto the sim's tower
and SAVE. To ship a tuned spot to everyone, add the numbers TOWER SETUP shows to
`common/towers.js`. A tower that is much bigger or smaller than DCA's would need a
resized cab (the parameters at the top of `build_tower_cab.py`).
