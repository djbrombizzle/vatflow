"""
Builds the cab with blender/build_tower_cab.py and writes the interior model the sim loads:
tower_cab_interior.gltf + .bin, with no Blender export or MSFS material panel work needed.

  blender --background --python tools/export_interior_gltf.py -- <out_dir>
  (or with the bpy module:  python tools/export_interior_gltf.py <out_dir>)

* One glTF node per object in TowerCab_Interior: the static interior plus each overhead
  monitor (TowerCab_DbriteMount, TowerCab_AsdexMount) as its own node.
* Each monitor gets a translation animation "<NODE>_SLIDE" along its rail:
  frame 0 = one end, frame 50 = centre (the rest position), frame 100 = other end,
  keyed at 24 fps like the Asobo exporter. Model behaviors drive it (tower_cab_interior.xml).
* Materials are written the way the working sim build has them: screens exactly like
  the SDK GaugeAircraft sample ("$SCREEN_*" with emissive 2000), everything else plain PBR,
  double sided.
"""

import json
import math
import os
import runpy
import struct
import sys

import bpy  # noqa: E402  (must come before bmesh when run as a module)
import bmesh

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "blender", "build_tower_cab.py")
FPS = 24.0
ANIM_FRAMES = 100


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexlin(h):
    return [round(srgb_to_linear(int(h[i:i + 2], 16) / 255), 5) for i in (0, 2, 4)]


# name: (base colour hex, metallic, roughness, alpha)
PBR = {
    "TWR_Carpet": ("2E3847", 0.0, 0.95, 1),
    "TWR_Ceiling": ("CCCCC7", 0.0, 0.9, 1),
    "TWR_Console": ("2A2C30", 0.0, 0.6, 1),
    "TWR_Bezel": ("0D0D0D", 0.1, 0.4, 1),
    "TWR_Mount": ("1C1C1F", 0.5, 0.45, 1),
    "TWR_Concrete": ("DCD6CA", 0.0, 0.85, 1),
    "TWR_Metal": ("C8C8C4", 0.8, 0.4, 1),
    "TWR_Mullion": ("1A1A1C", 0.2, 0.5, 1),
    "TWR_Glass": ("A0B4BE", 0.0, 0.05, 0.15),
}


def material_json(name):
    if name.startswith("$SCREEN_"):
        return {"emissiveFactor": [2000.0, 2000.0, 2000.0], "name": name}
    hx, met, rough, alpha = PBR[name]
    return {
        "alphaMode": "BLEND" if alpha < 1 else "OPAQUE",
        "doubleSided": True,
        "emissiveFactor": [0, 0, 0],
        "name": name,
        "pbrMetallicRoughness": {"baseColorFactor": hexlin(hx) + [alpha], "metallicFactor": met, "roughnessFactor": rough},
    }


def to_gltf(v):
    """Blender (x, y, z), Z up, nose -Y  ->  glTF (x, z, -y)."""
    return [v[0], v[2], -v[1]]


