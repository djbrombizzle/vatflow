"""
MIA Style Tower - parametric tower cab builder for Blender (MSFS 2024).

A large-airport cab inspired by the Miami International (KMIA) tower: an octagonal
cab with four main sides, three windows wide each, joined by a single angled window
at every corner, all of the glass leaning outward. Above the glass: a dark fascia
band, a railed roof, a dark set-back penthouse and a white radome. Below the cab:
the wide white concrete collar (two bands with a groove between), a recessed dark
level with windows behind a railing, a white ledge, and the octagonal shaft flaring
out to meet it.

Inside: carpet, an acoustic-tile ceiling with light panels, consoles round seven of
the eight windows (the rear main side holds the stair well), a monitor, radio panel
and keyboard at each position, a light gun, tower chairs and a supervisor desk. No
live screens yet (see README).

Follows the conventions of msfs-tower/blender/build_tower_cab.py (the KDCA cab) and
class-d-generic-tower, so everything in msfs-tower/SDK-GUIDE.md applies here too.

How to run
  Blender GUI:  Scripting tab -> Open -> this file -> Run Script
  Headless:     blender --background --python build_mia_tower.py
                (add  -- --save out.blend  to save the result)
  Ready to load glTF files: tools/export_gltf.py (no Blender export needed)

Conventions
  * Units are meters. Origin (0,0,0) = center of the cab floor.
  * Forward ("nose" of the SimObject) = Blender -Y. Face k looks along
    -90deg + k*45deg: even k are the main sides (0 front -Y, 2 right +X,
    4 rear +Y with the stairs, 6 left -X), odd k the angled corner windows.
  * Every outline is the cab's floor-level glass outline grown (or shrunk) by an
    offset d in meters, so the octagon keeps its shape at every level.
  * Two collections are created, one per glTF:
      MIA_Exterior -> mia_tower.gltf           (model.cfg normal=)
      MIA_Interior -> mia_tower_interior.gltf  (model.cfg interior=)
"""

import math
import sys

import bmesh
import bpy
from mathutils import Vector

# ---------------------------------------------------------------------------
# Parameters (meters / degrees)
# ---------------------------------------------------------------------------
P = {
    "main_w": 5.4,           # main side width at the floor: three 1.8 m windows
    "main_panes": 3,
    "corner_w": 2.0,         # angled corner window width at the floor: one window
    "sill_h": 0.9,           # solid wall under the glass
    "glass_h": 2.7,          # glass height (vertical)
    "glass_lean_deg": 15.0,  # glass leans outward at the top
    "wall_t": 0.25,          # sill wall thickness
    "mullion_r": 0.05,       # mullion half-width
    "fascia_h": 0.95,        # dark band above the glass
    "roof_overhang": 0.25,
    "rail_h": 1.07,          # railing height (42 in)
    "pent_inset": 1.5,       # penthouse set back this far from the roof edge
    "pent_h": 1.3,
    "dome_r": 1.35,          # radome on top of the penthouse
    "collar_d": 1.9,         # white collar sticks out this far past the glass line
    "collar_top_h": 1.5,     # upper white band
    "collar_mid_h": 0.9,     # lower white band, under the groove
    "dark_level_h": 2.4,     # recessed dark level with windows (junction level)
    "ledge_h": 0.5,          # white ledge under the dark level
    "flare_h": 9.0,          # shaft flares out over this height to meet the ledge
    "shaft_d_top": 1.4,      # shaft outline offset at the top of the flare
    "shaft_d_bottom": -0.6,  # ... and at the bottom
    "shaft_extra_h": 0.0,    # straight shaft below the flare (raise to stand it on the ground)
    "console_depth": 0.75,
    "console_h": 0.92,
    "eye_h": 1.65,           # standing eye height (used for the camera marker)
    "eye_fwd": 1.0,          # eye this far forward of the cab center
}

