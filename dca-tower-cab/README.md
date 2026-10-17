# DCA Tower Cab for MSFS 2024

A spawnable "aircraft" that is the Reagan National (KDCA) tower cab: the VATFLOW Tower Cab's
structure (the same octagonal cab, leaning glass, mullions, catwalk, roof, ceiling, monitor track
and shades) with the DCA cab's own layout inside, after its equipment-view floor plan
([`docs/floor-plan.html`](docs/floor-plan.html)). Load it in MSFS 2024 like a plane, put it up on
the tower from the **TOWER SETUP** screen, and work VATSIM traffic from the GC position.

It is its own project, separate from the VATFLOW Tower Cab (`msfs-tower/`, on the
`claude/awesome-meitner-uhbs43` branch): its own folder, its own MSFS project and Community
package, its own SimObject (`vatflow_dca_tower_cab`) and its own copy of the screens
(`VatflowDcaTower`). Both cabs can be installed at once and updating one never touches the other.

| Floor plan (top down) | From GC | Into the cab |
| --- | --- | --- |
| ![plan](docs/plan-render.png) | ![gc](docs/gc-view.png) | ![cab](docs/into-cab.png) |

![exterior](docs/exterior.png)

## What's in the cab

* **The VATFLOW cab's structure**: 8 sides, 9.2 m across, glass leaning out 15 degrees above a
  95 cm sill, the same exterior, built by the same code (`blender/build_dca_tower_cab.py` carries
  a copy of it).
