"""
Builds the tower with blender/build_mia_tower.py and writes the two models the sim
loads, with no Blender export or MSFS material panel work needed:

  mia_tower.gltf / .bin           exterior (MIA_Exterior)   model.cfg normal=
  mia_tower_interior.gltf / .bin  interior (MIA_Interior)   model.cfg interior=

plus mia_tower.xml and mia_tower_interior.xml (the LOD entries).

  blender --background --python tools/export_gltf.py -- <out_dir>
  (or with the bpy module:  python tools/export_gltf.py <out_dir>)

Same approach as msfs-tower/tools/export_interior_gltf.py: one glTF node per object,
meshes in world space, Blender Z-up / nose -Y turned into glTF Y-up, every material
plain PBR and double sided (the exporter's own defaults are metallic 1 and single
sided, which make a cab dark and the glass vanish from inside).
"""

import json
import os
import runpy
import struct
import sys

import bpy  # noqa: E402  (must come before bmesh when run as a module)
import bmesh

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "blender", "build_mia_tower.py")
MODELS = {
    # collection: (file base name, ModelInfo guid)
    "MIA_Exterior": ("mia_tower", "{246E96FA-1629-4AB0-A133-4E13AF59F0D9}"),
    "MIA_Interior": ("mia_tower_interior", "{B2BEFF25-76FB-42BF-960C-13D0F9312405}"),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexlin(h):
    return [round(srgb_to_linear(int(h[i:i + 2], 16) / 255), 5) for i in (0, 2, 4)]


# name: (base colour hex, metallic, roughness, alpha)
PBR = {
    "TWR_Concrete": ("E8E8E4", 0.0, 0.85, 1),     # white precast concrete
    "TWR_Fascia": ("101012", 0.2, 0.5, 1),        # near-black band above the glass
    "TWR_Dark": ("1A1B1E", 0.1, 0.6, 1),          # dark cladding: penthouse, recessed level
    "TWR_Mullion": ("A8A8A6", 0.6, 0.4, 1),       # light grey aluminium window frames
    "TWR_Glass": ("1E2A32", 0.0, 0.05, 0.55),    # dark tinted glass (the cockpit view uses the interior model, which has none)
    "TWR_Metal": ("C8C8C4", 0.8, 0.4, 1),
    "TWR_Roof": ("6B6B6B", 0.0, 0.9, 1),          # roof membrane
    "TWR_Dome": ("E4E6E8", 0.3, 0.35, 1),         # radome
    "TWR_Equipment": ("DAD8D0", 0.0, 0.6, 1),
    "TWR_Carpet": ("2E3440", 0.0, 0.95, 1),
    "TWR_Ceiling": ("C4C4BE", 0.0, 0.9, 1),       # acoustic tile
    "TWR_Sill": ("B0A690", 0.0, 0.7, 1),
    "TWR_ConsoleTop": ("8A8A86", 0.0, 0.45, 1),   # grey laminate worktop
    "TWR_ConsoleFront": ("958C7C", 0.0, 0.7, 1),  # putty steel console fronts
    "TWR_ConsoleKick": ("1E1E1E", 0.0, 0.7, 1),
    "TWR_Bezel": ("0D0D0D", 0.1, 0.4, 1),
    "TWR_ScreenOff": ("050709", 0.0, 0.1, 1),     # glossy dark glass of a switched-off monitor
    "TWR_PanelGrey": ("8A8C8E", 0.3, 0.5, 1),
    "TWR_KeyGreen": ("1E7A35", 0.0, 0.5, 1),
    "TWR_LightGun": ("2A2A2A", 0.4, 0.4, 1),
    "TWR_ChairSeat": ("141416", 0.0, 0.8, 1),
    "TWR_Stairwell": ("0A0A0A", 0.0, 1.0, 1),
}


def material_json(name):
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
            "asset": {"generator": "MIA Style Tower exporter", "version": "2.0"},
            "extensionsUsed": ["ASOBO_unique_id"],
            "scene": 0, "scenes": [{"name": "Scene", "nodes": []}],
            "nodes": [], "meshes": [], "materials": [], "accessors": [], "bufferViews": [], "buffers": [],
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
        """One node per object, mesh in world space, flat shaded, UVs from world position."""
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bm.normal_update()
        rot = obj.matrix_world.to_3x3()
        by_mat = {}
        for f in bm.faces:
            name = obj.material_slots[f.material_index].material.name
            d = by_mat.setdefault(name, {"pos": [], "nrm": [], "uv": []})
            wn = (rot @ f.normal).normalized()
            # box mapping, 1 UV unit per meter (no textures yet; ready for them)
            ax = max(range(3), key=lambda i: abs(wn[i]))
            u_i, v_i = [(1, 2), (0, 2), (0, 1)][ax]
            for loop in f.loops:
                wp = obj.matrix_world @ loop.vert.co
                d["pos"].append(to_gltf(wp))
                d["nrm"].append(to_gltf(wn))
                d["uv"].append([wp[u_i], 1.0 - wp[v_i]])
        bm.free()
        prims = []
        for name, d in by_mat.items():
            count = len(d["pos"])
            attrs = {
                "POSITION": self.accessor(d["pos"], 5126, "VEC3", 34962, minmax=True),
                "NORMAL": self.accessor(d["nrm"], 5126, "VEC3", 34962),
                "TEXCOORD_0": self.accessor(d["uv"], 5126, "VEC2", 34962),
            }
            idx = self.accessor(list(range(count)), 5123 if count < 65535 else 5125, "SCALAR", 34963)
            prims.append({"attributes": attrs, "indices": idx, "material": self.material(name)})
        self.g["meshes"].append({"name": obj.name, "primitives": prims})
        self.g["nodes"].append({"extensions": {"ASOBO_unique_id": {"id": obj.name}},
                                "mesh": len(self.g["meshes"]) - 1, "name": obj.name})
        self.g["scenes"][0]["nodes"].append(len(self.g["nodes"]) - 1)

    def save(self, out_dir, base):
        while len(self.blob) % 4:
            self.blob.append(0)
        self.g["buffers"] = [{"byteLength": len(self.blob), "uri": base + ".bin"}]
        with open(os.path.join(out_dir, base + ".bin"), "wb") as f:
            f.write(self.blob)
        with open(os.path.join(out_dir, base + ".gltf"), "w", encoding="utf-8") as f:
            json.dump(self.g, f, indent=1)


def write_model_xml(path, base, guid):
    xml = ("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
           "<ModelInfo guid=\"%s\" version=\"1.1\">\n"
           "\t<LODS>\n"
           "\t\t<LOD minSize=\"0\" ModelFile=\"%s.gltf\"/>\n"
           "\t</LODS>\n"
           "</ModelInfo>\n" % (guid, base))
    with open(path, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(xml)


def main(out_dir):
    runpy.run_path(BUILD, run_name="__main__")
    os.makedirs(out_dir, exist_ok=True)
    for coll, (base, guid) in MODELS.items():
        w = Writer()
        for obj in bpy.data.collections[coll].objects:
            if obj.type == "MESH":
                w.add_object(obj)
        w.save(out_dir, base)
        write_model_xml(os.path.join(out_dir, base + ".xml"), base, guid)
        tris = sum(a["count"] for m in w.g["meshes"] for p in m["primitives"]
                   for a in [w.g["accessors"][p["indices"]]]) // 3
        print("Wrote %s: %d nodes, %d triangles, materials %s" % (
            os.path.join(out_dir, base + ".gltf"), len(w.g["nodes"]), tris,
            [m["name"] for m in w.g["materials"]]))


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    if len(args) != 1:
        sys.exit(__doc__)
    main(args[0])
