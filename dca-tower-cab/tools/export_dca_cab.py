"""
Builds the DCA Tower Cab with blender/build_dca_tower_cab.py and writes every model file the
sim loads, into the SimObject's common/model folder (or <out_dir>), plus its systems.cfg lights:

  python tools/export_dca_cab.py [out_dir]          (bpy module, Blender 4.5+ / bpy 5.x)
  blender --background --python tools/export_dca_cab.py -- [out_dir]

* dca_tower_cab.gltf / .bin          the outside (DcaCab_Exterior): shell, glass, mullions, railings
* dca_tower_cab_interior.gltf / .bin the inside (DcaCab_Interior): one node per object; the overhead
  monitors (TowerCab_DbriteMount / TowerCab_AsdexMount and their parts) with the track, height
  and swivel animations, and the window shades in 20 strips each
* dca_tower_cab.xml, dca_tower_cab_interior.xml  LODs; the interior one has the model behaviours
  (drag the monitors round the track, set their height and swivel, pull the shades)
* ../config/systems.cfg [LIGHTS]: the ceiling lights and a task light over each position

The node names, L: vars and animations are the VATFLOW Tower Cab's (msfs-tower/), so the
screens behave the same. Materials: plain PBR, double sided; screens like the SDK
GaugeAircraft sample ("$SCREEN_*", emissive 4000 for brightness up to 200 %).
"""

import json
import math
import os
import re
import runpy
import struct
import sys

import bpy  # noqa: E402  (must come before bmesh when run as a module)
import bmesh

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "blender", "build_dca_tower_cab.py")
SIMOBJ = os.path.join(HERE, "..", "package", "SimObjects", "Airplanes", "vatflow_dca_tower_cab", "common")
FPS = 24.0
TRACK_FRAMES = 360       # one frame per degree round the track
SHADE_STRIPS = 20        # keep in sync with build_dca_tower_cab.py
TRACK_DRAG_SPEED = 0.125
SHADE_DRAG_SPEED = 0.2
LIFT_FRAMES = 40         # monitor height: frame = cm below the top of its travel
LIFT_TOP_M = 0.15        # frame 0 is 15 cm above where it is built (built = frame 15)
LIFT_DRAG_SPEED = 0.1
TWIST_FRAMES = 100       # monitor swivel: frame 50 = as built, 1 degree per frame
TWIST_DRAG_SPEED = 0.2
SLIDE_FRAMES = 400
KNOB_FRAMES = 90
FAN_FRAMES = 360
INTERIOR_GUID = "{5B1E2C7A-3D84-4F0B-9A61-0C2D7E9F4A13}"
EXTERIOR_GUID = "{8E4F6A21-B7C3-4D95-8F02-6A1D3C5B7E90}"
INTERIOR, EXTERIOR = "dca_tower_cab_interior", "dca_tower_cab"


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexlin(h):
    return [round(srgb_to_linear(int(h[i:i + 2], 16) / 255), 5) for i in (0, 2, 4)]


# name: (base colour hex, metallic, roughness, alpha)
# name: (base colour hex, metallic, roughness, alpha)
PBR = {
    "TWR_Carpet": ("2E3847", 0.0, 0.95, 1),
    "TWR_Ceiling": ("0A0A0B", 0.0, 0.9, 1),
    "TWR_LightPanel": ("FFF4DE", 0.0, 0.5, 1),
    "TWR_CanRim": ("B8A98C", 0.8, 0.35, 1),
    "TWR_Soffit": ("1B1C1F", 0.0, 0.8, 1),
    "TWR_ConsoleTop": ("4E7CB4", 0.0, 0.45, 1),
    "TWR_ConsoleFront": ("347FC0", 0.0, 0.85, 1),
    "TWR_ConsoleKick": ("1E2E4A", 0.0, 0.7, 1),
    "TWR_ConsoleRail": ("C9CED4", 0.15, 0.25, 1),
    "TWR_ConsoleBumper": ("2E3138", 0.0, 0.5, 1),
    "TWR_Console": ("2A2C30", 0.0, 0.6, 1),
    "TWR_Bezel": ("0D0D0D", 0.1, 0.4, 1),
    "TWR_Mount": ("1C1C1F", 0.5, 0.45, 1),
    "TWR_Concrete": ("DCD6CA", 0.0, 0.85, 1),
    "TWR_Metal": ("C8C8C4", 0.8, 0.4, 1),
    "TWR_Mullion": ("1A1A1C", 0.2, 0.5, 1),
    "TWR_Glass": ("A0B4BE", 0.0, 0.05, 0.15),
    "TWR_Shade": ("1C3557", 0.0, 0.8, 0.74),     # dark navy tinted film
    "TWR_Divider": ("101215", 0.2, 0.5, 1),      # the dark corner dividers by GC
    "TWR_Wall": ("B4B6B8", 0.0, 0.8, 1),         # knee walls round the stair core, stairwell
    "TWR_WallCap": ("41454C", 0.0, 0.5, 1),
    "TWR_StairTread": ("1F1F21", 0.0, 0.9, 1),
    "TWR_StairNosing": ("C29E26", 0.0, 0.6, 1),
    "TWR_Counter": ("9E9A90", 0.0, 0.35, 1),
    "TWR_Cabinet": ("CDCAC2", 0.0, 0.6, 1),
    "TWR_Appliance": ("B8BABD", 0.7, 0.35, 1),
    "TWR_SinkSteel": ("8C8F94", 0.8, 0.3, 1),
}