# Viewport colours (RGBA, linear). tools/export_gltf.py has the sim's PBR values.
COLORS = {
    "TWR_Concrete": (0.80, 0.80, 0.78, 1.0),
    "TWR_Fascia": (0.015, 0.015, 0.02, 1.0),
    "TWR_Dark": (0.02, 0.02, 0.025, 1.0),
    "TWR_Mullion": (0.40, 0.40, 0.40, 1.0),
    "TWR_Glass": (0.10, 0.14, 0.18, 0.3),
    "TWR_Metal": (0.60, 0.60, 0.58, 1.0),
    "TWR_Roof": (0.25, 0.25, 0.25, 1.0),
    "TWR_Dome": (0.85, 0.85, 0.85, 1.0),
    "TWR_Equipment": (0.70, 0.70, 0.66, 1.0),
    "TWR_Carpet": (0.03, 0.04, 0.06, 1.0),
    "TWR_Ceiling": (0.55, 0.55, 0.52, 1.0),
    "TWR_Sill": (0.45, 0.42, 0.36, 1.0),
    "TWR_ConsoleTop": (0.25, 0.25, 0.24, 1.0),
    "TWR_ConsoleFront": (0.30, 0.28, 0.24, 1.0),
    "TWR_ConsoleKick": (0.02, 0.02, 0.02, 1.0),
    "TWR_Bezel": (0.01, 0.01, 0.01, 1.0),
    "TWR_ScreenOff": (0.004, 0.006, 0.008, 1.0),
    "TWR_PanelGrey": (0.25, 0.26, 0.27, 1.0),
    "TWR_KeyGreen": (0.02, 0.20, 0.04, 1.0),
    "TWR_LightGun": (0.10, 0.10, 0.10, 1.0),
    "TWR_ChairSeat": (0.01, 0.01, 0.012, 1.0),
    "TWR_Stairwell": (0.008, 0.008, 0.008, 1.0),
}

N = 8  # faces of the octagon


# ---------------------------------------------------------------------------
# Octagon outline: face k has outward normal at face_angle(k) and sits h_k + d
# from the center (h = main or corner apothem). Vertex i is where face i-1 meets
# face i, so face k runs from vertex k to vertex k+1.
# ---------------------------------------------------------------------------
def face_angle(k):
    return -math.pi / 2 + 2 * math.pi / N * k


def apothem(k):
    half = P["main_w"] / 2
    a_main = half + P["corner_w"] / math.sqrt(2)
    return a_main if k % 2 == 0 else (a_main + half) / math.sqrt(2)


def corner(i, d, z):
    a1, a2 = face_angle(i - 1), face_angle(i)
    n1x, n1y, n2x, n2y = math.cos(a1), math.sin(a1), math.cos(a2), math.sin(a2)
    h1, h2 = apothem(i - 1) + d, apothem(i) + d
    det = n1x * n2y - n1y * n2x
    return Vector(((h1 * n2y - h2 * n1y) / det, (n1x * h2 - n2x * h1) / det, z))


def outline(d, z):
    return [corner(i, d, z) for i in range(N)]


def material(name):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    rgba = COLORS[name]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = 0.6
    mat.diffuse_color = rgba
    mat.use_backface_culling = False  # exported as doubleSided; visible from inside and out
    if name == "TWR_Glass":
        bsdf.inputs["Alpha"].default_value = rgba[3]
        bsdf.inputs["Roughness"].default_value = 0.05
        mat.blend_method = "BLEND"
    if name in ("TWR_Metal", "TWR_Mullion"):
        bsdf.inputs["Metallic"].default_value = 0.8
        bsdf.inputs["Roughness"].default_value = 0.4
    return mat


