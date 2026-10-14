"""
VATFLOW Tower Cab - parametric tower cab builder for Blender (MSFS 2024).

Builds the top of the KDCA (Reagan National) tower: an 8-sided cab with
outward-leaning glass, thin corner mullions, a railed catwalk below the
glass, a deep roof fascia, a railed roof with antenna masts, and a plain
support stub underneath (meant to sit on top of the sim's own tower).

Inside: console desks around the glass (rear side left open), a console
"TWR INFO" display and two overhead monitors hanging from a circular ceiling
track that runs all the way round the cab: "DBRITE" radar (starts front
right) and "ASDE-X" surface map (starts front left). Each overhead monitor
is its own object so it can travel the full 360 degrees. The three
display surfaces use the materials $SCREEN_TWRINFO, $SCREEN_DBRITE and $SCREEN_ASDEX, which
must match the texture= names in panel.cfg. Like the SDK GaugeAircraft sample,
they need the $ prefix and a strong emissive (2000) in the MSFS material panel:
the gauge is drawn into the emissive channel.

How to run
  Blender GUI:  Scripting tab -> Open -> this file -> Run Script
  Headless:     blender --background --python build_tower_cab.py
                (add  -- --save out.blend  to save the result)

Conventions
  * Units are meters. Origin (0,0,0) = center of the cab floor.
  * Forward ("nose" of the SimObject) = Blender -Y, so MSFS sees the
    front console as the front of the "aircraft". The cab is symmetric,
    so heading is only a matter of which console faces the field.
  * Two collections are created, one per glTF export:
      TowerCab_Exterior -> tower_cab.gltf           (model.cfg normal=)
      TowerCab_Interior -> tower_cab_interior.gltf  (model.cfg interior=)
"""

import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

# ---------------------------------------------------------------------------
# Parameters (meters / degrees). KDCA defaults, sized from the cab photo.
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
    "track_radius": 3.0,     # circular ceiling track for the overhead monitors
}

COLORS = {
    "TWR_Concrete": (0.86, 0.84, 0.79, 1.0),
    "TWR_Mullion": (0.10, 0.10, 0.11, 1.0),
    "TWR_Glass": (0.55, 0.65, 0.70, 0.12),
    "TWR_Metal": (0.78, 0.78, 0.76, 1.0),
    "TWR_Console": (0.16, 0.17, 0.19, 1.0),
    "TWR_Carpet": (0.18, 0.22, 0.28, 1.0),
    "TWR_Ceiling": (0.80, 0.80, 0.78, 1.0),
    "TWR_Bezel": (0.05, 0.05, 0.05, 1.0),
    "$SCREEN_TWRINFO": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_DBRITE": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_ASDEX": (0.0, 0.0, 0.0, 1.0),
    "TWR_Mount": (0.03, 0.03, 0.035, 1.0),
    "TWR_Shade": (0.07, 0.07, 0.08, 0.82),
}

# ---------------------------------------------------------------------------
# Helpers
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

    def box(self, center, size, mat_name, rot_z=0.0):
        cx, cy, cz = center
        sx, sy, sz = (s / 2 for s in size)
        c, s = math.cos(rot_z), math.sin(rot_z)

        def v(x, y, z):
            return Vector((cx + x * c - y * s, cy + x * s + y * c, cz + z))

        b = [v(-sx, -sy, -sz), v(sx, -sy, -sz), v(sx, sy, -sz), v(-sx, sy, -sz)]
        t = [v(-sx, -sy, sz), v(sx, -sy, sz), v(sx, sy, sz), v(-sx, sy, sz)]
        self.quad_strip(b, t, mat_name)
        self.face(list(reversed(b)), mat_name)
        self.face(t, mat_name)

    def cylinder(self, r, z0, z1, mat_name, segs=24):
        lo = [Vector((r * math.cos(2 * math.pi * i / segs), r * math.sin(2 * math.pi * i / segs), z0)) for i in range(segs)]
        hi = [Vector((v.x, v.y, z1)) for v in lo]
        self.quad_strip(lo, hi, mat_name)
        self.face(hi, mat_name)

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


def screen(b, center, normal, width, height, mat_name, bezel=0.04, depth=0.05):
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
    b.quad_strip(f, k, "TWR_Bezel")
    b.face(list(reversed(k)), "TWR_Bezel")
    return c, up, n


