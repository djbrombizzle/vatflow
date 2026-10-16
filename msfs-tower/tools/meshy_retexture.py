"""
Meshy retexture for one part of the cab (Meshy's API: https://docs.meshy.ai/en/api/retexture).

  python tools/meshy_retexture.py export <part> <out.glb>
      Builds the cab and writes the part alone (e.g. TowerCab_TmuDesk), moved to the
      origin and turned square (its vatflow_frame), as a GLB to send to Meshy.
  python tools/meshy_retexture.py fit <part> <meshy.glb> <asset name>
      Takes Meshy's result: scales / moves it back onto the part (fitting the boxes they
      both fill) and writes blender/assets/<asset name>.glb (mesh + UVs, cab coordinates).
  python tools/meshy_retexture.py prop <meshy.glb> <asset name> <size m> [up|long]
      A loose object for the cab (coffee maker, binoculars ...), e.g. from Meshy's text-to-3D:
      stands it on its base, centred, scaled so its biggest size (or its height: "up") is
      <size m>, and writes blender/assets/<asset name>.glb in its own frame (origin under its
      middle, +Y its front). build_tower_cab.py puts it in the cab with prop().
  python3 tools/meshy_retexture.py textures <meshy png dir> <asset name> <texture dir>
      (plain Python with Pillow, no Blender) Meshy's texture_urls files (base_color.png,
      roughness.png, metallic.png, normal.png) as the sim wants them, at most 1024 px:
        TWR_<Asset>_albd.png  base colour
        TWR_<Asset>_comp.png  occlusion (R, all lit) / roughness (G) / metallic (B)
        TWR_<Asset>_norm.png  normal map, DirectX (green flipped from Meshy's OpenGL)
      build_tower_cab.py then uses the asset for the part (retextured_part).

Run with the bpy module (python) or blender --background --python ... -- <args>.
"""

import math
import os
import runpy
import sys

try:
    import bpy
    from mathutils import Matrix, Vector
except ImportError:          # the "textures" step runs without Blender
    bpy = None

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "blender", "build_tower_cab.py")
ASSETS = os.path.join(HERE, "..", "blender", "assets")
MAX_PX = 1024


def frame_matrix(obj):
    """World -> the part's own square frame (origin at its corner, length along +Y)."""
    x, y, z, rot = obj["vatflow_frame"]
    return Matrix.Rotation(-rot, 4, "Z") @ Matrix.Translation((-x, -y, -z))


def bounds(obj, m=None):
    m = m or obj.matrix_world
    pts = [m @ v.co for v in obj.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def build(part):
    runpy.run_path(BUILD, run_name="__main__")
    return bpy.data.objects[part]


def export(part, out):
    obj = build(part)
    m = frame_matrix(obj)
    for o in list(bpy.data.objects):
        if o != obj:
            bpy.data.objects.remove(o, do_unlink=True)
    obj.data.transform(m @ obj.matrix_world)
    obj.matrix_world = Matrix.Identity(4)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=True)
    lo, hi = bounds(obj)
    print("exported %s: %d triangles, size %.2f x %.2f x %.2f m" % (
        part, sum(len(p.vertices) - 2 for p in obj.data.polygons), *(hi - lo)))


# the .png.xml MSFS compiles each texture with (as tools/make_textures.py writes them)
SLOT = {"_albd": "MTL_BITMAP_DECAL0", "_comp": "MTL_BITMAP_METAL_ROUGH_AO", "_norm": "MTL_BITMAP_NORMAL"}


