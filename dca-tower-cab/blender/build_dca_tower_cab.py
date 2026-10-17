"""
DCA Tower Cab - the Reagan National (KDCA) tower cab for MSFS 2024, built in Blender from
the DCA cab's equipment-view floor plan (docs/floor-plan.html).

Its own project, separate from msfs-tower/ (the generic VATFLOW Tower Cab): it shares the
way the cab is built and the screens (overhead monitors on a ceiling track, roll-down
shades, the same console look), but the floor plan is DCA's own:

  * The cab outline is the plan's 13-sided wall, glass leaning outward above a sill.
  * GC (POS #3) is front and centre: the front window (Blender -Y, the SimObject's nose).
  * Every counter on the plan is a console, built from its footprint with the same finish
    as the VATFLOW cab (blue laminate worktop, light grey writing strip along the
    controller's edge, dark bumper, blue vent panels, dark kick plinth).
    Perimeter: LCN #1, ALCN #2, GC #3, ALCS #4, LCS #5, TMTW #11; left island HC #6 /
    FD #10 / CD #9; right island NCH #7 / ASTW #8; the right-wall console and turret.
  * Stair and kitchen core at the back right: the stairwell along the glass with its
    treads going down, the refrigerator and sink counter facing the room, knee walls
    round the core.
  * Two overhead monitors (Tower Radar / DBRITE front right, Ground Radar / ASDE-X front
    left) on a circular ceiling track round the cab: drag along the track, height, swivel,
    exactly like the VATFLOW cab (same node names, so the same behaviours and screens).
  * A roll-down shade of navy tinted film in every window.

How to run
  Blender GUI:  Scripting tab -> Open -> this file -> Run Script
  Headless:     blender --background --python build_dca_tower_cab.py
                (add  -- --save out.blend  to save the result)
  Export:       python tools/export_dca_cab.py <out_dir>   (writes the .gltf files the sim loads)

Conventions
  * Units are meters. Origin (0,0,0) = the cab floor at the centre of the ceiling track.
  * Forward = Blender -Y (towards GC's window), the controller's right = Blender -X.
  * Plan coordinates (px of the floor plan sheet, x right, y down the page) go to Blender
    with pm(): 1 ft = PX_PER_FT px (the sheet's scale bar).
  * Collections: DcaCab_Exterior -> dca_tower_cab.gltf, DcaCab_Interior -> dca_tower_cab_interior.gltf.
    Interior objects keep the TowerCab_* names of the VATFLOW cab where they behave the same
    (monitors, shades), so the exporter's model behaviours are the same.
"""

import math
import sys

import bpy  # noqa: E402  (before bmesh when run as the bpy module)
import bmesh
from mathutils import Matrix, Vector
from mathutils.geometry import intersect_line_line_2d, tessellate_polygon

# ---------------------------------------------------------------------------
# The floor plan (px on the sheet, docs/floor-plan.html) and the scale
# ---------------------------------------------------------------------------
PX_PER_FT = 40.0                   # the sheet's scale bar: 4 ft = 160 px
PX_PER_M = PX_PER_FT / 0.3048
ORIGIN_PX = (620.0, 739.0)         # the cab's centre line (GC, x 620) half way front to back

# inner face of the cab wall (top of the console backs), clockwise from GC's window
WALL_PX = [(495, 58), (745, 58), (1000, 245), (1155, 490), (1180, 560), (1180, 930), (1050, 1200),
           (750, 1420), (480, 1420), (240, 1215), (60, 900), (60, 540), (240, 245)]

# counters / desks: (name, footprint, edges the controller works at, height)
# an edge i runs from point i to point i + 1; those get the light grey writing strip
CONSOLES_PX = [
    ("GC", [(515, 58), (725, 58), (725, 195), (515, 195)], [2]),
    ("ALCN", [(745, 58), (1000, 245), (920, 350), (725, 195)], [2]),
    ("LCN", [(1000, 245), (1155, 490), (1045, 540), (920, 350)], [2]),
    ("ALCS", [(240, 245), (495, 58), (515, 195), (320, 350)], [2]),
    ("LCS", [(240, 245), (60, 540), (180, 565), (320, 350)], [2]),
    ("TMTW", [(240, 1215), (480, 1420), (500, 1290), (330, 1130)], [2]),
    # left island: the wall-side block (HC at its top edge), the HC / FD core and the CD desk
    ("HC", [(60, 540), (180, 565), (180, 615), (310, 615), (310, 885), (190, 885), (301, 1157), (240, 1215), (60, 900)], [2]),
    ("FD", [(310, 615), (470, 615), (470, 885), (310, 885)], [0]),
    ("CD", [(190, 885), (470, 885), (470, 920), (244, 920), (330, 1130), (301, 1157)], [2]),
    # right island: NCH turret, the table, ASTW desk
    ("NCH", [(620, 580), (960, 580), (960, 640), (620, 640)], [0]),
    ("ISLAND", [(590, 650), (960, 650), (960, 800), (590, 800)], []),
    ("ASTW", [(620, 840), (790, 840), (790, 890), (620, 890)], [2]),
    # right wall: console and the stand-alone turret
    ("RWALL", [(960, 735), (1180, 735), (1180, 880), (960, 880)], [3]),
    ("TURRET", [(1085, 552.2), (1162.8, 630), (1085, 707.8), (1007.2, 630)], []),
]
# the dark dividers at the front corners, either side of GC
PILLARS_PX = [[(495, 58), (515, 58), (515, 195), (495, 195)], [(725, 58), (745, 58), (745, 195), (725, 195)]]