* **The DCA layout fitted to it** (window faces, front then round to the left: 0 front, 1
  front-left, 2 left, 3 back-left, 4 back, 5 back-right, 6 right, 7 front-right):
  * **GC (#3) front and centre** on the front window, the SimObject's nose, with dark dividers
    either side. FWD on TOWER SETUP moves towards GC's view; the eye point stands at GC.
  * Right: ALCN (#2) on the front-right window, LCN (#1) at the front of the right window with the
    stand-alone turret in front of it, the right wall console at its back end.
  * Left: ALCS (#4) on the front-left window, LCS (#5) at the front of the left window, TMTW (#11)
    on the back-left window.
  * Left island off the left wall console: the HC (#6) / FD (#10) block with its writing strip along
    the front, the CD (#9) desk behind it.
  * Right island: the NCH (#7) turret, the table and the ASTW (#8) desk, joined to the right wall
    console.
  * Stair / kitchen core on the back-right window: the stairwell along the glass, in from the
    landing by the right wall console and down towards the back; sink and refrigerator in front of
    it facing the room; guard walls. The back window is open floor.
  * Every console has the VATFLOW cab's finish: blue laminate worktop, light grey writing strip
    along the controller's edge, dark bumper, blue vent panels, dark kick plinth.
* **Overhead monitors, track and movement**, exactly as in the VATFLOW cab: Tower Radar (DBRITE)
  starts front right over the local north positions, Ground Radar (ASDE-X) front left over local
  south. Drag the screen post left / right to move it round the circular ceiling track (all the
  way round the cab), the handle bar up / down for height, a side knob to swivel it. Each runs the
  screen host: its MENU tab picks the app (DBRITE, ASDE-X, IDST, VATSMART, RAMP, RVR, STRIP
  BAYS, TOWER SETUP ...).
* **Window shades** in all 8 windows: dark navy tinted film you can see through. Drag the shade
  to set its height, click its roller to raise or lower it fully.
* Black ceiling with downlights and a dark soffit band; ceiling lights and a task light over each
  position (`systems.cfg`, on at night with AUTO CAB LIGHTS).

Not built (yet): the desk equipment (voice switch, TWR INFO, IDST screens on the consoles, strip
bays). The two overhead monitors give every app through their MENU.

## Folder

| Path | What it is |
| --- | --- |
| `blender/build_dca_tower_cab.py` | Builds the cab in Blender: the VATFLOW cab's structure (`P`, the same numbers) and the DCA layout (`CONSOLE_FACES`, `PERIMETER_POSITIONS`, `ISLANDS` in cab metres, the stair core on face 5). |
| `tools/export_dca_cab.py` | Runs the build headless and writes all model files into the package: `dca_tower_cab.gltf/.bin` (outside), `dca_tower_cab_interior.gltf/.bin` (inside, with the monitor animations), both `.xml` (LODs and model behaviours) and the lights in `systems.cfg`. No Blender export or MSFS material panel needed. |
| `tools/sync_screens.py` | Copies the screens from `msfs-tower/` into `package/html_ui/.../VatflowDcaTower` (paths moved to that folder; the ARTCC video maps stay shared with the `vatflow-towercab-maps` package). |
| `tools/test_dca_cab.mjs` | Checks the package: panel screens vs materials, pages and their files, monitor and shade behaviours, the positions. |
| `distribution/setup-project.bat` / `.ps1` | Turns a copy of the SDK's SimpleAircraft sample into the DCA Tower Cab project. |
| `package/` | What goes into the MSFS project: `SimObjects/Airplanes/vatflow_dca_tower_cab/common/` (model, panel, config, sound, texture) and `html_ui/`. The built model files are committed, so Blender is only needed to change the cab. |
| `docs/` | The floor plan and the renders above. |

## Build it in MSFS (its own project)

1. Copy `C:\MSFS 2024 SDK\Samples\DevmodeProjects\SimObjects\Aircraft\SimpleAircraft` to a new
   folder, e.g. `C:\MSFS-Projects\DcaTowerCab\` (not the VATFLOW Tower Cab's project).
2. Open it in MSFS once and **Build All** to check the sample builds, then close the project.
   While it is open, rename the package to `vatflow-dca-towercab` in the Project Editor so its
   Community folder doesn't clash with other sample-based packages.
3. Double-click `distribution\setup-project.bat` and give it the project folder. It renames the
   aircraft folder to `vatflow_dca_tower_cab` (and its asset group), puts in the model, panel,
   textures, sound and systems.cfg (the sample's model and sounds go to `backup-sample\`), copies
   the screens and adds the `html_ui` Copy asset group, names the aircraft **DCA Tower Cab** and
   sets the eye point on GC (10.17 ft forward of the cab origin, 5.41 ft up, minus the sample's
   datum: `eyepoint = 6.57, 0.00, 5.41` for SimpleAircraft).
4. Open the project in MSFS, **Clean All**, **Build All**.
5. Free flight at KDCA, aircraft **DCA Tower Cab**, any parking spot. On a monitor's MENU pick
   TOWER SETUP: PLACE IN TOWER puts it on the tower (AUTO PLACE ON SPAWN does it by itself a few
   seconds after the flight starts); nudge it with the move buttons and SAVE THIS SPOT. Same sim settings as the VATFLOW cab: crash damage
   off, vPilot as an observer.

Run `setup-project.bat` again after pulling a new version, then Build All.

## Change the cab

Edit `blender/build_dca_tower_cab.py` (`ISLANDS`, `CONSOLE_FACES`, the stair core; `P` for the cab itself), then

```
python dca-tower-cab/tools/export_dca_cab.py        # with the bpy module (pip install bpy), or
blender --background --python dca-tower-cab/tools/export_dca_cab.py
node dca-tower-cab/tools/test_dca_cab.mjs
```

and run `setup-project.bat` again. New screens from `msfs-tower/`:
`python dca-tower-cab/tools/sync_screens.py <msfs-tower>/package/html_ui/Pages/VCockpit/Instruments/VatflowTower`.

## Fitting the floor plan to the octagon

The sheet is an equipment view redrawn from a scan, with a 13-sided outline; the cab keeps the
VATFLOW cab's 8 sides and puts each position on the window it faces on the plan. The islands are
the plan's, in cab metres (the plan's 34 ft depth squeezed to the octagon's 29 ft, its width kept).
Where the plan leaves room for doubt (all easy to change at the top of the build script):

* **Height**: every counter is 92 cm, as in the VATFLOW cab; the plan has no heights.
* **The black bars either side of GC** are dark dividers 30 cm above the worktops.
* **The stair core**: the plan's kitchen fills the space between the stairs and the room, so the
  sink and refrigerator face the room with their backs to the stairwell's guard wall. The stairs
  go down from the end by the right wall console, as on the plan.
* **The back window** has no console: on the plan that side is the stair core and TMTW's end.

Both cabs read the same per-user sim storage, so a tower spot saved in one (per airport) and each
screen's chosen app may show up in the other.
