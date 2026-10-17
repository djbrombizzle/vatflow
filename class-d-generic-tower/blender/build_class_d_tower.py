"""
Class D Generic Tower - parametric tower cab builder for Blender (MSFS 2024).

Builds a generic US Class D (VFR) tower top: a square, four-sided cab with
outward-leaning glass on all four sides, slim corner mullions, a railed
catwalk round the glass, a dark fascia band and flat roof with a railed
parapet, antenna masts and a small equipment house, standing on a square
concrete shaft.

Inside: carpet, a light acoustic-tile ceiling, a U of consoles along the
front, left and right windows, plain monitors and radio panels on them, a
light gun, two tower chairs, and the stair well at the back (the rear
window side). No live screens yet; that is the next step (see README).

Follows the conventions of msfs-tower/blender/build_tower_cab.py (the KDCA
cab), so everything in msfs-tower/SDK-GUIDE.md applies to this model too.

How to run
  Blender GUI:  Scripting tab -> Open -> this file -> Run Script
  Headless:     blender --background --python build_class_d_tower.py
                (add  -- --save out.blend  to save the result)
  Ready to load glTF files: tools/export_gltf.py (no Blender export needed)

Conventions
  * Units are meters. Origin (0,0,0) = center of the cab floor.
  * Forward ("nose" of the SimObject) = Blender -Y. Face 0 (front window)
    looks along -Y, face 1 along +X (right), face 2 along +Y (rear, stairs),
    face 3 along -X (left).
  * Two collections are created, one per glTF:
      ClassD_Exterior -> class_d_tower.gltf           (model.cfg normal=)
      ClassD_Interior -> class_d_tower_interior.gltf  (model.cfg interior=)
"""

import math
import sys

import bmesh
import bpy
from mathutils import Vector

# ---------------------------------------------------------------------------
# Parameters (meters / degrees). A typical small FAA Class D cab: about
# 21 ft square at the floor, glass leaning out about 12 degrees.
# ---------------------------------------------------------------------------
P = {
    "sides": 4,
    "apothem": 3.2,          # floor-level center-to-glass distance (cab 6.4 m / 21 ft across)
    "sill_h": 0.95,          # solid wall under the glass
    "glass_h": 2.45,         # glass height (vertical)
    "glass_lean_deg": 12.0,  # glass leans outward at the top
    "wall_t": 0.25,          # sill wall thickness
    "mullion_r": 0.06,       # corner mullion half-width
    "catwalk_depth": 0.9,    # catwalk deck out from the glass line
    "rail_h": 1.07,          # railing height (42 in)
    "under_band_h": 0.55,    # band under the catwalk (floor structure)
    "fascia_h": 0.75,        # dark fascia band above the glass
    "roof_overhang": 0.30,
    "parapet_h": 0.30,       # low wall round the roof
    "shaft_apothem": 2.2,    # square concrete shaft under the cab (4.4 m across)
    "shaft_h": 8.0,          # how far the shaft goes down. 8 m sits on top of the sim's own
                             # tower like the KDCA cab; set ~20 m for a free-standing tower
    "console_depth": 0.75,
    "console_h": 0.92,
    "eye_h": 1.65,           # standing eye height (used for the camera marker)
    "eye_fwd": 0.6,          # eye this far forward of the cab center
}