# stair / kitchen core, in the core's own frame: px along and across the stair edge from
# (718, 1325), turned -36.25 deg on the sheet. Along = towards the top of the stairs
# (upper right), across + = towards the glass, - = into the room.
CORE_ORIGIN_PX, CORE_DEG = (718.0, 1325.0), -36.25
STAIR_ALONG, STAIR_ACROSS = 304.0, 95.0     # stairwell: along 0..304, across 0..95 (to the glass)
CORE_LINE = -100.0                          # the core line (counter fronts / knee walls)
CORE_FROM = -122.0                          # where the core line starts (560, 1317)
FRIDGE = (60.0, 170.0)
SINK = (180.0, 300.0)
CORE_CURVE_PX = [(917, 1055), (973, 1016), (1014, 1062)]   # quadratic curve round the stair top

P = {
    "wall_t": 0.22,          # sill wall: inner face on the plan line, glass on its outer face
    "sill_h": 0.95,          # solid wall under the glass
    "glass_h": 3.0,
    "glass_lean_deg": 15.0,  # glass leans outward at the top
    "mullion_r": 0.07,
    "catwalk_depth": 1.15,
    "rail_h": 1.07,
    "under_band_h": 0.7,
    "roof_band_h": 1.25,
    "roof_overhang": 0.35,
    "drum_r": 2.0,
    "drum_h": 0.9,
    "stub_inset": 1.2,       # support stub under the cab, this far inside the glass
    "stub_h": 6.0,
    "console_h": 0.92,
    "eye_h": 1.65,
    "track_radius": 4.10,    # circular ceiling track (the plan's narrowest point is 4.27 m from the centre)
    "stair_rise": 0.19,
    "knee_h": 1.07,          # knee walls / guards round the stair core
}
# standing eye point: the GC controller, half a metre back from the GC counter
EYE_PX = (620.0, 260.0)

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
    "TWR_Divider": (0.06, 0.065, 0.075, 1.0),       # the dark corner dividers by GC
    "TWR_Wall": (0.70, 0.71, 0.72, 1.0),            # knee walls, stairwell
    "TWR_WallCap": (0.25, 0.27, 0.30, 1.0),
    "TWR_StairTread": (0.12, 0.12, 0.13, 1.0),
    "TWR_StairNosing": (0.75, 0.62, 0.15, 1.0),
    "TWR_Counter": (0.62, 0.60, 0.56, 1.0),         # kitchen counter top
    "TWR_Cabinet": (0.80, 0.79, 0.76, 1.0),         # kitchen base cabinet
    "TWR_Appliance": (0.72, 0.73, 0.74, 1.0),       # refrigerator: brushed steel
    "TWR_SinkSteel": (0.55, 0.56, 0.58, 1.0),
    "$SCREEN_DBRITE": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_ASDEX": (0.0, 0.0, 0.0, 1.0),
}

# ---------------------------------------------------------------------------
# Plan -> Blender, polygons
# ---------------------------------------------------------------------------


def pm(p, z=0.0):
    """A floor plan point (px) in Blender coordinates (m)."""
    return Vector((-(p[0] - ORIGIN_PX[0]) / PX_PER_M, (p[1] - ORIGIN_PX[1]) / PX_PER_M, z))


def core_px(along, across):
    """A point of the stair / kitchen core frame on the sheet (px)."""
    t = math.radians(CORE_DEG)
    return (CORE_ORIGIN_PX[0] + along * math.cos(t) - across * math.sin(t),
            CORE_ORIGIN_PX[1] + along * math.sin(t) + across * math.cos(t))


def core(along, across, z=0.0):
    return pm(core_px(along, across), z)


def signed_area(pts):
    return sum(pts[i].x * pts[(i + 1) % len(pts)].y - pts[(i + 1) % len(pts)].x * pts[i].y for i in range(len(pts))) / 2


def outward(pts, i):
    """Outward unit normal (xy) of edge i of a polygon."""
    a, b = pts[i], pts[(i + 1) % len(pts)]
    e = (b - a).to_2d().normalized()
    n = Vector((e.y, -e.x)) if signed_area(pts) > 0 else Vector((-e.y, e.x))
    return Vector((n.x, n.y, 0.0))


def offset(pts, d, z=None):
    """Polygon with every edge moved out by d (a number, or one per edge; - = in), mitred."""
    n = len(pts)
    ds = d if isinstance(d, (list, tuple)) else [d] * n
    lines = []
    for i in range(n):
        o = outward(pts, i) * ds[i]
        lines.append((pts[i] + o, pts[(i + 1) % n] + o))
    out = []
    for i in range(n):
        (a0, a1), (b0, b1) = lines[i - 1], lines[i]
        x = intersect_line_line_2d(a0.to_2d(), a1.to_2d(), b0.to_2d(), b1.to_2d())
        if x is None or (Vector((x.x, x.y)) - b0.to_2d()).length > 5.0:   # parallel edges
            x = b0.to_2d()
        out.append(Vector((x.x, x.y, pts[i].z if z is None else z)))
    return out


