"""
Builds common/airports/<ICAO>.js: everything the in-cab screens need to know about one
airport, bundled with the cab so they work offline and without waiting for map servers.

  python build_airport_data.py <ICAO> <ourairports-dir> <out-dir> [<osm.json>]

<ourairports-dir> folder with airports.csv, runways.csv, navaids.csv from
                  https://davidmegginson.github.io/ourairports-data/
<osm.json>        OSM API extract around the field; downloaded when left out:
                  https://api.openstreetmap.org/api/0.6/map.json?bbox=<the field + 600 m>

The file sets VATFLOW_AIRPORTS["<ICAO>"] = {
  icao, name, lid, arp {lat, lon}, elevFt,
  runways [{ids: [le, he], a: [lat, lon], b: [lat, lon]}]   thresholds (OurAirports)
  tower {lat, lon, heightM, floorFtMsl, headingTrue, src}   control tower (OpenStreetMap) as a
                                                            first guess for the placement screen
  maps {asdex, dbrite}                                       what DbriteView / AsdexView draw:
       ASDE-X in meters, DBRITE in nm, x east / y north of the ARP
}
Airports that aren't bundled get the same data at runtime from OpenStreetMap
(common/site.js). Map data (c) OpenStreetMap contributors (ODbL), OurAirports (public domain).
"""

import csv
import json
import math
import os
import sys
import urllib.request

DBRITE_RADIUS_NM = 22
M_PER_DEG = 111320.0
FT_PER_M = 3.28084
CAB_BELOW_TOP_M = 6.0      # cab floor this far under the top of the tower (roof, glass)
MARGIN_M = 600


class Frame:
    def __init__(self, lat, lon):
        self.lat, self.lon = lat, lon

    def m(self, lat, lon):
        return ((lon - self.lon) * M_PER_DEG * math.cos(math.radians(self.lat)), (lat - self.lat) * M_PER_DEG)

    def nm(self, lat, lon):
        x, y = self.m(lat, lon)
        return (x / 1852.0, y / 1852.0)

    def latlon(self, x, y):
        return (self.lat + y / M_PER_DEG, self.lon + x / (M_PER_DEG * math.cos(math.radians(self.lat))))


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


def read_csv(oa_dir, name):
    with open(os.path.join(oa_dir, name), encoding="utf-8") as f:
        return list(csv.DictReader(f))


def airport_row(oa_dir, icao):
    for r in read_csv(oa_dir, "airports.csv"):
        if r["ident"] == icao or r.get("icao_code") == icao:
            return r
    sys.exit("%s is not in airports.csv" % icao)


def runway_rows(oa_dir, ident):
    return [r for r in read_csv(oa_dir, "runways.csv")
            if r["airport_ident"] == ident and r["closed"] != "1" and r["le_latitude_deg"] and r["he_latitude_deg"]]