# Textured materials (files in common/texture, copies of the VATFLOW cab's from
# msfs-tower/tools/make_textures.py): albd base colour, comp occlusion / roughness / metallic,
# norm normal map (DirectX); m = meters one copy covers, by world position (None = the
# mesh's own UVs, made in the Blender script)
TEXTURED = {
    "TWR_Carpet": {"albd": "TWR_Carpet_albd.png", "comp": "TWR_Carpet_comp.png", "norm": "TWR_Carpet_norm.png", "m": 2.4},
    "TWR_Ceiling": {"albd": "TWR_Ceiling_albd.png", "m": 1.2},
    "TWR_Console": {"albd": "TWR_Console_albd.png", "m": 1.0},
    "TWR_ConsoleTop": {"albd": "TWR_ConsoleTop_albd.png", "m": None},
    "TWR_ConsoleFront": {"albd": "TWR_ConsoleFront_albd.png", "norm": "TWR_ConsoleFront_norm.png", "m": None},
}


SMOOTH_COS = math.cos(math.radians(35))   # faces meeting flatter than this shade as one curve


def smooth_normal(f, v):
    """
    The normal at corner v of face f: the area-weighted mean of the faces round v with the
    same material that meet f at under 35 degrees. Curves (round parts, Meshy props) shade
    smooth; box edges, bevels, the cab's 45-degree octagon corners and edges between
    materials stay sharp.
    """
    n = f.normal * f.calc_area()
    for g in v.link_faces:
        if g is not f and g.material_index == f.material_index and g.normal.dot(f.normal) > SMOOTH_COS:
            n = n + g.normal * g.calc_area()
    return n.normalized() if n.length > 1e-12 else f.normal


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


# Self-lit (emissive) materials besides the screens, in the same units as the screens'
# 2000: the ceiling light diffusers glow softly ("lightly dimmed").
EMISSIVE = {"TWR_LightPanel": [450.0, 420.0, 370.0]}


