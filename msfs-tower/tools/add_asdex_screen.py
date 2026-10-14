"""
Adds the overhead ASDE-X screen (material $SCREEN_ASDEX) to an already exported
tower_cab_interior.gltf/.bin, so the cab doesn't have to be re-exported from Blender.

  python add_asdex_screen.py <path/to/tower_cab_interior.gltf>

Same geometry as the ASDE-X block in blender/build_tower_cab.py: a 0.60 x 0.80 m
portrait screen hanging from the ceiling at the front-left, tilted 28 deg down,
with a bezel and a ceiling rod. Safe to run twice (it does nothing if the screen
is already there). The screen material copies the SDK GaugeAircraft sample:
name with "$" and emissive 2000.
"""

import json
import math
import os
import struct
import sys

# --- cab parameters (keep in sync with build_tower_cab.py) -------------------
SIDES = 8
APOTHEM = 4.6
WALL_T = 0.25
CEILING_Z = 3.94
A_INNER = APOTHEM - WALL_T
SCREEN_W, SCREEN_H = 0.60, 0.80
BEZEL, DEPTH = 0.04, 0.05
TILT_DEG = 28.0
CENTER_OUT = A_INNER - 1.3
CENTER_Z = 2.55
MATERIAL = "$SCREEN_ASDEX"


def v_add(a, b): return [a[i] + b[i] for i in range(3)]
def v_sub(a, b): return [a[i] - b[i] for i in range(3)]
def v_mul(a, s): return [a[i] * s for i in range(3)]
def cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
def norm(a):
    l = math.sqrt(sum(x * x for x in a))
    return [x / l for x in a]


def to_gltf(p):
    """Blender (x, y, z), Z up, nose -Y  ->  glTF (x, z, -y)."""
    return [p[0], p[2], -p[1]]


def build_geometry():
    """Returns (screen_quad, bezel_quads, rod_quads) in Blender space; quads are 4 points CCW from the front."""
    ang = -math.pi / 2 + 2 * math.pi / SIDES * 1      # face 1 = front-left
    out = [math.cos(ang), math.sin(ang), 0.0]
    t = math.radians(TILT_DEG)
    c = v_add(v_mul(out, CENTER_OUT), [0, 0, CENTER_Z])
    n = norm(v_sub(v_mul(out, -math.cos(t)), [0, 0, math.sin(t)]))   # faces the cab center, tilted down
    right = norm(cross([0, 0, 1], n))
    up = norm(cross(n, right))
    hw, hh = SCREEN_W / 2, SCREEN_H / 2

    front = v_add(c, v_mul(n, 0.002))
    screen = [v_add(v_add(front, v_mul(right, sx * hw)), v_mul(up, sy * hh)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]

    bw, bh = hw + BEZEL, hh + BEZEL
    f = [v_add(v_add(c, v_mul(right, sx * bw)), v_mul(up, sy * bh)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    k = [v_sub(p, v_mul(n, DEPTH)) for p in f]
    bezel = [[f[i], f[(i + 1) % 4], k[(i + 1) % 4], k[i]] for i in range(4)] + [list(reversed(k))]

    top = v_add(c, v_mul(up, bh))
    r = 0.03
    ring0, ring1 = [], []
    for s in range(4):
        a = 2 * math.pi * s / 4 + math.pi / 4
        off = [r * math.cos(a), r * math.sin(a), 0]
        ring0.append(v_add(top, off))
        ring1.append(v_add([top[0], top[1], CEILING_Z], off))
    rod = [[ring0[i], ring0[(i + 1) % 4], ring1[(i + 1) % 4], ring1[i]] for i in range(4)]
    return screen, bezel, rod


def quads_to_arrays(quads, uv_for_first=None):
    pos, nrm, uv, idx = [], [], [], []
    for q in quads:
        g = [to_gltf(p) for p in q]
        nn = norm(cross(v_sub(g[1], g[0]), v_sub(g[2], g[0])))
        base = len(pos)
        pos += g
        nrm += [nn] * 4
        uv += [[0, 1], [1, 1], [1, 0], [0, 0]]   # glTF V is flipped vs Blender
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return pos, nrm, uv, idx


def main(argv):
    if len(argv) != 2:
        sys.exit(__doc__)
    gpath = argv[1]
    g = json.load(open(gpath, encoding="utf-8"))
    if any(m.get("name") == MATERIAL for m in g["materials"]):
        print("%s already has %s - nothing to do" % (os.path.basename(gpath), MATERIAL))
        return
    buf = g["buffers"][0]
    bpath = os.path.join(os.path.dirname(gpath), buf["uri"])
    blob = bytearray(open(bpath, "rb").read())
    assert len(blob) == buf["byteLength"], "bin size doesn't match the gltf"

    bezel_mat = next(i for i, m in enumerate(g["materials"]) if m.get("name") == "TWR_Bezel")
    g["materials"].append({"emissiveFactor": [2000.0, 2000.0, 2000.0], "name": MATERIAL})
    screen_mat = len(g["materials"]) - 1

    def add_view(data, target):
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        blob.extend(data)
        g["bufferViews"].append({"buffer": 0, "byteLength": len(data), "byteOffset": off, "target": target})
        return len(g["bufferViews"]) - 1

    def add_accessor(values, ctype, typ, target, minmax=False):
        flat = [x for v in values for x in (v if isinstance(v, list) else [v])]
        fmt = {5126: "f", 5123: "H"}[ctype]
        view = add_view(struct.pack("<%d%s" % (len(flat), fmt), *flat), target)
        acc = {"bufferView": view, "componentType": ctype, "count": len(values), "type": typ}
        if minmax:
            acc["min"] = [min(v[i] for v in values) for i in range(3)]
            acc["max"] = [max(v[i] for v in values) for i in range(3)]
        g["accessors"].append(acc)
        return len(g["accessors"]) - 1

    def add_primitive(quads, material, uv1=False):
        pos, nrm, uv, idx = quads_to_arrays(quads)
        a_pos = add_accessor(pos, 5126, "VEC3", 34962, minmax=True)
        a_nrm = add_accessor(nrm, 5126, "VEC3", 34962)
        a_uv = add_accessor(uv, 5126, "VEC2", 34962)
        a_idx = add_accessor(idx, 5123, "SCALAR", 34963)
        attrs = {"POSITION": a_pos, "NORMAL": a_nrm, "TEXCOORD_0": a_uv}
        if uv1:
            attrs["TEXCOORD_1"] = a_uv
        g["meshes"][0]["primitives"].append({"attributes": attrs, "indices": a_idx, "material": material})

    screen, bezel, rod = build_geometry()
    add_primitive([screen], screen_mat, uv1=True)
    add_primitive(bezel + rod, bezel_mat)

    while len(blob) % 4:
        blob.append(0)
    buf["byteLength"] = len(blob)
    open(bpath, "wb").write(blob)
    json.dump(g, open(gpath, "w", encoding="utf-8"), indent=1)
    print("Added %s to %s (bin now %d bytes)" % (MATERIAL, os.path.basename(gpath), len(blob)))


if __name__ == "__main__":
    main(sys.argv)
