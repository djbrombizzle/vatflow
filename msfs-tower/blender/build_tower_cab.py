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
import os
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
    "track_radius": 4.20,    # circular ceiling track, near the glass (the monitors hang 35 cm in from it on their arms)
}

COLORS = {
    "TWR_Concrete": (0.86, 0.84, 0.79, 1.0),
    "TWR_Mullion": (0.10, 0.10, 0.11, 1.0),
    "TWR_Glass": (0.55, 0.65, 0.70, 0.12),
    "TWR_Metal": (0.78, 0.78, 0.76, 1.0),
    "TWR_Console": (0.16, 0.17, 0.19, 1.0),
    "TWR_ConsoleTop": (0.27, 0.38, 0.53, 1.0),        # console worktop: light blue-grey laminate
    "TWR_ConsoleFront": (0.05, 0.16, 0.39, 1.0),      # console front panels: steel blue
    "TWR_ConsoleKick": (0.02, 0.05, 0.13, 1.0),       # recessed kick plinth: dark blue
    "TWR_ConsoleRail": (0.55, 0.58, 0.62, 1.0),       # light grey laminate writing strip along the front
    "TWR_ConsoleBumper": (0.03, 0.035, 0.04, 1.0),    # dark rounded bumper under it
    "TWR_Carpet": (0.20, 0.22, 0.26, 1.0),
    "TWR_Ceiling": (0.04, 0.04, 0.045, 1.0),     # the real cab ceiling is black
    "TWR_Keypad": (0.20, 0.20, 0.20, 1.0),
    "TWR_Keyboard": (0.05, 0.05, 0.05, 1.0),
    "TWR_Speaker": (0.30, 0.28, 0.24, 1.0),
    "TWR_PanelTan": (0.42, 0.38, 0.31, 1.0),
    "TWR_PanelGrey": (0.55, 0.56, 0.57, 1.0),
    "TWR_Knob": (0.08, 0.08, 0.09, 1.0),
    "TWR_KeyGrey": (0.35, 0.37, 0.40, 1.0),
    "TWR_KeyGreen": (0.10, 0.45, 0.18, 1.0),
    "TWR_KeyRed": (0.50, 0.10, 0.10, 1.0),
    "TWR_PropBlade": (0.95, 0.75, 0.05, 1.0),        # the propeller cap's yellow blade
    "TWR_LightPanel": (1.0, 0.95, 0.85, 1.0),     # ceiling light diffusers (emissive in the sim)
    "TWR_CanRim": (0.55, 0.5, 0.42, 1.0),         # downlight rims: warm brushed metal
    "TWR_FanBody": (0.12, 0.08, 0.05, 1.0),       # ceiling fan motor / brackets: dark bronze
    "TWR_FanBlade": (0.62, 0.63, 0.64, 1.0),      # ceiling fan blades: light grey
    "TWR_Soffit": (0.02, 0.02, 0.025, 1.0),       # dark band round the ceiling edge
    "TWR_SwitchPlate": (0.85, 0.84, 0.80, 1.0),   # wall switch plate
    "TWR_SwitchRocker": (0.95, 0.94, 0.90, 1.0),
    "TWR_GuideSheet": (1.0, 1.0, 1.0, 1.0),        # the laminated quick guide on the TMU desk
    "TWR_FanLabel": (1.0, 1.0, 1.0, 1.0),
    "TWR_FwdSign": (1.0, 1.0, 1.0, 1.0),           # FWD placard on the front console
    "TWR_Banner": (1.0, 1.0, 1.0, 1.0),            # party banner cards (tools/make_textures.py banner)
    "TWR_BannerString": (0.95, 0.94, 0.91, 1.0),
    "TWR_CarpetLogo": (0.20, 0.22, 0.26, 1.0),     # carpet with the VATFLOW logo woven in
    "TWR_AlarmLit": (1.0, 0.08, 0.06, 1.0),        # windshear MUTE button, lit          # FAN label above the fan switch
    "TWR_Laminate": (0.88, 0.9, 0.92, 1.0),       # its clear laminate border
    "TWR_KnobLit": (1.0, 0.78, 0.39, 1.0),        # knob pointers / knob panel edge light (faintly emissive in the sim)
    "TWR_Wood": (0.62, 0.48, 0.32, 1.0),          # light oak desk edging (TMU desk)
    "TWR_DeskTop": (0.30, 0.35, 0.40, 1.0),       # blue-grey desk top (TMU desk)
    "TWR_Strip": (0.92, 0.90, 0.84, 1.0),         # flight progress strips
    "TWR_StripBay": (0.80, 0.66, 0.30, 1.0),      # strip bay rails
    "$SCREEN_APTDEMAND": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_APTLIST": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_CLOCK2": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_RAMP": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_VATSMART": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_RAMPMAP_ED": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_RAMPMAP_CB": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_RAMPMAP_AS": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_STRIPS_1": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_STRIPS_2": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_STRIPS_3": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_SIGN_1": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_SIGN_2": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_SIGN_3": (0.0, 0.0, 0.0, 1.0),
    "TWR_Bezel": (0.05, 0.05, 0.05, 1.0),
    "$SCREEN_TWRINFO": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_DBRITE": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_ASDEX": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_IDST": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_CLOCK": (0.0, 0.0, 0.0, 1.0),
    "$SCREEN_VSCS": (0.0, 0.0, 0.0, 1.0),
    "TWR_Mount": (0.03, 0.03, 0.035, 1.0),
    "TWR_Shade": (0.16, 0.33, 0.60, 0.65),         # navy tinted film (glows a little of its own blue by day)
    "TWR_ShadeNight": (0.16, 0.33, 0.60, 0.65),    # the same film at night: no glow
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


def desk_monitor(b, at, facing, rot, r, depth, top, w, h, mat_screen, tilt=15, keyboard=True):
    """A desktop monitor on a stand (screen w x h m), optionally with a keyboard in front."""
    center, up, _ = screen(b, at(r, depth, top + 0.08 + h / 2), facing(tilt), w, h, mat_screen, bezel=0.03)
    b.beam(center - up * (h / 2 + 0.02), at(r, depth, top), 0.025, "TWR_Bezel")
    b.box(at(r, depth, top + 0.005), (0.22, 0.16, 0.01), "TWR_Bezel", rot_z=rot)
    if keyboard:
        b.box(at(r, depth + 0.26, top + 0.015), (0.44, 0.15, 0.03), "TWR_Bezel", rot_z=rot, top_mat="TWR_Keyboard")


FANS = [(1.15, 1.15), (-1.15, -1.15)]    # ceiling fans (Blender x, y), diagonal like the real cab


def ceiling_fans(inside, coll, ceiling_z):
    """
    Ceiling fans like the real cab: canopy and downrod (static), and the turning part
    (TowerCab_Fan_n: bronze motor housing, five light grey blades on dark brackets). They
    turn only while the switch on the TMU desk is on (L:VATFLOW_FANS; exporter "spin").
    """
    for i, (x, y) in enumerate(FANS):
        hub = ceiling_z - 0.48
        inside.beam(Vector((x, y, ceiling_z - 0.06)), Vector((x, y, ceiling_z)), 0.07, "TWR_FanBody", segs=24)   # canopy
        inside.beam(Vector((x, y, hub + 0.06)), Vector((x, y, ceiling_z - 0.06)), 0.013, "TWR_FanBody", segs=12)  # downrod
        b = Builder("TowerCab_Fan_%d" % (i + 1), coll)
        b.beam(Vector((x, y, hub - 0.07)), Vector((x, y, hub + 0.07)), 0.10, "TWR_FanBody", segs=32)          # motor
        b.beam(Vector((x, y, hub - 0.10)), Vector((x, y, hub - 0.07)), 0.05, "TWR_FanBody", segs=24)          # cap
        for k in range(5):
            a = 2 * math.pi * k / 5
            d = Vector((math.cos(a), math.sin(a), 0))
            b.box(Vector((x, y, hub - 0.02)) + d * 0.14, (0.10, 0.03, 0.012), "TWR_FanBody", rot_z=a)    # bracket
            b.box(Vector((x, y, hub - 0.03)) + d * 0.43, (0.52, 0.13, 0.01), "TWR_FanBlade", rot_z=a)    # blade
        fan = b.finish()
        fan["vatflow_anim"] = "spin"
        fan["vatflow_pivot"] = (x, y, hub)


def cap_propeller(coll, cap):
    """A little two-blade propeller on the cap's top button (its highest point)."""
    pts = [v.co for v in cap.data.vertices]
    ztop = max(p.z for p in pts)
    near = [p for p in pts if p.z > ztop - 0.004]
    c = Vector((sum(p.x for p in near) / len(near), sum(p.y for p in near) / len(near), ztop - 0.003))
    b = Builder("TowerCab_CapPropeller", coll)
    b.beam(c, c + Vector((0, 0, 0.022)), 0.004, "TWR_FanBody", segs=8)                 # shaft
    b.beam(c + Vector((0, 0, 0.018)), c + Vector((0, 0, 0.028)), 0.009, "TWR_KeyRed", segs=16)   # hub
    for k, mat in ((0, "TWR_KeyRed"), (1, "TWR_PropBlade")):
        d = Vector((math.cos(math.pi * k), math.sin(math.pi * k), 0))
        b.box(c + Vector((0, 0, 0.024)) + d * 0.045, (0.075, 0.018, 0.003), mat, rot_z=math.pi * k + 0.0)
    obj = b.finish()
    obj["vatflow_anim"] = "spin"
    obj["vatflow_pivot"] = tuple(c)
    return obj


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
        if all((x - fx) ** 2 + (y - fy) ** 2 > 0.75 ** 2 for fx, fy in FANS):    # none above a fan
            can(x, y, 0.07)


# Ceiling light spots (Blender x, y in m): four round the cab plus one in the middle.
CEILING_LIGHTS = [(0.0, 0.0), (1.9, 0.0), (-1.9, 0.0), (0.0, 1.9), (0.0, -1.9)]
# smaller downlights in a ring between them and the monitor track (look only: no light of their own)
CEILING_CANS = [(2.9 * math.cos(math.radians(22.5 + 45 * i)), 2.9 * math.sin(math.radians(22.5 + 45 * i))) for i in range(8)] + \
               [(1.25 * math.cos(math.radians(45 * i)), 1.25 * math.sin(math.radians(45 * i))) for i in range(8)]


def bevel_edges(obj, width, segments=2):
    """Rounds every box edge of a part a little (catches the light; a few hundred triangles)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, segments=segments, affect="EDGES", profile=0.5)
    bm.to_mesh(obj.data)
    bm.free()


ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


def retextured_part(obj, asset):
    """
    If blender/assets/<asset>.glb exists (a Meshy retexture of this part, fitted by
    tools/meshy_retexture.py), its mesh and UVs replace the part's, with one material
    TWR_<Asset> (textures in common/texture). Else the part keeps its plain materials.
    """
    path = os.path.join(ASSETS, asset + ".glb")
    if not os.path.exists(path):
        return
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if not new:
        return
    src = new[0]
    src.data.transform(src.matrix_world)                 # the asset is stored in cab coordinates
    mat_name = "TWR_" + "".join(p.capitalize() for p in asset.split("_"))
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    src.data.materials.clear()
    src.data.materials.append(mat)
    old = obj.data
    obj.data = src.data
    obj.data.name = obj.name
    for o in [x for x in bpy.data.objects if x not in before and x != obj]:    # the imported objects
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.meshes.remove(old)


def prop(coll, asset, at, rot_z=0.0):
    """
    A loose object from blender/assets/<asset>.glb (tools/meshy_retexture.py prop: standing
    on its base, its own frame), set down at `at` turned rot_z (radians) as its own object
    TowerCab_<Asset> with one material TWR_<Asset> (textures in common/texture). Nothing when
    the asset isn't there.
    """
    path = os.path.join(ASSETS, asset + ".glb")
    if not os.path.exists(path):
        return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if not new:
        return None
    src = new[0]
    src.data.transform(Matrix.Translation(at) @ Matrix.Rotation(rot_z, 4, "Z") @ src.matrix_world)
    name = "".join(p.capitalize() for p in asset.split("_"))
    mat = bpy.data.materials.get("TWR_" + name) or bpy.data.materials.new("TWR_" + name)
    src.data.materials.clear()
    src.data.materials.append(mat)
    obj = bpy.data.objects.new("TowerCab_" + name, src.data)
    obj.data.name = obj.name
    coll.objects.link(obj)
    for o in [x for x in bpy.data.objects if x not in before and x != obj]:
        bpy.data.objects.remove(o, do_unlink=True)
    return obj


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


def tmu_desk(inside, coll, a_inner, top):
    """
    TMU position in the back-left corner (window face 3), after the DCA TMU desk.
    On the console, three monitors with keyboards: VATSMART for KDCA,
    the APT Dashboard's demand vs AAR chart and its aircraft list. A desk with light oak edging and a blue-grey top runs
    from the console corner (between faces 2 and 3) diagonally into the room toward the
    middle, separating the corner; on it the red LED clock cabinet (console end).
    """
    at, facing, rot, out, right = face_frame(3, a_inner)
    desk_monitor(inside, at, facing, rot, -1.00, 0.40, top, 0.44, 0.33, "$SCREEN_VATSMART")
    desk_monitor(inside, at, facing, rot, -0.10, 0.40, top, 0.44, 0.33, "$SCREEN_APTDEMAND")
    desk_monitor(inside, at, facing, rot, 0.80, 0.40, top, 0.44, 0.33, "$SCREEN_APTLIST")

    # the desk: along the line from the console corner toward the cab centre
    ca = corner_angle(3)                                        # corner between faces 2 and 3
    toward = Vector((-math.cos(ca), -math.sin(ca), 0))          # inward, along the desk
    side = Vector((-toward.y, toward.x, 0))                     # across the desk
    start = corner(3, a_inner - P["console_depth"], 0.0)        # console's inner corner
    start = Vector((start.x, start.y, 0)) - toward * 0.05       # tucked under the console edge
    length, w = 2.2, 0.70
    drot = math.atan2(-toward.x, toward.y)                      # box local +y = along the desk

    def P2(s_, t_, z):                                          # s along the desk, t across
        return start + toward * s_ + side * t_ + Vector((0, 0, z))

    mid = length / 2
    # the desk is its own object (TowerCab_TmuDesk), so it can be textured on its own (Meshy
    # retexture: tools/meshy_retexture.py); vatflow_frame = its origin and turn, for that tool
    desk = Builder("TowerCab_TmuDesk", coll)
    desk.box(P2(mid, 0, top - 0.02), (w, length, 0.04), "TWR_ConsoleTop", rot_z=drot)          # top: console laminate
    desk.box(P2(mid, 0, top - 0.10), (w + 0.03, length + 0.015, 0.12), "TWR_Wood", rot_z=drot) # oak edge band, all round
    desk.box(P2(mid, 0, (top - 0.16) / 2 + 0.05), (w - 0.06, length - 0.04, top - 0.26), "TWR_ConsoleFront", rot_z=drot)
    desk.box(P2(mid, 0, 0.05), (w - 0.10, length - 0.08, 0.10), "TWR_ConsoleKick", rot_z=drot) # dark kick plinth
    desk_obj = desk.finish()
    # quick guide (how to put / move the cab in the tower), a printed letter sheet under clear
    # laminate on the desk top, read from the TMU side (-side): its top edge points away
    sc = P2(1.30, -0.10, top)
    upv, rgt = side, side.cross(Vector((0, 0, 1)))
    for mat, hw, hh, dz in (("TWR_Laminate", 0.118, 0.150, 0.0010), ("TWR_GuideSheet", 0.108, 0.1397, 0.0018)):
        cz = sc + Vector((0, 0, dz))
        pts = [cz - rgt * hw - upv * hh, cz + rgt * hw - upv * hh, cz + rgt * hw + upv * hh, cz - rgt * hw + upv * hh]
        inside.face(pts, mat, uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
    # ceiling fan switch on the desk's far end (the end out on the open floor), towards its
    # +side corner: a plate (click it, TowerCab_FanSwitch) and its rocker shown up (on) or
    # down (off), with an engraved FAN label above it
    # a propeller cap left on the desk's far end: the cap is a Meshy prop (if the asset is
    # there), the propeller on its top button is built here (TowerCab_CapPropeller) and
    # turns while the ceiling fans are on (exporter "spin", like the fans)
    cap = prop(coll, "prop_hat", P2(length - 0.32, 0.12, top), drot + math.radians(200))
    if cap:
        cap_propeller(coll, cap)
    end = length - 0.02 + 0.006                                 # just proud of the end panel
    sw = P2(end, w / 2 - 0.16, 0.62)
    b = Builder("TowerCab_FanSwitch", coll)
    b.box(sw, (0.08, 0.012, 0.12), "TWR_SwitchPlate", rot_z=drot)
    b.finish()
    for state, dz in (("On", 0.012), ("Off", -0.012)):
        b = Builder("TowerCab_FanSwitch_" + state, coll)
        b.box(sw + toward * 0.01 + Vector((0, 0, dz)), (0.022, 0.012, 0.03), "TWR_SwitchRocker", rot_z=drot)
        b.finish()
    lc, lr = sw + toward * 0.0065 + Vector((0, 0, 0.09)), side       # label: 8 x 4 cm, facing +toward
    inside.face([lc - lr * 0.04 - Vector((0, 0, 0.02)), lc + lr * 0.04 - Vector((0, 0, 0.02)),
                 lc + lr * 0.04 + Vector((0, 0, 0.02)), lc - lr * 0.04 + Vector((0, 0, 0.02))],
                "TWR_FanLabel", uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
    bevel_edges(desk_obj, 0.006)
    desk_obj["vatflow_frame"] = (start.x, start.y, 0.0, drot)
    planar_uvs(desk_obj, CONSOLE_MATS, 1.0,
               Matrix.Rotation(-drot, 4, "Z") @ Matrix.Translation((-start.x, -start.y, 0)))

    # red LED clock cabinet at the console end of the desk, facing the TMU corner (-side)
    inside.box(P2(0.35, 0, top + 0.11), (0.30, 0.42, 0.22), "TWR_PanelGrey", rot_z=drot)
    clock_face = P2(0.35, -0.151, top + 0.15)
    screen(inside, clock_face, -side, 0.22, 0.055, "$SCREEN_CLOCK2", bezel=0.012, depth=0.005)


STRIP_BAYS = 3
STRIP_BAY_W, STRIP_BAY_L, STRIP_BAY_SLOPE = 0.96, 0.56, 40.0   # board width (3 columns), length up the slope, degrees
STRIP_BAY_COLS = 3
STRIP_BAY_REST = 0.8       # built (and resting) this far right of the face centre: a clear spot (LOCAL's)


def strip_bays(coll, a_inner, top):
    """
    Flight strip bays (TMU, ground, local by default), each a sloped board three columns wide
    at the front of the console with its strips drawn on it ($SCREEN_STRIPS_n, gauge StripBay/) and a
    position sign on the console front below it ($SCREEN_SIGN_n). All are built at the
    front console (face 0, centre) and placed from the cab's STRIP BAYS screen:
      TowerCab_StripBay_n         turns round the cab, L:VATFLOW_BAY_n_DEG (45 per face)
      TowerCab_StripBay_n_Slide   slides along that face, L:VATFLOW_BAY_n_SLIDE (cm from where it
                                  is built, STRIP_BAY_REST right of the face centre, + 200)
    """
    at, facing, rot, out, right = face_frame(0, a_inner)
    s = math.radians(STRIP_BAY_SLOPE)
    d0, z0 = 0.71, top + 0.035                        # low (near) edge of the board
    d1, z1 = d0 - STRIP_BAY_L * math.cos(s), z0 + STRIP_BAY_L * math.sin(s)
    for n in range(1, STRIP_BAYS + 1):
        name = "TowerCab_StripBay_%d" % n
        hub = Builder(name, coll)                     # tiny anchor inside the console body
        hub.box(at(0, 0.45, top - 0.30), (0.01, 0.01, 0.01), "TWR_Console", rot_z=rot)
        hub_obj = hub.finish()
        hub_obj["vatflow_anim"] = "track"
        b = Builder(name + "_Slide", coll)
        c = at(STRIP_BAY_REST, (d0 + d1) / 2, (z0 + z1) / 2)
        center, up, n_ = screen(b, c, facing(90 - STRIP_BAY_SLOPE), STRIP_BAY_W, STRIP_BAY_L, "$SCREEN_STRIPS_%d" % n,
                                bezel=0.02, depth=0.03, bezel_mat="TWR_StripBay")
        # lip along the bottom edge (stops the strips sliding off) and a back leg under each
        # column edge (the column rails are drawn on the screen, so nothing covers its clicks)
        lo = center - up * (STRIP_BAY_L / 2 + 0.02)
        b.box(lo + n_ * 0.015 + Vector((0, 0, 0.005)), (STRIP_BAY_W + 0.04, 0.02, 0.03), "TWR_StripBay", rot_z=rot)
        for i in range(STRIP_BAY_COLS + 1):
            x = -STRIP_BAY_W / 2 + STRIP_BAY_W * i / STRIP_BAY_COLS
            x = max(-STRIP_BAY_W / 2 + 0.02, min(STRIP_BAY_W / 2 - 0.02, x))
            hi = center + up * (STRIP_BAY_L / 2) - n_ * 0.03 + right * x
            b.beam(hi, Vector((hi.x, hi.y, top)), 0.012, "TWR_StripBay")
        # position sign: a name plate standing on the outer (controller's) edge of the worktop,
        # in front of the bay's lip, leaning back 30 deg so it reads from the chair
        lean = math.radians(30)
        sh, sb = 0.06, 0.005
        foot = at(STRIP_BAY_REST, P["console_depth"] + 0.035, top - 0.002)
        tip = out * math.sin(lean) + Vector((0, 0, math.cos(lean)))
        screen(b, foot + tip * (sh / 2 + sb), facing(30), 0.24, sh, "$SCREEN_SIGN_%d" % n, bezel=sb, depth=0.006)
        bay = b.finish()
        bay["vatflow_anim"] = "slide"
        bay["vatflow_parent"] = name
        bay["vatflow_axis"] = tuple(right)


def props(coll, a_inner, top):
    """
    Loose objects made with Meshy (blender/assets/prop_*.glb, tools/meshy_retexture.py prop):
    the coffee maker on the back-right console by the stairs, binoculars on the front
    console by the window. Each is skipped when its asset isn't there.
    """
    at, facing, rot, out, right = face_frame(5, a_inner)
    prop(coll, "prop_coffee", at(0.35, 0.30, top), rot + math.radians(-15))
    at, facing, rot, out, right = face_frame(0, a_inner)
    prop(coll, "prop_binoculars", at(0.18, 0.22, top), rot + math.radians(70))


def fwd_sign(inside, a_inner):
    """
    FWD placard low on the front console's front (window face 0, the way FWD moves the cab
    on TOWER SETUP): an arrow pointing up towards the front window, 70 x 35 cm, a few mm
    proud of the vent panels.
    """
    at, facing, rot, out, right = face_frame(0, a_inner)
    c = at(0.0, P["console_depth"] + 0.004, 0.40)
    hw, hh = 0.35, 0.175
    up = Vector((0, 0, 1))
    pts = [c - right * hw - up * hh, c - right * hw + up * hh, c + right * hw + up * hh, c + right * hw - up * hh]
    inside.face(pts, "TWR_FwdSign", uvs=[(0, 0), (0, 1), (1, 1), (1, 0)])      # faces into the cab


# the party banner: as tools/make_textures.py BANNER_WORDS / BANNER_COLS / BANNER_ROWS
BANNER_CARDS, BANNER_COLS, BANNER_ROWS = 10, 5, 2


def party_banner(inside, a_inner, top):
    """
    A party banner strung along the front of the back-right console (window face 5, the one
    with the coffee maker): BANNER_CARDS swallow-tailed cards, one word each ("GOOD LUCK AT ZDC
    LIVE, WE'RE ALL COUNTING ON YOU", texture TWR_Banner), hanging from a string tied under the
    worktop's front edge at both ends and sagging in the middle. Each card hangs straight
    down from the string, a little in front of the vent panels, turned a few degrees either
    way like real party cards.
    """
    at, facing, rot, out, right = face_frame(5, a_inner)
    depth = P["console_depth"] + 0.07                  # just in front of the worktop's bumper
    z_tie, sag, span = top - 0.06, 0.13, 1.15          # string tied 6 cm under the top, sags 13 cm
    def string_at(r):                                  # the string's height at r (a parabola)
        return z_tie - sag * (1 - (r / span) ** 2)
    # the string, in short straight pieces
    n = 24
    pts = [at(-span + 2 * span * i / n, depth, string_at(-span + 2 * span * i / n)) for i in range(n + 1)]
    for i in range(n):
        inside.beam(pts[i], pts[i + 1], 0.0025, "TWR_BannerString", segs=6)
    # the cards
    pitch = 2 * span / BANNER_CARDS
    w, h, notch = pitch * 0.86, 0.26, 0.06
    up = Vector((0, 0, 1))
    for i in range(BANNER_CARDS):
        r = -span + pitch * (i + 0.5)
        top_c = at(r, depth + 0.004, string_at(r) + 0.012)
        tilt = math.radians((-3, 2, -2, 3, -1)[i % 5])  # each hangs a little crooked
        side = right * math.cos(tilt) + up * math.sin(tilt)
        down = -up * math.cos(tilt) + right * math.sin(tilt)
        tl, tr = top_c - side * (w / 2), top_c + side * (w / 2)
        bl, br = tl + down * h, tr + down * h
        tm, nm = top_c, top_c + down * (h - notch)     # top middle, the swallow-tail's notch
        u0, u1 = (i % BANNER_COLS) / BANNER_COLS, (i % BANNER_COLS + 1) / BANNER_COLS
        v1 = 1 - (i // BANNER_COLS) / BANNER_ROWS      # glTF / Blender UV: v up
        v0 = v1 - 1 / BANNER_ROWS
        um, vn = (u0 + u1) / 2, v0 + (v1 - v0) * notch / h
        # two halves (each convex), facing into the cab like the FWD placard
        inside.face([bl, tl, tm, nm], "TWR_Banner", uvs=[(u0, v0), (u0, v1), (um, v1), (um, vn)])
        inside.face([nm, tm, tr, br], "TWR_Banner", uvs=[(um, vn), (um, v1), (u1, v1), (u1, v0)])


# the woven-in carpet logo at the back of the cab (same numbers as tools/make_textures.py)
CARPET_LOGO_CENTER = (0.0, 1.75)
CARPET_LOGO_SIZE = (2.0, 0.85)


def carpet_logo(inside):
    """
    A patch of floor at the back of the cab (in front of the stair hatch) in TWR_CarpetLogo:
    the carpet with "MADE AND POWERED BY VATFLOW TECHNOLOGIES" woven in. It sits 1.5 mm
    above the floor and is mapped like the floor, so only the lettering shows.
    """
    (cx, cy), (w, h) = CARPET_LOGO_CENTER, CARPET_LOGO_SIZE
    z = 0.0015
    inside.face([Vector((cx - w / 2, cy - h / 2, z)), Vector((cx + w / 2, cy - h / 2, z)),
                 Vector((cx + w / 2, cy + h / 2, z)), Vector((cx - w / 2, cy + h / 2, z))], "TWR_CarpetLogo")


def ramp_computer(inside, a_inner, top):
    """
    Ramp computers. The ramp list (vatflow gates page) left of the clock: the right-hand
    end of window face 2, next to the local controller's position. Ramp maps, each on the
    console facing that part of the terminal: E / D left of the ramp list (face 2);
    C / B and A / Hangars right of the IDST, on the front window (face 0).
    """
    at, facing, rot, out, right = face_frame(2, a_inner)
    desk_monitor(inside, at, facing, rot, 1.05, 0.40, top, 0.48, 0.36, "$SCREEN_RAMP")
    desk_monitor(inside, at, facing, rot, 0.40, 0.40, top, 0.48, 0.36, "$SCREEN_RAMPMAP_ED", keyboard=False)
    at, facing, rot, out, right = face_frame(0, a_inner)
    desk_monitor(inside, at, facing, rot, -0.95, 0.40, top, 0.48, 0.36, "$SCREEN_RAMPMAP_CB", keyboard=False)
    desk_monitor(inside, at, facing, rot, -0.15, 0.40, top, 0.48, 0.36, "$SCREEN_RAMPMAP_AS", keyboard=False)


def console_equipment(inside, coll, k, a_inner, top):
    """
    The desk equipment round the TWR INFO screen on console face k, laid out like the
    DCA local control position: voice switch panel and red LED clock on the left, keypad
    and trackball in front of TWR INFO, the IDST release screen with its keyboard and
    four hardware keys on the right, and a knob panel. Positions are (right, depth, z):
    right = to the controller's right when facing the window, depth = in from the window wall.
    """
    ang = face_angle(k)
    out = Vector((math.cos(ang), math.sin(ang), 0))
    right = Vector((math.sin(ang), -math.cos(ang), 0))
    rot = ang - math.pi / 2          # box local +x = right, +y = toward the window

    def at(r, depth, z):
        return out * (a_inner - depth) + right * r + Vector((0, 0, z))

    def facing(tilt_deg):            # screen normal: toward the controller, tilted back
        t = math.radians(tilt_deg)
        return -out * math.cos(t) + Vector((0, 0, math.sin(t)))

    def deck(r, depth, size, body, top_mat=None, z0=top):
        inside.box(at(r, depth, z0 + size[2] / 2), size, body, rot_z=rot, top_mat=top_mat)

    # IDST release screen, fixed to the console right of TWR INFO
    center, up, _ = screen(inside, at(0.80, 0.42, top + 0.27), facing(20), 0.52, 0.39, "$SCREEN_IDST", bezel=0.035)
    inside.beam(center - up * 0.2, at(0.80, 0.42, top), 0.03, "TWR_Bezel")
    deck(0.78, 0.66, (0.44, 0.14, 0.03), "TWR_Bezel", "TWR_Keyboard")
    # IDST hardware keys (2 x 2): up / issue on the far row, down / cancel on the near row
    deck(1.17, 0.64, (0.17, 0.15, 0.02), "TWR_Bezel")
    for key, r, depth, mat in ((1, 1.13, 0.605, "TWR_KeyGrey"), (3, 1.21, 0.605, "TWR_KeyGreen"),
                               (2, 1.13, 0.675, "TWR_KeyGrey"), (4, 1.21, 0.675, "TWR_KeyRed")):
        kb = Builder("TowerCab_IdstKey_%d" % key, coll)
        kb.box(at(r, depth, top + 0.02 + 0.01), (0.065, 0.05, 0.02), mat, rot_z=rot)
        kb.finish()
    # knob panel: screen brightness knobs (left to right: all screens, DBRITE, ASDE-X,
    # console screens). Each is its own node turning about its pivot (see exporter).
    deck(1.33, 0.30, (0.22, 0.14, 0.03), "TWR_PanelGrey")
    # faint backlit strip along the panel's near edge, so the knobs can be found in a dark cab
    inside.box(at(1.33, 0.30 + 0.072, top + 0.015), (0.20, 0.004, 0.012), "TWR_KnobLit", rot_z=rot)
    for i, name in enumerate(("ALL", "DBRITE", "ASDEX", "CONSOLE")):
        p = at(1.25 + i * 0.053, 0.30, top + 0.03)
        kb = Builder("TowerCab_DimKnob_" + name, coll)
        kb.beam(p, p + Vector((0, 0, 0.025)), 0.019, "TWR_Knob", segs=24)
        # white pointer line on top, pointing at the window at full brightness
        kb.box(p + out * 0.009 + Vector((0, 0, 0.0255)), (0.004, 0.016, 0.002), "TWR_KnobLit", rot_z=rot)
        obj = kb.finish()
        obj["vatflow_pivot"] = tuple(p)
        obj["vatflow_anim"] = "knob"

    # keypad + trackball in front of TWR INFO
    deck(-0.10, 0.63, (0.26, 0.15, 0.04), "TWR_Bezel", "TWR_Keypad")
    deck(0.14, 0.63, (0.13, 0.15, 0.04), "TWR_Bezel")
    p = at(0.14, 0.63, top + 0.04)
    inside.beam(p, p + Vector((0, 0, 0.022)), 0.032, "TWR_Knob", segs=24)

    # voice switch touch panel (beige frame) and the red LED clock
    center, up, _ = screen(inside, at(-0.85, 0.42, top + 0.20), facing(35), 0.42, 0.315, "$SCREEN_VSCS",
                           bezel=0.05, bezel_mat="TWR_PanelTan")
    inside.beam(center - up * 0.2, at(-0.85, 0.42, top), 0.03, "TWR_PanelTan")
    deck(-1.30, 0.32, (0.30, 0.12, 0.14), "TWR_Bezel")
    screen(inside, at(-1.30, 0.38 + 0.001, top + 0.07), facing(0), 0.24, 0.06, "$SCREEN_CLOCK", bezel=0.012, depth=0.005)
    # speaker grille and a coffee mug
    deck(-1.30, 0.62, (0.24, 0.16, 0.06), "TWR_PanelTan", "TWR_Speaker")
    p = at(-0.50, 0.64, top)
    inside.beam(p, p + Vector((0, 0, 0.11)), 0.04, "TWR_Metal", segs=24)


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
        # its night twin: the same strip without the day glow (behaviors show one or the other)
        night = Builder("TowerCab_ShadeNight_%d_s%02d" % (k, i), coll)
        night.face([t0 - along * half_w, t0 + along * half_w, t1 + along * half_w, t1 - along * half_w], "TWR_ShadeNight")
        obj = night.finish()
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
        rails.beam(p, p + Vector((0, 0, h)), 0.035, "TWR_Metal", segs=12)
    rails.beam((0, 0, z_roof + P["drum_h"]), (0, 0, z_roof + P["drum_h"] + 5.0), 0.05, "TWR_Metal", segs=12)
    rails.finish()

    # --- Interior -----------------------------------------------------------
    inside = Builder("TowerCab_Interior", int_coll)
    a_inner = a0 - P["wall_t"]
    inside.prism(a_inner, a_inner, -0.02, 0.0, "TWR_Carpet")                       # floor
    inside.face(list(reversed([corner(i, a1 - 0.02, z_glass1 - 0.01) for i in range(n)])), "TWR_Ceiling")  # ceiling, faces down
    # consoles on every side except the rear (+Y) side, which is the stair entrance
    rear = n // 2
    console_sides = [k for k in range(n) if k != rear]
    consoles(int_coll, a_inner, P["console_h"], console_sides)
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
    # windshear MUTE button on the monitor's bottom bezel, right-hand side: a dark red push
    # button (TowerCab_WsMute) and its lit cap (TowerCab_WsMute_Lit), shown flashing while
    # the TWR INFO screen sounds a windshear alarm; either one clicks MUTE
    rgt = Vector((0, 0, 1)).cross(nrm).normalized()
    mb = center - up * 0.170 + rgt * 0.20
    for name, mat, grow in (("TowerCab_WsMute", "TWR_KeyRed", 0.0), ("TowerCab_WsMute_Lit", "TWR_AlarmLit", 0.002)):
        b = Builder(name, int_coll)
        hw, hh, dd = 0.05 + grow, 0.013 + grow, 0.008
        f = mb + nrm * (0.002 + grow)
        pts = [f - rgt * hw - up * hh, f + rgt * hw - up * hh, f + rgt * hw + up * hh, f - rgt * hw + up * hh]
        b.quad_strip(pts, [p_ + nrm * dd for p_ in pts], mat)
        b.face([p_ + nrm * dd for p_ in pts], mat)
        b.finish()
    inside.beam(center - up * 0.19, Vector((center.x, center.y, P["console_h"])), 0.03, "TWR_Bezel")
    console_equipment(inside, int_coll, 1, a_inner, P["console_h"])
    tmu_desk(inside, int_coll, a_inner, P["console_h"])
    props(int_coll, a_inner, P["console_h"])
    fwd_sign(inside, a_inner)
    party_banner(inside, a_inner, P["console_h"])
    carpet_logo(inside)
    ramp_computer(inside, a_inner, P["console_h"])
    strip_bays(int_coll, a_inner, P["console_h"])
    ceiling_lights(inside, z_glass1 - 0.012)
    ceiling_fans(inside, int_coll, z_glass1 - 0.01)
    soffit(inside, a1, z_glass1 - 0.01)

    # Overhead monitors on a circular ceiling track all the way round the cab
    # (each can travel the full 360 degrees): DBRITE radar starts front-right,
    # ASDE-X surface display starts front-left (both landscape 4:3).
    track_r = P["track_radius"]
    ceiling_z = z_glass1 - 0.01
    ceiling_track(inside, track_r, ceiling_z)
    monitor_mount("TowerCab_DbriteMount", int_coll, n - 1, 0.80, 0.60, "$SCREEN_DBRITE",
                  2.50, 20, ceiling_z, track_r)
    monitor_mount("TowerCab_AsdexMount", int_coll, 1, 0.80, 0.60, "$SCREEN_ASDEX",
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
