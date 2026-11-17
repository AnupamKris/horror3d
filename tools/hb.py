"""hb = horror-blender helpers. Imported inside Blender by tools/bl.py (auto-prepended).

Conventions (Blender space, Z up, meters):
  * Every prop lives in collection  PROP_<name>, parented to an Empty  PROP_<name>  (the "root").
  * The root sits at the prop's real place in the room (LAYOUT) so the room assembles live.
  * Parts are built in the root's LOCAL space: origin = floor-center of the footprint,
    "front" of the prop faces local -Y, up is +Z.
  * Objects named  MOV_*  are moving parts (doors, drawers, lids, head...) - kept separate on finalize,
    their object origin MUST be the pivot (hinge / slide origin).  INT_* = interactable static part.
    Everything else is joined into a single mesh  <name>_static  on finalize.
  * Materials come from the shared library (mat("M_Wood_Old")). The game swaps them by name for its
    own optimized triplanar materials, so DO NOT rely on UVs except where told (M_Portrait, M_Paper).
"""
import math
import os

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

PROJECT = r"C:\Users\anupa\Code\horror3d"
MODELS_DIR = os.path.join(PROJECT, "public", "models")
PREVIEW_DIR = os.path.join(PROJECT, "previews")

# name: (location xyz, rotation z degrees)
LAYOUT = {
    "room_shell":    ((0.0, 0.0, 0.0), 0),
    "door":          ((1.6, 2.5, 0.0), 0),
    "bed":           ((-1.95, -0.7, 0.0), 90),
    "nightstand":    ((-2.7, 0.42, 0.0), 90),
    "oil_lamp":      ((-2.7, 0.42, 0.6), 90),
    "wardrobe":      ((-1.55, 2.17, 0.0), 0),
    "rocking_chair": ((2.15, -1.65, 0.0), -135),
    "doll":          ((2.15, -1.65, 0.45), -135),
    "trunk":         ((-0.62, -0.7, 0.0), 90),
    "key":           ((-2.55, 0.42, 0.62), 30),
    "portrait":      ((0.0, -2.47, 1.55), 180),
    "books_pile":    ((-0.55, 2.2, 0.0), 15),
    "ceiling_lamp":  ((0.0, 0.0, 2.8), 0),
    "rug":           ((0.25, -0.35, 0.0), 4),
}

# Shared material library: name -> (base rgb, roughness, metallic, extra)
MATS = {
    "M_Wood_Old":       ((0.20, 0.12, 0.07), 0.80, 0.0, {}),
    "M_Wood_Dark":      ((0.07, 0.04, 0.025), 0.65, 0.0, {}),
    "M_Wood_Painted":   ((0.55, 0.52, 0.45), 0.85, 0.0, {}),   # chipped off-white paint
    "M_Floorboards":    ((0.16, 0.10, 0.06), 0.75, 0.0, {}),
    "M_Wallpaper":      ((0.33, 0.30, 0.20), 0.90, 0.0, {}),
    "M_Plaster":        ((0.45, 0.42, 0.37), 0.95, 0.0, {}),
    "M_Metal_Rust":     ((0.22, 0.10, 0.05), 0.85, 0.6, {}),
    "M_Metal_Iron":     ((0.06, 0.06, 0.06), 0.55, 1.0, {}),
    "M_Brass":          ((0.55, 0.38, 0.14), 0.40, 1.0, {}),
    "M_Fabric_Stained": ((0.42, 0.38, 0.30), 0.95, 0.0, {}),
    "M_Fabric_Dark":    ((0.12, 0.05, 0.05), 0.95, 0.0, {}),  # dark red / velvet
    "M_Leather":        ((0.10, 0.06, 0.04), 0.60, 0.0, {}),
    "M_Porcelain":      ((0.80, 0.74, 0.68), 0.35, 0.0, {}),
    "M_Doll_Dress":     ((0.30, 0.26, 0.28), 0.90, 0.0, {}),
    "M_Hair":           ((0.10, 0.07, 0.05), 0.70, 0.0, {}),
    "M_Eye":            ((0.02, 0.02, 0.02), 0.10, 0.0, {}),
    "M_Glass":          ((0.60, 0.65, 0.60), 0.05, 0.0, {"alpha": 0.25}),
    "M_Paper":          ((0.60, 0.55, 0.42), 0.90, 0.0, {}),
    "M_Portrait":       ((0.25, 0.20, 0.15), 0.70, 0.0, {}),   # UV 0..1 on canvas, game paints it
    "M_Bulb":           ((1.00, 0.85, 0.60), 0.30, 0.0, {"emit": 3.0}),
    "M_Flame":          ((1.00, 0.55, 0.20), 0.50, 0.0, {"emit": 5.0}),
    "M_Rubber":         ((0.03, 0.03, 0.03), 0.80, 0.0, {}),
    "M_Rug":            ((0.25, 0.08, 0.07), 0.95, 0.0, {}),
    "M_Blood":          ((0.18, 0.01, 0.01), 0.25, 0.0, {}),
}