def at_z(pts, z):
    return [Vector((p.x, p.y, z)) for p in pts]


def near_segment(p, a, b, tol):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (a + ab * t - p).length <= tol


def inside(p, pts):
    """Point in polygon (xy)."""
    c = False
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        if (a.y > p.y) != (b.y > p.y) and p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x:
            c = not c
    return c


# ---------------------------------------------------------------------------
# Geometry builder (as in msfs-tower/blender/build_tower_cab.py)
# ---------------------------------------------------------------------------


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
    mat.use_backface_culling = False
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

    def fill(self, outline, mat_name, down=False, holes=()):
        """Flat (possibly concave) polygon, optionally with holes, as triangles; faces up or down."""
        loops = [list(outline)] + [list(h) for h in holes]
        allp = [p for lp in loops for p in lp]
        for tri in tessellate_polygon([[Vector(p) for p in lp] for lp in loops]):
            t = [allp[i] for i in tri]
            nz = (t[1] - t[0]).cross(t[2] - t[0]).z
            if (nz < 0) != down:
                t.reverse()
            self.face(t, mat_name)

    def quad_strip(self, lower, upper, mat_name, closed=True):
        n = len(lower)
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            self.face([lower[i], lower[j], upper[j], upper[i]], mat_name)

    def slab(self, pts, z0, z1, mat_name, top_mat=None, side_mat=None):
        """Solid prism over a footprint (concave is fine)."""
        lo, hi = at_z(pts, z0), at_z(pts, z1)
        self.quad_strip(lo, hi, side_mat or mat_name)
        self.fill(lo, mat_name, down=True)
        self.fill(hi, top_mat or mat_name)

    def loft(self, lo, hi, mat_name, caps=True):
        """Prism between two outlines with the same number of points (convex caps)."""
        self.quad_strip(lo, hi, mat_name)
        if caps:
            self.fill(lo, mat_name, down=True)
            self.fill(hi, mat_name)

    def band(self, in0, out0, in1, out1, mat_name):
        """Closed ring between two outlines at the bottom (in0 / out0) and top (in1 / out1)."""
        self.quad_strip(out0, out1, mat_name)
        self.quad_strip(in1, in0, mat_name)
        self.quad_strip(in0, out0, mat_name)
        self.quad_strip(out1, in1, mat_name)

    def beam(self, p0, p1, r, mat_name, segs=4):
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


def screen(b, center, normal, width, height, mat_name, bezel=0.04, depth=0.05, bezel_mat="TWR_Bezel"):
    """A display: UV-mapped screen quad (0..1, upright) in front of a bezel box."""
    n = Vector(normal).normalized()
    right = Vector((0, 0, 1)).cross(n).normalized()
    up = n.cross(right).normalized()
    c = Vector(center)
    hw, hh = width / 2, height / 2
    front = c + n * 0.002
    pts = [front - right * hw - up * hh, front + right * hw - up * hh,
           front + right * hw + up * hh, front - right * hw + up * hh]
    b.face(pts, mat_name, uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
    bw, bh = hw + bezel, hh + bezel
    f = [c - right * bw - up * bh, c + right * bw - up * bh, c + right * bw + up * bh, c - right * bw + up * bh]
    k = [p - n * depth for p in f]
    b.quad_strip(f, k, bezel_mat)
    b.face(list(reversed(k)), bezel_mat)
    return c, up, n


def bevel_edges(obj, width, segments=2):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, segments=segments, affect="EDGES", profile=0.5)
    bm.to_mesh(obj.data)
    bm.free()


def planar_uvs(obj, mats, meters):
    """UVs for the faces of the given materials, projected on the plane each face mostly faces."""
    idx = [i for i, m in enumerate(obj.data.materials) if m and m.name in mats]
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        if f.material_index not in idx:
            continue
        n = f.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in f.loops:
            p = loop.vert.co
            if az >= ax and az >= ay:
                u, v = p.x, p.y
            elif ax >= ay:
                u, v = p.y, p.z
            else:
                u, v = p.x, p.z
            loop[uv].uv = (u / meters, v / meters)
    bm.to_mesh(obj.data)
    bm.free()


# ---------------------------------------------------------------------------
# Consoles from the plan
# ---------------------------------------------------------------------------

CONSOLE_MATS = ("TWR_ConsoleTop", "TWR_ConsoleFront")
TASK_LIGHTS = []      # (x, y) over each working edge; the exporter writes them into systems.cfg


