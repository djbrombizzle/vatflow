"""
Builds the cab with blender/build_tower_cab.py and writes the interior model the sim loads:
tower_cab_interior.gltf + .bin, with no Blender export or MSFS material panel work needed.

  blender --background --python tools/export_interior_gltf.py -- <out_dir>
  (or with the bpy module:  python tools/export_interior_gltf.py <out_dir>)

* One glTF node per object in TowerCab_Interior: the static interior plus each overhead
  monitor (TowerCab_DbriteMount, TowerCab_AsdexMount) as its own node.
* Each monitor gets a rotation animation "<NODE>_TRACK" for travelling round the
  circular ceiling track: frame = degrees (0..360, frame 0 = where it was built, the
  rest position), keyed at 24 fps like the Asobo exporter.
* Each window shade is SHADE_STRIPS strips (TowerCab_Shade_k_sNN); behaviors show the
  strips past the shade's position, so it unrolls in steps (no animation involved).
* Carpet, ceiling and console materials use the textures from make_textures.py
  (common/texture), mapped by world position so the patterns line up across parts.
* Also writes tower_cab_interior.xml: the LOD entry plus the model behaviors that let you
  drag the monitors round the track and the shades up and down.
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
TRACK_FRAMES = 360   # one frame per degree round the track
SHADE_STRIPS = 20        # keep in sync with build_tower_cab.py
TRACK_DRAG_SPEED = 0.125
SHADE_DRAG_SPEED = 0.2
MODEL_GUID = "{DB987680-9FBE-43DC-B341-084A38681F92}"


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
    "TWR_Shade": ("141416", 0.0, 0.8, 0.82),
}


# Textured materials: texture file (in common/texture, made by make_textures.py) and the
# meters one copy covers. UVs for these are projected from world position (box mapping).
TEXTURED = {
    "TWR_Carpet": ("TWR_Carpet_albd.png", 2.4),
    "TWR_Ceiling": ("TWR_Ceiling_albd.png", 1.2),
    "TWR_Console": ("TWR_Console_albd.png", 1.0),
}


def box_uv(p, n, meters):
    """World-space box mapping (Blender coords): project on the plane the face mostly faces."""
    ax, ay, az = abs(n[0]), abs(n[1]), abs(n[2])
    if az >= ax and az >= ay:
        u, v = p[0], p[1]
    elif ax >= ay:
        u, v = p[1], p[2]
    else:
        u, v = p[0], p[2]
    return [u / meters, v / meters]


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
            m = material_json(name)
            if name in TEXTURED:
                # glTF image uri is the bare file name; MSFS finds it in the texture folder
                self.g.setdefault("images", []).append({"uri": TEXTURED[name][0]})
                self.g.setdefault("samplers", [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}])
                self.g.setdefault("textures", []).append({"sampler": 0, "source": len(self.g["images"]) - 1})
                m["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(self.g["textures"]) - 1}
                m["pbrMetallicRoughness"]["baseColorFactor"] = [1.0, 1.0, 1.0, m["pbrMetallicRoughness"]["baseColorFactor"][3]]
            self.g["materials"].append(m)
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
        # Animated parts that scale (the shades) keep their own transform so the scale
        # runs along their local axes; everything else is baked into world space.
        local = False
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        uv_layer = bm.loops.layers.uv.active
        by_mat = {}
        for f in bm.faces:
            name = obj.material_slots[f.material_index].material.name
            d = by_mat.setdefault(name, {"pos": [], "nrm": [], "uv": []})
            nn = to_gltf(f.normal) if local else to_gltf((obj.matrix_world.to_3x3() @ f.normal).normalized())
            wn = (obj.matrix_world.to_3x3() @ f.normal)
            for loop in f.loops:
                wp = obj.matrix_world @ loop.vert.co
                d["pos"].append(to_gltf(loop.vert.co if local else wp))
                d["nrm"].append(nn)
                if name in TEXTURED:
                    uv = box_uv(wp, wn, TEXTURED[name][1])
                else:
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
        if local:
            loc, rot, _scale = obj.matrix_world.decompose()
            node["translation"] = to_gltf(loc)
            node["rotation"] = [rot.x, rot.z, -rot.y, rot.w]     # same axis change as to_gltf
        self.g["nodes"].append(node)
        node_i = len(self.g["nodes"]) - 1
        self.g["scenes"][0]["nodes"].append(node_i)

        if "vatflow_track" in obj:
            # Travel round the circular ceiling track = rotation about the cab's vertical
            # axis (glTF +Y) through the origin. Frame = degrees: 0..360, keyed every 10.
            times, keys = [], []
            for deg in range(0, TRACK_FRAMES + 1, 10):
                h = math.radians(deg) / 2
                times.append(deg / FPS)
                keys.append([0.0, math.sin(h), 0.0, math.cos(h)])
            t_acc = self.accessor(times, 5126, "SCALAR", minmax=True)
            k_acc = self.accessor(keys, 5126, "VEC4")
            self.g["animations"].append({
                "name": obj.name + "_TRACK",
                "channels": [{"sampler": 0, "target": {"node": node_i, "path": "rotation"}}],
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


def drag_template(axis, var, speed, looping, tooltip, anim_length=None):
    keep = "(L:%s) (&gt;L:%s)" % (var, var)
    extra = "\t\t\t\t<IS_LOOPING>True</IS_LOOPING>\n" if looping else "\t\t\t\t<ANIM_LENGTH>%d</ANIM_LENGTH>\n" % anim_length
    return (
        "\t\t\t<UseTemplate Name=\"ASOBO_GT_Interaction_Dragging%sAxis_Code\">\n" % axis
        + "\t\t\t\t<POSITION_TYPE>L</POSITION_TYPE>\n"
        + "\t\t\t\t<POSITION_VAR>%s</POSITION_VAR>\n" % var
        + "\t\t\t\t<UP_CODE>%s</UP_CODE>\n" % keep
        + "\t\t\t\t<DOWN_CODE>%s</DOWN_CODE>\n" % keep
        + extra
        + "\t\t\t\t<DRAG_SPEED>%s</DRAG_SPEED>\n" % speed
        + "\t\t\t\t<REVERSE_INTERACTION>False</REVERSE_INTERACTION>\n"
        + "\t\t\t\t<CURSOR>Grab</CURSOR>\n"
        + "\t\t\t\t<TOOLTIPID>%s</TOOLTIPID>\n" % tooltip
        + "\t\t\t</UseTemplate>\n")


def anim_template(name, code, length, wrap, lag=0):
    return (
        "\t\t\t<UseTemplate Name=\"ASOBO_GT_Anim_Code\">\n"
        + "\t\t\t\t<ANIM_NAME>%s</ANIM_NAME>\n" % name
        + "\t\t\t\t<ANIM_CODE>%s</ANIM_CODE>\n" % code
        + "\t\t\t\t<ANIM_LENGTH>%d</ANIM_LENGTH>\n" % length
        + ("\t\t\t\t<ANIM_WRAP>True</ANIM_WRAP>\n" if wrap else "")
        + "\t\t\t\t<ANIM_LAG>%d</ANIM_LAG>\n" % lag
        + "\t\t\t</UseTemplate>\n")


def write_behaviors(path, node_names):
    """tower_cab_interior.xml: LOD + model behaviors for every moving part in the export."""
    comps = []
    for node in node_names:
        if node.endswith("Mount"):                      # overhead monitor on the 360 track
            label = node.replace("TowerCab_", "").replace("Mount", "").upper()
            var = "VATFLOW_%s_TRACK_DEG" % label
            comps.append("\t\t<Component ID=\"VATFLOW_%s_TRACK\" Node=\"%s\">\n" % (label, node)
                         + anim_template(node + "_TRACK", "(L:%s) dnor" % var, TRACK_FRAMES, True)
                         + drag_template("X", var, TRACK_DRAG_SPEED, True, "%s - drag left/right to move it along the track" % label)
                         + "\t\t</Component>\n")
        elif node.startswith("TowerCab_ShadeRoller_"):  # click the roller: fully up / down
            k = node.rsplit("_", 1)[1]
            var = "VATFLOW_SHADE_%s" % k
            comps.append("\t\t<Component ID=\"VATFLOW_SHADE_ROLLER_%s\" Node=\"%s\">\n" % (k, node)
                         + "\t\t\t<UseTemplate Name=\"ASOBO_GT_Interaction_LeftSingle_Code\">\n"
                         + "\t\t\t\t<LEFT_SINGLE_CODE>(L:%s) 50 &gt; if{ 0 } els{ 100 } (&gt;L:%s)</LEFT_SINGLE_CODE>\n" % (var, var)
                         + "\t\t\t\t<TOOLTIPID>Window shade - click the roller to raise / lower it fully</TOOLTIPID>\n"
                         + "\t\t\t</UseTemplate>\n"
                         + "\t\t</Component>\n")
        elif node.startswith("TowerCab_ShadeBar_"):     # pull bar: only on the lowest visible strip
            k, strip = node.split("_")[2], int(node.rsplit("_s", 1)[1])
            var = "VATFLOW_SHADE_%s" % k
            lo, hi = strip * 100.0 / SHADE_STRIPS, (strip + 1) * 100.0 / SHADE_STRIPS
            code = "(L:%s) %g &gt; (L:%s) %g &lt;= and" % (var, lo, var, hi)
            if strip == SHADE_STRIPS - 1:
                code = "(L:%s) %g &gt;" % (var, lo)
            comps.append("\t\t<Component ID=\"VATFLOW_SHADE_%s_BAR%02d\" Node=\"%s\">\n" % (k, strip, node)
                         + "\t\t\t<UseTemplate Name=\"ASOBO_GT_Visibility_Code\">\n"
                         + "\t\t\t\t<VISIBILITY_CODE>%s</VISIBILITY_CODE>\n" % code
                         + "\t\t\t</UseTemplate>\n"
                         + drag_template("Y", var, SHADE_DRAG_SPEED, False, "Window shade - drag to set the height", 100)
                         + "\t\t</Component>\n")
        elif node.startswith("TowerCab_Shade_"):        # one strip of a shade: shown past its step
            k, strip = node.split("_")[2], int(node.rsplit("_s", 1)[1])
            var = "VATFLOW_SHADE_%s" % k
            step = strip * 100.0 / SHADE_STRIPS
            comps.append("\t\t<Component ID=\"VATFLOW_SHADE_%s_S%02d\" Node=\"%s\">\n" % (k, strip, node)
                         + "\t\t\t<UseTemplate Name=\"ASOBO_GT_Visibility_Code\">\n"
                         + "\t\t\t\t<VISIBILITY_CODE>(L:%s) %g &gt;</VISIBILITY_CODE>\n" % (var, step)
                         + "\t\t\t</UseTemplate>\n"
                         + drag_template("Y", var, SHADE_DRAG_SPEED, False, "Window shade - drag to set the height", 100)
                         + "\t\t</Component>\n")
    xml = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
        + "<ModelInfo guid=\"%s\" version=\"1.1\">\n" % MODEL_GUID
        + "\t<LODS>\n\t\t<LOD minSize=\"0\" ModelFile=\"tower_cab_interior.gltf\"/>\n\t</LODS>\n"
        + "\t<!--\n"
        + "\t\tGenerated by tools/export_interior_gltf.py together with tower_cab_interior.gltf.\n"
        + "\t\tOverhead monitors: node animation named node plus _TRACK, 360 frames = degrees round the\n"
        + "\t\tceiling track, position in an L: var, dragged left/right (wraps round).\n"
        + "\t\tShades: 20 strips each, shown past the shade position L:VATFLOW_SHADE_k (0 = up, 100 = down)\n"
        + "\t\twith ASOBO_GT_Visibility_Code; drag a strip to set the height, click the roller to raise /\n"
        + "\t\tlower it fully. Built on the SDK templates ASOBO_GT_Anim_Code, ASOBO_GT_Visibility_Code,\n"
        + "\t\tASOBO_GT_Interaction_DraggingXAxis_Code / DraggingYAxis_Code and\n"
        + "\t\tASOBO_GT_Interaction_LeftSingle_Code (Asobo Generic Interactions).\n"
        + "\t\tIf a drag goes the wrong way set REVERSE_INTERACTION to True; DRAG_SPEED sets the speed.\n"
        + "\t-->\n"
        + "\t<CompileBehaviors Version=\"2\">\n"
        + "\t\t<Include ModelBehaviorFile=\"Asobo\\Common.xml\"/>\n\n"
        + "\n".join(comps)
        + "\t</CompileBehaviors>\n</ModelInfo>\n")
    with open(path, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(xml)


def main(out_dir):
    runpy.run_path(BUILD, run_name="__main__")
    os.makedirs(out_dir, exist_ok=True)
    w = Writer()
    for obj in bpy.data.collections["TowerCab_Interior"].objects:
        if obj.type == "MESH":
            w.add_object(obj)
    w.save(out_dir, "tower_cab_interior")
    write_behaviors(os.path.join(out_dir, "tower_cab_interior.xml"), [n["name"] for n in w.g["nodes"]])
    print("Wrote %s: nodes %s, animations %s" % (
        os.path.join(out_dir, "tower_cab_interior.gltf"),
        [n["name"] for n in w.g["nodes"]],
        [a["name"] for a in w.g.get("animations", [])]))


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    if len(args) != 1:
        sys.exit(__doc__)
    main(args[0])
