#!/usr/bin/env python3
"""Build data/pct-sectors.geojson from the PCT SOP airspace overview diagrams.

Sources (data/pct-reference/airspace/):
  chp/shd/mtv/jrv-airspace-overview.png  SOP 3-1-1, 3-4-1, 3-3-1, 3-2-1 (from Matt)
  simaware-pct-boundaries.json           SimAware TRACON outlines (BWI, IAD, DCA, RIC, CHO)

Each diagram is split into its filled shelves (OpenCV connected components between the
coloured boundary lines), each purple altitude box is read by hand (TEXT below, ceiling/floor
as printed), and the whole diagram is georeferenced with an affine fit of its outline to the
matching SimAware outline (lon*cos(lat0), lat). The result is approximate: good enough to see
which shelf an aircraft is in, not a substitute for the SOP.

  python3 -m pip install numpy scipy opencv-python-headless
  python3 scripts/build-pct-sectors.py
"""
import json, os, sys
import cv2
import numpy as np
from scipy import ndimage
from scipy.optimize import least_squares
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data/pct-reference/airspace")
OUT = os.path.join(ROOT, "data/pct-sectors.geojson")
LAT0 = 38.7

AREAS = {
    # area: (fill colour RGB, SimAware outlines it matches)
    "CHP": ((210, 170, 165), ["BWI"]),
    "SHD": ((180, 240, 144), ["IAD"]),
    "MTV": ((178, 186, 230), ["DCA"]),
    "JRV": ((234, 248, 136), ["RIC"]),
}

# Altitude boxes, in the order the script finds them (top to bottom, left to right by scan).
# "a/b" is ceiling/floor as printed; a lone number is printed that way in the diagram.
TEXT = {
    "CHP": ["060/050", "100/SFC", "080", "080/SFC", "060/SFC", "040/SFC", "170/120", "110 - 040/SFC",
            "110/SFC", "140/040", "170/110", "140/SFC", "100/050", "170/SFC", "170/120", "040/SFC",
            "070/SFC", "140/SFC", "130/SFC", "090/080", "100/SFC", "060/040", "100/SFC", "140/080"],
    "SHD": ["120/SFC", "130/SFC", "130/070", "100/090", "110/SFC", "030/SFC", "110/SFC", "100/SFC",
            "110/SFC", "090/SFC", "090/SFC", "050/SFC", "070/SFC", "060/SFC", "060/SFC", "070/SFC",
            "100/050", "120/SFC", "120/050", "120/100"],
    "MTV": ["230/180", "230/100", "230/050", "170/110", "190/080", "170/100", "170/120", "140",
            "190/110", "170/100", "170/080", "170/060", "170/070", "230/060", "230/080", "170/110",
            "190/070 - 030/SFC", "230/SFC", "230/070", "190/SFC", "230/080", "230/110", "120/080",
            "190/100", "120/100"],
    "JRV": ["120/110", "100/SFC", "070/SFC", "040/SFC", "090/SFC", "090/SFC", "120/SFC", "100/SFC",
            "120/110"],
}
# Boxes that sit outside their shelf (arrows, or boxes too small to sit inside): box -> regions.
OVERRIDE = {
    "CHP": {0: [21, 22], 1: [33], 7: [40], 21: [69]},
    "SHD": {3: [11], 13: [25]},
    "MTV": {1: [93, 97], 16: [101, 121]},
    "JRV": {},
}
MIN_UNLABELED = 300  # px; smaller unlabelled bits are slivers or arrow artefacts


def masks(img, fill_rgb):
    im = img[..., ::-1].astype(int)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    mx, mn = im.max(2), im.min(2)
    f = np.array(fill_rgb)
    dfill = np.abs(im - f).sum(2)
    purple = (r > g + 8) & (b > g + 40) & (mx < 200)
    line = ((mx - mn) > (max(f) - min(f)) + 14) & ~purple & (dfill > 30)
    return line, dfill <= 45, purple


def segment(img, fill_rgb):
    line, fill, purple = masks(img, fill_rgb)
    area = ndimage.binary_fill_holes(cv2.morphologyEx(fill.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)) > 0)
    area &= ~cv2.dilate(line.astype(np.uint8), np.ones((4, 4), np.uint8)).astype(bool)
    lab, k = ndimage.label(area)
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, k + 1))
    keep = [i + 1 for i, s in enumerate(sizes) if s > 60]
    pl, _ = ndimage.label(cv2.dilate(purple.astype(np.uint8), np.ones((3, 3), np.uint8)))
    boxes = []
    for ys, xs in ndimage.find_objects(pl):
        if ys.stop - ys.start >= 10 and xs.stop - xs.start >= 10:
            boxes.append((xs.start, ys.start, xs.stop, ys.stop))
    return lab, keep, boxes