def edge_open(pts, i, wall, others):
    """True where edge i of a counter faces the room: not on the cab wall, not against another counter."""
    a, b = pts[i], pts[(i + 1) % len(pts)]
    mid = (a + b) / 2
    for k in range(len(wall)):
        if near_segment(a, wall[k], wall[(k + 1) % len(wall)], 0.03) and near_segment(b, wall[k], wall[(k + 1) % len(wall)], 0.03):
            return False
    for o in others:
        if inside(mid, o) or any(near_segment(mid, o[k], o[(k + 1) % len(o)], 0.03) for k in range(len(o))):
            return False
    return True


def console(coll, name, pts, seats, wall, others, top):
    """
    One counter from its plan footprint: blue laminate worktop, a 22 cm light grey writing
    strip along each working edge (seats), a dark bumper round every open edge, blue vent
    panels and a dark kick plinth set back 6 cm under the open edges.
    """
    b = Builder("TowerCab_Console_" + name, coll)
    opened = [edge_open(pts, i, wall, others) for i in range(len(pts))]
    kick = offset(pts, [-0.06 if o else 0.0 for o in opened])
    b.slab(kick, 0.0, 0.10, "TWR_ConsoleKick")
    b.slab(pts, 0.10, top - 0.035, "TWR_ConsoleFront")
    b.slab(pts, top - 0.035, top, "TWR_ConsoleTop")
    for i in seats:
        p0, p1 = pts[i], pts[(i + 1) % len(pts)]
        inn = -outward(pts, i)
        b.slab([p0, p1, p1 + inn * 0.22, p0 + inn * 0.22], top - 0.034, top + 0.003, "TWR_ConsoleRail")
        mid = (p0 + p1) / 2 + inn * 0.40
        TASK_LIGHTS.append((mid.x, mid.y))
    for i, o in enumerate(opened):
        if not o:
            continue
        p0, p1 = pts[i], pts[(i + 1) % len(pts)]
        e = (p1 - p0).normalized()
        out = outward(pts, i)
        z = Vector((0, 0, top - 0.035))
        b.beam(p0 - e * 0.02 + out * 0.012 + z, p1 + e * 0.02 + out * 0.012 + z, 0.036, "TWR_ConsoleBumper", segs=12)
    obj = b.finish()
    planar_uvs(obj, CONSOLE_MATS, 1.0)
    return obj


def consoles(coll, wall, top):
    feet = [[pm(p) for p in pts] for _, pts, _ in CONSOLES_PX]
    pillars = [[pm(p) for p in pts] for pts in PILLARS_PX]
    for i, (name, _, seats) in enumerate(CONSOLES_PX):
        others = [f for j, f in enumerate(feet) if j != i] + pillars
        console(coll, name, feet[i], seats, wall, others, top)
    # dark dividers at the front corners, standing 30 cm above the worktops
    b = Builder("TowerCab_Dividers", coll)
    for pts in pillars:
        b.slab(pts, 0.0, top + 0.30, "TWR_Divider")
    b.finish()


# ---------------------------------------------------------------------------
# Stair / kitchen core
# ---------------------------------------------------------------------------

def stair_hole():
    return [core(0, 0), core(STAIR_ALONG, 0), core(STAIR_ALONG, STAIR_ACROSS), core(0, STAIR_ACROSS)]


def knee_wall(b, p0, p1, h, away_from, t=0.10):
    """A knee wall with one face on the line p0 -> p1, its body on the side away from `away_from`."""
    e = (p1 - p0).normalized()
    n = Vector((-e.y, e.x, 0))
    if n.dot(away_from - p0) > 0:
        n = -n
    lo = [p0, p1, p1 + n * t, p0 + n * t]
    b.slab(lo, 0.0, h - 0.03, "TWR_Wall")
    cap = offset(lo, 0.012)
    b.slab(cap, h - 0.03, h, "TWR_WallCap")


