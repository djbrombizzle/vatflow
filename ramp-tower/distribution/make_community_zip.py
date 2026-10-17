"""
Builds a ready-to-test MSFS Community package of the Ramp Control Tower, with no SDK sample
and no MSFS project build needed:

  vatflow-ramp-tower/
    manifest.json, layout.json
    SimObjects/Airplanes/vatflow_ramp_tower/
      aircraft.cfg, cameras.cfg, engines.cfg, flight_model.cfg, systems.cfg   (distribution/aircraft/)
      model/   the built glTF models (package/.../common/model/)
      panel/   panel.cfg with the ten VATFLOW screens
    html_ui/   the VATFLOW screen pages, copied from msfs-tower/package/html_ui

and zips it (with an install note) to <out_dir>/vatflow-ramp-tower-test.zip.

  python distribution/make_community_zip.py <out_dir>

The model has no textures, so nothing needs the sim's package builder: the glTF files go in
as they are, like a built package carries them.
"""

import json
import os
import re
import shutil
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOWER = os.path.join(HERE, "..")
REPO = os.path.join(TOWER, "..")
NAME = "vatflow-ramp-tower"
AIRCRAFT = "vatflow_ramp_tower"
TITLE = "VATFLOW Ramp Control Tower (test)"
COMMON = os.path.join(TOWER, "package", "SimObjects", "Airplanes", "ramp_tower", "common")
HTML_UI = os.path.join(REPO, "msfs-tower", "package", "html_ui")

README = """VATFLOW Ramp Control Tower (test build)
=======================================

Install
  1. Close MSFS 2024.
  2. Unzip. Move the folder "{name}" into your MSFS 2024 Community folder (the same place
     as the VATFLOW Tower Cab). Check: it must be Community\\{name}\\manifest.json.
  3. Start MSFS. New Community packages are only read when the sim starts.

Fly
  1. Assistance > crash damage OFF.
  2. Aircraft: "VATFLOW Ramp Control Tower" (VATFLOW, Ramp Control Tower).
  3. Start at KATL at a parking spot next to the ramp you want to watch. The tower stands on
     that spot: the cab is 7.5 m (25 ft) up, about concourse-roof height. It does not jump
     into the main tower by itself (unlike the KDCA cab); to put it on a concourse roof use
     MENU > TOWER SETUP on any screen (nudge, SAVE THIS SPOT), or slew mode.
  4. Cockpit view: you stand behind the two front ramp positions.

The screens
  Left window   Ramp 1: RAMP (ramp list) and ramp map (first KATL ramp view)
  Front left    Ramp 2: ramp map (second KATL ramp view) and ASDE-X ground radar
  Front right   Ramp 3: ramp map (third KATL ramp view) and DBRITE
  Right window  Ramp coordinator: VATSMART and airport demand
  Middle        Supervisor: airport list; clock on the front console
  The screens find the airport from where the tower stands (KATL). The ramp data comes live
  from vatflow.io. MENU tab (bottom right of each screen) switches a screen to any app.

This package carries its own copy of the VATFLOW screen pages (html_ui), the same files as
the VATFLOW Tower Cab test build. If you also have that installed, keep both on the same
version.

Uninstall: delete "{name}" from Community.
"""


def filetime(path):
    """Windows FILETIME (100 ns since 1601) of the file's modification time, as layout.json wants."""
    return int(os.path.getmtime(path) * 10_000_000) + 116444736000000000


def copy_tree(src, dst, skip=None):
    for root, _dirs, files in os.walk(src):
        for f in files:
            s = os.path.join(root, f)
            rel = os.path.relpath(s, src)
            if skip and skip(rel):
                continue
            d = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)


def build(out_dir):
    stage = tempfile.mkdtemp(prefix="ramp-tower-zip-")
    pkg = os.path.join(stage, NAME)
    ac = os.path.join(pkg, "SimObjects", "Airplanes", AIRCRAFT)
    copy_tree(os.path.join(HERE, "aircraft"), ac)
    copy_tree(os.path.join(COMMON, "model"), os.path.join(ac, "model"))
    copy_tree(os.path.join(COMMON, "panel"), os.path.join(ac, "panel"))
    # the screen pages; never the ARTCC video map files (they go in the separate maps package)
    copy_tree(HTML_UI, os.path.join(pkg, "html_ui"), skip=lambda rel: re.search(r"(^|[\\/])facilities[\\/]", rel))

    # never ship anyone's VATSIM CID
    for root, _d, files in os.walk(pkg):
        for f in files:
            if f.endswith(".js") and re.search(r'cid:\s*"\d+', open(os.path.join(root, f), encoding="utf-8", errors="ignore").read()):
                sys.exit("A VATSIM CID is inside %s; clear it first." % os.path.join(root, f))

    content = []
    total = 0
    for root, _d, files in os.walk(pkg):
        for f in sorted(files):
            p = os.path.join(root, f)
            rel = os.path.relpath(p, pkg).replace(os.sep, "/")
            size = os.path.getsize(p)
            total += size
            content.append({"path": rel, "size": size, "date": filetime(p)})
    content.sort(key=lambda e: e["path"])
    with open(os.path.join(pkg, "layout.json"), "w", encoding="utf-8") as fh:
        json.dump({"content": content}, fh, indent=2)
    manifest = {
        "dependencies": [],
        "content_type": "AIRCRAFT",
        "title": TITLE,
        "manufacturer": "VATFLOW",
        "creator": "VATFLOW",
        "package_version": "0.1.0",
        "minimum_game_version": "1.0.0",
        "release_notes": {"neutral": {"LastUpdate": "", "OlderHistory": ""}},
        "total_package_size": "%020d" % total,
    }
    with open(os.path.join(pkg, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    with open(os.path.join(stage, "READ ME - install.txt"), "w", encoding="utf-8", newline="\r\n") as fh:
        fh.write(README.format(name=NAME))

    os.makedirs(out_dir, exist_ok=True)
    zpath = os.path.join(out_dir, NAME + "-test.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _d, files in os.walk(stage):
            for f in sorted(files):
                p = os.path.join(root, f)
                z.write(p, os.path.relpath(p, stage))
    shutil.rmtree(stage)
    print("Wrote %s (%d files in the package, %.1f MB)" % (zpath, len(content), os.path.getsize(zpath) / 1e6))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    build(sys.argv[1])