def fit(cont, rings):
    pts = []
    for ring in rings:
        ring = np.array(ring)
        for a, b in zip(ring[:-1], ring[1:]):
            k = max(1, int(np.hypot(*(b - a)) / 0.005))
            pts += [a + (b - a) * t / k for t in range(k)]
    P = np.array(pts)
    c0 = np.cos(np.radians(LAT0))
    Q = np.c_[P[:, 0] * c0, P[:, 1]]
    tree = cKDTree(cont)
    s0 = (cont[:, 0].max() - cont[:, 0].min()) / (Q[:, 0].max() - Q[:, 0].min())
    init = [s0, 0, cont[:, 0].min() - s0 * Q[:, 0].min(), 0, -s0, cont[:, 1].min() + s0 * Q[:, 1].max()]
    def tf(p):
        return np.c_[p[0] * Q[:, 0] + p[1] * Q[:, 1] + p[2], p[3] * Q[:, 0] + p[4] * Q[:, 1] + p[5]]
    def res(p):
        X = tf(p)
        return np.r_[np.minimum(tree.query(X)[0], 60), np.minimum(cKDTree(X).query(cont)[0], 60)]
    p = least_squares(res, init, loss="soft_l1", f_scale=3).x
    err = np.median(tree.query(tf(p))[0])
    A = np.array([[p[0], p[1]], [p[3], p[4]]]); t = np.array([p[2], p[5]])
    return np.linalg.inv(A), t, err, tf(p)


def main():
    bounds = json.load(open(os.path.join(SRC, "simaware-pct-boundaries.json")))["areas"]
    feats = []
    c0 = np.cos(np.radians(LAT0))
    for area, (fill_rgb, outlines) in AREAS.items():
        img = cv2.imread(os.path.join(SRC, area.lower() + "-airspace-overview.png"))
        lab, keep, boxes = segment(img, fill_rgb)
        text = TEXT[area]
        if len(text) != len(boxes):
            sys.exit(f"{area}: {len(boxes)} boxes found, {len(text)} texts")
        # box -> regions
        owners = {}
        for j, (x0, y0, x1, y1) in enumerate(boxes):
            regs = OVERRIDE[area].get(j)
            if regs is None:
                r = int(lab[(y0 + y1) // 2, (x0 + x1) // 2])
                if r not in keep:
                    sys.exit(f"{area} box {j} ({text[j]}) is not inside a shelf; add an OVERRIDE")
                regs = [r]
            for r in regs:
                owners.setdefault(r, []).append(j)
        # final label image: shelves with several boxes are split between them (nearest box)
        final = np.zeros_like(lab)
        info = {}
        nid = 1
        for r in keep:
            m = lab == r
            js = owners.get(r, [])
            if not js and m.sum() < MIN_UNLABELED:
                continue
            if len(js) <= 1:
                final[m] = nid; info[nid] = js; nid += 1
                continue
            yy, xx = np.nonzero(m)
            cen = np.array([((boxes[j][0] + boxes[j][2]) / 2, (boxes[j][1] + boxes[j][3]) / 2) for j in js])
            near = cKDTree(cen).query(np.c_[xx, yy])[1]
            for q, j in enumerate(js):
                final[yy[near == q], xx[near == q]] = nid; info[nid] = [j]; nid += 1
        # line pixels between shelves go to the nearest shelf, inside the closed area outline
        zone = cv2.morphologyEx((final > 0).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        zone = ndimage.binary_fill_holes(cv2.dilate(zone, np.ones((3, 3), np.uint8)))
        _, idx = ndimage.distance_transform_edt(final == 0, return_indices=True)
        full = final[idx[0], idx[1]] * zone
        cs, _ = cv2.findContours(zone.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cont = max(cs, key=cv2.contourArea)[:, 0, :].astype(float)
        rings = [poly[0] for name in outlines for poly in bounds[name]]
        Ai, t, err, _ = fit(cont, rings)
        print(f"{area}: {len(info)} shelves, {len(boxes)} boxes, outline fit median {err:.1f} px")

        def ll(px):
            q = (px - t) @ Ai.T
            return [[round(float(x / c0), 4), round(float(y), 4)] for x, y in q]

        for i, js in info.items():
            cs, _ = cv2.findContours((full == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            polys = []
            for c in cs:
                if cv2.contourArea(c) < 20:
                    continue
                c = cv2.approxPolyDP(c, 1.0, True)[:, 0, :].astype(float)
                if len(c) >= 3:
                    polys.append([ll(np.vstack([c, c[:1]]))])
            if not polys:
                continue
            label = text[js[0]] if js else ""
            feats.append({"type": "Feature",
                          "properties": {"area": area, "label": label,
                                         "lines": [s.strip() for s in label.split("/")] if label else []},
                          "geometry": {"type": "MultiPolygon", "coordinates": polys}})
    json.dump({"type": "FeatureCollection",
               "source": "PCT SOP airspace overviews 3-1-1 CHP, 3-2-1 JRV, 3-3-1 MTV, 3-4-1 SHD; outline fitted to SimAware PCT boundaries",
               "features": feats}, open(OUT, "w"), separators=(",", ":"))
    print(f"wrote {OUT}: {len(feats)} features")


if __name__ == "__main__":
    main()