def stair_core(inside, coll):
    """
    The back-right core: stairwell along the glass (top at the upper-right end, the way in from
    the room past the curved knee wall), treads going down; refrigerator and sink counter facing
    the room with their backs to the stairwell; knee walls on the rest of the core line.
    """
    ppx = 1.0 / PX_PER_M
    # stairwell: shaft walls, treads with yellow nosings, the landing at the bottom
    hole = stair_hole()
    n = int(round(STAIR_ALONG / 27.6))
    rise = P["stair_rise"]
    bottom = -(n + 1) * rise
    b = Builder("TowerCab_Stairs", coll)
    for i in range(4):
        p0, p1 = hole[i], hole[(i + 1) % 4]
        b.face([at_z([p0], bottom)[0], at_z([p1], bottom)[0], p1, p0][::-1], "TWR_Wall")
    b.fill(at_z(hole, bottom), "TWR_StairTread")
    step = STAIR_ALONG / n
    for i in range(n):
        a_hi = STAIR_ALONG - i * step
        z = -(i + 1) * rise
        fp = [core(a_hi - step, 0), core(a_hi, 0), core(a_hi, STAIR_ACROSS), core(a_hi - step, STAIR_ACROSS)]
        b.slab(fp, bottom, z, "TWR_StairTread")
        nose = [core(a_hi - 6, 2), core(a_hi, 2), core(a_hi, STAIR_ACROSS - 2), core(a_hi - 6, STAIR_ACROSS - 2)]
        b.slab(nose, z, z + 0.004, "TWR_StairNosing")
    b.finish()

    walls = Builder("TowerCab_CoreWalls", coll)
    h = P["knee_h"]
    # guard along the stair edge behind the counters (the counters' back wall) and across the
    # bottom end of the stairwell
    well = core(STAIR_ALONG / 2, STAIR_ACROSS / 2)
    room = Vector((0, 0, 0))
    knee_wall(walls, core(0, 0), core(STAIR_ALONG, 0), h, well)
    knee_wall(walls, core(0, STAIR_ACROSS), core(0, 0), h, well)
    # knee walls on the core line where there are no counters, and round the curve
    knee_wall(walls, core(CORE_FROM, CORE_LINE), core(FRIDGE[0], CORE_LINE), h, room)
    curve = [core(SINK[1], CORE_LINE)]
    (x0, y0), (cx, cy), (x1, y1) = CORE_CURVE_PX
    for k in range(0, 9):
        t = k / 8
        curve.append(pm(((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1,
                         (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1)))
    for p0, p1 in zip(curve, curve[1:]):
        knee_wall(walls, p0, p1, h, room)
    walls.finish()

    # kitchen: refrigerator and sink counter, fronts on the core line facing the room
    back = -0.10 / ppx                                    # in front of the guard wall
    k = Builder("TowerCab_Kitchen", coll)
    f0, f1 = FRIDGE
    fp = [core(f0, CORE_LINE), core(f1, CORE_LINE), core(f1, back), core(f0, back)]
    k.slab(fp, 0.02, 1.75, "TWR_Appliance")
    k.slab(offset(fp, -0.02), 0.0, 0.02, "TWR_ConsoleKick")
    door = [core(f0 + 3, CORE_LINE - 1), core(f1 - 3, CORE_LINE - 1)]
    for z in (1.20, 1.23):                                # line between freezer and fridge doors
        k.beam(at_z([door[0]], z)[0], at_z([door[1]], z)[0], 0.006, "TWR_Mount")
    hz = (0.95, 1.55)
    k.beam(core(f1 - 10, CORE_LINE - 4, hz[0]), core(f1 - 10, CORE_LINE - 4, hz[1]), 0.012, "TWR_Metal", segs=8)
    s0, s1 = SINK
    fp = [core(s0, CORE_LINE), core(s1, CORE_LINE), core(s1, back), core(s0, back)]
    k.slab(offset(fp, [-0.06, 0.0, 0.0, 0.0]), 0.0, 0.10, "TWR_ConsoleKick")
    k.slab(fp, 0.10, 0.88, "TWR_Cabinet")
    k.slab(offset(fp, [0.02, 0.0, 0.0, 0.0]), 0.88, 0.92, "TWR_Counter")
    mid = (s0 + s1) / 2
    basin = [core(mid - 22, CORE_LINE + 12), core(mid + 22, CORE_LINE + 12), core(mid + 22, CORE_LINE + 60), core(mid - 22, CORE_LINE + 60)]
    k.slab(basin, 0.75, 0.925, "TWR_SinkSteel")
    tap = core(mid, CORE_LINE + 72, 0.92)
    k.beam(tap, tap + Vector((0, 0, 0.30)), 0.012, "TWR_Metal", segs=12)
    k.beam(tap + Vector((0, 0, 0.30)), (core(mid, CORE_LINE + 45, 1.22)), 0.010, "TWR_Metal", segs=12)
    k.finish()


# ---------------------------------------------------------------------------
# Ceiling: lights, soffit, monitor track (as in the VATFLOW cab)
# ---------------------------------------------------------------------------

CEILING_LIGHTS = [(0.0, 0.0), (1.9, 0.0), (-1.9, 0.0), (0.0, 1.9), (0.0, -1.9)]
CEILING_CANS = [(2.9 * math.cos(math.radians(22.5 + 45 * i)), 2.9 * math.sin(math.radians(22.5 + 45 * i))) for i in range(8)] + \
               [(1.25 * math.cos(math.radians(45 * i)), 1.25 * math.sin(math.radians(45 * i))) for i in range(8)] + \
               [(0.0, -3.6), (1.3, -3.4), (-1.3, -3.4), (0.0, 3.6)]


def ceiling_lights(inside, z):
    def can(x, y, r):
        n = 40
        rim = r * 1.35
        disc = [Vector((x + r * math.cos(2 * math.pi * i / n), y + r * math.sin(2 * math.pi * i / n), z - 0.004)) for i in range(n)]
        ring = [Vector((x + rim * math.cos(2 * math.pi * i / n), y + rim * math.sin(2 * math.pi * i / n), z - 0.002)) for i in range(n)]
        inside.face(list(reversed(disc)), "TWR_LightPanel")
        for i in range(n):
            j = (i + 1) % n
            inside.face([ring[i], ring[j], disc[j], disc[i]][::-1], "TWR_CanRim")
    for x, y in CEILING_LIGHTS:
        can(x, y, 0.11)
    for x, y in CEILING_CANS:
        can(x, y, 0.07)


def soffit(inside, top_glass, ceiling_z):
    """Dark band round the ceiling edge above the windows, 65 cm wide with a 12 cm lip."""
    zi, zl = ceiling_z - 0.004, ceiling_z - 0.12
    o, i_ = at_z(offset(top_glass, -0.02), zi), at_z(offset(top_glass, -0.65), zi)
    lip, m = at_z(i_, zl), at_z(offset(top_glass, -0.64), zl)
    n = len(o)
    for k in range(n):
        j = (k + 1) % n
        inside.face([o[k], o[j], i_[j], i_[k]], "TWR_Soffit")
        inside.face([i_[k], i_[j], lip[j], lip[k]], "TWR_Soffit")
        inside.face([lip[k], lip[j], m[j], m[k]], "TWR_Soffit")


def ceiling_track(builder, radius, ceiling_z, segments=48):
    z = ceiling_z - 0.035
    pts = [Vector((radius * math.cos(2 * math.pi * i / segments), radius * math.sin(2 * math.pi * i / segments), z))
           for i in range(segments)]
    for i in range(segments):
        builder.beam(pts[i], pts[(i + 1) % segments], 0.035, "TWR_Mount")
    for i in range(0, segments, segments // 8):
        p = pts[i]
        builder.beam(p, Vector((p.x, p.y, ceiling_z + 0.005)), 0.025, "TWR_Mount")


MONITOR_ARM_M = 0.35
MONITOR_RAISE_M = 0.15
MONITOR_LOWER_M = 0.25


def monitor_mount(name, coll, ang_deg, width, height, mat_screen, center_z, tilt_deg, ceiling_z, rail_radius):
    """
    Ceiling-hung tower monitor, the same part as the VATFLOW cab's (see its build script):
    trolley + sleeve (name, track), telescoping post (name_Lift), display + yoke
    (name_Display), handle bar (name_Handle) and side knobs (name_SwivelL / R). It starts
    on the track at ang_deg (Blender degrees from +X), facing the cab centre.
    """
    ang = math.radians(ang_deg)
    out = Vector((math.cos(ang), math.sin(ang), 0))
    tilt = math.radians(tilt_deg)
    nrm = -out * math.cos(tilt) - Vector((0, 0, math.sin(tilt)))
    n = nrm.normalized()
    right = Vector((0, 0, 1)).cross(n).normalized()
    up = n.cross(right).normalized()
    hw, hh = width / 2 + 0.035, height / 2 + 0.035
    gap = 0.07
    fw, fh = hw + gap, hh + gap
    back = -n * 0.04
    center_out = rail_radius - MONITOR_ARM_M - (back + up * fh).dot(out)
    c = out * center_out + Vector((0, 0, center_z))
    top = c + back + up * fh
    pivot = (top.x, top.y, top.z)
    trolley_z = ceiling_z - 0.10
    elbow_z = top.z + 0.14
    post = top + out * MONITOR_ARM_M
    sleeve_bottom = elbow_z + MONITOR_RAISE_M + 0.06

    b = Builder(name, coll)
    b.beam(Vector((post.x, post.y, sleeve_bottom)), Vector((post.x, post.y, trolley_z)), 0.036, "TWR_Mount", segs=16)
    b.beam(Vector((post.x, post.y, sleeve_bottom - 0.01)), Vector((post.x, post.y, sleeve_bottom + 0.04)), 0.046, "TWR_Mount", segs=20)
    b.box((post.x, post.y, trolley_z + 0.03), (0.20, 0.12, 0.06), "TWR_Mount", rot_z=ang + math.pi / 2)
    mount = b.finish()
    mount["vatflow_anim"] = "track"

    b = Builder(name + "_Lift", coll)
    ez = Vector((0, 0, elbow_z))
    b.beam(Vector((post.x, post.y, elbow_z)), Vector((post.x, post.y, sleeve_bottom + MONITOR_LOWER_M + 0.08)), 0.026, "TWR_Mount", segs=16)
    b.beam(Vector((post.x, post.y, elbow_z - 0.045)), Vector((post.x, post.y, elbow_z + 0.045)), 0.042, "TWR_Mount", segs=20)
    arm0 = Vector((post.x, post.y, 0)) + ez
    arm1 = Vector((top.x, top.y, 0)) + ez
    b.beam(arm0, arm1, 0.024, "TWR_Mount", segs=16)
    b.beam(arm1 + Vector((0, 0, -0.035)), arm1 + Vector((0, 0, 0.035)), 0.036, "TWR_Mount", segs=20)
    b.beam(top, arm1, 0.022, "TWR_Mount", segs=16)
    lift = b.finish()
    lift["vatflow_anim"] = "lift"
    lift["vatflow_parent"] = name

    b = Builder(name + "_Display", coll)
    screen(b, c, nrm, width, height, mat_screen, bezel=0.035, depth=0.08)
    F = [c + back - right * fw - up * fh, c + back + right * fw - up * fh,
         c + back + right * fw + up * fh, c + back - right * fw + up * fh]
    for i in range(4):
        b.beam(F[i], F[(i + 1) % 4], 0.022, "TWR_Mount")
    for sgn in (-1, 1):
        b.beam(c + back + right * sgn * hw, c + back + right * sgn * (fw + 0.03), 0.02, "TWR_Mount", segs=16)
    dsp = b.finish()

    knobs = []
    for side, sgn in (("L", -1), ("R", 1)):
        b = Builder(name + "_Swivel" + side, coll)
        b.beam(c + back + right * sgn * (fw + 0.03), c + back + right * sgn * (fw + 0.07), 0.05, "TWR_Mount", segs=20)
        knobs.append(b.finish())

    b = Builder(name + "_Handle", coll)
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


SHADE_STRIPS = 20


def window_shade(k, coll, b0, b1, t0_, t1_):
    """
    Roll-down shade for window k (glass bottom corners b0, b1, top corners t0_, t1_): the
    VATFLOW cab's shade. A roller (TowerCab_ShadeRoller_k) and SHADE_STRIPS strips
    (TowerCab_Shade_k_sNN) with a pull bar each (TowerCab_ShadeBar_k_sNN), shown by the
    model behaviours from the shade position L:VATFLOW_SHADE_k.
    """
    top_c, bot_c = (t0_ + t1_) / 2, (b0 + b1) / 2
    along = (b1 - b0).normalized()
    down = (bot_c - top_c).normalized()
    inward = along.cross(down).normalized()
    if inward.dot(Vector((-top_c.x, -top_c.y, 0))) < 0:
        inward = -inward
    origin = top_c + inward * 0.12 + down * 0.10
    length = (bot_c - top_c).length - 0.25
    half_w = (b1 - b0).length * 0.45

    roller = Builder("TowerCab_ShadeRoller_%d" % k, coll)
    roller.beam(origin - along * (half_w + 0.05), origin + along * (half_w + 0.05), 0.045, "TWR_Mount", segs=20)
    for s in (-1, 1):
        e = origin + along * s * (half_w + 0.05)
        roller.beam(e, e - down * 0.10, 0.02, "TWR_Mount")
    roller.finish()

    h = length / SHADE_STRIPS
    for i in range(SHADE_STRIPS):
        s0 = origin + down * (0.045 + i * h)
        s1 = origin + down * (0.045 + (i + 1) * h)
        strip = Builder("TowerCab_Shade_%d_s%02d" % (k, i), coll)
        strip.face([s0 - along * half_w, s0 + along * half_w, s1 + along * half_w, s1 - along * half_w], "TWR_Shade")
        obj = strip.finish()
        obj["vatflow_shade"] = k
        obj["vatflow_strip"] = i
        bar = Builder("TowerCab_ShadeBar_%d_s%02d" % (k, i), coll)
        bar.beam(s1 - along * half_w, s1 + along * half_w, 0.018, "TWR_Mount", segs=12)
        obj = bar.finish()
        obj["vatflow_shade"] = k
        obj["vatflow_strip"] = i


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


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


def build():
    clear_scene()
    TASK_LIGHTS.clear()
    wall = [pm(p) for p in WALL_PX]                                  # inner face of the sill
    z0, z1 = P["sill_h"], P["sill_h"] + P["glass_h"]
    g0 = offset(wall, P["wall_t"])                                   # glass, bottom
    g1 = offset(g0, P["glass_h"] * math.tan(math.radians(P["glass_lean_deg"])))   # glass, top
    z_roof = z1 + P["roof_band_h"]
    roof = offset(g1, P["roof_overhang"])
    n = len(wall)
    ceiling_z = z1 - 0.01

    ext = new_collection("DcaCab_Exterior")
    itc = new_collection("DcaCab_Interior")

    # --- Exterior ---------------------------------------------------------------
    shell = Builder("DcaCab_Shell", ext)
    shell.band(at_z(wall, 0), at_z(g0, 0), at_z(wall, z0), at_z(g0, z0), "TWR_Concrete")          # sill wall
    band = offset(g0, 0.2)
    shell.loft(at_z(band, -P["under_band_h"]), at_z(band, -0.08), "TWR_Concrete")                 # floor slab
    cw = offset(g0, P["catwalk_depth"])
    shell.band(at_z(g0, -0.08), at_z(cw, -0.08), at_z(g0, 0), at_z(cw, 0), "TWR_Concrete")        # catwalk
    shell.loft(at_z(g1, z1), at_z(roof, z1 + 0.25), "TWR_Concrete")                               # roof fascia
    shell.loft(at_z(roof, z1 + 0.25), at_z(roof, z_roof), "TWR_Concrete")
    shell.cylinder(P["drum_r"], z_roof, z_roof + P["drum_h"], "TWR_Concrete")
    stub = offset(g0, -P["stub_inset"])
    shell.loft(at_z(stub, -P["under_band_h"] - P["stub_h"]), at_z(stub, -P["under_band_h"]), "TWR_Concrete")
    shell.finish()

    glass = Builder("DcaCab_Glass", ext)
    for k in range(n):
        j = (k + 1) % n
        glass.face([at_z([g0[k]], z0)[0], at_z([g0[j]], z0)[0], at_z([g1[j]], z1)[0], at_z([g1[k]], z1)[0]], "TWR_Glass")
    glass.finish()

    frame = Builder("DcaCab_Frame", ext)
    for k in range(n):
        j = (k + 1) % n
        frame.beam(at_z([g0[k]], z0)[0], at_z([g1[k]], z1)[0], P["mullion_r"], "TWR_Mullion")
        frame.beam(at_z([g0[k]], z0)[0], at_z([g0[j]], z0)[0], 0.04, "TWR_Mullion")
        frame.beam(at_z([g1[k]], z1)[0], at_z([g1[j]], z1)[0], 0.04, "TWR_Mullion")
    frame.finish()

    rails = Builder("DcaCab_Railings", ext)
    for poly, z in ((offset(g0, P["catwalk_depth"] - 0.05), 0.0), (offset(roof, -0.3), z_roof)):
        for k in range(n):
            p0, p1 = at_z([poly[k]], z)[0], at_z([poly[(k + 1) % n]], z)[0]
            seg = p1 - p0
            posts = max(1, int(seg.length / 1.4))
            for s in range(posts):
                p = p0 + seg * (s / posts)
                rails.beam(p, p + Vector((0, 0, P["rail_h"])), 0.03, "TWR_Metal")
            for h in (P["rail_h"], P["rail_h"] * 0.5):
                rails.beam(p0 + Vector((0, 0, h)), p1 + Vector((0, 0, h)), 0.025, "TWR_Metal")
    mast_poly = offset(roof, -0.15)
    for k, h in ((0, 4.0), (2, 6.5), (4, 3.5), (6, 7.0), (8, 4.5), (10, 6.0), (12, 3.5)):
        p = at_z([mast_poly[k]], z_roof)[0]
        rails.beam(p, p + Vector((0, 0, h)), 0.035, "TWR_Metal", segs=12)
    rails.beam((0, 0, z_roof + P["drum_h"]), (0, 0, z_roof + P["drum_h"] + 5.0), 0.05, "TWR_Metal", segs=12)
    rails.finish()

    # --- Interior ---------------------------------------------------------------
    inside = Builder("DcaCab_Interior", itc)
    inside.fill(at_z(wall, 0.0), "TWR_Carpet", holes=[stair_hole()])                    # floor, stairwell open
    inside.fill(at_z(offset(g1, -0.02), ceiling_z), "TWR_Ceiling", down=True)          # ceiling
    # window sill seen from inside (the exterior isn't drawn in the cockpit view)
    inside.band(at_z(wall, 0), at_z(offset(g0, -0.01), 0), at_z(wall, z0), at_z(offset(g0, -0.01), z0), "TWR_Console")
    for k in range(n):                                                                   # mullions seen from inside
        j = (k + 1) % n
        inside.beam(at_z([g0[k]], z0)[0], at_z([g1[k]], z1)[0], P["mullion_r"] * 0.85, "TWR_Mullion")
        inside.beam(at_z([g0[k]], z0)[0], at_z([g0[j]], z0)[0], 0.034, "TWR_Mullion")
        inside.beam(at_z([g1[k]], z1)[0], at_z([g1[j]], z1)[0], 0.034, "TWR_Mullion")

    consoles(itc, wall, P["console_h"])
    stair_core(inside, itc)
    ceiling_lights(inside, ceiling_z - 0.002)
    soffit(inside, g1, ceiling_z)

    # overhead monitors on the circular ceiling track, round the whole cab:
    # Tower Radar (DBRITE) starts front right over the local north positions,
    # Ground Radar (ASDE-X) front left over local south
    track_r = P["track_radius"]
    ceiling_track(inside, track_r, ceiling_z)
    monitor_mount("TowerCab_DbriteMount", itc, -135.0, 0.80, 0.60, "$SCREEN_DBRITE", 2.50, 20, ceiling_z, track_r)
    monitor_mount("TowerCab_AsdexMount", itc, -45.0, 0.80, 0.60, "$SCREEN_ASDEX", 2.55, 20, ceiling_z, track_r)

    # a roll-down shade in every window
    for k in range(n):
        j = (k + 1) % n
        window_shade(k, itc, at_z([g0[k]], z0)[0], at_z([g0[j]], z0)[0], at_z([g1[k]], z1)[0], at_z([g1[j]], z1)[0])
    inside.finish()

    eye = bpy.data.objects.new("EYEPOINT_marker", None)
    eye.empty_display_type = "SPHERE"
    eye.empty_display_size = 0.1
    eye.location = pm(EYE_PX, P["eye_h"])
    bpy.context.scene.collection.objects.link(eye)

    xs, ys = [p.x for p in wall], [p.y for p in wall]
    print("DCA tower cab built: %.1f x %.1f m inside, %d windows, %d counters, track r %.2f m, eye at %s"
          % (max(xs) - min(xs), max(ys) - min(ys), n, len(CONSOLES_PX), track_r, tuple(round(v, 2) for v in eye.location)))


def main():
    build()
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--save" in argv:
        path = argv[argv.index("--save") + 1]
        bpy.ops.wm.save_as_mainfile(filepath=path)
        print("Saved", path)


if __name__ == "__main__":
    main()