class Builder:
    """Collects geometry per material into one bmesh, then makes one object."""

    def __init__(self, name, collection):
        self.name = name
        self.collection = collection
        self.bm = bmesh.new()
        self.mats = []

    def mat_index(self, mat_name):
        if mat_name not in self.mats:
            self.mats.append(mat_name)
        return self.mats.index(mat_name)

    def face(self, pts, mat_name):
        verts = [self.bm.verts.new(p) for p in pts]
        f = self.bm.faces.new(verts)
        f.material_index = self.mat_index(mat_name)
        return f

    def quad_strip(self, lower, upper, mat_name, closed=True):
        n = len(lower)
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            self.face([lower[i], lower[j], upper[j], upper[i]], mat_name)

    def prism(self, d_bottom, d_top, z0, z1, mat_name, caps=True):
        lo, hi = outline(d_bottom, z0), outline(d_top, z1)
        self.quad_strip(lo, hi, mat_name)
        if caps:
            self.face(list(reversed(lo)), mat_name)
            self.face(hi, mat_name)

    def ring(self, d_in0, d_out0, d_in1, d_out1, z0, z1, mat_name, sides=None):
        """Band between two outlines, optionally only some faces (sides)."""
        for k in sides if sides is not None else range(N):
            i, j = k, (k + 1) % N
            o0, jo0 = corner(i, d_out0, z0), corner(j, d_out0, z0)
            o1, jo1 = corner(i, d_out1, z1), corner(j, d_out1, z1)
            i0, ji0 = corner(i, d_in0, z0), corner(j, d_in0, z0)
            i1, ji1 = corner(i, d_in1, z1), corner(j, d_in1, z1)
            self.face([o0, jo0, jo1, o1], mat_name)     # outer
            self.face([ji0, i0, i1, ji1], mat_name)     # inner
            self.face([i1, o1, jo1, ji1], mat_name)     # top
            self.face([i0, ji0, jo0, o0], mat_name)     # bottom
            if sides is not None:  # open ends need caps
                self.face([i0, o0, o1, i1], mat_name)
                self.face([jo0, ji0, ji1, jo1], mat_name)

    def beam(self, p0, p1, r, mat_name, segs=4):
        """Prism of radius r from p0 to p1 (posts, rails, mullions, masts)."""
        p0, p1 = Vector(p0), Vector(p1)
        q = (p1 - p0).to_track_quat("Z", "Y")
        ring0, ring1 = [], []
        for s in range(segs):
            a = 2 * math.pi * s / segs + math.pi / segs
            off = q @ Vector((r * math.cos(a), r * math.sin(a), 0))
            ring0.append(p0 + off)
            ring1.append(p1 + off)
        self.quad_strip(ring0, ring1, mat_name)
        self.face(list(reversed(ring0)), mat_name)
        self.face(ring1, mat_name)

    def box(self, center, size, mat_name, rot_z=0.0, top_mat=None, front_mat=None):
        """Box turned rot_z about Z. front_mat colours the local -Y face (a screen, a panel)."""
        cx, cy, cz = center
        sx, sy, sz = (s / 2 for s in size)
        c, s = math.cos(rot_z), math.sin(rot_z)

        def v(x, y, z):
            return Vector((cx + x * c - y * s, cy + x * s + y * c, cz + z))

        b = [v(-sx, -sy, -sz), v(sx, -sy, -sz), v(sx, sy, -sz), v(-sx, sy, -sz)]
        t = [v(-sx, -sy, sz), v(sx, -sy, sz), v(sx, sy, sz), v(-sx, sy, sz)]
        for i in range(4):
            j = (i + 1) % 4
            self.face([b[i], b[j], t[j], t[i]], front_mat if (i == 0 and front_mat) else mat_name)
        self.face(list(reversed(b)), mat_name)
        self.face(t, top_mat or mat_name)

    def cylinder(self, center, r, z0, z1, mat_name, segs=16):
        cx, cy = center
        lo = [Vector((cx + r * math.cos(2 * math.pi * i / segs), cy + r * math.sin(2 * math.pi * i / segs), z0))
              for i in range(segs)]
        hi = [Vector((v.x, v.y, z1)) for v in lo]
        self.quad_strip(lo, hi, mat_name)
        self.face(list(reversed(lo)), mat_name)
        self.face(hi, mat_name)

    def dome(self, center, r, z0, mat_name, segs=24, rings=8):
        cx, cy = center
        prev = None
        for j in range(rings):
            el = math.pi / 2 * j / rings
            cur = [Vector((cx + r * math.cos(el) * math.cos(2 * math.pi * i / segs),
                           cy + r * math.cos(el) * math.sin(2 * math.pi * i / segs), z0 + r * math.sin(el)))
                   for i in range(segs)]
            if prev:
                self.quad_strip(prev, cur, mat_name)
            prev = cur
        top = Vector((cx, cy, z0 + r))
        for i in range(segs):
            self.face([prev[i], prev[(i + 1) % segs], top], mat_name)

    def finish(self):
        me = bpy.data.meshes.new(self.name)
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(material(m))
        obj = bpy.data.objects.new(self.name, me)
        self.collection.objects.link(obj)
        return obj


