#!/usr/bin/env python3
"""
Build data/vzdc-sectors.geojson: vZDC's sector split, traced from the
"1-3-1 Washington Center airspace diagram" in the vZDC SOP
(data/zdc-reference/vzdc-airspace-diagram.png, supplied by Matt, Nov 2026).

1. The diagram's white areas are split into regions along the drawn lines.
2. The diagram is fitted to the ZDC high boundary (data/artcc-boundaries-high.geojson)
   with an affine transform of lon*cos(38), lat.
3. Each region gets the altitude bands read from its label (REGIONS below):
   "12 BRV 240A / 20 BKT 230B" = 12 owns FL240 and up, 20 owns 230 and below.
   Bands are hundreds of feet. ZNY/ZTL bands are another facility's.
4. Output: per sector an ALL MultiPolygon (every area it owns at any altitude),
   plus one REGION feature per area with its bands; the map labels each area
   from its bands, like the diagram.

Needs numpy, scipy, opencv-python-headless. Usage: python3 scripts/build-vzdc-sectors.py
To change a split, edit REGIONS (seed = a pixel inside the area on the diagram) and rerun.
"""
import json, os, sys
import cv2, numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from scipy.optimize import least_squares

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
IMG = os.path.join(ROOT, "data/zdc-reference/vzdc-airspace-diagram.png")
OUT = os.path.join(ROOT, "data/vzdc-sectors.geojson")
LAT0 = 38.0

TOP=600
def L(*a): return list(a)
REGIONS = [
 ((318,250),[("05",0,TOP)]),
 ((395,313),[("05",280,TOP),("37",0,270)]),
 ((230,357),[("37",0,TOP)]),
 ((380,377),[("32",0,TOP)]),
 ((265,534),[("32",0,TOP)]),
 ((205,462),[("52",0,TOP)]),
 ((470,385),[("12",240,TOP),("20",0,230)]),
 ((560,371),[("12",0,TOP)]),
 ((685,416),[("54",0,TOP)]),
 ((425,515),[("12",300,TOP),("20",0,290)]),
 ((538,518),[("09",240,TOP),("20",0,230)]),
 ((380,620),[("36",240,TOP),("20",0,230)]),
 ((292,600),[("36",240,TOP),("32",0,230)]),
 ((313,727),[("36",240,TOP),("09",0,230)]),
 ((560,752),[("09",0,TOP)]),
 ((510,252),[("05",240,TOP),("17",0,230)]),
 ((563,277),[("12",240,TOP),("17",0,230)]),
 ((697,158),[("19",0,TOP)]),
 ((605,220),[("19",200,TOP),("17",0,190)]),
 ((612,244),[("19",240,TOP),("17",0,230)]),
 ((685,203),[("19",170,TOP),("51",0,160)]),
 ((671,229),[("19",180,TOP),("51",0,170)]),
 ((708,240),[("58",180,TOP),("51",0,170)]),
 ((777,160),[("58",250,TOP),("ZNY",0,240)]),
 ((853,186),[("59",240,TOP),("ZNY",0,230)]),
 ((790,260),[("59",180,TOP),("51",0,170)]),
 ((632,292),[("12",240,TOP),("17",180,230),("51",0,170)]),
 ((629,315),[("12",180,TOP),("51",0,170)]),
 # small PHL-area pieces (labels from Matt's zoomed diagram, Nov 2026)
 ((637,237),[("19",240,TOP),("17",150,230),("51",0,140)]),
 ((646,253),[("19",240,TOP),("17",180,230),("51",0,170)]),
 ((608,314),[("12",180,TOP),("51",0,170)]),
 ((729,183),[("58",250,TOP),("ZNY",180,240),("51",0,170)]),
 # ZNY-owned tops north of PHL, 19 below
 ((732,111),[("ZNY",140,TOP),("19",80,130)]),
 ((777,116),[("ZNY",120,TOP),("19",100,110)]),
 ((716,124),[("ZNY",180,TOP),("19",0,170)]),
 ((758,131),[("ZNY",180,TOP),("19",0,170)]),
 # ZTL shelves on the SW edge
 ((225,683),[("36",280,TOP),("ZTL",240,270),("09",0,230)]),  # "RDU shelf"
 ((175,735),[("36",240,TOP),("ZTL",0,230)]),
]


# 1. regions
im = cv2.imread(IMG, cv2.IMREAD_UNCHANGED)
g = cv2.cvtColor(im[..., :3], cv2.COLOR_BGR2GRAY)
if im.shape[2] == 4:
    a = im[..., 3] / 255.0
    g = (g * a + 255 * (1 - a)).astype(np.uint8)
