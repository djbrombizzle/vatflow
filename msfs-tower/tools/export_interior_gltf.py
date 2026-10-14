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
  (common/texture), mapped by world position so the patterns line up across parts;
  keypad, keyboard and speaker grille textures are stretched once over their top face.
* The four IDST hardware keys (TowerCab_IdstKey_1..4) are their own nodes so they can be clicked.
* Also writes tower_cab_interior.xml: the LOD entry plus the model behaviors that let you
  drag the monitors round the track and the shades up and down.
* Materials are written the way the working sim build has them: screens exactly like
  the SDK GaugeAircraft sample ("$SCREEN_*" with emissive 2000), everything else plain PBR,
  double sided.
"""

import json
import re
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
KNOB_FRAMES = 90         # brightness knob: L:VATFLOW_DIM_* 0 (full bright) .. 90 (darkest)
KNOB_DRAG_SPEED = 0.2
LIFT_FRAMES = 40         # monitor height: frame = cm below the top of its travel
LIFT_TOP_M = 0.15        # frame 0 is 15 cm above where it is built (built = frame 15)
LIFT_DRAG_SPEED = 0.1
TWIST_FRAMES = 100       # monitor swivel: frame 50 = as built, 1 degree per frame
TWIST_DRAG_SPEED = 0.2
MODEL_GUID = "{DB987680-9FBE-43DC-B341-084A38681F92}"


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexlin(h):
    return [round(srgb_to_linear(int(h[i:i + 2], 16) / 255), 5) for i in (0, 2, 4)]


# name: (base colour hex, metallic, roughness, alpha)
PBR = {
    "TWR_Carpet": ("2E3847", 0.0, 0.95, 1),
    "TWR_Ceiling": ("0A0A0B", 0.0, 0.9, 1),
    "TWR_Keypad": ("333333", 0.0, 0.5, 1),
    "TWR_Keyboard": ("0D0D0D", 0.0, 0.5, 1),
    "TWR_Speaker": ("4D4840", 0.0, 0.7, 1),
    "TWR_PanelTan": ("6E6350", 0.0, 0.6, 1),
    "TWR_PanelGrey": ("8A8C8E", 0.3, 0.5, 1),
    "TWR_Knob": ("18181A", 0.4, 0.4, 1),
    "TWR_KeyGrey": ("5A5E63", 0.0, 0.5, 1),
    "TWR_KeyGreen": ("1E7A35", 0.0, 0.5, 1),
    "TWR_KeyRed": ("8A2020", 0.0, 0.5, 1),
    "TWR_FloorWear": ("FFFFFF", 0.0, 1.0, 0.999),     # alpha comes from the texture
    "TWR_GlassSmudge": ("FFFFFF", 0.0, 0.6, 0.999),
    "TWR_Console": ("2A2C30", 0.0, 0.6, 1),
    "TWR_Bezel": ("0D0D0D", 0.1, 0.4, 1),
    "TWR_Mount": ("1C1C1F", 0.5, 0.45, 1),
    "TWR_Concrete": ("DCD6CA", 0.0, 0.85, 1),
    "TWR_Metal": ("C8C8C4", 0.8, 0.4, 1),
    "TWR_Mullion": ("1A1A1C", 0.2, 0.5, 1),
    "TWR_Glass": ("A0B4BE", 0.0, 0.05, 0.15),
    "TWR_Shade": ("141416", 0.0, 0.8, 0.82),
}


# Textured materials (files in common/texture, made by make_textures.py):
#   albd  base colour (alpha too, for the BLEND decals)
#   comp  occlusion (R) / roughness (G) / metallic (B), the glTF "ORM" layout
#   norm  normal map, DirectX convention (green = down), as the asset header declares
#   m     meters one copy covers: UVs projected from world position (box mapping), so the
#         patterns line up across parts; None = stretched once over the face (decals)
TEXTURED = {
    "TWR_Carpet": {"albd": "TWR_Carpet_albd.png", "comp": "TWR_Carpet_comp.png", "norm": "TWR_Carpet_norm.png", "m": 2.4},
    "TWR_Ceiling": {"albd": "TWR_Ceiling_albd.png", "m": 1.2},
    "TWR_Console": {"albd": "TWR_Console_albd.png", "comp": "TWR_Console_comp.png", "norm": "TWR_Console_norm.png", "m": 1.0},
    "TWR_Keypad": {"albd": "TWR_Keypad_albd.png", "m": None},
    "TWR_Keyboard": {"albd": "TWR_Keyboard_albd.png", "m": None},
    "TWR_Speaker": {"albd": "TWR_Speaker_albd.png", "m": None},
    # wear decals (alpha blended layers just above the floor / inside the glass)
    "TWR_FloorWear": {"albd": "TWR_FloorWear_albd.png", "m": 3.6},
    "TWR_GlassSmudge": {"albd": "TWR_GlassSmudge_albd.png", "m": None},
}
IDST_KEYS = {"1": "IDST - select the aircraft above", "2": "IDST - select the aircraft below",
             "3": "IDST - issue the release for the selected aircraft", "4": "IDST - cancel the selected release"}


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


def tangent(p, uv, n):
    """Per-triangle tangent (glTF space) pointing along +U, with handedness in w."""
    e1 = [p[1][i] - p[0][i] for i in range(3)]
    e2 = [p[2][i] - p[0][i] for i in range(3)]
    du1, dv1 = uv[1][0] - uv[0][0], uv[1][1] - uv[0][1]
    du2, dv2 = uv[2][0] - uv[0][0], uv[2][1] - uv[0][1]
    det = du1 * dv2 - du2 * dv1
    if abs(det) < 1e-12:
        t = [1.0, 0.0, 0.0] if abs(n[0]) < 0.9 else [0.0, 0.0, 1.0]
        b = None
    else:
        r = 1.0 / det
        t = [(e1[i] * dv2 - e2[i] * dv1) * r for i in range(3)]
        b = [(e2[i] * du1 - e1[i] * du2) * r for i in range(3)]
    # Gram-Schmidt against the normal
    d = sum(t[i] * n[i] for i in range(3))
    t = [t[i] - n[i] * d for i in range(3)]
    ln = math.sqrt(sum(x * x for x in t)) or 1.0
    t = [x / ln for x in t]
    w = 1.0
    if b is not None:
        c = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]]
        w = -1.0 if sum(c[i] * b[i] for i in range(3)) < 0 else 1.0
    return [t[0], t[1], t[2], w]


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

    def texture(self, uri):
        """Index of a glTF texture for a file in common/texture (one per file)."""
        self.tex_index = getattr(self, "tex_index", {})
        if uri not in self.tex_index:
            # glTF image uri is the bare file name; MSFS finds it in the texture folder
            self.g.setdefault("images", []).append({"uri": uri})
            self.g.setdefault("samplers", [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}])
            self.g.setdefault("textures", []).append({"sampler": 0, "source": len(self.g["images"]) - 1})
            self.tex_index[uri] = len(self.g["textures"]) - 1
        return self.tex_index[uri]

    def material(self, name):
        if name not in self.mat_index:
            m = material_json(name)
            t = TEXTURED.get(name)
            if t:
                pbr = m["pbrMetallicRoughness"]
                pbr["baseColorTexture"] = {"index": self.texture(t["albd"])}
                pbr["baseColorFactor"] = [1.0, 1.0, 1.0, 1.0]
                if "comp" in t:
                    # same texture for occlusion (R) and roughness / metallic (G / B), as the
                    # Asobo exporter writes it; the factors then scale the texture values
                    ci = self.texture(t["comp"])
                    pbr["metallicRoughnessTexture"] = {"index": ci}
                    pbr["metallicFactor"], pbr["roughnessFactor"] = 1.0, 1.0
                    m["occlusionTexture"] = {"index": ci}
                if "norm" in t:
                    m["normalTexture"] = {"index": self.texture(t["norm"]), "scale": 1.0}
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
        """
        One node per object. Meshes are written in world space, or relative to the
        object's "vatflow_pivot" (a world point) for parts that turn about their own axis.
        "vatflow_parent" hangs the node under another object's node (translation =
        pivot minus the parent's pivot; nothing is rotated at rest). "vatflow_anim" adds
        its animation: track, lift, twist or knob (see the constants at the top).
        """
        pivot = obj.get("vatflow_pivot")
        pv = list(pivot) if pivot is not None else [0.0, 0.0, 0.0]
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        uv_layer = bm.loops.layers.uv.active
        by_mat = {}
        for f in bm.faces:
            name = obj.material_slots[f.material_index].material.name
            d = by_mat.setdefault(name, {"pos": [], "nrm": [], "uv": [], "tan": []})
            wn = (obj.matrix_world.to_3x3() @ f.normal).normalized()
            nn = to_gltf(wn)
            tri_p, tri_uv = [], []
            for loop in f.loops:
                wp = obj.matrix_world @ loop.vert.co
                d["pos"].append(to_gltf([wp[0] - pv[0], wp[1] - pv[1], wp[2] - pv[2]]))
                d["nrm"].append(nn)
                t = TEXTURED.get(name)
                if t and t["m"]:
                    uv = box_uv(wp, wn, t["m"])
                else:
                    uv = loop[uv_layer].uv if uv_layer else (0.0, 0.0)
                guv = [uv[0], 1.0 - uv[1]]                    # glTF V runs down
                d["uv"].append(guv)
                tri_p.append(to_gltf(wp))
                tri_uv.append(guv)
            tan = tangent(tri_p, tri_uv, nn)
            d["tan"].extend([tan] * 3)
        bm.free()
        prims = []
        for name, d in by_mat.items():
            count = len(d["pos"])
            attrs = {
                "POSITION": self.accessor(d["pos"], 5126, "VEC3", 34962, minmax=True),
                "NORMAL": self.accessor(d["nrm"], 5126, "VEC3", 34962),
                "TEXCOORD_0": self.accessor(d["uv"], 5126, "VEC2", 34962),
            }
            if name in TEXTURED and "norm" in TEXTURED[name]:
                attrs["TANGENT"] = self.accessor(d["tan"], 5126, "VEC4", 34962)
            if name.startswith("$SCREEN_"):
                attrs["TEXCOORD_1"] = attrs["TEXCOORD_0"]        # like the SDK sample screens
            idx = self.accessor(list(range(count)), 5123 if count < 65535 else 5125, "SCALAR", 34963)
            prims.append({"attributes": attrs, "indices": idx, "material": self.material(name)})
        self.g["meshes"].append({"name": obj.name, "primitives": prims})
        node = {"extensions": {"ASOBO_unique_id": {"id": obj.name}}, "mesh": len(self.g["meshes"]) - 1, "name": obj.name}
        self.g["nodes"].append(node)
        node_i = len(self.g["nodes"]) - 1
        self.node_info = getattr(self, "node_info", {})
        self.node_info[obj.name] = {"index": node_i, "pivot": pv, "parent": obj.get("vatflow_parent"),
                                    "anim": obj.get("vatflow_anim")}

    def link_nodes(self):
        """Parents, rest translations and animations, once every node exists."""
        roots = []
        for name, info in self.node_info.items():
            node = self.g["nodes"][info["index"]]
            parent = self.node_info.get(info["parent"]) if info["parent"] else None
            base = [info["pivot"][i] - (parent["pivot"][i] if parent else 0.0) for i in range(3)]
            base_g = to_gltf(base)
            if any(abs(v) > 1e-9 for v in base_g):
                node["translation"] = base_g
            if parent:
                self.g["nodes"][parent["index"]].setdefault("children", []).append(info["index"])
            else:
                roots.append(info["index"])
            anim = info["anim"]
            if anim == "track":
                # travel round the circular ceiling track = rotation about the cab's vertical
                # axis (glTF +Y) through the origin. Frame = degrees 0..360.
                self.rotation_anim(name + "_TRACK", info["index"], TRACK_FRAMES, lambda fr: fr)
            elif anim == "knob":
                # brightness knob: frame = L: var (0 full bright .. 90 darkest), 3 deg per frame
                # anticlockwise seen from above, so brighter = clockwise
                self.rotation_anim(name + "_TURN", info["index"], KNOB_FRAMES, lambda fr: fr * 3.0)
            elif anim == "twist":
                # monitor swivel about the vertical post: frame 50 = as built, 1 deg per frame
                self.rotation_anim(name + "_TWIST", info["index"], TWIST_FRAMES, lambda fr: fr - TWIST_FRAMES / 2,
                                   base=base_g)
            elif anim == "lift":
                # monitor height: frame = cm below the top of the travel (built = frame 15)
                times, keys = [], []
                for fr in range(0, LIFT_FRAMES + 1, 5):
                    times.append(fr / FPS)
                    keys.append([base_g[0], base_g[1] + LIFT_TOP_M - fr / 100.0, base_g[2]])
                self.add_anim(name + "_LIFT", info["index"], "translation", times, keys, "VEC3")
        self.g["scenes"][0]["nodes"] = roots

    def rotation_anim(self, anim_name, node_i, frames, deg_of_frame, base=None):
        times, keys = [], []
        for fr in range(0, frames + 1, 10 if frames > 50 else 5):
            h = math.radians(deg_of_frame(fr)) / 2
            times.append(fr / FPS)
            keys.append([0.0, math.sin(h), 0.0, math.cos(h)])
        self.add_anim(anim_name, node_i, "rotation", times, keys, "VEC4")

    def add_anim(self, anim_name, node_i, path, times, keys, typ):
        t_acc = self.accessor(times, 5126, "SCALAR", minmax=True)
        k_acc = self.accessor(keys, 5126, typ)
        self.g["animations"].append({
            "name": anim_name,
            "channels": [{"sampler": 0, "target": {"node": node_i, "path": path}}],
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


def drag_template(axis, var, speed, looping, tooltip, anim_length=None, reverse=False):
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
        + "\t\t\t\t<REVERSE_INTERACTION>%s</REVERSE_INTERACTION>\n" % ("True" if reverse else "False")
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
        m = re.match(r"TowerCab_(\w+?)Mount(_Lift|_Screen|_Swivel|_Handle)?$", node)
        if m:                                           # overhead monitor parts
            label, part = m.group(1).upper(), m.group(2) or ""
            track, height, twist = ("VATFLOW_%s_%s" % (label, v) for v in ("TRACK_DEG", "HEIGHT", "TWIST"))
            body = ""
            if part == "":                              # trolley: travels round the track
                body = anim_template(node + "_TRACK", "(L:%s) dnor" % track, TRACK_FRAMES, True)
            elif part == "_Lift":                       # telescoping post
                body = anim_template(node + "_LIFT", "(L:%s)" % height, LIFT_FRAMES, False)
            else:                                       # swivelling parts, each grabbed for one thing
                body = anim_template(node + "_TWIST", "(L:%s)" % twist, TWIST_FRAMES, False)
                if part == "_Screen":
                    body += drag_template("X", track, TRACK_DRAG_SPEED, True,
                                          "%s - drag left/right to move it along the track" % label)
                elif part == "_Handle":
                    body += drag_template("Y", height, LIFT_DRAG_SPEED, False,
                                          "%s - drag the handle up/down to set the height" % label, LIFT_FRAMES)
                else:
                    body += drag_template("X", twist, TWIST_DRAG_SPEED, False,
                                          "%s - drag the side knob left/right to swivel the screen" % label, TWIST_FRAMES)
            comps.append("\t\t<Component ID=\"VATFLOW_%s_MON%s\" Node=\"%s\">\n" % (label, part.upper(), node)
                         + body + "\t\t</Component>\n")
        elif node.startswith("TowerCab_DimKnob_"):      # screen brightness knob
            grp = node.rsplit("_", 1)[1]
            var = "VATFLOW_DIM_%s" % grp
            what = {"ALL": "all screens", "DBRITE": "DBRITE", "ASDEX": "ASDE-X",
                    "CONSOLE": "console screens (TWR INFO, IDST, voice switch, clock)"}[grp]
            comps.append("\t\t<Component ID=\"VATFLOW_DIM_%s\" Node=\"%s\">\n" % (grp, node)
                         + anim_template(node + "_TURN", "(L:%s)" % var, KNOB_FRAMES, False)
                         + drag_template("X", var, KNOB_DRAG_SPEED, False,
                                         "Brightness, %s - drag right brighter, left dimmer" % what, KNOB_FRAMES, reverse=True)
                         + "\t\t</Component>\n")
        elif node.startswith("TowerCab_IdstKey_"):      # IDST hardware key -> the gauge reads it
            k = node.rsplit("_", 1)[1]
            comps.append("\t\t<Component ID=\"VATFLOW_IDST_KEY_%s\" Node=\"%s\">\n" % (k, node)
                         + "\t\t\t<UseTemplate Name=\"ASOBO_GT_Interaction_LeftSingle_Code\">\n"
                         + "\t\t\t\t<LEFT_SINGLE_CODE>%s (&gt;L:VATFLOW_IDST_KEY)</LEFT_SINGLE_CODE>\n" % k
                         + "\t\t\t\t<TOOLTIPID>%s</TOOLTIPID>\n" % IDST_KEYS[k]
                         + "\t\t\t</UseTemplate>\n"
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
        + "\t\tOverhead monitors: trolley node animation _TRACK, 360 frames = degrees round the ceiling\n"
        + "\t\ttrack (L:VATFLOW_x_TRACK_DEG, drag the screen left/right, wraps round); post _LIFT, frame =\n"
        + "\t\tcm below the top of the travel (L:VATFLOW_x_HEIGHT, drag the handle up/down); screen, handle\n"
        + "\t\tand side knobs _TWIST, frame 50 = straight (L:VATFLOW_x_TWIST, drag a side knob). The DBRITE /\n"
        + "\t\tASDE-X screens set HEIGHT 15 and TWIST 50 when the flight starts (dimmer.js initMonitorPose).\n"
        + "\t\tShades: 20 strips each, shown past the shade position L:VATFLOW_SHADE_k (0 = up, 100 = down)\n"
        + "\t\twith ASOBO_GT_Visibility_Code; drag a strip to set the height, click the roller to raise /\n"
        + "\t\tlower it fully. Built on the SDK templates ASOBO_GT_Anim_Code, ASOBO_GT_Visibility_Code,\n"
        + "\t\tASOBO_GT_Interaction_DraggingXAxis_Code / DraggingYAxis_Code and\n"
        + "\t\tASOBO_GT_Interaction_LeftSingle_Code (Asobo Generic Interactions).\n"
        + "\t\tBrightness knobs: drag sets L:VATFLOW_DIM_ALL / _DBRITE / _ASDEX / _CONSOLE (0 = full bright,\n"
        + "\t\t90 = darkest); common/dimmer.js in each screen reads them. Node animation <NODE>_TURN.\n"
        + "\t\tIDST keys: click sets L:VATFLOW_IDST_KEY (1 up, 2 down, 3 issue, 4 cancel); the IDST gauge\n"
        + "\t\treads it and sets it back to 0.\n"
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
    w.link_nodes()
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
