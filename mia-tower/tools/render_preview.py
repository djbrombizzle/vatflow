"""
Renders preview pictures of the exported models (docs/exterior.png, docs/interior.png) by
loading the .gltf files back into Blender, so the pictures show what the sim gets.

  blender --background --python tools/render_preview.py -- <model_dir> <docs_dir>
  (or with the bpy module:  python tools/render_preview.py <model_dir> <docs_dir>)
"""

import math
import os
import sys

import bpy
from mathutils import Vector


def look_at(cam, target):
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def setup(samples):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 800
    sc.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in
        sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"
    world = bpy.data.worlds.new("Sky")
    sc.world = world
    world.use_nodes = True
    sky = world.node_tree.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA" if hasattr(sky, "sky_type") and "NISHITA" in [
        i.identifier for i in sky.bl_rna.properties["sky_type"].enum_items] else sky.sky_type
    try:
        sky.sun_elevation = math.radians(35)
        sky.sun_rotation = math.radians(210)
    except AttributeError:
        pass
    world.node_tree.links.new(sky.outputs[0], world.node_tree.nodes["Background"].inputs[0])
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.35
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    return sc, cam


def load(model_dir, base):
    bpy.ops.import_scene.gltf(filepath=os.path.join(model_dir, base + ".gltf"))


def ground(sc, z):
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, z))
    mat = bpy.data.materials.new("Ground")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.12, 0.16, 0.08, 1)
    bpy.context.object.data.materials.append(mat)


def main(model_dir, docs_dir):
    os.makedirs(docs_dir, exist_ok=True)
    # exterior: three-quarter view from the front left, a little below the catwalk
    sc, cam = setup(48)
    load(model_dir, "mia_tower")
    ground(sc, -13.7)
    cam.data.lens = 35
    cam.location = (-13.0, -29.0, -1.0)   # front left (the nose is -Y)
    look_at(cam, (0, 0, 0.0))
    sc.render.filepath = os.path.join(docs_dir, "exterior.png")
    bpy.ops.render.render(write_still=True)

    # interior: from the stair side, looking out of the front window over the consoles
    sc, cam = setup(64)
    load(model_dir, "mia_tower")
    load(model_dir, "mia_tower_interior")
    ground(sc, -60)
    for o in list(sc.objects):
        if o.name.startswith("MIA_RoofGear"):
            bpy.data.objects.remove(o, do_unlink=True)
    lamp = bpy.data.objects.new("CabLight", bpy.data.lights.new("CabLight", "AREA"))
    lamp.data.energy = 400
    lamp.data.size = 3.0
    lamp.location = (0, 0, 3.3)
    sc.collection.objects.link(lamp)
    cam.data.lens = 16
    cam.location = (0.0, 1.3, 1.75)
    look_at(cam, (0.0, -4.0, 1.1))
    sc.render.filepath = os.path.join(docs_dir, "interior.png")
    bpy.ops.render.render(write_still=True)
    print("Rendered", os.path.join(docs_dir, "exterior.png"), os.path.join(docs_dir, "interior.png"))


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    if len(args) != 2:
        sys.exit(__doc__)
    main(*args)
