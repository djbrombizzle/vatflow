"""
Copies the cab screens (html_ui instruments) from the VATFLOW Tower Cab project into this
package as VatflowDcaTower, so the DCA Tower Cab is its own Community package and never
shares files with the VATFLOW Tower Cab (both can be installed; updating one doesn't change
the other). Run it to bring in a newer version of the screens:

  python tools/sync_screens.py [<VatflowTower instruments folder>]

Default source: ../msfs-tower/package/html_ui/Pages/VCockpit/Instruments/VatflowTower (the
msfs-tower/ project next to this one; it lives on its own branch). Paths inside the pages are
moved to .../Instruments/VatflowDcaTower/, except the ARTCC video maps
(VatflowTower/facilities/), which stay shared with the vatflow-towercab-maps package.
"""

import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
INSTR = os.path.join("html_ui", "Pages", "VCockpit", "Instruments")
DEFAULT_SRC = os.path.join(HERE, "..", "..", "msfs-tower", "package", INSTR, "VatflowTower")
DEST = os.path.join(HERE, "..", "package", INSTR, "VatflowDcaTower")
TEXT = (".html", ".js", ".css", ".json", ".txt")
OLD, NEW, KEEP = "Instruments/VatflowTower/", "Instruments/VatflowDcaTower/", "Instruments/VatflowTower/facilities/"


def rewrite(text):
    return text.replace(KEEP, "\0").replace(OLD, NEW).replace("\0", KEEP)


def main(src):
    src = os.path.abspath(src)
    if not os.path.isdir(os.path.join(src, "Screen")):
        sys.exit("not the VatflowTower instruments folder: " + src)
    if os.path.isdir(DEST):
        shutil.rmtree(DEST)
    n = 0
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d != "facilities"]       # ARTCC files: the maps package's
        rel = os.path.relpath(root, src)
        os.makedirs(os.path.join(DEST, rel), exist_ok=True)
        for name in files:
            a, b = os.path.join(root, name), os.path.join(DEST, rel, name)
            if name.endswith(TEXT):
                with open(a, encoding="utf-8", newline="") as f:
                    text = f.read()
                with open(b, "w", encoding="utf-8", newline="") as f:
                    f.write(rewrite(text))
            else:
                shutil.copyfile(a, b)
            n += 1
    print("copied %d files to %s" % (n, os.path.normpath(DEST)))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC)