def download_osm(frame, rwys, path):
    xs, ys = [0.0], [0.0]
    for r in rwys:
        for k in ("le", "he"):
            x, y = frame.m(float(r[k + "_latitude_deg"]), float(r[k + "_longitude_deg"]))
            xs.append(x)
            ys.append(y)
    s, w = frame.latlon(min(xs) - MARGIN_M, min(ys) - MARGIN_M)
    n, e = frame.latlon(max(xs) + MARGIN_M, max(ys) + MARGIN_M)
    url = "https://api.openstreetmap.org/api/0.6/map.json?bbox=%.5f,%.5f,%.5f,%.5f" % (w, s, e, n)
    print("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "vatflow-towercab-builder"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(path, "wb") as f:
        f.write(resp.read())


def load_osm(path):
    d = json.load(open(path, encoding="utf-8"))
    nodes = {e["id"]: e for e in d["elements"] if e["type"] == "node"}
    ways = {e["id"]: e for e in d["elements"] if e["type"] == "way"}
    rels = [e for e in d["elements"] if e["type"] == "relation"]
    return nodes, ways, rels


def build_asdex(frame, osm):
    nodes, ways, rels = osm

    def way_m(w):
        return [frame.m(nodes[n]["lat"], nodes[n]["lon"]) for n in w["nodes"] if n in nodes]

    out = {"land": [], "aprons": [], "buildings": [], "taxiways": [], "runways": []}
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
            try:
                width = float(t.get("width", "46").split()[0])
            except ValueError:
                width = 46
            closed = w["nodes"][0] == w["nodes"][-1]
            out["runways"].append({"w": width, "p": flat(rdp(way_m(w), 1.0)), "ref": t.get("ref", ""), "c": 1 if closed else 0})
    # keep only what is near the field (the extract is a rectangle)
    lim = 6000.0
    for k in ("land", "aprons", "buildings"):
        out[k] = [p for p in out[k] if p and abs(p[0]) < lim and abs(p[1]) < lim]
    out["taxiways"] = [t for t in out["taxiways"] if t["p"] and abs(t["p"][0]) < lim and abs(t["p"][1]) < lim]
    return out


def build_dbrite(frame, oa_dir):
    def near(lat, lon):
        x, y = frame.nm(lat, lon)
        return math.hypot(x, y) <= DBRITE_RADIUS_NM

    airports, heliports, idents = [], [], {}
    for r in read_csv(oa_dir, "airports.csv"):
        if r["type"] == "closed" or not r["latitude_deg"]:
            continue
        lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
        if not near(lat, lon):
            continue
        x, y = frame.nm(lat, lon)
        if r["type"] == "heliport":
            heliports.append([round(x, 3), round(y, 3)])
        elif r["type"] != "seaplane_base":
            idents[r["ident"]] = True
            airports.append({"id": r["ident"], "t": r["type"], "x": round(x, 3), "y": round(y, 3)})
    runways = []
    for r in read_csv(oa_dir, "runways.csv"):
        if r["airport_ident"] not in idents or r["closed"] == "1":
            continue
        if not (r["le_latitude_deg"] and r["he_latitude_deg"]):
            continue
        a = frame.nm(float(r["le_latitude_deg"]), float(r["le_longitude_deg"]))
        b = frame.nm(float(r["he_latitude_deg"]), float(r["he_longitude_deg"]))
        runways.append([round(a[0], 3), round(a[1], 3), round(b[0], 3), round(b[1], 3)])
    navaids = []
    for r in read_csv(oa_dir, "navaids.csv"):
        lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
        if near(lat, lon) and r["type"] in ("VOR", "VOR-DME", "VORTAC", "NDB", "TACAN"):
            x, y = frame.nm(lat, lon)
            navaids.append({"id": r["ident"], "t": r["type"], "x": round(x, 3), "y": round(y, 3)})
    return {"runways": runways, "airports": airports, "heliports": heliports, "navaids": navaids}


def is_control_tower(t):
    return (t.get("aeroway") in ("control_tower", "tower") or t.get("building") == "control_tower"
            or (t.get("man_made") == "tower" and t.get("tower:type") in ("airport_control", "control"))
            or t.get("service") == "aircraft_control")


def height_m(t):
    for k in ("height", "est_height"):
        v = t.get(k)
        if v:
            try:
                return float(v.replace("m", "").strip().split()[0])
            except ValueError:
                pass
    lv = t.get("building:levels")
    if lv:
        try:
            return float(lv) * 3.5
        except ValueError:
            pass
    return None


def find_tower(frame, osm, elev_ft):
    """The control tower nearest the ARP (OpenStreetMap); cab floor = top of the tower - CAB_BELOW_TOP_M."""
    nodes, ways, _ = osm
    best = None
    for e in list(nodes.values()) + list(ways.values()):
        t = e.get("tags", {})
        if not is_control_tower(t):
            continue
        if e["type"] == "node":
            lat, lon = e["lat"], e["lon"]
        else:
            pts = [nodes[n] for n in e["nodes"] if n in nodes]
            if not pts:
                continue
            if e["nodes"][0] == e["nodes"][-1] and len(pts) > 1:
                pts = pts[:-1]
            lat = sum(p["lat"] for p in pts) / len(pts)
            lon = sum(p["lon"] for p in pts) / len(pts)
        x, y = frame.m(lat, lon)
        d = math.hypot(x, y)
        if best is None or d < best[0]:
            best = (d, lat, lon, height_m(t), t.get("name", ""))
    if not best:
        return None
    _, lat, lon, h, name = best
    floor = elev_ft + ((h - CAB_BELOW_TOP_M) * FT_PER_M if h else 150.0)
    x, y = frame.m(lat, lon)
    hdg = (math.degrees(math.atan2(-x, -y)) + 360) % 360   # front window looks at the ARP
    return {"lat": round(lat, 7), "lon": round(lon, 7), "heightM": h, "floorFtMsl": round(floor),
            "headingTrue": round(hdg), "src": "OpenStreetMap" + (" (%s)" % name if name else "")}


def main(argv):
    if len(argv) not in (4, 5):
        sys.exit(__doc__)
    icao, oa_dir, out_dir = argv[1].upper(), argv[2], argv[3]
    apt = airport_row(oa_dir, icao)
    frame = Frame(float(apt["latitude_deg"]), float(apt["longitude_deg"]))
    rwys = runway_rows(oa_dir, apt["ident"])
    osm_path = argv[4] if len(argv) == 5 else os.path.join(out_dir, "_osm_%s.json" % icao)
    if not os.path.exists(osm_path):
        download_osm(frame, rwys, osm_path)
    osm = load_osm(osm_path)
    elev = float(apt["elevation_ft"] or 0)
    data = {
        "icao": icao,
        "name": apt["name"].upper(),
        "lid": apt.get("iata_code") or apt.get("local_code") or icao[-3:],
        "arp": {"lat": frame.lat, "lon": frame.lon},
        "elevFt": elev,
        "runways": [{"ids": [r["le_ident"], r["he_ident"]],
                     "a": [round(float(r["le_latitude_deg"]), 5), round(float(r["le_longitude_deg"]), 5)],
                     "b": [round(float(r["he_latitude_deg"]), 5), round(float(r["he_longitude_deg"]), 5)]} for r in rwys],
        "tower": find_tower(frame, osm, elev),
        "maps": {"asdex": build_asdex(frame, osm), "dbrite": build_dbrite(frame, oa_dir)},
    }
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, icao + ".js")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* Generated by msfs-tower/tools/build_airport_data.py - do not edit.\n"
                " * Map data (c) OpenStreetMap contributors (ODbL), OurAirports (public domain). */\n")
        f.write("var VATFLOW_AIRPORTS = typeof VATFLOW_AIRPORTS !== \"undefined\" ? VATFLOW_AIRPORTS : {};\n")
        f.write("VATFLOW_AIRPORTS[%s] = " % json.dumps(icao))
        json.dump(data, f, separators=(",", ":"))
        f.write(";\n")
    a, b = data["maps"]["asdex"], data["maps"]["dbrite"]
    print("%s: %d bytes; tower %s; asdex land %d aprons %d buildings %d taxiways %d runways %d | dbrite runways %d airports %d navaids %d"
          % (out, os.path.getsize(out), data["tower"], len(a["land"]), len(a["aprons"]), len(a["buildings"]),
             len(a["taxiways"]), len(a["runways"]), len(b["runways"]), len(b["airports"]), len(b["navaids"])))


if __name__ == "__main__":
    main(sys.argv)
