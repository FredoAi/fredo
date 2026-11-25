"""
Render the TWO poster passes for the avatar fallback (spec 3210 ST-2).

Adapted from `render_clips.py`: same rig, same camera, same 420x525 raster, the
idle clip's first frame - but `film_transparent=True` (the poster is an overlay,
never a baked background) and the two material groups rendered SEPARATELY so the
runtime can tint the body while leaving the authored detail alone:

  pass 1  poster-body.png    the four base materials the asset ships in neutral
                             white and the runtime tints (`fredo_body`,
                             `fredo_limb`, `fredo_boot`, `fredo_accent`).
                             The runtime uses this pass as an ALPHA MASK only and
                             fills it with the live accent, so its colour is
                             irrelevant - but it must be rendered as a silhouette.
  pass 2  poster-detail.png  every other material, in its authored colour
                             (hat, hair, glove, skin, metal, trim, brass, wood,
                             lava, FX). The accent must never reach these.

The two passes are complementary: each render hides the materials the other one
shows, so stacking them reconstructs the whole figure with no double paint.

FRAMING - the product frame, not the authoring viewer's. `render_clips.py` uses
`ortho_scale = 2.368`, which frames the figure at ~0.76 of the frame height with
room for the hat; that is the VIEWER's framing. The reserved avatar box frames the
body at 0.9233 of the height with the feet at 0.9763 and the figure centred
(`AVATAR_FRAMING` in the renderer), so the poster must use the same frame or the
poster-to-live handoff would jump scale. This script therefore solves
`ortho_scale` and the camera height from the body's silhouette rather than
copying the viewer's constant.

RUN IT on a machine with Blender + the official Lab MCP add-on listening on 9876,
after the character has been built (`build_character.py`), exactly like the other
authoring scripts:

    python blender_client.py render_poster.py

Output goes to `apps/ui/public/avatar/` - the committed shipped location - so the
files it writes are the ones the asset-contract pin checks. Verify the digests with
`node scripts/sync-avatar-asset.mjs --check` afterwards.
"""

import json
import os

import bpy
from mathutils import Vector

# The repo root is two levels above `.opencode/wireframes/blender`.
BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.normpath(os.path.join(BASE, "../../../apps/ui/public/avatar"))
os.makedirs(PUBLIC, exist_ok=True)

# The four materials the runtime tints (and the authoring preview tints), plus the
# authored remainder.
BODY_MATERIALS = ("fredo_body", "fredo_limb", "fredo_boot", "fredo_accent")
BODY_SET = set(BODY_MATERIALS)

# The frozen silhouette fractions (mirrored in the renderer's AVATAR_FRAMING).
CONTENT_HEIGHT_FRACTION = 0.9233
BOTTOM_MARGIN_FRACTION = 0.0237

RESOLUTION_X = 420
RESOLUTION_Y = 525

sc = bpy.context.scene
arm = bpy.data.objects["FREDO_Rig"]
cam = bpy.data.objects["FREDO_Camera"]
sc.camera = cam
cam.data.type = "ORTHO"
cam.rotation_euler = (1.5707963, 0.0, 0.0)  # looking along +Y: the face, never the back

sc.render.resolution_x = RESOLUTION_X
sc.render.resolution_y = RESOLUTION_Y
sc.render.resolution_percentage = 100
sc.render.film_transparent = True
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA"
sc.render.image_settings.color_depth = "8"
try:
    sc.eevee.taa_render_samples = 32
except Exception:
    pass


def evaluated_bounds():
    """World-space bounds of the BODY meshes only (props/FX must not shrink the fit)."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    found = False
    for obj in sc.objects:
        if obj.type != "MESH":
            continue
        slots = [slot.material.name for slot in obj.material_slots if slot.material]
        if not slots or not any(name in BODY_SET for name in slots):
            continue
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            world = evaluated.matrix_world @ Vector(corner)
            lo = Vector((min(lo[i], world[i]) for i in range(3)))
            hi = Vector((max(hi[i], world[i]) for i in range(3)))
            found = True
    if not found:
        raise RuntimeError("no body-material mesh found: is the character built?")
    return lo, hi


def frame_camera():
    """Solve the ortho scale + camera height so the body lands on the frozen fractions."""
    lo, hi = evaluated_bounds()
    body_height = hi.z - lo.z
    # ortho_scale is the frame size along the LARGER axis; the raster is portrait.
    span = body_height / CONTENT_HEIGHT_FRACTION
    cam.data.ortho_scale = span * (RESOLUTION_X / RESOLUTION_Y)
    span = cam.data.ortho_scale * (RESOLUTION_Y / RESOLUTION_X)
    # Camera centre: the body's feet minus the reserved bottom margin, plus half a frame.
    centre_z = lo.z - BOTTOM_MARGIN_FRACTION * span + span / 2.0
    cam.location = (0.0, -6.0, centre_z)
    return {"body_height": body_height, "ortho_scale": cam.data.ortho_scale, "centre_z": centre_z}


def render_pass(filename, keep_body_group):
    """Render one pass: materials outside the requested group are made invisible."""
    saved = {}
    for mat in bpy.data.materials:
        if not mat.use_nodes or "Principled BSDF" not in mat.node_tree.nodes:
            continue
        is_body = mat.name in BODY_SET
        if is_body == keep_body_group:
            continue
        bsdf = mat.node_tree.nodes["Principled BSDF"]
        saved[mat.name] = bsdf.inputs["Alpha"].default_value
        bsdf.inputs["Alpha"].default_value = 0.0
        try:
            mat.blend_method = "BLEND"
        except Exception:
            pass

    path = os.path.join(PUBLIC, filename)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)

    for mat_name, alpha in saved.items():
        mat = bpy.data.materials.get(mat_name)
        if mat and mat.use_nodes and "Principled BSDF" in mat.node_tree.nodes:
            mat.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = alpha

    return path


# Idle's FIRST frame — the pose the live renderer shows at mount, so the
# poster-to-live handoff is a shading change, not a pose or scale change.
idle = bpy.data.actions.get("idle")
if idle is None:
    raise RuntimeError("the authored 'idle' action is missing from this scene")
arm.animation_data.action = idle
sc.frame_set(1)
bpy.context.view_layer.update()

framing = frame_camera()
body_path = render_pass("poster-body.png", keep_body_group=True)
detail_path = render_pass("poster-detail.png", keep_body_group=False)

arm.animation_data.action = None
sc.frame_set(1)

print(json.dumps({
    "framing": framing,
    "body": body_path,
    "detail": detail_path,
    "resolution": [RESOLUTION_X, RESOLUTION_Y],
    "body_materials": list(BODY_MATERIALS),
}))