def face_frame(k, d_inner):
    """Placing things on console face k: at(right, depth, z) and the box turn rot."""
    ang = face_angle(k)
    out = Vector((math.cos(ang), math.sin(ang), 0))
    right = Vector((math.sin(ang), -math.cos(ang), 0))
    rot = ang - math.pi / 2          # box local -y faces the controller (away from the window)

    def at(r, depth, z):
        return out * (apothem(k) + d_inner - depth) + right * r + Vector((0, 0, z))

    return at, rot


def railing(b, p0, p1, h, spacing=1.4):
    seg = p1 - p0
    posts = max(1, int(seg.length / spacing))
    for s in range(posts + 1):
        p = p0 + seg * (s / posts)
        b.beam(p, p + Vector((0, 0, h)), 0.025, "TWR_Metal")
    for z in (h, h * 0.5):
        b.beam(p0 + Vector((0, 0, z)), p1 + Vector((0, 0, z)), 0.022, "TWR_Metal")


def rail_round(b, d, z, h):
    for k in range(N):
        railing(b, corner(k, d, z), corner(k + 1, d, z), h)


def chair(b, x, y, rot):
    """Tall tower chair: five-star base, gas post, seat, backrest. Faces local -Y turned by rot."""
    c, s = math.cos(rot), math.sin(rot)
    for i in range(5):
        a = 2 * math.pi * i / 5
        b.beam((x, y, 0.06), (x + 0.32 * math.cos(a), y + 0.32 * math.sin(a), 0.04), 0.02, "TWR_Metal")
    b.cylinder((x, y), 0.03, 0.06, 0.70, "TWR_Metal", segs=10)
    b.box((x, y, 0.74), (0.48, 0.46, 0.08), "TWR_ChairSeat", rot_z=rot)
    back = Vector((x, y, 0)) + Vector((-s, c, 0)) * 0.24
    b.box((back.x, back.y, 1.02), (0.44, 0.06, 0.48), "TWR_ChairSeat", rot_z=rot)


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(bpy.data.collections):
        if coll.name.startswith("MIA_"):
            bpy.data.collections.remove(coll)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def new_collection(name):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    return coll


def glass_and_frames(b, mullion_r, rail_r, glass=True):
    """Glass panes and mullions: main sides split into main_panes windows, corners one."""
    z0 = P["sill_h"]
    z1 = z0 + P["glass_h"]
    d1 = P["glass_h"] * math.tan(math.radians(P["glass_lean_deg"]))
    for k in range(N):
        lo0, lo1 = corner(k, 0, z0), corner(k + 1, 0, z0)
        hi0, hi1 = corner(k, d1, z1), corner(k + 1, d1, z1)
        if glass:
            b.face([lo0, lo1, hi1, hi0], "TWR_Glass")
        b.beam(lo0, hi0, mullion_r, "TWR_Mullion")
        b.beam(lo0, lo1, rail_r, "TWR_Mullion")
        b.beam(hi0, hi1, rail_r, "TWR_Mullion")
        panes = P["main_panes"] if k % 2 == 0 else 1
        for s in range(1, panes):
            t = s / panes
            b.beam(lo0.lerp(lo1, t), hi0.lerp(hi1, t), mullion_r * 0.8, "TWR_Mullion")


