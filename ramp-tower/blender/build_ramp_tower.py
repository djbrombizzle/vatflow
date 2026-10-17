"""
Ramp Control Tower - parametric ramp tower builder for Blender (MSFS 2024).

A basic airline ramp control tower of the kind that sits on top of a concourse, like the
ones at Atlanta (KATL): a boxy shaft of vertically ribbed metal cladding rising off the
concourse roof, a cab whose dark window band leans outward on all four sides, and a ribbed
roof band on top of the glass carrying HVAC units and antenna masts. The cladding round one
corner is white (on the right as you look at the front, as on the reference photo,
docs/reference.jpeg), the rest dark slate.

Inside: carpet, a tile ceiling with light panels, consoles along the front and both side
windows, and four ramp positions with live VATFLOW screens ($SCREEN_* materials, wired up
in common/panel/panel.cfg with the msfs-tower screen pages):

  Left window  (+X)  Ramp 1: ramp list (RAMP) and ramp map E/D (RAMPMAP_ED)
  Front window (-Y)  Ramp 2: ramp map C/B (RAMPMAP_CB) and ground radar (ASDEX)
                     Ramp 3: ramp map A/Hangars (RAMPMAP_AS) and tower radar (DBRITE)
                     clock (CLOCK) between them
  Right window (-X)  Ramp coordinator: VATSMART and airport demand (APTDEMAND)
  Middle, rear       Supervisor desk facing the front windows: airport list (APTLIST)

Every 1024x768 screen runs the msfs-tower screen host, so the MENU tab in its corner
switches it to any other VATFLOW app.

Follows the conventions of msfs-tower/blender/build_tower_cab.py (the KDCA cab) and the
other tower models in this repo, so everything in msfs-tower/SDK-GUIDE.md applies here too.

How to run
  Blender GUI:  Scripting tab -> Open -> this file -> Run Script
  Headless:     blender --background --python build_ramp_tower.py
                (add  -- --save out.blend  to save the result)
  Ready to load glTF files: tools/export_gltf.py (no Blender export needed)

Conventions
  * Units are meters. Origin (0,0,0) = center of the cab floor.
  * Forward ("nose" of the SimObject) = Blender -Y. Left = +X when facing -Y (as in the
    KDCA cab, so the screens' faceDeg matches: 0 front window, 90 left window).
  * Sides: 0 front (-Y), 1 left (+X), 2 rear (+Y), 3 right (-X). Every outline is the
    cab's floor-level rectangle grown (or shrunk) by an offset d in meters.
  * Two collections are created, one per glTF:
      RAMP_Exterior -> ramp_tower.gltf           (model.cfg normal=)
      RAMP_Interior -> ramp_tower_interior.gltf  (model.cfg interior=)
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
    "half_w": 5.0,           # cab / shaft half-width across the front (10 m wide)
    "half_d": 3.75,          # half-depth front to back (7.5 m deep)
    "shaft_h": 7.5,          # shaft from the concourse roof up to the cab floor
    "sill_h": 1.0,           # cladded wall under the glass
    "glass_h": 2.3,          # window band height (vertical)
    "glass_lean_deg": 32.0,  # glass leans outward at the top
    "pane_w": 1.7,           # mullion spacing along the glass
    "wall_t": 0.25,
    "band_h": 1.25,          # ribbed roof band above the glass
    "band_overhang": 0.12,   # roof band sticks out past the top of the glass
    "rib_spacing": 0.32,     # vertical ribs of the metal cladding
    "white_from_x": 2.4,     # cladding is white from here to the left-hand (+X) side (seen from the front: the right)
    "annex": (-3.0, -4.4, 4.2, 2.6, 3.2),   # stair annex on the concourse roof: x, y, w, d, h
    "console_depth": 0.75,
    "console_h": 0.92,
    "eye_h": 1.65,           # standing eye height (camera marker)
    "eye_fwd": 1.2,          # eye this far forward of the cab center
}

# Viewport colours (RGBA, linear). tools/export_gltf.py has the sim's PBR values.
COLORS = {
    "TWR_CladDark": (0.07, 0.08, 0.10, 1.0),
    "TWR_CladWhite": (0.72, 0.72, 0.70, 1.0),
    "TWR_Soffit": (0.02, 0.02, 0.025, 1.0),
    "TWR_Mullion": (0.03, 0.03, 0.035, 1.0),
    "TWR_Glass": (0.004, 0.005, 0.007, 0.92),
    "TWR_Metal": (0.60, 0.60, 0.58, 1.0),
    "TWR_Roof": (0.25, 0.25, 0.25, 1.0),
    "TWR_Equipment": (0.55, 0.56, 0.56, 1.0),
    "TWR_ConcourseRoof": (0.35, 0.35, 0.34, 1.0),
    "TWR_Carpet": (0.03, 0.04, 0.06, 1.0),
    "TWR_Ceiling": (0.55, 0.55, 0.52, 1.0),
    "TWR_LightPanel": (0.90, 0.90, 0.86, 1.0),
    "TWR_Sill": (0.45, 0.42, 0.36, 1.0),
    "TWR_ConsoleTop": (0.25, 0.25, 0.24, 1.0),
    "TWR_ConsoleFront": (0.30, 0.28, 0.24, 1.0),
    "TWR_ConsoleKick": (0.02, 0.02, 0.02, 1.0),
    "TWR_Bezel": (0.01, 0.01, 0.01, 1.0),
    "TWR_PanelGrey": (0.25, 0.26, 0.27, 1.0),
    "TWR_KeyGreen": (0.02, 0.20, 0.04, 1.0),
    "TWR_ChairSeat": (0.01, 0.01, 0.012, 1.0),
    "TWR_Stairwell": (0.008, 0.008, 0.008, 1.0),
    "TWR_Wood": (0.30, 0.18, 0.09, 1.0),
}
SCREEN_COLOR = (0.0, 0.0, 0.0, 1.0)      # every $SCREEN_* material

SIDES = 4


# ---------------------------------------------------------------------------
# Rectangle outline: side k has outward normal at side_angle(k) and sits
# apothem(k) + d from the center. Corner i is where side i-1 meets side i,
# so side k runs from corner k to corner k+1.
# ---------------------------------------------------------------------------
def side_angle(k):
    return -math.pi / 2 + math.pi / 2 * k      # 0 front -Y, 1 left +X, 2 rear +Y, 3 right -X


def apothem(k):
    return P["half_d"] if k % 2 == 0 else P["half_w"]


def corner(i, d, z):
    i %= SIDES
    sx = (-1, 1, 1, -1)[i]      # corner 0 front-right (-X,-Y), 1 front-left, 2 rear-left, 3 rear-right
    sy = (-1, -1, 1, 1)[i]
    return Vector((sx * (P["half_w"] + d), sy * (P["half_d"] + d), z))


def outline(d, z):
    return [corner(i, d, z) for i in range(SIDES)]


def lean_d(z):
    """Offset of the glass line at height z (0 at the sill, growing with the lean)."""
    z0 = P["sill_h"]
    return max(0.0, z - z0) * math.tan(math.radians(P["glass_lean_deg"]))


def material(name):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    rgba = SCREEN_COLOR if name.startswith("$SCREEN_") else COLORS[name]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = 0.6
    mat.diffuse_color = rgba
    mat.use_backface_culling = False  # exported as doubleSided; visible from inside and out
    if name == "TWR_Glass":
        bsdf.inputs["Alpha"].default_value = rgba[3]
        bsdf.inputs["Roughness"].default_value = 0.05
        mat.blend_method = "BLEND"
    if name in ("TWR_Metal", "TWR_CladDark", "TWR_CladWhite"):
        bsdf.inputs["Metallic"].default_value = 0.5
        bsdf.inputs["Roughness"].default_value = 0.45
    return mat


class Builder:
    """Collects geometry per material into one bmesh, then makes one object."""

    def __init__(self, name, collection):
        self.name = name
        self.collection = collection
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
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
            for loop, uv in zip(f.loops, uvs):
                loop[self.uv].uv = uv
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

    def ring(self, d_in, d_out, z0, z1, mat_name, sides=None):
        """Band between two outlines (a wall of thickness d_out - d_in), optionally some sides."""
        for k in sides if sides is not None else range(SIDES):
            i, j = k, k + 1
            o0, jo0, o1, jo1 = corner(i, d_out, z0), corner(j, d_out, z0), corner(i, d_out, z1), corner(j, d_out, z1)
            i0, ji0, i1, ji1 = corner(i, d_in, z0), corner(j, d_in, z0), corner(i, d_in, z1), corner(j, d_in, z1)
            self.face([o0, jo0, jo1, o1], mat_name)
            self.face([ji0, i0, i1, ji1], mat_name)
            self.face([i1, o1, jo1, ji1], mat_name)
            self.face([i0, ji0, jo0, o0], mat_name)
            if sides is not None:
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
        """Box turned rot_z about Z. front_mat colours the local -Y face."""
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


# ---------------------------------------------------------------------------
# Cladding: two-tone ribbed metal
# ---------------------------------------------------------------------------
def clad_mat(x0, x1, k):
    """White round the +X corner (on the right as you look at the front), dark slate elsewhere."""
    if k == 1:
        return "TWR_CladWhite"
    if k in (0, 2) and min(x0, x1) >= P["white_from_x"] - 1e-6:
        return "TWR_CladWhite"
    return "TWR_CladDark"


def split_points(k, d, z):
    """Corners of side k at offset d, split where the cladding colour changes."""
    a, b = corner(k, d, z), corner(k + 1, d, z)
    pts = [a, b]
    xs = P["white_from_x"]
    if k in (0, 2) and min(a.x, b.x) < xs < max(a.x, b.x):
        t = (xs - a.x) / (b.x - a.x)
        pts = [a, a.lerp(b, t), b]
    return pts


def clad_wall(b, d, z0, z1, rib_depth=0.05, rib_w=0.07, top_cap=False):
    """Vertical outside wall at offset d from z0 to z1, two-tone, with ribs every rib_spacing."""
    for k in range(SIDES):
        lo = split_points(k, d, z0)
        hi = split_points(k, d, z1)
        for s in range(len(lo) - 1):
            mat = clad_mat(lo[s].x, lo[s + 1].x, k)
            b.face([lo[s], lo[s + 1], hi[s + 1], hi[s]], mat)
        a, e = corner(k, d, z0), corner(k + 1, d, z0)
        out = Vector((math.cos(side_angle(k)), math.sin(side_angle(k)), 0))
        length = (e - a).length
        n = int(length / P["rib_spacing"])
        rot = side_angle(k) - math.pi / 2
        for r in range(1, n):
            p = a.lerp(e, r / n) + out * (rib_depth / 2)
            mat = clad_mat(p.x, p.x, k)
            b.box((p.x, p.y, (z0 + z1) / 2), (rib_w, rib_depth, z1 - z0), mat, rot_z=rot)
    if top_cap:
        b.face(outline(d, z1), "TWR_Roof")


# ---------------------------------------------------------------------------
# Inside helpers
# ---------------------------------------------------------------------------
def face_frame(k, d_inner):
    """Placing things against side k: at(right, depth, z), screen normal facing(tilt), box turn rot."""
    ang = side_angle(k)
    out = Vector((math.cos(ang), math.sin(ang), 0))
    right = Vector((math.sin(ang), -math.cos(ang), 0))     # controller's right, facing the window
    rot = ang - math.pi / 2                                 # box local -y faces the controller

    def at(r, depth, z):
        return out * (apothem(k) + d_inner - depth) + right * r + Vector((0, 0, z))

    def facing(tilt_deg):
        t = math.radians(tilt_deg)
        return -out * math.cos(t) + Vector((0, 0, math.sin(t)))

    return at, facing, rot


def screen(b, center, normal, width, height, mat_name, bezel=0.03, depth=0.05):
    """A display: UV-mapped screen quad (0..1, upright) in front of a bezel box (msfs-tower's screen())."""
    n = Vector(normal).normalized()
    right = Vector((0, 0, 1)).cross(n).normalized()       # viewer's right, looking along -n
    up = n.cross(right).normalized()
    c = Vector(center)
    hw, hh = width / 2, height / 2
    front = c + n * 0.002
    b.face([front - right * hw - up * hh, front + right * hw - up * hh,
            front + right * hw + up * hh, front - right * hw + up * hh],
           mat_name, uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
    bw, bh = hw + bezel, hh + bezel
    f = [c - right * bw - up * bh, c + right * bw - up * bh, c + right * bw + up * bh, c - right * bw + up * bh]
    k = [p - n * depth for p in f]
    b.quad_strip(f, k, "TWR_Bezel")
    b.face(list(reversed(k)), "TWR_Bezel")
    return c, up


def desk_monitor(b, at, facing, rot, r, depth, top, w, h, mat_screen, tilt=12):
    """A desktop monitor on a stand (screen w x h m)."""
    center, up = screen(b, at(r, depth, top + 0.10 + h / 2), facing(tilt), w, h, mat_screen)
    b.beam(center - up * (h / 2 + 0.02), at(r, depth, top), 0.025, "TWR_Bezel")
    b.box(at(r, depth, top + 0.005), (0.24, 0.18, 0.01), "TWR_Bezel", rot_z=rot)


def chair(b, x, y, rot):
    """Tall sit-stand chair: five-star base, gas post, seat, backrest. Faces local -Y turned by rot."""
    c, s = math.cos(rot), math.sin(rot)
    for i in range(5):
        a = 2 * math.pi * i / 5
        b.beam((x, y, 0.06), (x + 0.32 * math.cos(a), y + 0.32 * math.sin(a), 0.04), 0.02, "TWR_Metal")
    b.cylinder((x, y), 0.03, 0.06, 0.70, "TWR_Metal", segs=10)
    b.box((x, y, 0.74), (0.48, 0.46, 0.08), "TWR_ChairSeat", rot_z=rot)
    back = Vector((x, y, 0)) + Vector((-s, c, 0)) * 0.24
    b.box((back.x, back.y, 1.02), (0.44, 0.06, 0.48), "TWR_ChairSeat", rot_z=rot)


def ramp_position(b, k, d_in, r, screens, top):
    """
    One ramp controller's position on side k, centred r to the controller's right: two
    monitors side by side, keyboard and mouse, radio / intercom panel, chair.
    """
    at, facing, rot = face_frame(k, d_in)
    for i, mat in enumerate(screens):
        desk_monitor(b, at, facing, rot, r + (i - (len(screens) - 1) / 2) * 0.62, 0.36, top, 0.52, 0.39, mat)
    b.box(at(r, 0.60, top + 0.015), (0.46, 0.16, 0.03), "TWR_Bezel", rot_z=rot)                 # keyboard
    b.box(at(r + 0.36, 0.60, top + 0.012), (0.07, 0.11, 0.025), "TWR_Bezel", rot_z=rot)          # mouse
    b.box(at(r - 0.95, 0.42, top + 0.05), (0.36, 0.30, 0.10), "TWR_PanelGrey", rot_z=rot,       # radio panel
          top_mat="TWR_KeyGreen")
    p = at(r, P["console_depth"] + 0.40, 0)
    chair(b, p.x, p.y, rot)


def railing(b, p0, p1, h, spacing=1.2):
    seg = p1 - p0
    posts = max(1, int(seg.length / spacing))
    for s in range(posts + 1):
        p = p0 + seg * (s / posts)
        b.beam(p, p + Vector((0, 0, h)), 0.025, "TWR_Metal")
    for z in (h, h * 0.5):
        b.beam(p0 + Vector((0, 0, z)), p1 + Vector((0, 0, z)), 0.022, "TWR_Metal")


def glass_frames(b, r_mull, glass=True):
    """Leaning glass on all four sides with dark mullions every pane_w and at the corners."""
    z0, z1 = P["sill_h"], P["sill_h"] + P["glass_h"]
    d1 = lean_d(z1)
    for k in range(SIDES):
        lo0, lo1 = corner(k, 0, z0), corner(k + 1, 0, z0)
        hi0, hi1 = corner(k, d1, z1), corner(k + 1, d1, z1)
        if glass:
            b.face([lo0, lo1, hi1, hi0], "TWR_Glass")
        b.beam(lo0, hi0, r_mull * 1.3, "TWR_Mullion")
        b.beam(lo0, lo1, r_mull, "TWR_Mullion")
        b.beam(hi0, hi1, r_mull, "TWR_Mullion")
        panes = max(1, round((lo1 - lo0).length / P["pane_w"]))
        for s in range(1, panes):
            t = s / panes
            b.beam(lo0.lerp(lo1, t), hi0.lerp(hi1, t), r_mull * 0.7, "TWR_Mullion")


def antenna_frame(b, p, along, w, h):
    """H-frame antenna mount: two posts, two cross bars and a diagonal, whips on top."""
    a, e = p - along * (w / 2), p + along * (w / 2)
    up = Vector((0, 0, 1))
    for q in (a, e):
        b.beam(q, q + up * h, 0.04, "TWR_Metal", segs=6)
        b.beam(q + up * h, q + up * (h + 1.4), 0.015, "TWR_Metal", segs=6)          # whip
    for z in (0.35, h * 0.85):
        b.beam(a + up * z, e + up * z, 0.025, "TWR_Metal", segs=6)
    b.beam(a + up * 0.35, e + up * (h * 0.85), 0.018, "TWR_Metal", segs=6)
    b.beam(p + up * h * 0.85, p + up * (h + 1.0), 0.02, "TWR_Metal", segs=6)          # centre whip


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(bpy.data.collections):
        if coll.name.startswith("RAMP_"):
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
    z_g0 = P["sill_h"]
    z_g1 = z_g0 + P["glass_h"]
    d1 = lean_d(z_g1)
    d_band = d1 + P["band_overhang"]
    z_roof = z_g1 + P["band_h"]
    z_base = -P["shaft_h"]

    ext = new_collection("RAMP_Exterior")
    inn = new_collection("RAMP_Interior")

    # --- Exterior: shaft and sill wall (one ribbed cladding from the concourse roof to the glass)
    shell = Builder("RAMP_Shell", ext)
    clad_wall(shell, 0.0, z_base, z_g0)
    shell.face(list(reversed(outline(0.0, z_base))), "TWR_CladDark")
    # roof band: soffit under the overhang, ribbed band, roof deck with a low coping
    shell.face(list(reversed(outline(d_band, z_g1))), "TWR_Soffit")
    clad_wall(shell, d_band, z_g1, z_roof, rib_depth=0.04)
    shell.ring(d_band - 0.18, d_band + 0.02, z_roof, z_roof + 0.12, "TWR_Metal")
    shell.face(outline(d_band - 0.18, z_roof + 0.02), "TWR_Roof")
    shell.finish()

    glass = Builder("RAMP_Glass", ext)
    glass_frames(glass, 0.0, glass=True)
    glass.finish()
    frames = Builder("RAMP_Frame", ext)
    glass_frames(frames, 0.04, glass=False)
    frames.finish()

    # stair / elevator annex on the concourse roof (front-right of the shaft, as in the photo)
    annex = Builder("RAMP_Annex", ext)
    ax, ay, aw, ad, ah = P["annex"]
    annex.box((ax, ay, z_base + ah / 2), (aw, ad, ah), "TWR_CladWhite", top_mat="TWR_Roof")
    annex.box((ax + 0.9, ay - ad / 2 - 0.02, z_base + 1.05), (1.0, 0.04, 2.1), "TWR_CladDark")      # door
    annex.box((ax - 1.0, ay, z_base + ah + 0.45), (1.2, 1.0, 0.9), "TWR_Equipment")              # AC unit
    annex.finish()

    # rooftop: HVAC units on the left-rear, two H-frame antenna mounts and masts
    roof = Builder("RAMP_RoofGear", ext)
    zr = z_roof + 0.02
    for x, y in ((3.0, 1.6), (1.6, 1.6)):
        roof.box((x, y, zr + 0.45), (1.1, 1.4, 0.9), "TWR_Equipment")
        roof.cylinder((x, y), 0.35, zr + 0.9, zr + 1.0, "TWR_Bezel", segs=12)                     # fan
    antenna_frame(roof, Vector((0.6, -0.8, zr)), Vector((1, 0, 0)), 2.6, 2.4)
    antenna_frame(roof, Vector((-2.6, -0.8, zr)), Vector((1, 0, 0)), 2.6, 2.0)
    for x, y, h in ((-4.6, 2.6, 4.2), (-4.2, -2.4, 3.6), (4.4, -2.8, 2.6)):
        roof.beam((x, y, zr), (x, y, zr + h), 0.04, "TWR_Metal", segs=8)
        roof.beam((x - 0.5, y, zr + h - 0.6), (x + 0.5, y, zr + h - 0.6), 0.015, "TWR_Metal", segs=6)
    roof.finish()

    # --- Interior ---------------------------------------------------------------
    inside = Builder("RAMP_Interior", inn)
    wt = P["wall_t"]
    d_in = -wt
    inside.prism(d_in, d_in, -0.02, 0.0, "TWR_Carpet")
    inside.face(list(reversed(outline(d1, z_g1 - 0.01))), "TWR_Ceiling")
    inside.ring(d_in, -0.01, 0.0, z_g0, "TWR_Sill")                       # sill wall seen from inside
    glass_frames(inside, 0.035, glass=False)
    # the roof band's soffit and the concourse roof below, seen through the glass
    inside.ring(d1, d_band + 0.05, z_g1, z_g1 + 0.3, "TWR_Soffit")
    inside.face(outline(14.0, z_base), "TWR_ConcourseRoof")
    clad_wall(inside, 0.0, z_base, z_g0 - 0.05, rib_depth=0.03)

    # consoles along the front (0), left (1) and right (3) windows; the rear (2) has the stairs
    top = P["console_h"]
    d_c = d_in - P["console_depth"]
    for k in (0, 1, 3):
        inside.ring(d_c, d_in, top - 0.04, top, "TWR_ConsoleTop", sides=[k])
        inside.ring(d_c, d_in, 0.10, top - 0.04, "TWR_ConsoleFront", sides=[k])
        inside.ring(d_c + 0.06, d_in, 0.0, 0.10, "TWR_ConsoleKick", sides=[k])

    # ramp positions (live screens, see panel.cfg)
    ramp_position(inside, 1, d_in, 0.4, ["$SCREEN_RAMPMAP_ED", "$SCREEN_RAMP"], top)            # Ramp 1
    ramp_position(inside, 0, d_in, -2.2, ["$SCREEN_RAMPMAP_CB", "$SCREEN_ASDEX"], top)          # Ramp 2 (front, left half)
    ramp_position(inside, 0, d_in, 2.0, ["$SCREEN_RAMPMAP_AS", "$SCREEN_DBRITE"], top)          # Ramp 3 (front, right half)
    ramp_position(inside, 3, d_in, -0.4, ["$SCREEN_VATSMART", "$SCREEN_APTDEMAND"], top)        # coordinator
    # clock between Ramp 2 and Ramp 3, on a small stand
    at, facing, rot = face_frame(0, d_in)
    screen(inside, at(-0.25, 0.25, top + 0.20), facing(5), 0.40, 0.10, "$SCREEN_CLOCK", bezel=0.02)
    inside.box(at(-0.25, 0.27, top + 0.07), (0.30, 0.10, 0.14), "TWR_Bezel", rot_z=rot)

    # supervisor desk in the middle-rear, facing the front windows
    sy = 1.1
    inside.box((0.6, sy, top / 2), (2.2, 0.75, top), "TWR_ConsoleFront", top_mat="TWR_ConsoleTop")
    desk_monitor(inside, lambda r, dp, z: Vector((0.6 - r, sy - 0.20 + dp - 0.36, z)),
                 lambda t: Vector((0, math.cos(math.radians(t)), math.sin(math.radians(t)))),
                 math.pi, 0.0, 0.36, top, 0.52, 0.39, "$SCREEN_APTLIST")
    inside.box((0.6, sy + 0.12, top + 0.015), (0.46, 0.16, 0.03), "TWR_Bezel")
    inside.box((1.4, sy - 0.05, top + 0.05), (0.36, 0.30, 0.10), "TWR_PanelGrey", top_mat="TWR_KeyGreen")
    chair(inside, 0.6, sy + 0.75, 0.0)

    # rear wall: stair well (rear right) with a guard rail, coffee counter (rear left)
    y_rear = apothem(2) + d_in
    s0, s1 = Vector((-4.3, y_rear - 2.4, 0)), Vector((-3.0, y_rear, 0))
    inside.box(((s0.x + s1.x) / 2, (s0.y + s1.y) / 2, 0.003), (s1.x - s0.x, s1.y - s0.y, 0.004), "TWR_Stairwell")
    railing(inside, Vector((s1.x, s1.y - 0.05, 0)), Vector((s1.x, s0.y, 0)), 1.07)
    railing(inside, Vector((s1.x, s0.y, 0)), Vector((s0.x + 0.9, s0.y, 0)), 1.07)
    inside.box((3.2, y_rear - 0.30, top / 2), (2.4, 0.60, top), "TWR_Wood", top_mat="TWR_ConsoleTop")
    inside.box((2.6, y_rear - 0.30, top + 0.17), (0.28, 0.25, 0.34), "TWR_Bezel")                # coffee maker

    # ceiling light panels
    for x in (-2.8, 0.0, 2.8):
        for y in (-1.6, 1.4):
            inside.box((x, y, z_g1 - 0.03), (1.2, 0.6, 0.02), "TWR_LightPanel")
    inside.finish()

    eye = bpy.data.objects.new("EYEPOINT_marker", None)
    eye.empty_display_type = "SPHERE"
    eye.empty_display_size = 0.1
    eye.location = (0.0, -P["eye_fwd"], P["eye_h"])
    bpy.context.scene.collection.objects.link(eye)

    print("Ramp tower built: cab %.1f x %.1f m, glass %.2f-%.2f m (lean %.0f deg, top %.2f m out), roof %.2f m, "
          "shaft bottom %.1f m" % (2 * P["half_w"], 2 * P["half_d"], z_g0, z_g1, P["glass_lean_deg"], d1, z_roof, z_base))


def main():
    build()
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--save" in argv:
        path = argv[argv.index("--save") + 1]
        bpy.ops.wm.save_as_mainfile(filepath=path)
        print("Saved", path)


if __name__ == "__main__":
    main()
