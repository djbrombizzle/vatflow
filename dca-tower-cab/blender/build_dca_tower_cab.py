"""
DCA Tower Cab - the Reagan National (KDCA) tower cab for MSFS 2024: the VATFLOW Tower Cab's
structure with the DCA cab's own layout inside, after its equipment-view floor plan
(docs/floor-plan.html).

Its own project, separate from msfs-tower/ (the VATFLOW Tower Cab). The structure is that
cab's, built by the same code: the 8-sided cab, outward-leaning glass, mullions, catwalk,
roof, sill, black ceiling with downlights and soffit, the circular ceiling track with the two
overhead monitors (Tower Radar / DBRITE front right, Ground Radar / ASDE-X front left: drag
round the track, height, swivel) and a roll-down shade in each of the 8 windows.

Inside, the DCA floor plan fitted to the octagon (window faces k = 0 front, then round the
cab to the left: 1 front-left, 2 left, 3 back-left, 4 back, 5 back-right, 6 right, 7 front-right):

  * GC (POS #3) front and centre on the front window (face 0, the SimObject's nose), with
    the dark dividers either side of it.
  * Perimeter consoles: ALCN #2 (face 7) and LCN #1 (face 6, front end) on the right, ALCS #4
    (face 1) and LCS #5 (face 2, front end) on the left, TMTW #11 (face 3). The right wall
    console (face 6, back end) with the stand-alone turret in front of LCN.
  * Left island off the left wall: the HC #6 / FD #10 block (writing strip along its front)
    and the CD #9 desk behind it.
  * Right island: the NCH #7 turret, the table and the ASTW #8 desk, joined to the right
    wall console.
  * Stair / kitchen core on face 5: the stairwell along the glass (in at the landing next to
    the right wall console, down towards the back), sink and refrigerator in front of it
    facing the room, guard walls. Face 4 (back) is open floor.

Every console has the VATFLOW cab's finish (blue laminate worktop, light grey writing strip
along the controller's edge, dark bumper, blue vent panels, dark kick plinth).

How to run
  Blender GUI:  Scripting tab -> Open -> this file -> Run Script
  Headless:     blender --background --python build_dca_tower_cab.py   (-- --save out.blend)
  Export:       python tools/export_dca_cab.py                         (writes the model files)

Conventions (as in msfs-tower/blender/build_tower_cab.py)
  * Units are meters. Origin (0,0,0) = center of the cab floor (the track's centre).
  * Forward = Blender -Y (GC's window); the controller's right = Blender -X.
  * Collections: DcaCab_Exterior -> dca_tower_cab.gltf, DcaCab_Interior -> dca_tower_cab_interior.gltf.
    Moving parts keep the VATFLOW cab's TowerCab_* names, so the model behaviours and the
    screens are the same.
"""

import math
import os
import sys

import bpy  # noqa: E402  (before bmesh when run as the bpy module)
import bmesh
from mathutils import Matrix, Vector
from mathutils.geometry import tessellate_polygon

# ---------------------------------------------------------------------------
# Parameters (meters / degrees): the VATFLOW Tower Cab's, sized from the DCA cab photo.
# ---------------------------------------------------------------------------
P = {
    "sides": 8,
    "apothem": 4.6,          # floor-level center-to-glass distance (cab ~30 ft across flats)
    "sill_h": 0.95,          # solid wall under the glass
    "glass_h": 3.0,          # glass height (vertical)
    "glass_lean_deg": 15.0,  # glass leans outward at the top
    "wall_t": 0.25,          # sill wall thickness
    "mullion_r": 0.07,       # corner mullion half-width
    "catwalk_depth": 1.15,   # catwalk deck out from the glass line
    "rail_h": 1.07,          # railing height
    "under_band_h": 0.7,     # white band under the catwalk
    "roof_band_h": 1.25,     # deep roof fascia above the glass
    "roof_overhang": 0.35,
    "drum_r": 2.0,           # round structure on the roof
    "drum_h": 0.9,
    "stub_apothem": 3.4,     # plain support "box" under the cab
    "stub_h": 6.0,
    "console_depth": 0.75,
    "console_h": 0.92,
    "eye_h": 1.65,           # standing eye height (used for the camera marker)
    "track_radius": 4.20,    # circular ceiling track, near the glass (the monitors hang 35 cm in from it on their arms)
    "stair_rise": 0.19,      # stairwell treads
    "knee_h": 1.07,          # guard / knee walls round the stair core
}
COLORS = {
    "TWR_Concrete": (0.86, 0.84, 0.79, 1.0),
    "TWR_Mullion": (0.10, 0.10, 0.11, 1.0),
    "TWR_Glass": (0.55, 0.65, 0.70, 0.12),
    "TWR_Metal": (0.78, 0.78, 0.76, 1.0),
    "TWR_Console": (0.16, 0.17, 0.19, 1.0),
    "TWR_ConsoleTop": (0.27, 0.38, 0.53, 1.0),
    "TWR_ConsoleFront": (0.05, 0.16, 0.39, 1.0),
    "TWR_ConsoleKick": (0.02, 0.05, 0.13, 1.0),
    "TWR_ConsoleRail": (0.55, 0.58, 0.62, 1.0),
    "TWR_ConsoleBumper": (0.03, 0.035, 0.04, 1.0),
    "TWR_Carpet": (0.20, 0.22, 0.26, 1.0),
    "TWR_Ceiling": (0.04, 0.04, 0.045, 1.0),
    "TWR_LightPanel": (1.0, 0.95, 0.85, 1.0),
    "TWR_CanRim": (0.55, 0.5, 0.42, 1.0),
    "TWR_Soffit": (0.02, 0.02, 0.025, 1.0),
    "TWR_Bezel": (0.05, 0.05, 0.05, 1.0),
    "TWR_Mount": (0.03, 0.03, 0.035, 1.0),
    "TWR_Shade": (0.11, 0.21, 0.34, 0.74),
    "TWR_Divider": (0.06, 0.065, 0.075, 1.0),       # the dark dividers either side of GC
    "TWR_Wall": (0.70, 0.71, 0.72, 1.0),            # guard walls, stairwell
    "TWR_WallCap": (0.25, 0.27, 0.30, 1.0),
    "TWR_StairTread": (0.12, 0.12, 0.13, 1.0),
    "TWR_StairNosing": (0.75, 0.62, 0.15, 1.0),
    "TWR_Counter": (0.62, 0.60, 0.56, 1.0),
    "TWR_Cabinet": (0.80, 0.79, 0.76, 1.0),
    "TWR_Appliance": (0.72, 0.73, 0.74, 1.0),
    "TWR_SinkSteel": (0.55, 0.56, 0.58, 1.0),
    "$SCREEN_DBRITE": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_ASDEX": (0.0, 0.0, 0.0, 1.0),
}