def material_json(name):
    if name.startswith("$SCREEN_"):
        # twice the SDK sample's 2000: the screens' black layer (common/dimmer.js) takes it
        # back to normal and thins out up to 200 % brightness on bright days
        return {"emissiveFactor": [4000.0, 4000.0, 4000.0], "name": name}
    if name in EMISSIVE:
        hx, met, rough, alpha = PBR[name]
        return {"alphaMode": "OPAQUE", "doubleSided": True, "emissiveFactor": EMISSIVE[name], "name": name,
                "pbrMetallicRoughness": {"baseColorFactor": hexlin(hx) + [1], "metallicFactor": met, "roughnessFactor": rough}}
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
        bm.normal_update()
        uv_layer = bm.loops.layers.uv.active
        rot = obj.matrix_world.to_3x3()
        by_mat = {}
        for f in bm.faces:
            name = obj.material_slots[f.material_index].material.name
            d = by_mat.setdefault(name, {"pos": [], "nrm": [], "uv": [], "tan": []})
            wn = (rot @ f.normal).normalized()
            nn = to_gltf(wn)
            tri_p, tri_uv = [], []
            for loop in f.loops:
                wp = obj.matrix_world @ loop.vert.co
                d["pos"].append(to_gltf([wp[0] - pv[0], wp[1] - pv[1], wp[2] - pv[2]]))
                d["nrm"].append(to_gltf((rot @ smooth_normal(f, loop.vert)).normalized()))
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
                                    "anim": obj.get("vatflow_anim"), "axis": obj.get("vatflow_axis")}

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
            elif anim == "spin":
                # ceiling fan: turns about its own vertical axis, frame = degrees
                self.rotation_anim(name + "_SPIN", info["index"], FAN_FRAMES, lambda fr: fr)
            elif anim == "slide":
                # strip bay along its console face: frame = cm + 130 along "vatflow_axis"
                ax = to_gltf(list(info["axis"]))
                times, keys = [], []
                for fr in range(0, SLIDE_FRAMES + 1, 10):
                    d = (fr - SLIDE_FRAMES / 2) / 100.0
                    times.append(fr / FPS)
                    keys.append([base_g[i] + ax[i] * d for i in range(3)])
                self.add_anim(name + "_SLIDE", info["index"], "translation", times, keys, "VEC3")
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
    """dca_tower_cab_interior.xml: LOD + model behaviours for the monitors and the shades."""
    comps = []
    comps = []
    for node in node_names:
        m = re.match(r"TowerCab_(\w+?)Mount(_Lift|_Display|_SwivelL|_SwivelR|_Handle)?$", node)
        if m:                                           # overhead monitor parts
            label, part = m.group(1).upper(), m.group(2) or ""
            track, height, twist = ("VATFLOW_%s_%s" % (label, v) for v in ("TRACK_DEG", "HEIGHT", "TWIST"))
            shown = {"DBRITE": "Tower Radar", "ASDEX": "Ground Radar"}.get(label, label)   # names on the screens
            body = ""
            if part == "":                              # trolley: travels round the track (drag it too)
                body = anim_template(node + "_TRACK", "(L:%s) dnor" % track, TRACK_FRAMES, True)
                body += drag_template("X", track, TRACK_DRAG_SPEED, True,
                                      "%s - drag left/right to move it along the track" % shown)
            elif part == "_Lift":                       # telescoping post: drag it to move round the track
                body = anim_template(node + "_LIFT", "(L:%s)" % height, LIFT_FRAMES, False)
                body += drag_template("X", track, TRACK_DRAG_SPEED, True,
                                      "%s - drag the post left/right to move it along the track" % shown)
            else:                                       # swivelling parts, each grabbed for one thing
                body = anim_template(node + "_TWIST", "(L:%s)" % twist, TWIST_FRAMES, False)
                if part == "_Display":
                    pass                                # no drag: clicks go to the screen's page
                elif part == "_Handle":
                    body += drag_template("Y", height, LIFT_DRAG_SPEED, False,
                                          "%s - drag the handle up/down to set the height" % shown, LIFT_FRAMES)
                else:
                    body += drag_template("X", twist, TWIST_DRAG_SPEED, False,
                                          "%s - drag the side knob left/right to swivel the screen" % shown, TWIST_FRAMES)
            comps.append("\t\t<Component ID=\"VATFLOW_%s_MON%s\" Node=\"%s\">\n" % (label, part.upper(), node)
                         + body + "\t\t</Component>\n")
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
        + "<ModelInfo guid=\"%s\" version=\"1.1\">\n" % INTERIOR_GUID
        + "\t<LODS>\n\t\t<LOD minSize=\"0\" ModelFile=\"%s.gltf\"/>\n\t</LODS>\n" % INTERIOR
        + "\t<!--\n"
        + "\t\tGenerated by dca-tower-cab/tools/export_dca_cab.py together with %s.gltf.\n" % INTERIOR
        + "\t\tOverhead monitors: trolley node animation _TRACK, 360 frames = degrees round the ceiling\n"
        + "\t\ttrack (L:VATFLOW_x_TRACK_DEG, drag the screen left/right, wraps round); post _LIFT, frame =\n"
        + "\t\tcm below the top of the travel (L:VATFLOW_x_HEIGHT, drag the handle up/down); screen, handle\n"
        + "\t\tand side knobs _TWIST, frame 50 = straight (L:VATFLOW_x_TWIST, drag a side knob).\n"
        + "\t\tShades: 20 strips each, shown past the shade position L:VATFLOW_SHADE_k (0 = up, 100 = down);\n"
        + "\t\tdrag a strip to set the height, click the roller to raise / lower it fully.\n"
        + "\t\tSame behaviours as the VATFLOW Tower Cab (msfs-tower/), on the SDK templates\n"
        + "\t\tASOBO_GT_Anim_Code, ASOBO_GT_Visibility_Code, ASOBO_GT_Interaction_DraggingXAxis_Code /\n"
        + "\t\tDraggingYAxis_Code and ASOBO_GT_Interaction_LeftSingle_Code.\n"
        + "\t-->\n"
        + "\t<CompileBehaviors Version=\"2\">\n"
        + "\t\t<Include ModelBehaviorFile=\"Asobo\\Common.xml\"/>\n\n"
        + "\n".join(comps)
        + "\t</CompileBehaviors>\n</ModelInfo>\n")
    with open(path, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(xml)


def write_exterior_xml(path):
    xml = ("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
           + "<ModelInfo guid=\"%s\" version=\"1.1\">\n" % EXTERIOR_GUID
           + "\t<LODS>\n\t\t<LOD minSize=\"0\" ModelFile=\"%s.gltf\"/>\n\t</LODS>\n</ModelInfo>\n" % EXTERIOR)
    with open(path, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(xml)


FT = 1 / 0.3048
DATUM_BEHIND_FT = 3.6       # the SimpleAircraft sample's model centre is 3.6 ft behind its datum


def light_pos(x, y, z):
    """Blender metres -> systems.cfg LocalPosition (feet from the datum: forward, right, up)."""
    return "%.2f,%.2f,%.2f" % (-y * FT - DATUM_BEHIND_FT, -x * FT, z * FT)


def write_lights(path, ceiling, task):
    """Replaces the [LIGHTS] section of systems.cfg: ceiling lights (cabin 1 / 2), task lights (cabin 3)."""
    lines = ["[LIGHTS]",
             "; DCA Tower Cab (generated by tools/export_dca_cab.py): the cab's ceiling lights (cabin",
             "; circuits 1 and 2, 3.6 m up under the ceiling light discs) and a task light over each position",
             "; (cabin circuit 3 = circuit.40, on at night). Feet from the datum: forward, right, up",
             "; (model centre %.1f ft behind the datum, as in the SimpleAircraft sample)." % DATUM_BEHIND_FT]
    i = 0
    for k, (x, y) in enumerate(ceiling):
        lines.append("lightdef.%d = Type:9#Index:%d#LocalPosition:%s#LocalRotation:90,0,0#EffectFile:LIGHT_ASOBO_CabinBounceLarge"
                     % (i, 1 + k % 2, light_pos(x, y, 3.60)))
        i += 1
    for x, y in task:
        lines.append("lightdef.%d = Type:9#Index:3#LocalPosition:%s#LocalRotation:90,0,0#EffectFile:LIGHT_ASOBO_CabinBounceSmall"
                     % (i, light_pos(x, y, 2.1)))
        i += 1
    with open(path, encoding="utf-8") as f:
        text = f.read()
    text = re.sub(r"\[LIGHTS\].*?(?=\n\[)", "\n".join(lines) + "\n", text, flags=re.S)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def export(collection, out_dir, base):
    w = Writer()
    for obj in bpy.data.collections[collection].objects:
        if obj.type == "MESH":
            w.add_object(obj)
    w.link_nodes()
    w.save(out_dir, base)
    return w


def main(out_dir):
    g = runpy.run_path(BUILD, run_name="__main__")
    os.makedirs(out_dir, exist_ok=True)
    w = export("DcaCab_Interior", out_dir, INTERIOR)
    write_behaviors(os.path.join(out_dir, INTERIOR + ".xml"), [n["name"] for n in w.g["nodes"]])
    export("DcaCab_Exterior", out_dir, EXTERIOR)
    write_exterior_xml(os.path.join(out_dir, EXTERIOR + ".xml"))
    cfg = os.path.join(out_dir, "..", "config", "systems.cfg")
    if os.path.exists(cfg):
        write_lights(cfg, g["CEILING_LIGHTS"], g["TASK_LIGHTS"])
    eye = g["pm"](g["EYE_PX"], g["P"]["eye_h"])
    print("Wrote %s: %d interior nodes, %d animations; %s.gltf; eye point %.2f ft forward of the cab origin, %.2f ft up"
          % (out_dir, len(w.g["nodes"]), len(w.g.get("animations", [])), EXTERIOR, -eye.y * FT, eye.z * FT))


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    if len(args) > 1:
        sys.exit(__doc__)
    main(args[0] if args else os.path.join(SIMOBJ, "model"))