class Writer:
    def __init__(self):
        self.g = {
            "asset": {"extensions": {"ASOBO_normal_map_convention": {"tangent_space_convention": "DirectX"}},
                      "generator": "VATFLOW tower cab exporter", "version": "2.0"},
            "extensionsUsed": ["ASOBO_normal_map_convention", "ASOBO_unique_id"],
            "scene": 0, "scenes": [{"name": "Scene", "nodes": []}],
            "nodes": [], "meshes": [], "materials": [], "accessors": [], "bufferViews": [],
            "buffers": [], "animations": [],
        }
        self.blob = bytearray()
        self.mat_index = {}

    def material(self, name):
        if name not in self.mat_index:
            self.g["materials"].append(material_json(name))
            self.mat_index[name] = len(self.g["materials"]) - 1
        return self.mat_index[name]

    def accessor(self, values, ctype, typ, target=None, minmax=False):
        flat = [x for v in values for x in (v if isinstance(v, (list, tuple)) else [v])]
        fmt = {5126: "f", 5123: "H", 5125: "I"}[ctype]
        while len(self.blob) % 4:
            self.blob.append(0)
        off = len(self.blob)
        self.blob.extend(struct.pack("<%d%s" % (len(flat), fmt), *flat))
        view = {"buffer": 0, "byteLength": len(self.blob) - off, "byteOffset": off}
        if target:
            view["target"] = target
        self.g["bufferViews"].append(view)
        acc = {"bufferView": len(self.g["bufferViews"]) - 1, "componentType": ctype, "count": len(values), "type": typ}
        if minmax:
            n = len(values[0]) if isinstance(values[0], (list, tuple)) else 1
            vals = values if n > 1 else [[v] for v in values]
            acc["min"] = [min(v[i] for v in vals) for i in range(n)]
            acc["max"] = [max(v[i] for v in vals) for i in range(n)]
        self.g["accessors"].append(acc)
        return len(self.g["accessors"]) - 1

    def add_object(self, obj):
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        uv_layer = bm.loops.layers.uv.active
        by_mat = {}
        for f in bm.faces:
            name = obj.material_slots[f.material_index].material.name
            d = by_mat.setdefault(name, {"pos": [], "nrm": [], "uv": []})
            nn = to_gltf(f.normal)
            for loop in f.loops:
                d["pos"].append(to_gltf(obj.matrix_world @ loop.vert.co))
                d["nrm"].append(nn)
                uv = loop[uv_layer].uv if uv_layer else (0.0, 0.0)
                d["uv"].append([uv[0], 1.0 - uv[1]])          # glTF V runs down
        bm.free()
        prims = []
        for name, d in by_mat.items():
            count = len(d["pos"])
            attrs = {
                "POSITION": self.accessor(d["pos"], 5126, "VEC3", 34962, minmax=True),
                "NORMAL": self.accessor(d["nrm"], 5126, "VEC3", 34962),
                "TEXCOORD_0": self.accessor(d["uv"], 5126, "VEC2", 34962),
            }
            if name.startswith("$SCREEN_"):
                attrs["TEXCOORD_1"] = attrs["TEXCOORD_0"]        # like the SDK sample screens
            idx = self.accessor(list(range(count)), 5123 if count < 65535 else 5125, "SCALAR", 34963)
            prims.append({"attributes": attrs, "indices": idx, "material": self.material(name)})
        self.g["meshes"].append({"name": obj.name, "primitives": prims})
        node = {"extensions": {"ASOBO_unique_id": {"id": obj.name}}, "mesh": len(self.g["meshes"]) - 1, "name": obj.name}
        self.g["nodes"].append(node)
        node_i = len(self.g["nodes"]) - 1
        self.g["scenes"][0]["nodes"].append(node_i)

        if "vatflow_slide_axis" in obj:
            axis = to_gltf(list(obj["vatflow_slide_axis"]))
            r = float(obj["vatflow_slide_range"])
            times = [0.0, ANIM_FRAMES / 2 / FPS, ANIM_FRAMES / FPS]
            keys = [[a * -r for a in axis], [0.0, 0.0, 0.0], [a * r for a in axis]]
            t_acc = self.accessor(times, 5126, "SCALAR", minmax=True)
            k_acc = self.accessor(keys, 5126, "VEC3")
            self.g["animations"].append({
                "name": obj.name + "_SLIDE",
                "channels": [{"sampler": 0, "target": {"node": node_i, "path": "translation"}}],
                "samplers": [{"input": t_acc, "interpolation": "LINEAR", "output": k_acc}],
            })

    def save(self, out_dir, base):
        while len(self.blob) % 4:
            self.blob.append(0)
        self.g["buffers"] = [{"byteLength": len(self.blob), "uri": base + ".bin"}]
        if not self.g["animations"]:
            del self.g["animations"]
        with open(os.path.join(out_dir, base + ".bin"), "wb") as f:
            f.write(self.blob)
        with open(os.path.join(out_dir, base + ".gltf"), "w", encoding="utf-8") as f:
            json.dump(self.g, f, indent=1)


def main(out_dir):
    runpy.run_path(BUILD, run_name="__main__")
    os.makedirs(out_dir, exist_ok=True)
    w = Writer()
    for obj in bpy.data.collections["TowerCab_Interior"].objects:
        if obj.type == "MESH":
            w.add_object(obj)
    w.save(out_dir, "tower_cab_interior")
    print("Wrote %s: nodes %s, animations %s" % (
        os.path.join(out_dir, "tower_cab_interior.gltf"),
        [n["name"] for n in w.g["nodes"]],
        [a["name"] for a in w.g.get("animations", [])]))


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    if len(args) != 1:
        sys.exit(__doc__)
    main(args[0])