def fit(part, meshy_glb, asset):
    obj = build(part)
    m = frame_matrix(obj)
    lo0, hi0 = bounds(obj, m @ obj.matrix_world)            # the part, in its own frame
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=meshy_glb)
    new = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    src = new[0]
    if len(new) > 1:                                        # join everything Meshy sent
        bpy.ops.object.select_all(action="DESELECT")
        for o in new:
            o.select_set(True)
        bpy.context.view_layer.objects.active = src
        bpy.ops.object.join()
    src.data.transform(src.matrix_world)
    src.matrix_world = Matrix.Identity(4)
    lo1, hi1 = bounds(src)
    # Meshy may centre / scale the model: fit its box back onto the part's (per axis)
    s = [(hi0[i] - lo0[i]) / max(1e-9, hi1[i] - lo1[i]) for i in range(3)]
    fitm = Matrix.Translation(lo0) @ Matrix.Diagonal((s[0], s[1], s[2], 1)) @ Matrix.Translation(-lo1)
    src.data.transform(m.inverted() @ fitm)                  # back to cab coordinates
    print("fit scale %.3f %.3f %.3f" % tuple(s))
    # the mesh (with its UVs) for build_tower_cab.py
    for o in list(bpy.data.objects):
        if o != src:
            bpy.data.objects.remove(o, do_unlink=True)
    os.makedirs(ASSETS, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    src.select_set(True)
    dst = os.path.join(ASSETS, asset + ".glb")
    bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", use_selection=True, export_materials="NONE")
    print("wrote %s: %d triangles" % (dst, sum(len(p.vertices) - 2 for p in src.data.polygons)))


def prop(meshy_glb, asset, size, by="long"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=meshy_glb)
    new = [o for o in bpy.data.objects if o.type == "MESH"]
    src = new[0]
    if len(new) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for o in new:
            o.select_set(True)
        bpy.context.view_layer.objects.active = src
        bpy.ops.object.join()
    src.data.transform(src.matrix_world)                     # glTF +Y up arrives as Blender +Z up
    src.matrix_world = Matrix.Identity(4)
    lo, hi = bounds(src)
    dims = hi - lo
    k = size / max(1e-9, dims.z if by == "up" else max(dims))
    src.data.transform(Matrix.Diagonal((k, k, k, 1)) @ Matrix.Translation((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)))
    for o in list(bpy.data.objects):
        if o != src:
            bpy.data.objects.remove(o, do_unlink=True)
    os.makedirs(ASSETS, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    src.select_set(True)
    dst = os.path.join(ASSETS, asset + ".glb")
    bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", use_selection=True, export_materials="NONE")
    lo, hi = bounds(src)
    print("wrote %s: %d triangles, %.2f x %.2f x %.2f m" % (dst, sum(len(p.vertices) - 2 for p in src.data.polygons), *(hi - lo)))


def textures(src_dir, asset, tex_dir):
    import numpy as np
    from PIL import Image
    base = "TWR_" + "".join(p.capitalize() for p in asset.split("_"))
    os.makedirs(tex_dir, exist_ok=True)

    def load(name, mode="RGB"):
        path = os.path.join(src_dir, name)
        if not os.path.exists(path):
            return None
        im = Image.open(path).convert(mode)
        if max(im.size) > MAX_PX:
            im = im.resize((MAX_PX, MAX_PX), Image.LANCZOS)
        return im

    def save(im, suffix):
        path = os.path.join(tex_dir, base + suffix + ".png")
        im.save(path)
        with open(path + ".xml", "w") as f:
            f.write("<BitmapConfiguration><BitmapSlot>%s</BitmapSlot></BitmapConfiguration>" % SLOT[suffix])
        print("wrote", path, im.size)

    col = load("base_color.png")
    if col:
        save(col, "_albd")
    rough, metal = load("roughness.png", "L"), load("metallic.png", "L")
    if rough or metal:
        size = (rough or metal).size
        ao = Image.new("L", size, 255)                      # no occlusion map: all lit
        save(Image.merge("RGB", (ao, rough or Image.new("L", size, 160), metal or Image.new("L", size, 0))), "_comp")
    nrm = load("normal.png")
    if nrm:
        a = np.array(nrm)
        a[:, :, 1] = 255 - a[:, :, 1]                       # OpenGL (Meshy) -> DirectX (MSFS)
        save(Image.fromarray(a), "_norm")


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    if args[:1] == ["export"] and len(args) == 3:
        export(args[1], args[2])
    elif args[:1] == ["fit"] and len(args) == 4:
        fit(*args[1:])
    elif args[:1] == ["prop"] and len(args) in (4, 5):
        prop(args[1], args[2], float(args[3]), args[4] if len(args) == 5 else "long")
    elif args[:1] == ["textures"] and len(args) == 4:
        textures(*args[1:])
    else:
        sys.exit(__doc__)