# ---------------------------------------------------------------------------
# Helpers (from msfs-tower/blender/build_tower_cab.py)
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
    if name.startswith("$SCREEN_"):
        bsdf.inputs["Roughness"].default_value = 0.2
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

    def face(self, pts, mat_name, uvs=None):
        verts = [self.bm.verts.new(p) for p in pts]
        f = self.bm.faces.new(verts)
        f.material_index = self.mat_index(mat_name)
        if uvs:
            self.bm.loops.layers.uv.verify()
            uv_layer = self.bm.loops.layers.uv.active
            for loop, uv in zip(f.loops, uvs):
                loop[uv_layer].uv = uv
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
        """Annulus between two octagons, optionally only some faces (sides)."""
        n = P["sides"]
        for k in sides if sides is not None else range(n):
            i, j = k, k + 1
            pts = {
                "i0": corner(i, a_in0, z0), "o0": corner(i, a_out0, z0),
                "i1": corner(i, a_in1, z1), "o1": corner(i, a_out1, z1),
                "j_i0": corner(j, a_in0, z0), "j_o0": corner(j, a_out0, z0),
                "j_i1": corner(j, a_in1, z1), "j_o1": corner(j, a_out1, z1),
            }
            self.face([pts["o0"], pts["j_o0"], pts["j_o1"], pts["o1"]], mat_name)   # outer
            self.face([pts["j_i0"], pts["i0"], pts["i1"], pts["j_i1"]], mat_name)   # inner
            self.face([pts["i1"], pts["o1"], pts["j_o1"], pts["j_i1"]], mat_name)   # top
            self.face([pts["i0"], pts["j_i0"], pts["j_o0"], pts["o0"]], mat_name)   # bottom
            if sides is not None:  # open ends need caps
                self.face([pts["i0"], pts["o0"], pts["o1"], pts["i1"]], mat_name)
                self.face([pts["j_o0"], pts["j_i0"], pts["j_i1"], pts["j_o1"]], mat_name)

    def beam(self, p0, p1, r, mat_name, segs=4):
        """Prism of radius r from p0 to p1 (posts, rails, mullions, masts)."""
        p0, p1 = Vector(p0), Vector(p1)
        axis = p1 - p0
        q = axis.to_track_quat("Z", "Y")
        ring0, ring1 = [], []
        for s in range(segs):
            a = 2 * math.pi * s / segs + math.pi / segs
            off = q @ Vector((r * math.cos(a), r * math.sin(a), 0))
            ring0.append(p0 + off)
            ring1.append(p1 + off)
        self.quad_strip(ring0, ring1, mat_name)
        self.face(list(reversed(ring0)), mat_name)
        self.face(ring1, mat_name)

    def box(self, center, size, mat_name, rot_z=0.0, top_mat=None):
        """Box; top_mat puts a texture (UV 0..1, v toward the box's +y) on the top face."""
        cx, cy, cz = center
        sx, sy, sz = (s / 2 for s in size)
        c, s = math.cos(rot_z), math.sin(rot_z)

        def v(x, y, z):
            return Vector((cx + x * c - y * s, cy + x * s + y * c, cz + z))

        b = [v(-sx, -sy, -sz), v(sx, -sy, -sz), v(sx, sy, -sz), v(-sx, sy, -sz)]
        t = [v(-sx, -sy, sz), v(sx, -sy, sz), v(sx, sy, sz), v(-sx, sy, sz)]
        self.quad_strip(b, t, mat_name)
        self.face(list(reversed(b)), mat_name)
        if top_mat:
            self.face(t, top_mat, uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
        else:
            self.face(t, mat_name)

    def cylinder(self, r, z0, z1, mat_name, segs=24):
        lo = [Vector((r * math.cos(2 * math.pi * i / segs), r * math.sin(2 * math.pi * i / segs), z0)) for i in range(segs)]
        hi = [Vector((v.x, v.y, z1)) for v in lo]
        self.quad_strip(lo, hi, mat_name)
        self.face(hi, mat_name)

    def fill(self, outline, mat_name, down=False, holes=()):
        """Flat (possibly concave) polygon, optionally with holes, as triangles; faces up or down."""
        loops = [list(outline)] + [list(h) for h in holes]
        allp = [p for lp in loops for p in lp]
        for tri in tessellate_polygon([[Vector(p) for p in lp] for lp in loops]):
            t = [allp[i] for i in tri]
            if ((t[1] - t[0]).cross(t[2] - t[0]).z < 0) != down:
                t.reverse()
            self.face(t, mat_name)

    def slab(self, pts, z0, z1, mat_name):
        """Solid prism over a flat footprint (concave is fine)."""
        lo = [Vector((p.x, p.y, z0)) for p in pts]
        hi = [Vector((p.x, p.y, z1)) for p in pts]
        self.quad_strip(lo, hi, mat_name)
        self.fill(lo, mat_name, down=True)
        self.fill(hi, mat_name)

    def finish(self):
        me = bpy.data.meshes.new(self.name)
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-5)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(material(m))
        obj = bpy.data.objects.new(self.name, me)
        self.collection.objects.link(obj)
        return obj