# ---------------------------------------------------------------- materials
def mat(name):
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    rgb, rough, metal, extra = MATS.get(name, ((0.5, 0.5, 0.5), 0.8, 0.0, {}))
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if "emit" in extra:
        bsdf.inputs["Emission Color"].default_value = (*rgb, 1.0)
        bsdf.inputs["Emission Strength"].default_value = extra["emit"]
    if "alpha" in extra:
        bsdf.inputs["Alpha"].default_value = extra["alpha"]
        try:
            m.surface_render_method = "BLENDED"
        except AttributeError:
            pass
    m.diffuse_color = (*rgb, 1.0)
    return m


# ---------------------------------------------------------------- prop root / collection
def _coll(name):
    cname = "PROP_" + name
    c = bpy.data.collections.get(cname)
    if c is None:
        c = bpy.data.collections.new(cname)
        bpy.context.scene.collection.children.link(c)
    return c


def root(name):
    """Get/create the prop root Empty at its LAYOUT position."""
    c = _coll(name)
    rname = "PROP_" + name
    r = bpy.data.objects.get(rname)
    if r is None:
        r = bpy.data.objects.new(rname, None)
        r.empty_display_type = "PLAIN_AXES"
        r.empty_display_size = 0.25
        c.objects.link(r)
    loc, rz = LAYOUT.get(name, ((0, 0, 0), 0))
    r.location = loc
    r.rotation_euler = (0, 0, math.radians(rz))
    return r


def reset(name):
    """Delete every object of this prop (only this prop!) and recreate the root."""
    c = _coll(name)
    for o in list(c.objects):
        if o.name != "PROP_" + name:
            bpy.data.objects.remove(o, do_unlink=True)
    for me in [m for m in bpy.data.meshes if m.users == 0]:
        bpy.data.meshes.remove(me)
    return root(name)


def remove_part(name, part_name):
    o = bpy.data.objects.get(part_name)
    if o and o.users_collection and o.users_collection[0] == _coll(name):
        bpy.data.objects.remove(o, do_unlink=True)


def part(name, obj, material=None, smooth=False):
    """Adopt obj into prop `name`: move into its collection, parent to root keeping LOCAL coords
    (obj.location etc are interpreted as root-local). Replaces an existing part with the same name."""
    r = root(name)
    c = _coll(name)
    for uc in list(obj.users_collection):
        if uc != c:
            uc.objects.unlink(obj)
    if c not in obj.users_collection:
        c.objects.link(obj)
    obj.parent = r
    obj.matrix_parent_inverse = Matrix.Identity(4)
    if material is not None and obj.type == "MESH":
        obj.data.materials.clear()
        obj.data.materials.append(mat(material) if isinstance(material, str) else material)
    if smooth and obj.type == "MESH":
        set_smooth(obj)
    bpy.context.view_layer.update()
    return obj


def _fresh(part_name, mesh):
    old = bpy.data.objects.get(part_name)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)
    return bpy.data.objects.new(part_name, mesh)


def mesh_obj(name, part_name, bm, material=None, loc=(0, 0, 0), rot=(0, 0, 0), smooth=False):
    """Turn a bmesh into a part object of prop `name`."""
    me = bpy.data.meshes.new(part_name)
    bm.to_mesh(me)
    bm.free()
    o = _fresh(part_name, me)
    o.location = loc
    o.rotation_euler = [math.radians(a) for a in rot]
    return part(name, o, material, smooth)


