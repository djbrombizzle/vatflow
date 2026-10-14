"""
Builds common/maps-kdca.js: the map geometry for the in-cab DBRITE and ASDE-X screens.

  python build_kdca_maps.py <osm.json> <ourairports-dir> <out.js>

<osm.json>        OSM API extract around the field, e.g.
                  https://api.openstreetmap.org/api/0.6/map.json?bbox=-77.0520,38.8330,-77.0230,38.8720
<ourairports-dir> folder with airports.csv, runways.csv, navaids.csv from
                  https://davidmegginson.github.io/ourairports-data/

ASDE-X geometry is in meters, DBRITE geometry in nautical miles, both x east / y north
from the airport reference point in airport.js. Map data (c) OpenStreetMap contributors (ODbL)
and OurAirports (public domain).
"""

import csv
import json
import math
import os
import sys

ARP = (38.8521, -77.0377)       # keep in sync with VATFLOW_TWR.arp
DBRITE_RADIUS_NM = 22
M_PER_DEG = 111320.0


def to_m(lat, lon):
    return ((lon - ARP[1]) * M_PER_DEG * math.cos(math.radians(ARP[0])), (lat - ARP[0]) * M_PER_DEG)


def to_nm(lat, lon):
    x, y = to_m(lat, lon)
    return (x / 1852.0, y / 1852.0)


def rdp(pts, eps):
    """Ramer-Douglas-Peucker line simplification."""
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy)
    dmax, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        if norm < 1e-6:  # closed ring: measure from the start point
            d = math.hypot(pts[i][0] - x1, pts[i][1] - y1)
        else:
            d = abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / norm
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return rdp(pts[: idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def flat(pts, nd=1):
    out = []
    for x, y in pts:
        out += [round(x, nd), round(y, nd)]
    return out


def build_asdex(osm_path):
    d = json.load(open(osm_path, encoding="utf-8"))
    nodes = {e["id"]: (e["lat"], e["lon"]) for e in d["elements"] if e["type"] == "node"}
    ways = {e["id"]: e for e in d["elements"] if e["type"] == "way"}
    rels = [e for e in d["elements"] if e["type"] == "relation"]

    def way_m(w):
        return [to_m(*nodes[n]) for n in w["nodes"] if n in nodes]

    out = {"land": [], "aprons": [], "buildings": [], "taxiways": [], "runways": []}
    # field boundary (aerodrome multipolygon outer ring, or a closed aerodrome way)
    for r in rels:
        if r.get("tags", {}).get("aeroway") == "aerodrome":
            for m in r["members"]:
                if m["type"] == "way" and m.get("role") == "outer" and m["ref"] in ways:
                    out["land"].append(flat(rdp(way_m(ways[m["ref"]]), 2.0)))
    for w in ways.values():
        t = w.get("tags", {})
        a = t.get("aeroway")
        if a == "aerodrome":
            out["land"].append(flat(rdp(way_m(w), 2.0)))
        elif a == "apron":
            out["aprons"].append(flat(rdp(way_m(w), 1.0)))
        elif a in ("terminal", "hangar"):
            out["buildings"].append(flat(rdp(way_m(w), 1.0)))
        elif a in ("taxiway", "taxilane"):
            out["taxiways"].append({"w": 23 if a == "taxiway" else 15, "p": flat(rdp(way_m(w), 1.0))})
        elif a in ("runway", "stopway") and len(set(w["nodes"])) > 1:
            width = float(t.get("width", "46").split()[0]) if t.get("width") else 46
            closed = w["nodes"][0] == w["nodes"][-1]
            out["runways"].append({"w": width, "p": flat(rdp(way_m(w), 1.0)), "ref": t.get("ref", ""), "c": 1 if closed else 0})
    return out


def build_dbrite(oa_dir):
    def near(lat, lon):
        x, y = to_nm(lat, lon)
        return math.hypot(x, y) <= DBRITE_RADIUS_NM

    airports, heliports, idents = [], [], {}
    with open(os.path.join(oa_dir, "airports.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["type"] == "closed" or not r["latitude_deg"]:
                continue
            lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
            if not near(lat, lon):
                continue
            x, y = to_nm(lat, lon)
            if r["type"] == "heliport":
                heliports.append([round(x, 3), round(y, 3)])
            elif r["type"] != "seaplane_base":
                idents[r["ident"]] = True
                airports.append({"id": r["ident"], "t": r["type"], "x": round(x, 3), "y": round(y, 3)})
    runways = []
    with open(os.path.join(oa_dir, "runways.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["airport_ident"] not in idents or r["closed"] == "1":
                continue
            if not (r["le_latitude_deg"] and r["he_latitude_deg"]):
                continue
            a = to_nm(float(r["le_latitude_deg"]), float(r["le_longitude_deg"]))
            b = to_nm(float(r["he_latitude_deg"]), float(r["he_longitude_deg"]))
            runways.append([round(a[0], 3), round(a[1], 3), round(b[0], 3), round(b[1], 3)])
    navaids = []
    with open(os.path.join(oa_dir, "navaids.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
            if near(lat, lon) and r["type"] in ("VOR", "VOR-DME", "VORTAC", "NDB", "TACAN"):
                x, y = to_nm(lat, lon)
                navaids.append({"id": r["ident"], "t": r["type"], "x": round(x, 3), "y": round(y, 3)})
    return {"runways": runways, "airports": airports, "heliports": heliports, "navaids": navaids}


def main(argv):
    if len(argv) != 4:
        sys.exit(__doc__)
    data = {"asdex": build_asdex(argv[1]), "dbrite": build_dbrite(argv[2])}
    with open(argv[3], "w", encoding="utf-8", newline="\n") as f:
        f.write("/* Generated by msfs-tower/tools/build_kdca_maps.py - do not edit.\n"
                " * ASDE-X: meters, DBRITE: nm; x east, y north of the ARP.\n"
                " * Map data (c) OpenStreetMap contributors (ODbL), OurAirports (public domain). */\n")
        f.write("var VATFLOW_MAPS = ")
        json.dump(data, f, separators=(",", ":"))
        f.write(";\n")
    a, b = data["asdex"], data["dbrite"]
    print("asdex: land %d aprons %d buildings %d taxiways %d runways %d | dbrite: runways %d airports %d heliports %d navaids %d"
          % (len(a["land"]), len(a["aprons"]), len(a["buildings"]), len(a["taxiways"]), len(a["runways"]),
             len(b["runways"]), len(b["airports"]), len(b["heliports"]), len(b["navaids"])))


if __name__ == "__main__":
    main(sys.argv)