def screen(b, center, normal, width, height, mat_name, bezel=0.04, depth=0.05, bezel_mat="TWR_Bezel"):
    """A display: UV-mapped screen quad (0..1, upright) in front of a bezel box."""
    n = Vector(normal).normalized()
    up_world = Vector((0, 0, 1))
    right = up_world.cross(n).normalized()          # viewer's right, looking along -n
    up = n.cross(right).normalized()
    c = Vector(center)
    hw, hh = width / 2, height / 2
    front = c + n * 0.002
    pts = [front - right * hw - up * hh, front + right * hw - up * hh,
           front + right * hw + up * hh, front - right * hw + up * hh]
    b.face(pts, mat_name, uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
    # bezel: a slab behind the screen
    bw, bh = hw + bezel, hh + bezel
    f = [c - right * bw - up * bh, c + right * bw - up * bh, c + right * bw + up * bh, c - right * bw + up * bh]
    k = [p - n * depth for p in f]
    b.quad_strip(f, k, bezel_mat)
    b.face(list(reversed(k)), bezel_mat)
    return c, up, n


def face_frame(k, a_inner):
    """Helpers for placing things on console face k: at(right, depth, z), facing(tilt), rot."""
    ang = face_angle(k)
    out = Vector((math.cos(ang), math.sin(ang), 0))
    right = Vector((math.sin(ang), -math.cos(ang), 0))
    rot = ang - math.pi / 2          # box local +x = right, +y = toward the window

    def at(r, depth, z):
        return out * (a_inner - depth) + right * r + Vector((0, 0, z))

    def facing(tilt_deg):            # screen normal: toward the controller, tilted back
        t = math.radians(tilt_deg)
        return -out * math.cos(t) + Vector((0, 0, math.sin(t)))

    return at, facing, rot, out, right


def bevel_edges(obj, width, segments=2):
    """Rounds every box edge of a part a little (catches the light; a few hundred triangles)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, segments=segments, affect="EDGES", profile=0.5)
    bm.to_mesh(obj.data)
    bm.free()


def planar_uvs(obj, mats, meters, frame=None):
    """
    UVs for the faces of the given materials: each face projected on the plane it mostly
    faces, in the part's own square frame (so turned copies and diagonal parts keep square
    texture), one texture copy per `meters`. Used by the textures from make_textures.py
    that the exporter takes as they are (TEXTURED "m": None).
    """
    frame = frame or Matrix.Identity(4)
    idx = [i for i, m in enumerate(obj.data.materials) if m and m.name in mats]
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.verify()
    rot = frame.to_3x3()
    for f in bm.faces:
        if f.material_index not in idx:
            continue
        n = rot @ f.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in f.loops:
            p = frame @ loop.vert.co
            if az >= ax and az >= ay:
                u, v = p.x, p.y
            elif ax >= ay:
                u, v = p.y, p.z
            else:
                u, v = p.x, p.z
            loop[uv].uv = (u / meters, v / meters)
    bm.to_mesh(obj.data)
    bm.free()


CONSOLE_MATS = ("TWR_ConsoleTop", "TWR_ConsoleFront")


def consoles(coll, a_inner, top, sides):
    """
    The consoles round the cab, after photos of a real cab: medium blue laminate worktop
    with a wide light grey laminate writing strip along the front edge and a dark rounded
    bumper, blue perforated steel vent panels
    for the computers inside (make_textures.py), dark blue kick plinth set back 6 cm. One segment
    (window face 0, square to the axes) is built and UV mapped, and every console face is
    a turned copy of it (TowerCab_Consoles), so the texture sits the same on all of them.
    """
    a_in = a_inner - P["console_depth"]
    seg = Builder("TowerCab_ConsoleSeg", coll)
    # worktop: blue laminate at the back, then a 22 cm light grey laminate writing strip along
    # the controller's edge (a step 5 mm lower), ending in the dark rounded bumper
    seg.ring(a_in + 0.20, a_inner, a_in + 0.20, a_inner, top - 0.035, top, "TWR_ConsoleTop", sides=[0])
    seg.ring(a_in - 0.02, a_in + 0.20, a_in - 0.02, a_in + 0.20, top - 0.04, top - 0.005, "TWR_ConsoleRail", sides=[0])
    seg.ring(a_in - 0.045, a_in + 0.01, a_in - 0.045, a_in + 0.01, top - 0.075, top - 0.002, "TWR_ConsoleBumper", sides=[0])
    seg.ring(a_in, a_inner, a_in, a_inner, 0.10, top - 0.095, "TWR_ConsoleFront", sides=[0])
    seg.ring(a_in + 0.06, a_inner, a_in + 0.06, a_inner, 0.0, 0.10, "TWR_ConsoleKick", sides=[0])
    obj = seg.finish()
    bevel_edges(obj, 0.004)
    planar_uvs(obj, CONSOLE_MATS, 1.0)
    bm = bmesh.new()
    for k in sides:
        me = obj.data.copy()
        me.transform(Matrix.Rotation(face_angle(k) - face_angle(0), 4, "Z"))
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new("TowerCab_Consoles")
    bm.to_mesh(me)
    bm.free()
    for m in obj.data.materials:
        me.materials.append(m)
    allc = bpy.data.objects.new("TowerCab_Consoles", me)
    coll.objects.link(allc)
    bpy.data.objects.remove(obj, do_unlink=True)
    return allc


def soffit(inside, a1, ceiling_z):
    """The dark band round the edge of the ceiling, above the windows: a smooth charcoal
    strip 65 cm wide with a 12 cm deep lip at its inner edge (clear of the shade rollers)."""
    n = P["sides"]
    zi, zl = ceiling_z - 0.004, ceiling_z - 0.12
    for k in range(n):
        o0, o1 = corner(k, a1 - 0.02, zi), corner(k + 1, a1 - 0.02, zi)
        i0, i1 = corner(k, a1 - 0.65, zi), corner(k + 1, a1 - 0.65, zi)
        l0, l1 = corner(k, a1 - 0.65, zl), corner(k + 1, a1 - 0.65, zl)
        inside.face([o0, o1, i1, i0], "TWR_Soffit")          # band under the ceiling, facing down
        inside.face([i0, i1, l1, l0], "TWR_Soffit")          # lip
        m0, m1 = corner(k, a1 - 0.64, zl), corner(k + 1, a1 - 0.64, zl)
        inside.face([l0, l1, m1, m0], "TWR_Soffit")          # lip's lower edge


CEILING_LIGHTS = [(0.0, 0.0), (1.9, 0.0), (-1.9, 0.0), (0.0, 1.9), (0.0, -1.9)]


CEILING_CANS = [(2.9 * math.cos(math.radians(22.5 + 45 * i)), 2.9 * math.sin(math.radians(22.5 + 45 * i))) for i in range(8)] + \
               [(1.25 * math.cos(math.radians(45 * i)), 1.25 * math.sin(math.radians(45 * i))) for i in range(8)]


def ceiling_lights(inside, z):
    """Round recessed downlights (emissive disc in a metal rim), like the real cab: one at
    each cabin light of systems.cfg (CEILING_LIGHTS) and a ring of smaller ones round the
    room (CEILING_CANS)."""
    def can(x, y, r):
        n = 40
        rim = r * 1.35
        disc = [Vector((x + r * math.cos(2 * math.pi * i / n), y + r * math.sin(2 * math.pi * i / n), z - 0.004)) for i in range(n)]
        ring = [Vector((x + rim * math.cos(2 * math.pi * i / n), y + rim * math.sin(2 * math.pi * i / n), z - 0.002)) for i in range(n)]
        inside.face(list(reversed(disc)), "TWR_LightPanel")                 # faces down
        for i in range(n):
            j = (i + 1) % n
            inside.face([ring[i], ring[j], disc[j], disc[i]][::-1], "TWR_CanRim")
    for x, y in CEILING_LIGHTS:
        can(x, y, 0.11)
    for x, y in CEILING_CANS:
        can(x, y, 0.07)


MONITOR_ARM_M = 0.35       # the arm reaches this far in from the track to the monitor


MONITOR_RAISE_M = 0.15     # height adjust: up to 15 cm above where it is built...


MONITOR_LOWER_M = 0.25     # ...and 25 cm below (keep in sync with the exporter)


def monitor_mount(name, coll, face_k, width, height, mat_screen, center_z, tilt_deg,
                  ceiling_z, rail_radius):
    """
    Ceiling-hung tower monitor like the real DCA cab: the display in a square-tube
    yoke with side pivot knobs and a handle bar, hanging on a telescoping post from a
    trolley on the circular ceiling track (radius rail_radius) that runs all the way
    round the cab. The monitor starts facing the cab centre from window face face_k.

    Five objects, exported as a node hierarchy (custom properties for the exporter):
      name            trolley + outer sleeve   travels round the track      (vatflow_anim = track)
      name_Lift       inner post               slides up / down in the sleeve (lift)
      name_Display    display + yoke           swivels about the post        (twist; no drag, clicks go to the page)
      name_Handle     handle bar under it      swivels with it; drag = height
      name_SwivelL/R  side pivot knobs         swivel with it; drag = swivel
    The trolley and the post are dragged left / right to move the monitor round the track.
    Lift, Display, Handle and SwivelL / R hang under the trolley; Display / Handle / SwivelL / R are
    separate nodes (not children of each other) so each can be grabbed on its own.
    """
    ang = face_angle(face_k)
    out = Vector((math.cos(ang), math.sin(ang), 0))
    tilt = math.radians(tilt_deg)
    nrm = -out * math.cos(tilt) - Vector((0, 0, math.sin(tilt)))
    n = nrm.normalized()
    right = Vector((0, 0, 1)).cross(n).normalized()          # same frame as screen()
    up = n.cross(right).normalized()
    hw, hh = width / 2 + 0.035, height / 2 + 0.035          # housing half sizes
    gap = 0.07
    fw, fh = hw + gap, hh + gap                             # yoke half sizes
    back = -n * 0.04
    # place the monitor so the top of its yoke sits exactly under the track
    center_out = rail_radius - MONITOR_ARM_M - (back + up * fh).dot(out)
    c = out * center_out + Vector((0, 0, center_z))
    top = c + back + up * fh                                # where the arm meets the yoke
    pivot = (top.x, top.y, top.z)                           # swivel axis: vertical through here
    trolley_z = ceiling_z - 0.10
    elbow_z = top.z + 0.14                                  # the arm's elbow, above the yoke
    post = top + out * MONITOR_ARM_M                        # under the trolley, on the track
    sleeve_bottom = elbow_z + MONITOR_RAISE_M + 0.06        # the elbow clears the sleeve when raised

    # trolley + outer sleeve (travels round the track)
    b = Builder(name, coll)
    b.beam(Vector((post.x, post.y, sleeve_bottom)), Vector((post.x, post.y, trolley_z)), 0.036, "TWR_Mount", segs=16)
    b.beam(Vector((post.x, post.y, sleeve_bottom - 0.01)), Vector((post.x, post.y, sleeve_bottom + 0.04)), 0.046, "TWR_Mount", segs=20)  # collar
    b.box((post.x, post.y, trolley_z + 0.03), (0.20, 0.12, 0.06), "TWR_Mount", rot_z=ang + math.pi / 2)
    mount = b.finish()
    mount["vatflow_anim"] = "track"

    # the arm (slides up / down in the sleeve): inner post, elbow joint, the arm reaching in
    # over the screen and a short drop to the yoke, like the articulated arms in real cabs.
    # All of it is above the screen, so its box doesn't take the screen's clicks.
    b = Builder(name + "_Lift", coll)
    ez = Vector((0, 0, elbow_z))
    b.beam(Vector((post.x, post.y, elbow_z)), Vector((post.x, post.y, sleeve_bottom + MONITOR_LOWER_M + 0.08)), 0.026, "TWR_Mount", segs=16)
    b.beam(Vector((post.x, post.y, elbow_z - 0.045)), Vector((post.x, post.y, elbow_z + 0.045)), 0.042, "TWR_Mount", segs=20)  # elbow
    arm0 = Vector((post.x, post.y, 0)) + ez
    arm1 = Vector((top.x, top.y, 0)) + ez
    b.beam(arm0, arm1, 0.024, "TWR_Mount", segs=16)
    b.beam(arm1 + Vector((0, 0, -0.035)), arm1 + Vector((0, 0, 0.035)), 0.036, "TWR_Mount", segs=20)            # wrist
    b.beam(top, arm1, 0.022, "TWR_Mount", segs=16)
    lift = b.finish()
    lift["vatflow_anim"] = "lift"
    lift["vatflow_parent"] = name

    # The display and its yoke: one node with no drag behaviour. The sim picks what you click
    # by each node's bounding box, so a draggable part must not have a box covering the screen,
    # or clicks on the screen (MENU, MAPS) turn into drags. The grab points are small parts
    # round it: the post / trolley (track), the side knobs (swivel), the handle (height).
    b = Builder(name + "_Display", coll)
    screen(b, c, nrm, width, height, mat_screen, bezel=0.035, depth=0.08)
    F = [c + back - right * fw - up * fh, c + back + right * fw - up * fh,
         c + back + right * fw + up * fh, c + back - right * fw + up * fh]
    for i in range(4):                                      # square-tube yoke
        b.beam(F[i], F[(i + 1) % 4], 0.022, "TWR_Mount")
    for sgn in (-1, 1):                                     # pivot stubs on the sides
        b.beam(c + back + right * sgn * hw, c + back + right * sgn * (fw + 0.03), 0.02, "TWR_Mount", segs=16)
    dsp = b.finish()

    knobs = []                                              # the big side knobs, one node each
    for side, sgn in (("L", -1), ("R", 1)):
        b = Builder(name + "_Swivel" + side, coll)
        b.beam(c + back + right * sgn * (fw + 0.03), c + back + right * sgn * (fw + 0.07), 0.05, "TWR_Mount", segs=20)
        knobs.append(b.finish())

    b = Builder(name + "_Handle", coll)                     # handle bar under the yoke
    drop = -up * 0.11 + n * 0.07
    hl = c + back - up * fh - right * fw * 0.7
    hr = c + back - up * fh + right * fw * 0.7
    b.beam(hl, hl + drop, 0.018, "TWR_Mount", segs=12)
    b.beam(hr, hr + drop, 0.018, "TWR_Mount", segs=12)
    b.beam(hl + drop, hr + drop, 0.018, "TWR_Mount", segs=12)
    hnd = b.finish()

    for o in [dsp, hnd] + knobs:
        o["vatflow_anim"] = "twist"
        o["vatflow_parent"] = name + "_Lift"
        o["vatflow_pivot"] = pivot
    return mount


SHADE_STRIPS = 20   # each shade shows in 5 % steps


def window_shade(k, coll, a0, a1, z0, z1):
    """
    Roll-down shade for window face k: dark tinted fabric parallel to the leaning glass,
    hanging from a roller just inside the head of the window.

    The roller is one object (TowerCab_ShadeRoller_k). The shade is SHADE_STRIPS
    seamless horizontal strips (TowerCab_Shade_k_sNN, NN = 0 at the top) plus a pull bar
    per step (TowerCab_ShadeBar_k_sNN), each its own object with custom properties
    vatflow_shade = k and vatflow_strip = NN. Model behaviors show strip NN when the shade
    position (0-100 %) is past NN * 100 / SHADE_STRIPS and bar NN only while strip NN is
    the lowest one showing, so the shade unrolls from the top and is gone when fully up.
    No animation needed.
    """
    top_c = (corner(k, a1, z1) + corner(k + 1, a1, z1)) / 2
    bot_c = (corner(k, a0, z0) + corner(k + 1, a0, z0)) / 2
    along = (corner(k + 1, a0, z0) - corner(k, a0, z0)).normalized()
    down = (bot_c - top_c).normalized()
    inward = along.cross(down).normalized()
    if inward.dot(Vector((-top_c.x, -top_c.y, 0))) < 0:
        inward = -inward
    origin = top_c + inward * 0.12 + down * 0.10
    length = (bot_c - top_c).length - 0.25
    half_w = (corner(k + 1, a0, z0) - corner(k, a0, z0)).length * 0.45

    roller = Builder("TowerCab_ShadeRoller_%d" % k, coll)
    roller.beam(origin - along * (half_w + 0.05), origin + along * (half_w + 0.05), 0.045, "TWR_Mount", segs=20)
    for s in (-1, 1):                                       # end brackets up to the head
        e = origin + along * s * (half_w + 0.05)
        roller.beam(e, e - down * 0.10, 0.02, "TWR_Mount")
    roller.finish()

    # Strips butt edge to edge (no overlap: two layers of translucent fabric would show
    # as a darker line) and carry no seams, so a lowered shade reads as one sheet.
    # Each step also has its own pull bar, shown only while it is the bottom edge.
    h = length / SHADE_STRIPS
    for i in range(SHADE_STRIPS):
        t0 = origin + down * (0.045 + i * h)
        t1 = origin + down * (0.045 + (i + 1) * h)
        strip = Builder("TowerCab_Shade_%d_s%02d" % (k, i), coll)
        strip.face([t0 - along * half_w, t0 + along * half_w, t1 + along * half_w, t1 - along * half_w], "TWR_Shade")
        obj = strip.finish()
        obj["vatflow_shade"] = k
        obj["vatflow_strip"] = i
        bar = Builder("TowerCab_ShadeBar_%d_s%02d" % (k, i), coll)
        bar.beam(t1 - along * half_w, t1 + along * half_w, 0.018, "TWR_Mount", segs=12)
        obj = bar.finish()
        obj["vatflow_shade"] = k
        obj["vatflow_strip"] = i


def ceiling_track(builder, radius, ceiling_z, segments=48):
    """Circular ceiling track all the way round the cab, with hangers every 45 degrees."""
    z = ceiling_z - 0.035
    pts = [Vector((radius * math.cos(2 * math.pi * i / segments), radius * math.sin(2 * math.pi * i / segments), z))
           for i in range(segments)]
    for i in range(segments):
        builder.beam(pts[i], pts[(i + 1) % segments], 0.035, "TWR_Mount")
    for i in range(0, segments, segments // 8):
        p = pts[i]
        builder.beam(p, Vector((p.x, p.y, ceiling_z + 0.005)), 0.025, "TWR_Mount")


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(bpy.data.collections):
        if coll.name.startswith("DcaCab_"):
            bpy.data.collections.remove(coll)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def new_collection(name):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    return coll

# ---------------------------------------------------------------------------
# The DCA layout
# ---------------------------------------------------------------------------

# perimeter consoles: every window face but the back (4) and the stair core (5)
CONSOLE_FACES = [0, 1, 2, 3, 6, 7]
# positions on them: (name, face, right of the face centre in m) - the task lights
PERIMETER_POSITIONS = [("GC", 0, 0.0), ("ALCS", 1, 0.0), ("LCS", 2, -0.9), ("TMTW", 3, 0.0),
                       ("LCN", 6, 0.9), ("RWALL", 6, -0.6), ("ALCN", 7, 0.0)]

# islands and console extensions from the plan, in cab metres (x, y; -y = forward, -x = right):
# (name, footprint, edges the controller works at). Edge i runs from point i to point i + 1.
ISLANDS = [
    # left island off the left wall console: HC (wall end) and FD (inner end) along its
    # front edge, the CD desk behind it
    ("HC_FD", [(3.62, -0.80), (1.14, -0.80), (1.14, 0.93), (3.62, 0.93)], [0]),
    ("CD", [(3.62, 0.93), (1.14, 0.93), (1.14, 1.20), (3.62, 1.20)], [2]),
    # right island: NCH turret, the table, ASTW desk; the right wall console's deep end joins it
    ("NCH", [(0.0, -1.02), (-2.59, -1.02), (-2.59, -0.63), (0.0, -0.63)], [0]),
    ("ISLAND", [(0.23, -0.57), (-2.59, -0.57), (-2.59, 0.39), (0.23, 0.39)], []),
    ("ASTW", [(0.0, 0.65), (-1.30, 0.65), (-1.30, 0.97), (0.0, 0.97)], [2]),
    ("RWALL", [(-2.59, 0.0), (-3.62, 0.0), (-3.62, 0.90), (-2.59, 0.90)], [2]),
    # the stand-alone turret in front of LCN
    ("TURRET", [(-3.15 + 0.45 * math.cos(a), -0.80 + 0.45 * math.sin(a)) for a in (0, math.pi / 2, math.pi, 3 * math.pi / 2)], []),
]
# stair / kitchen core on face 5, in its face frame: r = right of the face centre (+ = towards
# the back window), depth = in from the inner wall
STAIR_R, STAIR_DEPTH = (-0.60, 1.35), 0.80    # stairwell (the landing at r -1.25..-0.60 is floor)
GUARD_T = 0.10
SINK_R, FRIDGE_R = (-0.55, 0.35), (0.45, 1.29)
KITCHEN_DEPTH = 0.66
EYE = (0.0, -3.10)            # standing eye point: the GC controller, half a metre back from the counter
TASK_LIGHTS = []              # (x, y) over each position; the exporter writes them into systems.cfg


def signed_area(pts):
    return sum(pts[i].x * pts[(i + 1) % len(pts)].y - pts[(i + 1) % len(pts)].x * pts[i].y for i in range(len(pts))) / 2


def outward(pts, i):
    a, b = pts[i], pts[(i + 1) % len(pts)]
    e = (b - a).normalized()
    n = Vector((e.y, -e.x, 0)) if signed_area(pts) > 0 else Vector((-e.y, e.x, 0))
    return n


def inset(pts, ds):
    """Polygon with edge i moved in by ds[i] (mitred; for the convex footprints here)."""
    n = len(pts)
    lines = [(pts[i] - outward(pts, i) * ds[i], pts[(i + 1) % n] - outward(pts, i) * ds[i]) for i in range(n)]
    out = []
    for i in range(n):
        (a0, a1), (b0, b1) = lines[i - 1], lines[i]
        d1, d2 = a1 - a0, b1 - b0
        den = d1.x * d2.y - d1.y * d2.x
        if abs(den) < 1e-9:
            out.append(b0)
            continue
        t = ((b0.x - a0.x) * d2.y - (b0.y - a0.y) * d2.x) / den
        out.append(a0 + d1 * t)
    return out


def near_segment(p, a, b, tol):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (a + ab * t - p).length <= tol


def inside(p, pts):
    c = False
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        if (a.y > p.y) != (b.y > p.y) and p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x:
            c = not c
    return c


def island_console(coll, name, pts, seats, others, top):
    """
    A console from its footprint with the perimeter consoles' finish: worktop, a 22 cm light
    grey writing strip along each working edge (seats), dark bumper and kick plinth set back
    6 cm along every open edge (not against another console).
    """
    b = Builder("TowerCab_Console_" + name, coll)
    opened = []
    for i in range(len(pts)):
        mid = (pts[i] + pts[(i + 1) % len(pts)]) / 2
        opened.append(not any(inside(mid, o) or any(near_segment(mid, o[k], o[(k + 1) % len(o)], 0.03) for k in range(len(o)))
                              for o in others))
    b.slab(inset(pts, [0.06 if o else 0.0 for o in opened]), 0.0, 0.10, "TWR_ConsoleKick")
    b.slab(pts, 0.10, top - 0.035, "TWR_ConsoleFront")
    b.slab(pts, top - 0.035, top, "TWR_ConsoleTop")
    for i in seats:
        p0, p1 = pts[i], pts[(i + 1) % len(pts)]
        inn = -outward(pts, i)
        b.slab([p0, p1, p1 + inn * 0.22, p0 + inn * 0.22], top - 0.034, top + 0.003, "TWR_ConsoleRail")
        mid = (p0 + p1) / 2 + inn * 0.40
        TASK_LIGHTS.append((mid.x, mid.y))
    for i, o in enumerate(opened):
        if o:
            p0, p1 = pts[i], pts[(i + 1) % len(pts)]
            e, out = (p1 - p0).normalized(), outward(pts, i)
            z = Vector((0, 0, top - 0.035))
            b.beam(p0 - e * 0.02 + out * 0.012 + z, p1 + e * 0.02 + out * 0.012 + z, 0.036, "TWR_ConsoleBumper", segs=12)
    obj = b.finish()
    planar_uvs(obj, CONSOLE_MATS, 1.0)


def islands(coll, a_inner, top):
    a_in = a_inner - P["console_depth"]
    perimeter = [[corner(k, a_inner, 0), corner(k + 1, a_inner, 0), corner(k + 1, a_in, 0), corner(k, a_in, 0)]
                 for k in CONSOLE_FACES]
    feet = [[Vector((x, y, 0)) for x, y in pts] for _, pts, _ in ISLANDS]
    for i, (name, _, seats) in enumerate(ISLANDS):
        island_console(coll, name, feet[i], seats, [f for j, f in enumerate(feet) if j != i] + perimeter, top)


def dividers(inside_b, a_inner, top):
    """The dark dividers either side of GC: along the console corners between faces 7 / 0 and 0 / 1."""
    a_in = a_inner - P["console_depth"]
    for i in (0, 1):
        p0, p1 = corner(i, a_inner, 0), corner(i, a_in - 0.02, 0)
        e = (p1 - p0).normalized()
        n = Vector((-e.y, e.x, 0)) * 0.025
        inside_b.slab([p0 - n, p1 - n, p1 + n, p0 + n], 0.0, top + 0.30, "TWR_Divider")


def perimeter_lights(a_inner):
    for _, k, r in PERIMETER_POSITIONS:
        at, facing, rot, out, right = face_frame(k, a_inner)
        p = at(r, 0.40, 0)
        TASK_LIGHTS.append((p.x, p.y))


def guard(b, at, r0, d0, r1, d1, h):
    """A guard / knee wall with a dark cap over the rectangle r0..r1 x d0..d1 of a face frame."""
    fp = [at(r0, d0, 0), at(r1, d0, 0), at(r1, d1, 0), at(r0, d1, 0)]
    b.slab(fp, 0.0, h - 0.03, "TWR_Wall")
    cap = [at(r0 - 0.012, d0 - 0.012, 0), at(r1 + 0.012, d0 - 0.012, 0), at(r1 + 0.012, d1 + 0.012, 0), at(r0 - 0.012, d1 + 0.012, 0)]
    b.slab(cap, h - 0.03, h, "TWR_WallCap")


def stair_hole(a_inner):
    at = face_frame(5, a_inner)[0]
    (r0, r1), d = STAIR_R, STAIR_DEPTH
    return [at(r0, 0, 0), at(r1, 0, 0), at(r1, d, 0), at(r0, d, 0)]


def stair_core(coll, a_inner):
    """
    The stair / kitchen core on face 5 (back right), after the plan: the stairwell along the
    glass, entered from the landing next to the right wall console and going down towards the
    back window, with guard walls on its room side and far end; sink and refrigerator in front
    of it, facing the room.
    """
    at = face_frame(5, a_inner)[0]
    (r0, r1), d = STAIR_R, STAIR_DEPTH
    rise = P["stair_rise"]
    n = 9
    bottom = -(n + 1) * rise
    b = Builder("TowerCab_Stairs", coll)
    hole = stair_hole(a_inner)
    for i in range(4):
        p0, p1 = hole[i], hole[(i + 1) % 4]
        b.face([p0, p1, p1 + Vector((0, 0, bottom)), p0 + Vector((0, 0, bottom))], "TWR_Wall")
    b.fill([p + Vector((0, 0, bottom)) for p in hole], "TWR_StairTread")
    step = (r1 - r0) / n
    for i in range(n):
        s0 = r0 + i * step
        z = -(i + 1) * rise
        b.slab([at(s0, 0, 0), at(s0 + step, 0, 0), at(s0 + step, d, 0), at(s0, d, 0)], bottom, z, "TWR_StairTread")
        b.slab([at(s0, 0.02, 0), at(s0 + 0.04, 0.02, 0), at(s0 + 0.04, d - 0.02, 0), at(s0, d - 0.02, 0)], z, z + 0.004, "TWR_StairNosing")
    b.finish()

    w = Builder("TowerCab_CoreWalls", coll)
    h = P["knee_h"]
    guard(w, at, r0, d, r1 + GUARD_T, d + GUARD_T, h)                           # behind the kitchen
    guard(w, at, r1, 0.0, r1 + GUARD_T, d + GUARD_T + KITCHEN_DEPTH, h)          # the far end, out to the kitchen front
    w.finish()

    k = Builder("TowerCab_Kitchen", coll)
    d0, d1 = d + GUARD_T, d + GUARD_T + KITCHEN_DEPTH                           # back, front
    f0, f1 = FRIDGE_R
    k.slab([at(f0, d0, 0), at(f1, d0, 0), at(f1, d1, 0), at(f0, d1, 0)], 0.02, 1.75, "TWR_Appliance")
    k.slab([at(f0 + 0.02, d0, 0), at(f1 - 0.02, d0, 0), at(f1 - 0.02, d1 - 0.02, 0), at(f0 + 0.02, d1 - 0.02, 0)], 0.0, 0.02, "TWR_ConsoleKick")
    for z in (1.20, 1.23):                                                      # freezer / fridge door line
        k.beam(at(f0 + 0.02, d1 + 0.004, z), at(f1 - 0.02, d1 + 0.004, z), 0.006, "TWR_Mount")
    k.beam(at(f0 + 0.08, d1 + 0.035, 0.95), at(f0 + 0.08, d1 + 0.035, 1.55), 0.012, "TWR_Metal", segs=8)
    s0, s1 = SINK_R
    k.slab([at(s0, d0, 0), at(s1, d0, 0), at(s1, d1 - 0.06, 0), at(s0, d1 - 0.06, 0)], 0.0, 0.10, "TWR_ConsoleKick")
    k.slab([at(s0, d0, 0), at(s1, d0, 0), at(s1, d1, 0), at(s0, d1, 0)], 0.10, 0.88, "TWR_Cabinet")
    k.slab([at(s0 - 0.01, d0, 0), at(s1 + 0.01, d0, 0), at(s1 + 0.01, d1 + 0.02, 0), at(s0 - 0.01, d1 + 0.02, 0)], 0.88, 0.92, "TWR_Counter")
    m = (s0 + s1) / 2
    k.slab([at(m - 0.22, d0 + 0.18, 0), at(m + 0.22, d0 + 0.18, 0), at(m + 0.22, d1 - 0.08, 0), at(m - 0.22, d1 - 0.08, 0)], 0.75, 0.925, "TWR_SinkSteel")
    tap = at(m, d0 + 0.08, 0.92)
    k.beam(tap, tap + Vector((0, 0, 0.30)), 0.012, "TWR_Metal", segs=12)
    k.beam(tap + Vector((0, 0, 0.30)), at(m, d0 + 0.30, 1.22), 0.010, "TWR_Metal", segs=12)
    k.finish()


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def build():
    clear_scene()
    TASK_LIGHTS.clear()
    n = P["sides"]
    a0 = P["apothem"]
    z_glass0 = P["sill_h"]
    z_glass1 = z_glass0 + P["glass_h"]
    a1 = a0 + P["glass_h"] * math.tan(math.radians(P["glass_lean_deg"]))
    z_roof = z_glass1 + P["roof_band_h"]
    a_roof = a1 + P["roof_overhang"]

    ext_coll = new_collection("DcaCab_Exterior")
    int_coll = new_collection("DcaCab_Interior")

    # --- Exterior: the VATFLOW Tower Cab's ------------------------------------------
    shell = Builder("TowerCab_Shell", ext_coll)
    shell.ring(a0 - P["wall_t"], a0, a0 - P["wall_t"], a0, 0.0, z_glass0, "TWR_Concrete")
    shell.prism(a0 + 0.2, a0 + 0.2, -P["under_band_h"], -0.08, "TWR_Concrete")
    shell.ring(a0, a0 + P["catwalk_depth"], a0, a0 + P["catwalk_depth"], -0.08, 0.0, "TWR_Concrete")
    shell.prism(a1, a_roof, z_glass1, z_glass1 + 0.25, "TWR_Concrete")
    shell.prism(a_roof, a_roof, z_glass1 + 0.25, z_roof, "TWR_Concrete")
    shell.cylinder(P["drum_r"], z_roof, z_roof + P["drum_h"], "TWR_Concrete")
    shell.prism(P["stub_apothem"], P["stub_apothem"], -P["under_band_h"] - P["stub_h"], -P["under_band_h"], "TWR_Concrete")
    shell.finish()

    glass = Builder("TowerCab_Glass", ext_coll)
    for k in range(n):
        glass.face([corner(k, a0, z_glass0), corner(k + 1, a0, z_glass0),
                    corner(k + 1, a1, z_glass1), corner(k, a1, z_glass1)], "TWR_Glass")
    glass.finish()

    frame = Builder("TowerCab_Frame", ext_coll)
    for k in range(n):
        frame.beam(corner(k, a0, z_glass0), corner(k, a1, z_glass1), P["mullion_r"], "TWR_Mullion")
    for k in range(n):
        frame.beam(corner(k, a0, z_glass0), corner(k + 1, a0, z_glass0), 0.04, "TWR_Mullion")
        frame.beam(corner(k, a1, z_glass1), corner(k + 1, a1, z_glass1), 0.04, "TWR_Mullion")
    frame.finish()

    rails = Builder("TowerCab_Railings", ext_coll)
    a_rail = a0 + P["catwalk_depth"] - 0.05
    a_roof_rail = a_roof - 0.3
    for a, z in ((a_rail, 0.0), (a_roof_rail, z_roof)):
        for k in range(n):
            p0, p1 = corner(k, a, z), corner(k + 1, a, z)
            seg = p1 - p0
            posts = max(2, int(seg.length / 1.4))
            for s in range(posts):
                p = p0 + seg * (s / posts)
                rails.beam(p, p + Vector((0, 0, P["rail_h"])), 0.03, "TWR_Metal")
            for h in (P["rail_h"], P["rail_h"] * 0.5):
                rails.beam(p0 + Vector((0, 0, h)), p1 + Vector((0, 0, h)), 0.025, "TWR_Metal")
    masts = [(0, 4.0), (1, 6.5), (2, 3.5), (3, 7.0), (4, 4.5), (5, 6.0), (6, 3.5), (7, 5.5)]
    for k, h in masts:
        p = corner(k, a_roof - 0.15, z_roof)
        rails.beam(p, p + Vector((0, 0, h)), 0.035, "TWR_Metal", segs=12)
    rails.beam((0, 0, z_roof + P["drum_h"]), (0, 0, z_roof + P["drum_h"] + 5.0), 0.05, "TWR_Metal", segs=12)
    rails.finish()

    # --- Interior: the VATFLOW cab's room ------------------------------------------
    inside = Builder("TowerCab_Interior", int_coll)
    a_inner = a0 - P["wall_t"]
    top = P["console_h"]
    ceiling_z = z_glass1 - 0.01
    inside.fill([corner(i, a_inner, 0.0) for i in range(n)], "TWR_Carpet", holes=[stair_hole(a_inner)])     # floor
    inside.face(list(reversed([corner(i, a1 - 0.02, z_glass1 - 0.01) for i in range(n)])), "TWR_Ceiling")
    for k in range(n):        # window frames seen from inside (the exterior isn't drawn in the cockpit view)
        inside.beam(corner(k, a0, z_glass0), corner(k, a1, z_glass1), P["mullion_r"] * 0.85, "TWR_Mullion")
        inside.beam(corner(k, a0, z_glass0), corner(k + 1, a0, z_glass0), 0.034, "TWR_Mullion")
        inside.beam(corner(k, a1, z_glass1), corner(k + 1, a1, z_glass1), 0.034, "TWR_Mullion")
    inside.ring(a_inner, a0 - 0.01, a_inner, a0 - 0.01, 0.0, z_glass0, "TWR_Console")   # sill seen from inside
    ceiling_lights(inside, z_glass1 - 0.012)
    soffit(inside, a1, ceiling_z)

    # --- The DCA layout ----------------------------------------------------------
    consoles(int_coll, a_inner, top, CONSOLE_FACES)
    perimeter_lights(a_inner)
    dividers(inside, a_inner, top)
    islands(int_coll, a_inner, top)
    stair_core(int_coll, a_inner)

    # overhead monitors on the circular ceiling track (all the way round the cab):
    # Tower Radar (DBRITE) front right over ALCN, Ground Radar (ASDE-X) front left over ALCS
    track_r = P["track_radius"]
    ceiling_track(inside, track_r, ceiling_z)
    monitor_mount("TowerCab_DbriteMount", int_coll, n - 1, 0.80, 0.60, "$SCREEN_DBRITE", 2.50, 20, ceiling_z, track_r)
    monitor_mount("TowerCab_AsdexMount", int_coll, 1, 0.80, 0.60, "$SCREEN_ASDEX", 2.55, 20, ceiling_z, track_r)

    for k in range(n):        # a roll-down shade in every window
        window_shade(k, int_coll, a0, a1, z_glass0, z_glass1)
    inside.finish()

    eye = bpy.data.objects.new("EYEPOINT_marker", None)
    eye.empty_display_type = "SPHERE"
    eye.empty_display_size = 0.1
    eye.location = (EYE[0], EYE[1], P["eye_h"])
    bpy.context.scene.collection.objects.link(eye)
    print("DCA tower cab built: %.1f m across flats, %d windows, %d perimeter consoles, %d island consoles, eye %s"
          % (2 * a0, n, len(CONSOLE_FACES), len(ISLANDS), tuple(eye.location)))


def main():
    build()
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--save" in argv:
        path = argv[argv.index("--save") + 1]
        bpy.ops.wm.save_as_mainfile(filepath=path)
        print("Saved", path)


if __name__ == "__main__":
    main()
