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
* **ASDE-X** (hanging from the ceiling, front left): the DCA surface in ASDE-X
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
  the console (vZDC IDS, arrivals by ETA, ground departures with P-time) with keyboards,
  and an oak-edged desk running from the console corner diagonally into the room,
  separating the corner, with the red LED clock and flight strip bays on it.
* **vZDC IDS** (TMU desk, third screen): the IDS needs a VATSIM SSO login and a modern
  browser, so `placement/web_mirror.py` (`4-ids-screen.bat`) opens it in Edge on the PC
  (log in once; the login is kept) and serves a picture of it to the screen
  (`Mirror/`, from `http://127.0.0.1:8777`); clicks and scrolling on the screen go back
  to the page. The page is laid out 1600 px wide (the IDS refuses smaller windows) and
  scaled to the screen.
* **Ramp list** computer left of the clock (right-hand end of the front-left window):
  the vatflow.io gates page for KDCA (inbound gate proposals, departures on the ground),
  from `shared/ramp-core.js` bundled into `common/vatflow-ramp.js` plus the KDCA layout.
* **Console equipment** round those two, after the DCA local position: voice switch
  panel (keys light while that position is online on VATSIM), red LED Zulu clock,
  keypad, trackball, keyboard, knob panel, speaker. The ceiling is black, like the real cab.
* **Sound**: no aircraft sounds at all: `common/sound/sound.xml` is empty (no Wwise
  packages), and the installer moves the sample aircraft's sound folders to
  `backup-sound\` in the project (`tools/silence-sounds.ps1`). `3-place-KDCA.bat` also turns
  the engine off and loops a quiet fan sound (`placement/cab_fan.wav`, made by
  `tools/make_fan_sound.py`).

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
| `package/SimObjects/Airplanes/vatflow_tower_cab/common/panel/panel.cfg` | Puts the six HTML screens (DBRITE, TWR INFO, ASDE-X, IDST, clock, voice switch) onto the screen materials. |
| `package/html_ui/Pages/VCockpit/Instruments/VatflowTower/` | The screens: `Dbrite/`, `TwrInfo/`, shared `common/airport.js` (all the KDCA specifics) and `common/vatsim-feed.js`. |
| `placement/` | Windows tool: teleport + freeze on the tower, nudge it into place, save. Double-click `1-setup.bat`, `2-adjust-KDCA.bat`, then `3-place-KDCA.bat` every session (see `placement/README.txt`). |
| `tools/make_textures.py` | Generates the interior textures (carpet tiles, black ceiling grid, console laminate, light oak, keypad, keyboard, speaker grille) into `common/texture/`, with the `.png.xml` MSFS compiles them from. |
| `tools/build_vatflow_bundles.mjs` | Bundles VATFLOW code from `shared/` for the screens: the release engine (`common/vatflow-metering.js`, IDST) and the ramp logic (`common/vatflow-ramp.js`) plus `common/ramp-kdca.js` from `data/ramp/KDCA.json`. |
| `tools/make_fan_sound.py` | Writes `placement/cab_fan.wav`, the seamless quiet fan loop. |
| `tools/build_kdca_maps.py` | Builds `common/maps-kdca.js` (ASDE-X and DBRITE map geometry) from OpenStreetMap and OurAirports. |
| `tools/export_interior_gltf.py` | Builds the cab with the Blender script (headless) and writes `tower_cab_interior.gltf/.bin` directly: static interior plus each overhead monitor as its own node with a `<NODE>_TRACK` 360-degree track animation, materials already set the way the sim needs them. No Blender export or MSFS material panel needed for the interior. |
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
