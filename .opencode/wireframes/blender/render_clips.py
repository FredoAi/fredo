import bpy, os, math
from mathutils import Vector

BASE = "C:/Code/fredo/.opencode/wireframes/blender"
OUT = f"{BASE}/previews"
os.makedirs(OUT, exist_ok=True)

# The asset ships with NEUTRAL white materials so a runtime can tint it.
# Previews apply a tint here, at render time only - never exported.
TINT = (0.333, 0.867, 0.918)
BASE_TINTED = ("fredo_body", "fredo_accent", "fredo_limb", "fredo_boot")
for mat_name in BASE_TINTED:
    mat = bpy.data.materials.get(mat_name)
    if mat:
        bsdf = mat.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*TINT, 1.0)
        bsdf.inputs["Emission Color"].default_value = (*TINT, 1.0)
        mat.diffuse_color = (*TINT, 1.0)

sc = bpy.context.scene
arm = bpy.data.objects["FREDO_Rig"]
cam = bpy.data.objects["FREDO_Camera"]
sc.camera = cam
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 2.368          # the builder's framing: room for the hat
cam.location = (0.0, -6.0, 0.9)
cam.rotation_euler = (math.radians(90), 0, 0)

sc.render.resolution_x = 420
sc.render.resolution_y = 525
sc.render.film_transparent = False
try:
    sc.eevee.taa_render_samples = 24
except Exception:
    pass

shots = [("idle", 1), ("happy", 5), ("thinking", 8),
         ("working", 8), ("complete", 5), ("angry", 4),
         ("funny", 9), ("greeting", 3),
         ("analyzing", 8), ("planning", 8), ("playful", 4), ("listening", 8),
         ("uwu", 8), ("confused", 9), ("skeptical", 10),
         ("silly", 6), ("squint", 5),
         ("love", 6), ("sad", 8), ("surprised", 3), ("sleepy", 9)]

rendered = []


def shot(path, action_name, frame, loc=None, ortho=None):
    act = bpy.data.actions.get(action_name)
    if act is None:
        return
    arm.animation_data.action = act
    if loc is not None:
        cam.location = loc
        d = Vector((0, 0, 0.9)) - Vector(loc)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.data.ortho_scale = ortho if ortho else 2.368
    sc.frame_set(frame)
    bpy.context.view_layer.update()
    sc.render.filepath = path
    sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    rendered.append(path)


for name, frame in shots:
    shot(f"{OUT}/clip_{name}_f{frame:02d}.png", name, frame)

# ---------------------------------------------------------------- doom pass
# Same rig, same clips - only the palette changes. This is exactly what the
# runtime does when the user types "doom".
DOOM_TINT = {
    "fredo_body": (0.25, 0.42, 0.12), "fredo_accent": (0.56, 0.78, 0.25),
    "fredo_limb": (0.91, 0.71, 0.55), "fredo_boot": (0.30, 0.34, 0.40),
    "fredo_doom": (0.42, 0.72, 0.12), "fredo_helm": (0.30, 0.34, 0.40),
    "fredo_visor": (0.18, 0.72, 0.30), "fredo_metal": (0.16, 0.18, 0.19),
    "fredo_fx": (1.0, 0.54, 0.16), "fredo_lava": (0.78, 0.12, 0.03),
    "fredo_trim": (0.16, 0.18, 0.19), "fredo_glove": (0.03, 0.03, 0.04),
    "fredo_skin": (0.91, 0.71, 0.55),
}
MAT_SAVE = {}
for mat_name, col in DOOM_TINT.items():
    mat = bpy.data.materials.get(mat_name)
    if mat:
        bsdf = mat.node_tree.nodes["Principled BSDF"]
        MAT_SAVE[mat_name] = (tuple(bsdf.inputs["Base Color"].default_value),
                              tuple(bsdf.inputs["Emission Color"].default_value))
        bsdf.inputs["Base Color"].default_value = (*col, 1.0)
        bsdf.inputs["Emission Color"].default_value = (*col, 1.0)
        mat.diffuse_color = (*col, 1.0)

shot(f"{OUT}/clip_doom-idle_f08.png", "doom-idle", 8)
shot(f"{OUT}/doom-idle_three4.png", "doom-idle", 8,
     loc=(4.4, -4.4, 1.15), ortho=2.368)
shot(f"{OUT}/doom-idle_side.png", "doom-idle", 8,
     loc=(6.0, 0.0, 0.9), ortho=2.368)
shot(f"{OUT}/doom-idle_closeup.png", "doom-idle", 8,
     loc=(2.6, -3.4, 1.30), ortho=1.70)
shot(f"{OUT}/clip_doom-in_f04.png", "doom-in", 9)
shot(f"{OUT}/clip_doom-sword_f08.png", "doom-sword", 8)
shot(f"{OUT}/clip_doom-mg_f08.png", "doom-mg", 8)
shot(f"{OUT}/clip_doom-shoot_f03.png", "doom-shoot", 3)

# restore the neutral palette so the scene is left as the builder made it
for mat_name, (base, emit) in MAT_SAVE.items():
    mat = bpy.data.materials.get(mat_name)
    if mat:
        bsdf = mat.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = base
        bsdf.inputs["Emission Color"].default_value = emit
        mat.diffuse_color = emit

arm.animation_data.action = None
sc.frame_set(1)
cam.location = (0.0, -6.0, 0.9)
cam.rotation_euler = (math.radians(90), 0, 0)
cam.data.ortho_scale = 2.368
result = {"rendered": len(rendered), "files": [p.split("/")[-1] for p in rendered]}
