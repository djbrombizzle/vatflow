# Step-by-step: from this folder to standing in the KDCA tower in MSFS 2024

No MSFS development experience needed. Allow an evening for the first run.
Menu names in MSFS's Developer Mode move around between sim updates, so if a
label below doesn't match exactly, look for the closest one. The official docs
are at <https://docs.flightsimulator.com/msfs2024/>.

**The approach in one sentence:** we don't build an aircraft from scratch. We
copy the SDK's ready-made **SimpleAircraft** sample, which already builds and
flies, and swap its 3D model for our tower cab, add our two screens, and move
its eye point. Everything that makes it "fly" stays as is, because the
placement tool freezes it in place anyway.

---

## 0. What you need

* MSFS 2024 on a Windows PC.
* **Blender 4.2 LTS** (free, blender.org). The MSFS 2024 exporter supports
  3.3, 3.6, 4.2 and 4.5 LTS; 4.2 is the safe pick.
* **Python 3.11 or newer** for Windows (python.org; tick "Add to PATH").
* **vPilot** (for VATSIM traffic in the sim).
* This folder (`msfs-tower/`) on that PC: download the repo from GitHub, or
  just this folder.

## 1. Turn on Developer Mode

1. In MSFS 2024, open the settings: **General Options → Developers**.
2. Switch **Developer Mode** on. A Developer Mode toolbar appears at the top
   of the screen.

## 2. Install the SDK and the samples