def set_smooth(obj, angle=40):
    for p in obj.data.polygons:
        p.use_smooth = True
    try:
        obj.data.set_sharp_from_angle(angle=math.radians(angle))
    except Exception:
        pass


# ---------------------------------------------------------------- primitive builders (bmesh)
def bm_box(size=(1, 1, 1), center=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return bm


def bm_cyl(radius=0.5, depth=1.0, segments=12, center=(0, 0, 0), radius2=None, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segments,
                          radius1=radius, radius2=radius if radius2 is None else radius2, depth=depth)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return bm


def bm_sphere(radius=0.5, u=12, v=8, center=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=radius)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return bm


def box(name, part_name, size, loc=(0, 0, 0), rot=(0, 0, 0), material=None, bevel=0.0, bevel_segments=1):
    """Box part. size=(x,y,z) full extents, loc=center (root-local), rot degrees. Optional bevel modifier."""
    o = mesh_obj(name, part_name, bm_box(size), material, loc, rot)
    if bevel > 0:
        add_bevel(o, bevel, bevel_segments)
    return o


def cyl(name, part_name, radius, depth, loc=(0, 0, 0), rot=(0, 0, 0), material=None, segments=12,
        radius2=None, smooth=True):
    """Cylinder/cone along local Z of the part. rot in degrees."""
    return mesh_obj(name, part_name, bm_cyl(radius, depth, segments, radius2=radius2), material, loc, rot, smooth)


def sphere(name, part_name, radius, loc=(0, 0, 0), scale=(1, 1, 1), material=None, u=12, v=8):
    o = mesh_obj(name, part_name, bm_sphere(radius, u, v), material, loc, (0, 0, 0), True)
    o.scale = scale
    return o


def add_bevel(obj, width=0.01, segments=1, limit_angle=30):
    m = obj.modifiers.new("Bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(limit_angle)
    m.harden_normals = False
    return m


def add_subsurf(obj, levels=1):
    m = obj.modifiers.new("Subsurf", "SUBSURF")
    m.levels = levels
    m.render_levels = levels
    return m


def ctx(objs, active=None):
    """Context override for operators acting on objs: with hb.ctx([a,b], a): bpy.ops.object.join()"""
    active = active or objs[0]
    return bpy.context.temp_override(active_object=active, object=active, selected_objects=objs,
                                     selected_editable_objects=objs)


# ---------------------------------------------------------------- finalize / export / preview
def _apply_modifiers(o):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = o.data
    o.modifiers.clear()
    o.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)


def parts(name):
    return [o for o in _coll(name).objects if o.type == "MESH"]


def finalize(name, merge_dist=0.0005):
    """Apply modifiers + scale, join all non MOV_/INT_ parts into <name>_static. Returns stats."""
    r = root(name)
    objs = parts(name)
    for o in objs:
        _apply_modifiers(o)
        # bake object scale into the mesh (keep loc/rot so MOV_ pivots survive)
        if any(abs(s - 1) > 1e-6 for s in o.scale):
            o.data.transform(Matrix.Diagonal((*o.scale, 1.0)))
            o.scale = (1, 1, 1)
    static = [o for o in objs if not (o.name.startswith("MOV_") or o.name.startswith("INT_"))]
    if len(static) > 1:
        tgt = static[0]
        with ctx(static, tgt):
            bpy.ops.object.join()
        static = [tgt]
    if static:
        tgt = static[0]
        tgt.name = name + "_static"
        tgt.data.name = name + "_static"
    for o in parts(name):
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge_dist)
        bm.to_mesh(o.data)
        bm.free()
        o.data.update()
    return stats(name)


def stats(name):
    out = {}
    total = 0
    dg = bpy.context.evaluated_depsgraph_get()
    for o in parts(name):
        me = o.evaluated_get(dg).to_mesh()
        me.calc_loop_triangles()
        t = len(me.loop_triangles)
        o.evaluated_get(dg).to_mesh_clear()
        out[o.name] = t
        total += t
    out["_total_tris"] = total
    return out