def monitor_mount(name, coll, face_k, width, height, mat_screen, center_z, tilt_deg,
                  ceiling_z, rail_radius):
    """
    Ceiling-hung tower monitor like the real DCA cab: the display in a square-tube
    yoke with side pivot knobs and a handle bar, hanging from a trolley on the
    circular ceiling track (radius rail_radius) that runs all the way round the cab.

    The monitor starts facing the cab centre from window face face_k. It becomes its
    own object `name` (custom property vatflow_track = 1) so the exporter can give it
    a 360-degree animation round the vertical axis: moving along a circular track is
    a rotation about the cab centre.
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
    center_out = rail_radius - (back + up * fh).dot(out)
    c = out * center_out + Vector((0, 0, center_z))

    b = Builder(name, coll)
    screen(b, c, nrm, width, height, mat_screen, bezel=0.035, depth=0.08)
    F = [c + back - right * fw - up * fh, c + back + right * fw - up * fh,
         c + back + right * fw + up * fh, c + back - right * fw + up * fh]
    for i in range(4):                                      # square-tube yoke
        b.beam(F[i], F[(i + 1) % 4], 0.022, "TWR_Mount")
    for s in (-1, 1):                                       # pivot knobs on the sides
        b.beam(c + back + right * s * hw, c + back + right * s * (fw + 0.03), 0.02, "TWR_Mount", segs=8)
        b.beam(c + back + right * s * (fw + 0.03), c + back + right * s * (fw + 0.07), 0.05, "TWR_Mount", segs=10)
    drop = -up * 0.11 + n * 0.07                            # handle bar under the yoke
    hl = c + back - up * fh - right * fw * 0.7
    hr = c + back - up * fh + right * fw * 0.7
    b.beam(hl, hl + drop, 0.018, "TWR_Mount", segs=6)
    b.beam(hr, hr + drop, 0.018, "TWR_Mount", segs=6)
    b.beam(hl + drop, hr + drop, 0.018, "TWR_Mount", segs=6)
    top = c + back + up * fh                                # post up to the trolley
    trolley_z = ceiling_z - 0.10
    b.beam(top, Vector((top.x, top.y, trolley_z)), 0.03, "TWR_Mount", segs=6)
    b.box((top.x, top.y, trolley_z + 0.03), (0.20, 0.12, 0.06), "TWR_Mount", rot_z=ang + math.pi / 2)
    obj = b.finish()
    obj["vatflow_track"] = 1
    return obj


def window_shade(k, coll, a0, a1, z0, z1):
    """
    Roll-down shade for window face k: a dark tinted fabric sheet parallel to the
    leaning glass, hanging from a roller just inside the head of the window.

    Two objects: the roller (static, TowerCab_ShadeRoller_k) and the shade
    (TowerCab_Shade_k). The shade mesh is built in its own local frame (origin on the
    roller, local -Y running down the glass) and gets custom property vatflow_shade,
    so the exporter keeps its transform and animates its local Y scale: frame 0 =
    rolled up, frame 100 = fully down.
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
    roller.beam(origin - along * (half_w + 0.05), origin + along * (half_w + 0.05), 0.045, "TWR_Mount", segs=8)
    for s in (-1, 1):                                       # end brackets up to the head
        e = origin + along * s * (half_w + 0.05)
        roller.beam(e, e - down * 0.10 + inward * 0.0, 0.02, "TWR_Mount")
    roller.finish()

    X, Y = along, -down
    Z = X.cross(Y).normalized()
    shade = Builder("TowerCab_Shade_%d" % k, coll)
    w, L = half_w, length
    shade.face([Vector((-w, 0, 0)), Vector((w, 0, 0)), Vector((w, -L, 0)), Vector((-w, -L, 0))], "TWR_Shade")
    shade.beam(Vector((-w, -L, 0)), Vector((w, -L, 0)), 0.018, "TWR_Mount", segs=6)   # pull bar
    obj = shade.finish()
    obj.matrix_world = Matrix(((X.x, Y.x, Z.x, origin.x), (X.y, Y.y, Z.y, origin.y),
                               (X.z, Y.z, Z.z, origin.z), (0, 0, 0, 1)))
    obj["vatflow_shade"] = 1
    return obj


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


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(bpy.data.collections):
        if coll.name.startswith("TowerCab_"):
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
    z_roof = z_glass1 + P["roof_band_h"]
    a_roof = a1 + P["roof_overhang"]

    ext_coll = new_collection("TowerCab_Exterior")
    int_coll = new_collection("TowerCab_Interior")

    # --- Exterior shell -----------------------------------------------------
    shell = Builder("TowerCab_Shell", ext_coll)
    # sill wall under the glass
    shell.ring(a0 - P["wall_t"], a0, a0 - P["wall_t"], a0, 0.0, z_glass0, "TWR_Concrete")
    # band under the catwalk + floor slab
    shell.prism(a0 + 0.2, a0 + 0.2, -P["under_band_h"], -0.08, "TWR_Concrete")
    # catwalk deck
    shell.ring(a0, a0 + P["catwalk_depth"], a0, a0 + P["catwalk_depth"], -0.08, 0.0, "TWR_Concrete")
    # roof fascia (solid slab, its underside is the overhang soffit)
    shell.prism(a1, a_roof, z_glass1, z_glass1 + 0.25, "TWR_Concrete")
    shell.prism(a_roof, a_roof, z_glass1 + 0.25, z_roof, "TWR_Concrete")
    # round drum on the roof
    shell.cylinder(P["drum_r"], z_roof, z_roof + P["drum_h"], "TWR_Concrete")
    # support stub (the "box" holding it up)
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
    # thin sill and head rails along the glass edges
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
    # antenna masts on the roof edge and the drum
    masts = [(0, 4.0), (1, 6.5), (2, 3.5), (3, 7.0), (4, 4.5), (5, 6.0), (6, 3.5), (7, 5.5)]
    for k, h in masts:
        p = corner(k, a_roof - 0.15, z_roof)
        rails.beam(p, p + Vector((0, 0, h)), 0.035, "TWR_Metal", segs=6)
    rails.beam((0, 0, z_roof + P["drum_h"]), (0, 0, z_roof + P["drum_h"] + 5.0), 0.05, "TWR_Metal", segs=6)
    rails.finish()

    # --- Interior -----------------------------------------------------------
    inside = Builder("TowerCab_Interior", int_coll)
    a_inner = a0 - P["wall_t"]
    inside.prism(a_inner, a_inner, -0.02, 0.0, "TWR_Carpet")                       # floor
    inside.face(list(reversed([corner(i, a1 - 0.02, z_glass1 - 0.01) for i in range(n)])), "TWR_Ceiling")  # ceiling, faces down
    # consoles on every side except the rear (+Y) side, which is the stair entrance
    rear = n // 2
    console_sides = [k for k in range(n) if k != rear]
    inside.ring(a_inner - P["console_depth"], a_inner, a_inner - P["console_depth"], a_inner,
                0.0, P["console_h"], "TWR_Console", sides=console_sides)
    # stair hatch marker at the rear
    ang = face_angle(rear)
    hatch_c = Vector((math.cos(ang), math.sin(ang), 0)) * (a_inner - 1.2)
    inside.box((hatch_c.x, hatch_c.y, 0.005), (1.6, 1.0, 0.01), "TWR_Console", rot_z=ang)

    # TWR INFO display standing on the front-left console (left = +X when facing -Y)
    ang = face_angle(1)  # -45deg
    out = Vector((math.cos(ang), math.sin(ang), 0))
    tilt = math.radians(25)
    c = out * (a_inner - 0.45) + Vector((0, 0, P["console_h"] + 0.24))
    nrm = -out * math.cos(tilt) + Vector((0, 0, math.sin(tilt)))
    center, up, _ = screen(inside, c, nrm, 0.60, 0.30, "$SCREEN_TWRINFO")
    inside.beam(center - up * 0.19, Vector((center.x, center.y, P["console_h"])), 0.03, "TWR_Bezel")

    # Overhead monitors on a circular ceiling track all the way round the cab
    # (each can travel the full 360 degrees): DBRITE radar starts front-right,
    # ASDE-X surface display (portrait) starts front-left.
    track_r = P["track_radius"]
    ceiling_z = z_glass1 - 0.01
    ceiling_track(inside, track_r, ceiling_z)
    monitor_mount("TowerCab_DbriteMount", int_coll, n - 1, 0.80, 0.60, "$SCREEN_DBRITE",
                  2.50, 20, ceiling_z, track_r)
    monitor_mount("TowerCab_AsdexMount", int_coll, 1, 0.60, 0.80, "$SCREEN_ASDEX",
                  2.55, 20, ceiling_z, track_r)

    # Window frames seen from inside: MSFS doesn't draw the exterior model's mullions
    # in the cockpit view, so the interior gets its own, slightly thinner so the two
    # copies don't fight when seen from outside.
    for k in range(n):
        inside.beam(corner(k, a0, z_glass0), corner(k, a1, z_glass1), P["mullion_r"] * 0.85, "TWR_Mullion")
        inside.beam(corner(k, a0, z_glass0), corner(k + 1, a0, z_glass0), 0.034, "TWR_Mullion")
        inside.beam(corner(k, a1, z_glass1), corner(k + 1, a1, z_glass1), 0.034, "TWR_Mullion")

    # Window sill seen from inside: closes the gap between the console tops and the
    # bottom of the glass (the exterior sill wall isn't drawn in the cockpit view).
    # Its outer face stays 1 cm inside the exterior wall so they don't fight.
    inside.ring(a_inner, a0 - 0.01, a_inner, a0 - 0.01, 0.0, z_glass0, "TWR_Console")

    # Roll-down shades, one per window
    for k in range(n):
        window_shade(k, int_coll, a0, a1, z_glass0, z_glass1)
    inside.finish()

    # Eye point marker (not exported): where the MSFS eyepoint should be
    eye = bpy.data.objects.new("EYEPOINT_marker", None)
    eye.empty_display_type = "SPHERE"
    eye.empty_display_size = 0.1
    eye.location = (0.0, -0.5, P["eye_h"])
    bpy.context.scene.collection.objects.link(eye)

    print("Tower cab built: glass %.2f-%.2f m, roof %.2f m, cab %.1f m across flats, eye %.2f m"
          % (z_glass0, z_glass1, z_roof, 2 * a0, P["eye_h"]))


def main():
    build()
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--save" in argv:
        path = argv[argv.index("--save") + 1]
        bpy.ops.wm.save_as_mainfile(filepath=path)
        print("Saved", path)


if __name__ == "__main__":
    main()