def build():
    clear_scene()
    z_glass0 = P["sill_h"]
    z_glass1 = z_glass0 + P["glass_h"]
    d1 = P["glass_h"] * math.tan(math.radians(P["glass_lean_deg"]))
    d_roof = d1 + P["roof_overhang"]
    z_roof = z_glass1 + P["fascia_h"]
    cd = P["collar_d"]
    z_ct = z_glass0 - 0.05                      # top of the white collar, just under the glass

    ext_coll = new_collection("MIA_Exterior")
    int_coll = new_collection("MIA_Interior")

    # --- Exterior: collar, dark level, ledge, shaft ---------------------------
    shell = Builder("MIA_Shell", ext_coll)
    z = z_ct
    # upper band: a ring, so its top doesn't cover the cab floor (inner edge hides behind the sill)
    shell.ring(-0.1, cd, -0.1, cd, z - P["collar_top_h"], z, "TWR_Concrete")
    z -= P["collar_top_h"]
    shell.prism(cd - 0.15, cd - 0.15, z - 0.1, z, "TWR_Concrete", caps=False)  # groove
    z -= 0.1
    shell.prism(cd - 0.05, cd - 0.05, z - P["collar_mid_h"], z, "TWR_Concrete")  # lower band
    z -= P["collar_mid_h"]
    z_dark1 = z
    z -= P["dark_level_h"]
    z_dark0 = z
    shell.prism(cd, cd, z - P["ledge_h"], z, "TWR_Concrete")                  # ledge
    z -= P["ledge_h"]
    # flared shaft: the outline offset eases from shaft_d_top to shaft_d_bottom
    steps = 10
    rings = []
    for s in range(steps + 1):
        t = s / steps
        d = P["shaft_d_bottom"] + (P["shaft_d_top"] - P["shaft_d_bottom"]) * (1 - t) ** 2.2
        rings.append(outline(d, z - P["flare_h"] * t))
    if P["shaft_extra_h"] > 0:
        rings.append(outline(P["shaft_d_bottom"], z - P["flare_h"] - P["shaft_extra_h"]))
    for lo, hi in zip(rings[1:], rings[:-1]):
        shell.quad_strip(lo, hi, "TWR_Concrete")
    shell.face(list(reversed(rings[-1])), "TWR_Concrete")
    # roof slab
    shell.prism(d1 - 0.05, d1 - 0.05, z_roof - 0.05, z_roof, "TWR_Roof")
    shell.finish()

    dark = Builder("MIA_DarkLevel", ext_coll)
    dark.prism(0.3, 0.3, z_dark0, z_dark1, "TWR_Dark", caps=False)
    for k in range(N):        # window band on the dark level
        dark.face([corner(k, 0.32, z_dark0 + 0.5), corner(k + 1, 0.32, z_dark0 + 0.5),
                   corner(k + 1, 0.32, z_dark1 - 0.3), corner(k, 0.32, z_dark1 - 0.3)],
                  "TWR_Glass")
    dark.finish()

    fascia = Builder("MIA_Fascia", ext_coll)
    fascia.prism(d1, d_roof, z_glass1, z_glass1 + 0.15, "TWR_Fascia")
    fascia.prism(d_roof, d_roof, z_glass1 + 0.15, z_roof, "TWR_Fascia", caps=False)
    # thin dark strip between the collar and the glass
    fascia.prism(0.02, 0.02, z_ct, z_glass0, "TWR_Fascia", caps=False)
    fascia.finish()

    glass = Builder("MIA_Glass", ext_coll)
    for k in range(N):
        glass.face([corner(k, 0, z_glass0), corner(k + 1, 0, z_glass0),
                    corner(k + 1, d1, z_glass1), corner(k, d1, z_glass1)], "TWR_Glass")
    glass.finish()

    frame = Builder("MIA_Frame", ext_coll)
    glass_and_frames(frame, P["mullion_r"], 0.04, glass=False)
    frame.finish()

    roof = Builder("MIA_RoofGear", ext_coll)
    rail_round(roof, d_roof - 0.1, z_roof, P["rail_h"])
    rail_round(roof, cd - 0.15, z_dark0, P["rail_h"])                         # dark level railing
    # penthouse, its roof rail, and the radome
    d_p = d_roof - P["pent_inset"]
    z_p = z_roof + P["pent_h"]
    roof.prism(d_p, d_p, z_roof, z_p, "TWR_Dark")
    roof.prism(d_p + 0.1, d_p + 0.1, z_p, z_p + 0.12, "TWR_Fascia")
    rail_round(roof, d_p, z_p + 0.12, 0.9)
    roof.cylinder((0, 0), P["dome_r"], z_p + 0.12, z_p + 0.6, "TWR_Dark", segs=24)
    roof.dome((0, 0), P["dome_r"], z_p + 0.6, "TWR_Dome")
    # two antenna masts, front left and back right of the roof
    for i, h in ((0, 4.5), (4, 3.5)):
        p = corner(i, d_roof - 0.4, z_roof)
        roof.beam(p, p + Vector((0, 0, h)), 0.035, "TWR_Metal", segs=10)
        roof.beam(p + Vector((0, 0, h - 0.8)), p + Vector((0, 0, h + 0.4)), 0.015, "TWR_Metal", segs=6)
    roof.finish()

    # --- Interior -------------------------------------------------------------
    inside = Builder("MIA_Interior", int_coll)
    wt = P["wall_t"]
    d_in = -wt
    inside.prism(d_in, d_in, -0.02, 0.0, "TWR_Carpet")                                        # floor
    inside.face(list(reversed(outline(d1 - 0.02, z_glass1 - 0.01))), "TWR_Ceiling")
    # window sill seen from inside (MSFS doesn't draw the exterior model in the cockpit view)
    inside.ring(d_in, -0.01, d_in, -0.01, 0.0, z_glass0, "TWR_Sill")
    # the collar top seen through the glass, and the window frames, slightly thinner
    inside.ring(0.0, cd, 0.0, cd, z_ct - 0.1, z_ct, "TWR_Concrete")
    glass_and_frames(inside, P["mullion_r"] * 0.85, 0.034, glass=False)

    # consoles round every window but the rear main side (4), which has the stairs
    top = P["console_h"]
    d_c = d_in - P["console_depth"]
    sides = [5, 6, 7, 0, 1, 2, 3]
    inside.ring(d_c, d_in, d_c, d_in, top - 0.04, top, "TWR_ConsoleTop", sides=sides)
    inside.ring(d_c, d_in, d_c, d_in, 0.10, top - 0.04, "TWR_ConsoleFront", sides=sides)
    inside.ring(d_c + 0.06, d_in, d_c + 0.06, d_in, 0.0, 0.10, "TWR_ConsoleKick", sides=sides)
    # low cabinets along the rear wall either side of the stair well
    y_rear = apothem(4) + d_in
    x_end = corner(5, d_c, 0).x            # where the rear corner consoles stop
    for x0, x1 in ((-abs(x_end), -1.05), (1.05, abs(x_end))):
        inside.box(((x0 + x1) / 2, y_rear - 0.225, top / 2), (x1 - x0, 0.45, top), "TWR_ConsoleFront",
                   top_mat="TWR_ConsoleTop")

    # positions (see /research/tower-cab-interior-layouts.md, "Miami-style octagonal cab"):
    # each runway side gets a Local + Ground pair side by side on the window line, support
    # positions on the other faces, the supervisor and TMC at a U desk in the middle.
    positions = [
        (0, -1.5, "LC1"), (0, 0.3, "GC1"),          # front: main Local / Ground pair
        (2, -1.0, "LC2"), (2, 1.0, "GC2"),          # right: second runway complex
        (6, -1.0, "CD"), (6, 1.0, "FD"),            # left: Clearance Delivery, Flight Data
        (1, -0.25, "CC1"), (7, -0.25, "CC2"),       # front corners: cab coordinator / assist
        (3, -0.25, "RAMP"), (5, -0.25, "VFR"),      # rear corners: ramp / flow, Class B radar
    ]
    for k, r, _name in positions:
        at, rot = face_frame(k, d_in)
        inside.box(at(r, 0.45, top + 0.03), (0.30, 0.20, 0.02), "TWR_Bezel", rot_z=rot)
        inside.box(at(r, 0.45, top + 0.12), (0.06, 0.04, 0.16), "TWR_Bezel", rot_z=rot)
        inside.box(at(r, 0.47, top + 0.36), (0.56, 0.05, 0.36), "TWR_Bezel", rot_z=rot, front_mat="TWR_ScreenOff")
        inside.box(at(r + 0.55, 0.40, top + 0.05), (0.40, 0.28, 0.10), "TWR_PanelGrey", rot_z=rot,
                   top_mat="TWR_KeyGreen")
        inside.box(at(r, 0.62, top + 0.012), (0.44, 0.15, 0.024), "TWR_Bezel", rot_z=rot)
        p = at(r, P["console_depth"] + 0.45, 0)
        chair(inside, p.x, p.y, rot)
    at, rot = face_frame(0, d_in)
    lg = at(1.6, 0.25, 0)
    inside.cylinder((lg.x, lg.y), 0.09, top, top + 0.18, "TWR_LightGun", segs=14)            # light gun
    inside.box(at(1.6, 0.25, top + 0.20), (0.06, 0.20, 0.05), "TWR_LightGun", rot_z=rot)

    # supervisor + TMC U desk in the middle of the cab, facing the front windows
    inside.box((0.0, 0.1, top / 2), (2.6, 0.6, top), "TWR_ConsoleFront", top_mat="TWR_ConsoleTop")
    for x in (-1.0, 1.0):
        inside.box((x, 0.8, top / 2), (0.6, 0.8, top), "TWR_ConsoleFront", top_mat="TWR_ConsoleTop")
        inside.box((x * 0.45, 0.05, top + 0.30), (0.56, 0.05, 0.36), "TWR_Bezel", rot_z=math.pi,
                   front_mat="TWR_ScreenOff")
        inside.box((x * 0.45, 0.05, top + 0.06), (0.06, 0.20, 0.12), "TWR_Bezel")
        inside.box((x * 0.45, 0.28, top + 0.012), (0.44, 0.15, 0.024), "TWR_Bezel")
        chair(inside, x * 0.4, 0.85, 0.0)

    # stair well at the back: dark opening in the floor with a guard rail on three sides
    sw0, sw1 = Vector((-0.9, y_rear - 2.2, 0)), Vector((0.9, y_rear, 0))
    inside.box(((sw0.x + sw1.x) / 2, (sw0.y + sw1.y) / 2, 0.003), (sw1.x - sw0.x, sw1.y - sw0.y, 0.004),
               "TWR_Stairwell")
    railing(inside, Vector((sw0.x, sw1.y - 0.05, 0)), Vector((sw0.x, sw0.y, 0)), P["rail_h"], spacing=1.2)
    railing(inside, Vector((sw1.x, sw1.y - 0.05, 0)), Vector((sw1.x, sw0.y + 0.9, 0)), P["rail_h"], spacing=1.2)
    railing(inside, Vector((sw0.x, sw0.y, 0)), Vector((sw1.x - 0.9, sw0.y, 0)), P["rail_h"], spacing=1.2)
    # ceiling light panels
    for x in (-1.6, 0.0, 1.6):
        for y in (-1.6, 1.6):
            inside.box((x, y, z_glass1 - 0.02), (0.6, 0.6, 0.02), "TWR_Equipment")
    inside.finish()

    # Eye point marker (not exported): where the MSFS eyepoint should be
    eye = bpy.data.objects.new("EYEPOINT_marker", None)
    eye.empty_display_type = "SPHERE"
    eye.empty_display_size = 0.1
    eye.location = (0.0, -P["eye_fwd"], P["eye_h"])
    bpy.context.scene.collection.objects.link(eye)

    print("MIA tower built: glass %.2f-%.2f m, roof %.2f m, cab %.1f m across, shaft bottom %.1f m, eye %.2f m"
          % (z_glass0, z_glass1, z_roof, 2 * apothem(0), z - P["flare_h"] - P["shaft_extra_h"], P["eye_h"]))


def main():
    build()
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--save" in argv:
        path = argv[argv.index("--save") + 1]
        bpy.ops.wm.save_as_mainfile(filepath=path)
        print("Saved", path)


if __name__ == "__main__":
    main()
