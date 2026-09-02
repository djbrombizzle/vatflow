#!/usr/bin/env python3
"""Build data/vice/vice-reference.js from a vice checkout.

vice validates timetables against its own aircraft and airport databases and
refuses to load a scenario when a row names something it does not know, so
SWIM to vICE checks the same things in the browser before you ever launch the
sim. That means carrying vice's lists with us.

Usage:
    pip install zstandard
    git clone --depth 1 https://github.com/mmp/vice
    python3 scripts/vice/build-vice-reference.py path/to/vice

Sources, both under the vice checkout's resources/:
    openscope-aircraft.json  every aircraft type vice can fly
    airports.csv.zst         the ourairports.com database vice loads airports from
"""

import csv
import io
import json
import os
import sys

try:
    import zstandard
except ImportError:
    sys.exit("pip install zstandard")

# Types that show up in real flight data under a name vice does not use. The
# value must itself be a type vice knows; substitutions whose target is missing
# are dropped rather than written out broken.
SUBSTITUTIONS = {
    "E175": "E75L", "E75S": "E75L", "A19N": "A20N", "B37M": "B38M",
    "GLF3": "GLF4", "CL64": "CL60", "B461": "B462", "TBM": "TBM9",
    "F18": "F18S", "KC35": "K35R", "C5M": "C5", "UH60": "H60",
    "B412": "B407", "A748": "AT72", "B703": "B722", "FA8X": "FA7X",
    "B739ER": "B739", "A320N": "A20N", "A321N": "A21N", "B738M": "B38M",
    "CRJ200": "CRJ2", "CRJ700": "CRJ7", "CRJ900": "CRJ9", "DH8": "DH8D",
    "AT7": "AT72", "B733F": "B733",
}

# Airports are kept for North America and for anywhere with scheduled service:
# enough to cover both ends of any flight a US facility works, without carrying
# all 86,000 rows of the source data into the browser.
KEEP_COUNTRIES = ("US", "CA", "MX", "BS", "PR")


def read_airports(path):
    with open(path, "rb") as f:
        raw = zstandard.ZstdDecompressor().stream_reader(f).read()
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8", errors="replace"))))


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "vice"
    resources = os.path.join(root, "resources")

    with open(os.path.join(resources, "openscope-aircraft.json")) as f:
        types = sorted({a["icao"].upper() for a in json.load(f)["aircraft"]})
    known = set(types)
    subs = {k: v for k, v in SUBSTITUTIONS.items() if v in known and k not in known}

    airports, lid_to_icao = set(), {}
    for row in read_airports(os.path.join(resources, "airports.csv.zst")):
        icao = (row["gps_code"] or row["icao_code"] or "").strip().upper()
        if len(icao) != 4 or row["type"] == "closed":
            continue
        if row["iso_country"] not in KEEP_COUNTRIES and row["scheduled_service"] != "yes":
            continue
        airports.add(icao)

        # Feeds identify US airports by FAA location identifier. Most are the
        # ICAO code without its K, which needs no table; the rest do.
        lid = (row["local_code"] or "").strip().upper()
        if lid and lid != icao and icao != "K" + lid and len(lid) <= 4 and icao[0] in "KPT":
            lid_to_icao[lid] = icao

    data = {
        "aircraftTypes": types,
        "aircraftSubs": subs,
        "airports": sorted(airports),
        "lidToIcao": lid_to_icao,
    }
    out = os.path.join(os.path.dirname(__file__), "..", "..", "data", "vice", "vice-reference.js")
    with open(os.path.normpath(out), "w") as f:
        f.write(
            "// Reference data extracted from the vice ATC simulator (github.com/mmp/vice).\n"
            "// aircraftTypes: every type vice can fly (resources/openscope-aircraft.json).\n"
            "// airports: ICAO codes vice knows, North America plus scheduled service.\n"
            '// lidToIcao: FAA identifiers whose ICAO code is not just "K" + the identifier.\n'
            "// Rebuild with scripts/vice/build-vice-reference.py when vice updates its data.\n"
            "window.VICE_REFERENCE = " + json.dumps(data, separators=(",", ":")) + ";\n"
        )
    print(f"{len(types)} aircraft types, {len(subs)} substitutions, "
          f"{len(airports)} airports, {len(lid_to_icao)} identifier mappings")


if __name__ == "__main__":
    main()