# Viewport colours (RGBA, linear). tools/export_gltf.py has the sim's PBR values.
COLORS = {
    "TWR_Concrete": (0.80, 0.77, 0.70, 1.0),
    "TWR_Fascia": (0.05, 0.045, 0.04, 1.0),
    "TWR_Mullion": (0.05, 0.045, 0.04, 1.0),
    "TWR_Glass": (0.40, 0.50, 0.55, 0.15),
    "TWR_Metal": (0.60, 0.60, 0.58, 1.0),
    "TWR_Roof": (0.25, 0.25, 0.25, 1.0),
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


# ---------------------------------------------------------------------------
# Helpers (same geometry conventions as msfs-tower/blender/build_tower_cab.py)
# ---------------------------------------------------------------------------
def corner_radius(apothem):
    return apothem / math.cos(math.pi / P["sides"])


def corner_angle(i):
    # Flat face toward -Y: face k is centered at -90deg + k*360/n,
    # corners sit half a step either side.
    step = 2 * math.pi / P["sides"]
    return -math.pi / 2 + step * (i - 0.5)


def face_angle(k):
    return -math.pi / 2 + 2 * math.pi / P["sides"] * k


def corner(i, apothem, z):
    a = corner_angle(i)
    r = corner_radius(apothem)
    return Vector((r * math.cos(a), r * math.sin(a), z))


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
    if name == "TWR_Metal":
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

    def prism(self, apothem_bottom, apothem_top, z0, z1, mat_name, caps=True):
        n = P["sides"]
        lo = [corner(i, apothem_bottom, z0) for i in range(n)]
        hi = [corner(i, apothem_top, z1) for i in range(n)]
        self.quad_strip(lo, hi, mat_name)
        if caps:
            self.face(list(reversed(lo)), mat_name)
            self.face(hi, mat_name)

    def ring(self, a_in0, a_out0, a_in1, a_out1, z0, z1, mat_name, sides=None):
        """Annulus between two squares, optionally only some faces (sides)."""
        n = P["sides"]
        for k in sides if sides is not None else range(n):
            i, j = k, k + 1
            o0, jo0 = corner(i, a_out0, z0), corner(j, a_out0, z0)
            o1, jo1 = corner(i, a_out1, z1), corner(j, a_out1, z1)
            i0, ji0 = corner(i, a_in0, z0), corner(j, a_in0, z0)
            i1, ji1 = corner(i, a_in1, z1), corner(j, a_in1, z1)
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


def face_frame(k, a_inner):
    """Placing things on console face k: at(right, depth, z) and the box turn rot."""
    ang = face_angle(k)
    out = Vector((math.cos(ang), math.sin(ang), 0))
    right = Vector((math.sin(ang), -math.cos(ang), 0))
    rot = ang - math.pi / 2          # box local -y faces the controller (away from the window)

    def at(r, depth, z):
        return out * (a_inner - depth) + right * r + Vector((0, 0, z))

    return at, rot


def railing(b, p0, p1, h, spacing=1.4):
    seg = p1 - p0
    posts = max(1, int(seg.length / spacing))
    for s in range(posts + 1):
        p = p0 + seg * (s / posts)
        b.beam(p, p + Vector((0, 0, h)), 0.025, "TWR_Metal")
    for z in (h, h * 0.5):
        b.beam(p0 + Vector((0, 0, z)), p1 + Vector((0, 0, z)), 0.022, "TWR_Metal")


def chair(b, x, y, rot):
    """Tall tower chair: five-star base, gas post, seat, backrest."""
    c, s = math.cos(rot), math.sin(rot)
    for i in range(5):
        a = 2 * math.pi * i / 5
        b.beam((x, y, 0.06), (x + 0.32 * math.cos(a), y + 0.32 * math.sin(a), 0.04), 0.02, "TWR_Metal")
    b.cylinder((x, y), 0.03, 0.06, 0.70, "TWR_Metal", segs=10)
    b.beam((x - 0.25, y, 0.40), (x + 0.25, y, 0.40), 0.012, "TWR_Metal")   # foot ring (simplified)
    b.box((x, y, 0.74), (0.48, 0.46, 0.08), "TWR_ChairSeat", rot_z=rot)
    back = Vector((x, y, 0)) + Vector((-s, c, 0)) * 0.24
    b.box((back.x, back.y, 1.02), (0.44, 0.06, 0.48), "TWR_ChairSeat", rot_z=rot)


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(bpy.data.collections):
        if coll.name.startswith("ClassD_"):
            bpy.data.collections.remove(coll)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def new_collection(name):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    return coll


def build():
    clear_scene()
    n = P["sides"]
    a0 = P["apothem"]
    z_glass0 = P["sill_h"]
    z_glass1 = z_glass0 + P["glass_h"]
    a1 = a0 + P["glass_h"] * math.tan(math.radians(P["glass_lean_deg"]))
    a_roof = a1 + P["roof_overhang"]
    z_roof = z_glass1 + P["fascia_h"]
    z_floor_under = -P["under_band_h"]

    ext_coll = new_collection("ClassD_Exterior")
    int_coll = new_collection("ClassD_Interior")

    # --- Exterior shell -----------------------------------------------------
    shell = Builder("ClassD_Shell", ext_coll)
    # sill wall under the glass
    shell.ring(a0 - P["wall_t"], a0, a0 - P["wall_t"], a0, 0.0, z_glass0, "TWR_Concrete")
    # floor structure under the cab, flush with the catwalk edge
    shell.prism(a0 + P["catwalk_depth"], a0 + P["catwalk_depth"], z_floor_under, -0.1, "TWR_Concrete")
    # catwalk deck
    shell.ring(a0, a0 + P["catwalk_depth"], a0, a0 + P["catwalk_depth"], -0.1, 0.0, "TWR_Roof")
    # square concrete shaft
    shell.prism(P["shaft_apothem"], P["shaft_apothem"], z_floor_under - P["shaft_h"], z_floor_under, "TWR_Concrete")
    # roof slab and parapet
    shell.prism(a1 - 0.05, a1 - 0.05, z_roof - 0.05, z_roof, "TWR_Roof")
    shell.ring(a_roof - 0.2, a_roof, a_roof - 0.2, a_roof, z_roof, z_roof + P["parapet_h"], "TWR_Concrete")
    shell.finish()

    fascia = Builder("ClassD_Fascia", ext_coll)
    # dark band above the glass, sloping out to the overhang
    fascia.prism(a1, a_roof, z_glass1, z_glass1 + 0.15, "TWR_Fascia")
    fascia.prism(a_roof, a_roof, z_glass1 + 0.15, z_roof, "TWR_Fascia", caps=False)
    fascia.finish()

    glass = Builder("ClassD_Glass", ext_coll)
    for k in range(n):
        glass.face([corner(k, a0, z_glass0), corner(k + 1, a0, z_glass0),
                    corner(k + 1, a1, z_glass1), corner(k, a1, z_glass1)], "TWR_Glass")
    glass.finish()

    frame = Builder("ClassD_Frame", ext_coll)
    for k in range(n):
        frame.beam(corner(k, a0, z_glass0), corner(k, a1, z_glass1), P["mullion_r"], "TWR_Mullion")
        frame.beam(corner(k, a0, z_glass0), corner(k + 1, a0, z_glass0), 0.04, "TWR_Mullion")
        frame.beam(corner(k, a1, z_glass1), corner(k + 1, a1, z_glass1), 0.04, "TWR_Mullion")
    frame.finish()

    roof = Builder("ClassD_RoofGear", ext_coll)
    a_rail = a0 + P["catwalk_depth"] - 0.05
    for k in range(n):
        railing(roof, corner(k, a_rail, 0.0), corner(k + 1, a_rail, 0.0), P["rail_h"])
        railing(roof, corner(k, a_roof - 0.1, z_roof + P["parapet_h"]),
                corner(k + 1, a_roof - 0.1, z_roof + P["parapet_h"]), 0.75)
    # equipment house (HVAC / radio room) on the back half of the roof
    roof.box((0.0, 1.2, z_roof + 0.6), (2.0, 1.6, 1.2), "TWR_Equipment")
    roof.box((0.0, 1.2, z_roof + 1.22), (2.2, 1.8, 0.05), "TWR_Fascia")
    # antenna masts at three roof corners, the wind sensor mast at the fourth
    for i, h in ((0, 4.0), (1, 3.0), (2, 5.0)):
        p = corner(i, a_roof - 0.4, z_roof)
        roof.beam(p, p + Vector((0, 0, h)), 0.035, "TWR_Metal", segs=10)
        roof.beam(p + Vector((0, 0, h - 0.8)), p + Vector((0, 0, h + 0.4)), 0.015, "TWR_Metal", segs=6)
    p = corner(3, a_roof - 0.4, z_roof)
    top = p + Vector((0, 0, 4.5))
    roof.beam(p, top, 0.04, "TWR_Metal", segs=10)
    roof.beam(top + Vector((-0.4, 0, 0)), top + Vector((0.4, 0, 0)), 0.015, "TWR_Metal")   # cross arm
    roof.cylinder((top.x - 0.4, top.y), 0.06, top.z, top.z + 0.12, "TWR_Equipment")       # wind cups
    roof.cylinder((top.x + 0.4, top.y), 0.03, top.z, top.z + 0.35, "TWR_Equipment")       # vane
    roof.finish()

    # --- Interior -----------------------------------------------------------
    inside = Builder("ClassD_Interior", int_coll)
    a_inner = a0 - P["wall_t"]
    inside.prism(a_inner, a_inner, -0.02, 0.0, "TWR_Carpet")                       # floor
    inside.face(list(reversed([corner(i, a1 - 0.02, z_glass1 - 0.01) for i in range(n)])), "TWR_Ceiling")
    # window sill seen from inside (MSFS doesn't draw the exterior model in the cockpit view)
    inside.ring(a_inner, a0 - 0.01, a_inner, a0 - 0.01, 0.0, z_glass0, "TWR_Sill")
    # interior copy of the window frames, slightly thinner so the two don't fight from outside
    for k in range(n):
        inside.beam(corner(k, a0, z_glass0), corner(k, a1, z_glass1), P["mullion_r"] * 0.85, "TWR_Mullion")
        inside.beam(corner(k, a0, z_glass0), corner(k + 1, a0, z_glass0), 0.034, "TWR_Mullion")
        inside.beam(corner(k, a1, z_glass1), corner(k + 1, a1, z_glass1), 0.034, "TWR_Mullion")

    # consoles: a U along the front (0), right (1) and left (3) windows; the rear (2) is the stairs
    top = P["console_h"]
    a_in = a_inner - P["console_depth"]
    sides = [0, 1, 3]
    inside.ring(a_in, a_inner, a_in, a_inner, top - 0.04, top, "TWR_ConsoleTop", sides=sides)
    inside.ring(a_in, a_inner, a_in, a_inner, 0.10, top - 0.04, "TWR_ConsoleFront", sides=sides)
    inside.ring(a_in + 0.06, a_inner, a_in + 0.06, a_inner, 0.0, 0.10, "TWR_ConsoleKick", sides=sides)
    # rear wall cabinets either side of the stair well, half depth
    a_cab = a_inner - 0.45
    for x0, x1 in ((-a_inner + P["console_depth"], -0.95), (0.95, a_inner - P["console_depth"])):
        inside.box(((x0 + x1) / 2, (a_inner + a_cab) / 2, top / 2), (x1 - x0, a_inner - a_cab, top), "TWR_ConsoleFront",
                   top_mat="TWR_ConsoleTop")

    # console equipment: a monitor and a radio panel per position, light gun on the front console
    for k, positions in ((0, (-1.1, 1.1)), (1, (0.0,)), (3, (0.0,))):
        at, rot = face_frame(k, a_inner)
        for r in positions:
            # monitor on a short stand, tilted back by being set deeper at the top (kept simple)
            inside.box(at(r, 0.45, top + 0.03), (0.30, 0.20, 0.02), "TWR_Bezel", rot_z=rot)
            inside.box(at(r, 0.45, top + 0.12), (0.06, 0.04, 0.16), "TWR_Bezel", rot_z=rot)
            inside.box(at(r, 0.47, top + 0.36), (0.56, 0.05, 0.36), "TWR_Bezel", rot_z=rot, front_mat="TWR_ScreenOff")
            # radio / frequency panel with a row of green keys, keyboard in front
            inside.box(at(r + 0.55, 0.40, top + 0.05), (0.40, 0.28, 0.10), "TWR_PanelGrey", rot_z=rot,
                       top_mat="TWR_KeyGreen")
            inside.box(at(r, 0.62, top + 0.012), (0.44, 0.15, 0.024), "TWR_Bezel", rot_z=rot)
    at, rot = face_frame(0, a_inner)
    lg = at(-0.1, 0.25, top + 0.09)
    inside.cylinder((lg.x, lg.y), 0.09, top, top + 0.18, "TWR_LightGun", segs=14)            # light gun (signal lamp)
    inside.box(at(-0.1, 0.25, top + 0.20), (0.06, 0.20, 0.05), "TWR_LightGun", rot_z=rot)

    # chairs at the front and side positions
    chair(inside, -0.9, -1.55, 0.0)
    chair(inside, 0.9, -1.55, 0.0)
    chair(inside, 1.5, 0.3, math.pi / 2)

    # stair well at the back: dark opening in the floor with a guard rail on three sides
    sw0, sw1 = Vector((-0.9, a_inner - 2.4, 0)), Vector((0.9, a_inner, 0))
    inside.box(((sw0.x + sw1.x) / 2, (sw0.y + sw1.y) / 2, 0.003), (sw1.x - sw0.x, sw1.y - sw0.y, 0.004),
               "TWR_Stairwell")
    railing(inside, Vector((sw0.x, sw1.y - 0.05, 0)), Vector((sw0.x, sw0.y, 0)), P["rail_h"], spacing=1.2)
    railing(inside, Vector((sw1.x, sw1.y - 0.05, 0)), Vector((sw1.x, sw0.y + 0.9, 0)), P["rail_h"], spacing=1.2)
    railing(inside, Vector((sw0.x, sw0.y, 0)), Vector((sw1.x - 0.9, sw0.y, 0)), P["rail_h"], spacing=1.2)
    # ceiling light panels
    for x in (-1.2, 1.2):
        for y in (-1.2, 1.2):
            inside.box((x, y, z_glass1 - 0.02), (0.6, 0.6, 0.02), "TWR_Equipment")
    inside.finish()

    # Eye point marker (not exported): where the MSFS eyepoint should be
    eye = bpy.data.objects.new("EYEPOINT_marker", None)
    eye.empty_display_type = "SPHERE"
    eye.empty_display_size = 0.1
    eye.location = (0.0, -P["eye_fwd"], P["eye_h"])
    bpy.context.scene.collection.objects.link(eye)

    print("Class D tower built: glass %.2f-%.2f m, roof %.2f m, cab %.1f m across, shaft %.1f m, eye %.2f m"
          % (z_glass0, z_glass1, z_roof, 2 * a0, P["shaft_h"], P["eye_h"]))


def main():
    build()
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--save" in argv:
        path = argv[argv.index("--save") + 1]
        bpy.ops.wm.save_as_mainfile(filepath=path)
        print("Saved", path)


if __name__ == "__main__":
    main()