def export(name):
    """Export prop to public/models/<name>.glb with root moved to origin (local space)."""
    os.makedirs(MODELS_DIR, exist_ok=True)
    r = root(name)
    saved = (r.location.copy(), r.rotation_euler.copy())
    r.location = (0, 0, 0)
    r.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    objs = parts(name)
    path = os.path.join(MODELS_DIR, name + ".glb")
    vl = bpy.context.view_layer
    prev_sel = [o for o in vl.objects if o.select_get()]
    for o in prev_sel:
        o.select_set(False)
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    try:
        with bpy.context.temp_override(active_object=objs[0], selected_objects=objs):
            bpy.ops.export_scene.gltf(
                filepath=path, export_format="GLB", use_selection=True, export_apply=True,
                export_yup=True, export_materials="EXPORT", export_extras=True,
                export_cameras=False, export_lights=False, export_animations=False,
                export_texcoords=True, export_normals=True)
    finally:
        for o in objs:
            o.select_set(False)
        for o in prev_sel:
            try:
                o.select_set(True)
            except Exception:
                pass
        r.location, r.rotation_euler = saved
        bpy.context.view_layer.update()
    return {"path": path, "bytes": os.path.getsize(path)}


def preview(name, res=480, dist_scale=2.2, elev=22, azim=-35):
    """Render an isolated EEVEE preview of the prop to previews/<name>.png and return the path.
    View it with your image-reading tool. Keep it rare (it blocks Blender for everyone)."""
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    scene = bpy.context.scene
    objs = parts(name)
    # bounds in world space
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    if not pts:
        return {"error": "no parts"}
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    ctr = (mn + mx) / 2
    rad = max((mx - mn).length / 2, 0.05)
    r = root(name)
    # camera orbit relative to prop front (-Y local)
    yaw = r.rotation_euler.z + math.radians(azim)
    d = rad * dist_scale
    fwd = Vector((math.sin(yaw) * -1, -math.cos(yaw), 0)) * -1  # direction from center to camera
    camloc = ctr + Vector((-math.sin(yaw) * 0 + math.sin(yaw), -math.cos(yaw), 0)) * d * math.cos(math.radians(elev))
    camloc.z = ctr.z + d * math.sin(math.radians(elev))

    cam_data = bpy.data.cameras.get("HB_PreviewCam") or bpy.data.cameras.new("HB_PreviewCam")
    cam = bpy.data.objects.get("HB_PreviewCam")
    if cam is None:
        cam = bpy.data.objects.new("HB_PreviewCam", cam_data)
        scene.collection.objects.link(cam)
    cam.location = camloc
    direction = ctr - camloc
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam_data.lens = 50
    cam_data.clip_end = 100

    light_data = bpy.data.lights.get("HB_PreviewKey") or bpy.data.lights.new("HB_PreviewKey", "AREA")
    light_data.energy = 60 * rad * rad + 20
    light_data.size = rad * 2
    key = bpy.data.objects.get("HB_PreviewKey")
    if key is None:
        key = bpy.data.objects.new("HB_PreviewKey", light_data)
        scene.collection.objects.link(key)
    key.location = camloc + Vector((0, 0, rad * 1.5))
    key.rotation_euler = (ctr - key.location).to_track_quat("-Z", "Y").to_euler()

    # isolate
    hidden = []
    for o in scene.objects:
        if o in objs or o in (cam, key):
            continue
        if not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    saved = (scene.camera, scene.render.resolution_x, scene.render.resolution_y,
             scene.render.resolution_percentage, scene.render.filepath, scene.render.film_transparent)
    try:
        scene.camera = cam
        scene.render.resolution_x = res
        scene.render.resolution_y = res
        scene.render.resolution_percentage = 100
        scene.render.film_transparent = False
        try:
            scene.eevee.taa_render_samples = 16
        except Exception:
            pass
        path = os.path.join(PREVIEW_DIR, name + ".png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
    finally:
        for o in hidden:
            o.hide_render = False
        (scene.camera, scene.render.resolution_x, scene.render.resolution_y,
         scene.render.resolution_percentage, scene.render.filepath, scene.render.film_transparent) = saved
    return {"preview": path}