1. In the Developer Mode toolbar, open **Help** and choose the **SDK
   installer** (core). Run it and note the install folder, e.g.
   `C:\MSFS 2024 SDK\`. We'll call it `<SDK>`.
2. From the same menu, also install the **Samples**. They land in
   `<SDK>\Samples\`.
3. Check that a **SimpleAircraft** sample folder exists and contains
   `SimpleAircraftProject.xml`. `<SDK>\Samples\` has three folders
   (`DevmodeProjects`, `ModelBehavior`, `VisualStudio`); the aircraft samples
   are inside **`DevmodeProjects`**, possibly a folder or two deeper. The quick
   way: open `<SDK>\Samples\DevmodeProjects` in File Explorer and type
   `SimpleAircraftProject.xml` in the search box at the top right.

## 3. Install the MSFS exporter in Blender

1. Find the add-on in `<SDK>\Tools\Blender\addons\`. It is called
   `io_scene_gltf2_msfs_2024`.
2. If it is a folder rather than a .zip, right-click → *Send to → Compressed
   (zipped) folder*.
3. Blender → **Edit → Preferences → Add-ons → Install from disk** (the small
   arrow at the top right in 4.2) → pick the zip → tick it to enable it.
4. If you ever installed the MSFS **2020** exporter, disable it. The two
   shouldn't be enabled together.

## 4. Build the cab in Blender (one click)

1. Open Blender, delete the default cube (select it, press X).
2. Go to the **Scripting** tab → **Open** → `msfs-tower/blender/build_tower_cab.py`
   → **Run Script** (the ▶ button).
3. In the Outliner (top right) you now have two collections:
   * `TowerCab_Exterior`: shell, glass, mullions, railings and antennas, and the support stub.
   * `TowerCab_Interior`: floor, ceiling, consoles and the two screens.
   * `EYEPOINT_marker` is only a visual marker for where your head will be. Don't export it.
4. **Want it to look different?** Edit the `P = { ... }` numbers at the top of
   the script (cab width, glass lean, roof depth, stub height…) and run it
   again. It rebuilds from scratch each time.
5. **Save** the .blend file next to the script (e.g. `tower_cab.blend`).

Model facts you'll need later: units are meters, the origin is the **center
of the cab floor**, and the cab's "nose" (the front console) points along
Blender's **-Y** axis.

## 5. Set the MSFS materials

The 2024 exporter ignores Blender's own shader settings and uses only its
**MSFS material panel**. Do this once per material: select an object, open
the **Material Properties** tab (red sphere icon), pick the material in the
list, and scroll to the MSFS 2024 material section.

| Material | MSFS material type | Settings |
| --- | --- | --- |
| `TWR_Concrete` | Standard | Base color off-white (≈ 220, 214, 202) |
| `TWR_Mullion` | Standard | Base color near-black |
| `TWR_Glass` | **Glass** (or Standard with alpha blend) | Light blue-grey, very transparent |
| `TWR_Metal` | Standard | Light grey, metallic ≈ 0.8 |
| `TWR_Console`, `TWR_Bezel` | Standard | Dark grey / black |
| `TWR_Carpet`, `TWR_Ceiling` | Standard | Blue-grey / light grey |
| `SCREEN_DBRITE`, `SCREEN_TWRINFO` | Standard | Base color white. Emissive white (so the screen glows at night). **Do not rename these two:** the names must match `texture=` in `panel.cfg`. |

All materials are already double-sided (backface culling off), so the glass
and walls render from inside and outside.

## 6. Export two glTF files

1. In the Outliner, right-click `TowerCab_Exterior` → **Select Objects**.
2. **File → Export →** the Microsoft Flight Simulator 2024 glTF option added
   by the add-on. Tick **Selected Objects** only.
   Name: `tower_cab.gltf`. If the exporter offers *Generate texturelib* /
   *Keep original*, tick them.
3. Repeat for `TowerCab_Interior` → `tower_cab_interior.gltf`.
4. Each export writes a `.gltf` and a `.bin`. Keep both.

## 7. Make your project from the SimpleAircraft sample

1. **Copy** the whole SimpleAircraft sample folder to a work folder, e.g.
   `C:\MSFS-Projects\VatflowTowerCab\`. Never edit the original sample.
2. In MSFS: Developer Mode toolbar → **File → Open project…** → pick
   `SimpleAircraftProject.xml` **in your copy**.
3. In the Project Editor, click **Build All**. Go to the aircraft selection
   screen and check that the sample plane shows up. This proves your
   toolchain works *before* we change anything. Don't skip it.
4. Look inside your copy's `PackageSources\SimObjects\Airplanes\<aircraft folder>\`.
   You'll see `common\` and `presets\` (MSFS 2024 "modular" layout). That
   `<aircraft folder>` is where the next steps happen.

## 8. Swap in the tower cab

All paths below are inside `PackageSources\SimObjects\Airplanes\<aircraft folder>\`.

1. **Model.** Open `common\model\`. Move everything in it to a backup folder
   **outside** `PackageSources`. Then put in:
   * `model.cfg`, `tower_cab.xml` and `tower_cab_interior.xml` from
     `msfs-tower/package/SimObjects/Airplanes/vatflow_tower_cab/common/model/`
   * your exported `tower_cab.gltf/.bin` and `tower_cab_interior.gltf/.bin`
2. **Panel.** Copy `msfs-tower/package/.../common/panel/panel.cfg` into
   `common\panel\` (create the folder if needed; replace any existing
   panel.cfg). If the sample keeps its panel in `presets\...\panel\` instead,
   put ours there.
3. **Screens (html_ui).** Copy the folder `msfs-tower/package/html_ui` to your
   project's `PackageSources\html_ui`. Then, in the Project Editor, select the
   package → **Add asset group** → type **Copy**, name `html_ui`, source folder
   `PackageSources\html_ui\`, output folder `html_ui\`.
4. **Eye point.** Open the files in `common\config\` with Notepad and search
   for `eyepoint` (normally in `flight_model.cfg`, section `[VIEWS]`). The
   values are **feet**: forward, right, up from the aircraft's reference
   datum. In the same file, search for `reference_datum_position` and set it
   to `0, 0, 0` so the datum is our model origin (the cab floor center).
   Then set:
   ```
   eyepoint = 1.6, 0, 5.4     ; 0.5 m forward of center, standing eye height 1.65 m
   ```
   (Seated instead: `eyepoint = 1.6, 0, 4.0`.) You can fine-tune this later
   in the sim with the camera controls.
5. **Name.** In `presets\...\config\aircraft.cfg`, search for `title` and set
   it to `"VATFLOW Tower Cab KDCA"` so you can find it in the aircraft list.
6. **Build All** again.

Leave engines, contact points and the flight model alone for now. The cab is
frozen in the air by the placement tool, so they never come into play.

## 9. First time in the tower

1. **Sim settings:** under Assistance, turn **crash damage off**. The cab sits on
   (and slightly into) the sim's own tower, and with crash damage on that ends
   your flight. Turn **AI / real-time traffic off** so the only aircraft you
   see are VATSIM ones. Live weather and live time **on**.
2. Start a free flight at **KDCA**, any parking spot, with **VATFLOW Tower
   Cab KDCA** as the aircraft. It will look odd at the gate. That's expected.
3. On the same PC, open a terminal in `msfs-tower/placement/`:
   ```
   pip install -r requirements.txt
   python tower_place.py adjust KDCA
   ```
   The cab jumps to the DCA tower position and freezes. Now nudge it, watching
   from outside (drone or external camera), until it sits nicely on top of
   the sim's tower:
   * `u 3` / `d 3`: up / down 3 ft
   * `f 2` / `b 2` / `l 2` / `r 2`: move forward / back / left / right 2 m
   * `h 121`: face 121° true (towards the runways); `t 10` turns 10°
   * `save` writes it to `towers.json`. Next time, just `python tower_place.py place KDCA`.
4. Switch to the **cockpit view**. You are standing in the cab. Use the
   normal camera zoom as your binoculars.
5. **Save your looks:** point the view at the 01 approach end, the 19 end, the
   ramp, and so on, and save each as a custom camera. MSFS has "save / load
   custom camera" bindings (look under Controls → Camera); bind them to keys
   you like. These are your instant "look at runway 01" buttons.
6. If you'd rather place it by hand: `python tower_place.py release`, use the
   sim's **slew mode** to move the cab, then `python tower_place.py capture KDCA`
   to save wherever it is and freeze it.

## 10. VATSIM traffic outside the glass

* Connect **vPilot as an observer, not as a pilot**. If you connect as a
  pilot, everyone on the network sees an aircraft sitting on top of the
  tower. vPilot's connect window has an observer option; vPilot then
  injects the VATSIM aircraft around you into MSFS as models.
* vPilot also has a **Tower View** mode (`.towerview`), where it gets traffic
  from your local controller client instead of logging into VATSIM itself.
  It works with EuroScope; check the vNAS documentation for whether CRC
  supports it today.
* Work the traffic in CRC on your other monitor as usual. The cab gives you
  the out-the-window view, the DBRITE and the TWR INFO.

## Troubleshooting

| What you see | What to try |
| --- | --- |
| The cab is invisible | File names must match exactly: `model.cfg` → `tower_cab.xml` → `ModelFile="tower_cab.gltf"`. Check the Project Editor's build log for errors. |
| A screen is black or shows the bare material | Its material name in Blender must match `texture=` in `panel.cfg` exactly (`SCREEN_DBRITE`, `SCREEN_TWRINFO`). Developers report MSFS 2024 sometimes wants a `$` prefix (`$SCREEN_DBRITE` in **both** places); try that next. Also check the html_ui asset group (step 8.3) built into the package. |
| Screen says `VATSIM FEED: NETWORK ERROR` | The sim's instrument engine couldn't reach `data.vatsim.net`. Check your firewall/AV. The rest of the cab still works. |
| Screens look fine but are dark at night | Raise the emissive on the two screen materials (step 5). |
| Text is upside-down or mirrored | Shouldn't happen (the UVs were tested upright), but if it does, rotate the screen's UVs 180° in Blender's UV editor and re-export. |
| Cab sinks, drifts or tilts | Run `python tower_place.py place KDCA` again. Some sim actions (e.g. pausing or changing the aircraft) clear the freeze. |
| You're inside the sim's tower walls | `adjust KDCA`, then `u 5` until you're above its roof, then `save`. |
| The sim tower's antennas poke through your floor | Move a few meters with `f` / `b` / `l` / `r`, or raise the stub (`stub_h` in the Blender script) and go up. |

## Things only the sim can confirm

These were built from the SDK docs and community knowledge but could not be
run here. They are the likely spots if something misbehaves:

1. **Screen material naming** (with or without `$`). See troubleshooting.
2. **Where the 2024 SimpleAircraft keeps its eyepoint and panel** (step 8.2
   and 8.4 say how to find them).
3. **Internet access from in-sim instruments.** The screens fetch the VATSIM
   feed and METAR directly. If MSFS blocks that, the screens show
   `NETWORK ERROR`. The plan B then is a tiny local relay on your PC, so tell me if you hit it.
4. **Freeze events** (`FREEZE_LATITUDE_LONGITUDE_SET` etc.) holding the cab
   still in 2024. If it creeps, re-running `place` fixes it, and slew mode is
   the fallback.