white = (g >= 160).astype(np.uint8)
white[:30, :] = 0  # title
n, lab, _, _ = cv2.connectedComponentsWithStats(white, connectivity=4)
H, W = lab.shape
areas = np.bincount(lab.ravel(), minlength=n)
border = set(np.unique(np.concatenate([lab[31, :], lab[-1, :], lab[:, 0], lab[:, -1]])).tolist())

# 2. fit the diagram's ZDC outline to the ZDC high boundary
inside = np.zeros_like(lab, np.uint8)
for i in range(1, n):
    if areas[i] > 40 and i not in border:
        inside[lab == i] = 1
inside = cv2.morphologyEx(inside, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
cs, _ = cv2.findContours(inside, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
cont = max(cs, key=cv2.contourArea)[:, 0, :].astype(float)
bd = json.load(open(os.path.join(ROOT, "data/artcc-boundaries-high.geojson")))
ring = np.array([f for f in bd["features"] if f["properties"]["id"] == "ZDC"][0]["geometry"]["coordinates"][0])
pts = []
for a, b in zip(ring[:-1], ring[1:]):
    k = max(1, int(np.hypot(*(b - a)) / 0.02))
    pts += [a + (b - a) * t / k for t in range(k)]
P = np.array(pts)
Q = np.c_[P[:, 0] * np.cos(np.radians(LAT0)), P[:, 1]]
tree = cKDTree(cont)
s0 = (cont[:, 0].max() - cont[:, 0].min()) / (Q[:, 0].max() - Q[:, 0].min())
init = [s0, 0, cont[:, 0].min() - s0 * Q[:, 0].min(), 0, -s0, cont[:, 1].min() + s0 * Q[:, 1].max()]
def tf(p):
    return np.c_[p[0] * Q[:, 0] + p[1] * Q[:, 1] + p[2], p[3] * Q[:, 0] + p[4] * Q[:, 1] + p[5]]
def res(p):
    X = tf(p)
    return np.r_[np.minimum(tree.query(X)[0], 40), np.minimum(cKDTree(X).query(cont)[0], 40)]
p = least_squares(res, init, loss="soft_l1", f_scale=3).x
print("fit: median outline error %.1f px" % np.median(tree.query(tf(p))[0]))
A = np.array([[p[0], p[1]], [p[3], p[4]]]); t = np.array([p[2], p[5]]); Ai = np.linalg.inv(A)

# 3. assign regions
seen = {}
for (x, y), layers in REGIONS:
    best = None
    for r in range(0, 15):
        v = lab[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1]
        ok = (v > 1) & (areas[v] > 15)
        if ok.any():
            vals, cnt = np.unique(v[ok], return_counts=True)
            best = int(vals[cnt.argmax()]); break
    if best is None:
        sys.exit(f"no region at {x},{y}")
    seen[best] = ((x, y), layers)
assigned = np.zeros_like(lab)
for i in seen:
    assigned[lab == i] = i
zone = cv2.morphologyEx((assigned > 0).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
zone = cv2.dilate(zone, np.ones((3, 3), np.uint8))
_, idx = ndimage.distance_transform_edt(assigned == 0, return_indices=True)
full = assigned[idx[0], idx[1]] * zone  # line pixels go to the nearest region

# 4. emit
c38 = np.cos(np.radians(LAT0))
def ll(px):
    q = (px - t) @ Ai.T
    return [[round(float(x / c38), 4), round(float(y), 4)] for x, y in q]
def polys(mask):
    cs, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in cs:
        c = cv2.approxPolyDP(c, 0.9, True)[:, 0, :].astype(float)
        if len(c) >= 3:
            out.append([ll(np.vstack([c, c[:1]]))])
    return out
views = {"ALL": lambda ly: ly}
feats = []
secs = sorted({s for _, ly in seen.values() for s, _, _ in ly if s.isdigit()})
for vname, pick in views.items():
    for s in secs:
        ids = [i for i, (_, ly) in seen.items() if any(l[0] == s for l in pick(ly))]
        if ids:
            feats.append({"type": "Feature", "properties": {"artcc": "ZDC", "sector": s, "stratum": vname, "source": "vZDC SOP 1-3-1 airspace diagram"},
                          "geometry": {"type": "MultiPolygon", "coordinates": polys(np.isin(full, ids))}})
for i, (_, ly) in seen.items():
    feats.append({"type": "Feature", "properties": {"artcc": "ZDC", "stratum": "REGION", "bands": [{"sector": s, "floor": f, "ceiling": c} for s, f, c in ly]},
                  "geometry": {"type": "MultiPolygon", "coordinates": polys(full == i)}})
json.dump({"type": "FeatureCollection", "features": feats}, open(OUT, "w"), separators=(",", ":"))
print(f"wrote {OUT}: {len(feats)} features")
