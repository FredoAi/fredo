import bpy, bmesh, math, re, os
from mathutils import Matrix, Vector

# =====================================================================
# FREDO - game-ready character, single skinned mesh + GLB package
#
#   * 1 unit = 1 metre, origin at ground between the feet
#   * ONE mesh, rigidly skinned (every vertex weight 1.0 to a single bone)
#     -> 1 draw call, standard AnimationMixer setup in three.js
#   * Principled BSDF only; emission via KHR_materials_emissive_strength
#   * one named Action per clip, each stashed as its own NLA strip
#   * quad-only low poly, bevel baked in, no engine-side modifiers
# =====================================================================

REF = "C:/Code/fredo/.opencode/wireframes/fredo-avatar.html"
REF_W = 1014.0
CX_REF = 507.0
GROUND_REF = 1234.0
TOP_REF = 67.0
TARGET_HEIGHT_M = 1.8
S = (GROUND_REF - TOP_REF) / TARGET_HEIGHT_M

FPS = 12
BASE = "C:/Code/fredo/.opencode/wireframes/blender"
BLEND_OUT = f"{BASE}/fredo-character.blend"
GLB_OUT = f"{BASE}/fredo-character.glb"

CYAN = (0.333, 0.867, 0.918)
CYAN_BRIGHT = (0.478, 0.933, 0.957)
CYAN_EMIT = (0.12, 0.72, 0.85)
CYAN_BRIGHT_EMIT = (0.18, 0.85, 0.95)


def wx(v):
    return (v - CX_REF) / S


def wz(v):
    return (GROUND_REF - v) / S


# ---------------------------------------------------------------- source rects
raw = open(REF, encoding="utf-8").read()
tokens = []
for m in re.finditer(r"(/\*.*?\*/)|(\badd(?:Rect|Mirrored)\()", raw, flags=re.S):
    tokens.append((m.start(), "call" if m.group(2) else re.sub(r"[/*]", " ", m.group(1)).strip()))


def label_for(pos):
    best = ""
    for p, text in tokens:
        if p < pos and text != "call":
            best = text
    return " ".join(best.split())


NUM = r"(-?\d+(?:\.\d+)?)"
rects = []
for m in re.finditer(r"addRect\(\s*" + r"\s*,\s*".join([NUM] * 4) + r"\s*\)", raw):
    rects.append((*[float(g) for g in m.groups()], label_for(m.start())))
for m in re.finditer(r"addMirrored\(\s*" + r"\s*,\s*".join([NUM] * 4) + r"\s*\)", raw):
    x, y, w, h = (float(g) for g in m.groups())
    lab = label_for(m.start())
    rects.append((x, y, w, h, lab))
    rects.append((REF_W - x - w, y, w, h, lab))


def part_of(x, y, w, h, label):
    t = label.lower()
    left = (x + w / 2) < CX_REF
    if "eye" in t:
        return "eye_l" if left else "eye_r"
    if "foot" in t:
        return "foot_l" if left else "foot_r"
    if "leg" in t:
        return "leg_l" if left else "leg_r"
    if "bow" in t or "tie" in t:
        return "tie"
    if "arm" in t:
        return "arm_l" if left else "arm_r"
    if "button" in t:
        return "body"
    if any(k in t for k in ("head", "forehead", "diagonal", "shoulder")):
        return "head"
    cy = y + h / 2
    if cy < 800:
        return "head"
    if cy < 900:
        return "tie"
    if cy < 1075:
        return "body"
    if cy < 1200:
        return "leg_l" if left else "leg_r"
    return "foot_l" if left else "foot_r"


PARENT = {
    "root": None, "body": "root", "head": "body", "eye_l": "head", "eye_r": "head",
    "tie": "body", "arm_l": "body", "arm_r": "body",
    "leg_l": "root", "leg_r": "root", "foot_l": "leg_l", "foot_r": "leg_r",
    "mustache": "head",
}

BONE_HEAD_REF = {          # where each bone starts, in reference space
    "body": (CX_REF, 918.0), "head": (CX_REF, 800.0),
    "eye_l": (357.0, 518.0), "eye_r": (657.0, 518.0),
    "tie": (CX_REF, 812.0), "arm_l": (303.0, 824.0), "arm_r": (711.0, 824.0),
    "leg_l": (344.0, 1085.0), "leg_r": (670.0, 1085.0),
    "foot_l": (398.0, 1201.0), "foot_r": (616.0, 1201.0),
    "mustache": (507.0, 642.0),
}

PARTS = {}
for (x, y, w, h, lab) in rects:
    PARTS.setdefault(part_of(x, y, w, h, lab), []).append((x, y, w, h))

# ---------------------------------------------------------------- accessories & props
def _ring(cx, cy, r, size, n=12, phase=0.0, sweep=2 * math.pi):
    out = []
    for i in range(n):
        t = phase + sweep * i / n
        out.append((cx + r * math.cos(t) - size / 2, cy + r * math.sin(t) - size / 2, size, size))
    return out


def prop_bubble():
    out = _ring(944.0, 254.0, 42.0, 20.0, 14, -math.pi * 0.5, math.pi * 1.7)
    out += [(908.0, 310.0, 24, 24), (882.0, 344.0, 15, 15)]
    return out


def prop_magnifier():
    out = _ring(744.0, 930.0, 38.0, 20.0, 10)
    for i in range(3):
        out.append((772.0 + i * 15, 958.0 + i * 15, 17, 17))
    return out


def prop_hat():
    return [(357.0, -46.0, 300.0, 130.0),   # crown (tall top hat)
            (277.0, 70.0, 460.0, 26.0)]     # wide brim


def prop_monocle():
    out = _ring(657.0, 518.0, 68.0, 18.0, 20)
    out += [(736.0, 592.0, 13.0, 13.0), (748.0, 610.0, 11.0, 11.0), (756.0, 632.0, 9.0, 9.0)]
    return out


def prop_glasses():
    out = _ring(357.0, 518.0, 62.0, 16.0, 20)
    out += _ring(657.0, 518.0, 62.0, 16.0, 20)
    out += [(462.0, 508.0, 90.0, 14.0)]      # bridge
    return out


def prop_steam():
    return [(690.0, 84.0, 22.0, 22.0), (726.0, 58.0, 18.0, 18.0),
            (762.0, 92.0, 16.0, 16.0), (700.0, 44.0, 14.0, 14.0)]


def prop_burst():
    """Energy ring used by the teleport clips."""
    return _ring(507.0, 880.0, 150.0, 20.0, 18)


# ---------------------------------------------------------------- face rig
# Eye shapes are separate meshes toggled by bone scale (glTF has no visibility
# channel), so a state can swap the whole eye shape - UwU, >.<, o_0, lid ...
EYE_L = (357.0, 518.0)
EYE_R = (657.0, 518.0)
MOUTH = (507.0, 706.0)


def _arc(cx, cy):
    """Closed smiling eye - the ∩ shape."""
    dy = [14.0, 3.0, -6.0, 3.0, 14.0]
    return [(cx + (i - 2) * 17.0 - 12.0, cy + d - 12.0, 24.0, 24.0) for i, d in enumerate(dy)]


def _chev(cx, cy, flip):
    """Squeezed > or < , tip pointing inward for '>.<'."""
    out = []
    for dx, dy in ((-1, -1), (-0.55, -0.5), (0, 0), (-0.55, 0.5), (-1, 1)):
        out.append((cx + flip * dx * 32.0 - 11.0, cy + dy * 34.0 - 11.0, 22.0, 22.0))
    return out


def _round(cx, cy):
    """Wide 'o' eye."""
    return _ring(cx, cy, 52.0, 18.0, 14)


def _lid(cx, cy, outer):
    """Half-lidded ¬ : flat lid bar with a tick on the outer edge."""
    return [(cx - 46.0, cy - 24.0, 92.0, 16.0),
            (cx + outer * 46.0 - 8.0, cy - 44.0, 16.0, 24.0)]


def _mouth_v(cx, cy):
    """The v of ':v'."""
    return [(cx - 26.0, cy - 10.0, 18.0, 18.0),
            (cx - 9.0, cy + 2.0, 18.0, 18.0),
            (cx + 8.0, cy - 10.0, 18.0, 18.0)]


def _mouth_smile(cx, cy):
    """Small asymmetric side-smile (a smirk), not an open 'u'."""
    return [(cx - 18.0, cy + 4.0, 22.0, 9.0),
            (cx + 3.0, cy + 0.0, 22.0, 9.0),
            (cx + 24.0, cy - 6.0, 22.0, 9.0)]


def _heart(cx, cy):
    """Heart eyes."""
    b = 20.0
    return [(cx - 22.0, cy - 20.0, b, b), (cx + 2.0, cy - 20.0, b, b),
            (cx - 34.0, cy - 2.0, b, b), (cx - 12.0, cy - 2.0, b, b), (cx + 10.0, cy - 2.0, b, b),
            (cx - 12.0, cy + 16.0, b, b), (cx + 10.0, cy + 16.0, b, b)]


def _sad(cx, cy):
    """Drooping eye - the arc flipped."""
    dy = [-16.0, -4.0, 6.0, -4.0, -16.0]
    return [(cx + (i - 2) * 17.0 - 12.0, cy + d - 12.0, 24.0, 24.0) for i, d in enumerate(dy)]


EYE_VARIANTS = {
    "arc":   {"l": _arc(*EYE_L),      "r": _arc(*EYE_R)},
    "chev":  {"l": _chev(*EYE_L, 1),  "r": _chev(*EYE_R, -1)},
    "round": {"l": _round(*EYE_L),    "r": _round(*EYE_R)},
    "lid":   {"l": _lid(*EYE_L, -1),  "r": _lid(*EYE_R, 1)},
    "heart": {"l": _heart(*EYE_L),    "r": _heart(*EYE_R)},
    "sad":   {"l": _sad(*EYE_L),      "r": _sad(*EYE_R)},
}

# bone name -> (centre, parent, slabs, material)
EXTRA_BONES = {}
for _v, _sides in EYE_VARIANTS.items():
    EXTRA_BONES[f"eye_{_v}_l"] = (EYE_L, "head", _sides["l"], "fredo_accent")
    EXTRA_BONES[f"eye_{_v}_r"] = (EYE_R, "head", _sides["r"], "fredo_accent")
EXTRA_BONES["mouth_smile"] = ((507.0, 700.0), "head", _mouth_smile(507.0, 700.0), "fredo_accent")
EXTRA_BONES["mouth_v"] = (MOUTH, "head", _mouth_v(*MOUTH), "fredo_accent")

# =====================================================================
# DOOM ARMOUR - hard-surface plate kit
# ---------------------------------------------------------------------
# Construction style: "plated 3D" (STYLE_RULES section 1). Every piece is a
# closed solid built either by lofting polygon rings or by extruding a
# chamfered outline. There is deliberately no UV sphere in here: a sphere has
# no panel breaks and no chamfers, and that is exactly what made the first pass
# read as a smooth toy instead of as armour.
#
# Four ideas carry the look:
#   * BOXY CROSS-SECTIONS - bodies of revolution use a superellipse, not a
#     circle, so the shell has flat planes and rounded corners like machined
#     plate. A circular sweep always reads as a ball, however it is decorated.
#   * VOLUME CHANGES - the helmet is three stacked shells (jaw block, crown
#     shell, crown cap), the spaulders are three lames, the cuirass is two
#     halves. Masses that step against each other read as armour.
#   * PANEL BREAKS - every plate stands 20-76 mm proud of the shell beneath it
#     with a real 5-10 mm gap, so it earns its own shadow line.
#   * HARD EDGES   - _chamfer() bevels ONLY the silhouette edges (filtered by
#     face angle), so highlights catch a 6-14 mm lip without melting the
#     low-poly forms back into blobs.
# =====================================================================


# ---------------------------------------------------------------- primitives
def _new_loft(bm, rings, cap0=True, cap1=True, closed=False):
    """Loft equal-length rings into a solid. `rings` is the sweep, each ring is
    a closed polygon. The two ends get triangle-fan caps unless `closed`."""
    rows = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    spans = len(rows) if closed else len(rows) - 1
    for i in range(spans):
        lo, hi = rows[i], rows[(i + 1) % len(rows)]
        for j in range(n):
            k = (j + 1) % n
            try:
                bm.faces.new((lo[j], lo[k], hi[k], hi[j]))
            except ValueError:
                pass
    if closed:
        return
    for use, row in ((cap0, rows[0]), (cap1, rows[-1])):
        if not use:
            continue
        c = bm.verts.new((sum(v.co.x for v in row) / n,
                          sum(v.co.y for v in row) / n,
                          sum(v.co.z for v in row) / n))
        for j in range(n):
            k = (j + 1) % n
            try:
                bm.faces.new((row[j], row[k], c))
            except ValueError:
                pass


def _append_patch(bm, outer, inner):
    """Close two matching (u,v) grids into one solid panel."""
    nu, nv = len(outer), len(outer[0])
    ov = [[bm.verts.new(p) for p in col] for col in outer]
    iv = [[bm.verts.new(p) for p in col] for col in inner]

    def q(a, b, c, d):
        try:
            bm.faces.new((a, b, c, d))
        except ValueError:
            pass

    for i in range(nu - 1):
        for j in range(nv - 1):
            q(ov[i][j], ov[i + 1][j], ov[i + 1][j + 1], ov[i][j + 1])
            q(iv[i][j], iv[i][j + 1], iv[i + 1][j + 1], iv[i + 1][j])
    for i in range(nu - 1):
        q(ov[i][0], iv[i][0], iv[i + 1][0], ov[i + 1][0])
        q(ov[i][nv - 1], ov[i + 1][nv - 1], iv[i + 1][nv - 1], iv[i][nv - 1])
    for j in range(nv - 1):
        q(ov[0][j], ov[0][j + 1], iv[0][j + 1], iv[0][j])
        q(ov[nu - 1][j], iv[nu - 1][j], iv[nu - 1][j + 1], ov[nu - 1][j + 1])


def _chamfer(bm, offset=0.010, angle=26.0, segments=1):
    """Bevel ONLY the hard edges: plates keep their facets and gain a lip that
    catches a specular highlight. Near-coplanar internals are left alone, so a
    chamfer costs a few dozen faces instead of doubling the mesh."""
    hard = [e for e in bm.edges
            if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > math.radians(angle)]
    if hard:
        bmesh.ops.bevel(bm, geom=hard, offset=offset, segments=segments,
                        profile=0.5, affect='EDGES')


def _se_ring(z, rx, ry, yc=0.0, cx=0.0, n=16, p=2.8):
    """Superellipse ring: flat-ish sides, rounded corners. p=2 is an ellipse;
    p>2 squares it off, which is what makes a shell read as hammered plate
    rather than as a sphere. Angle 0 is the FRONT (-Y), positive turns to +X."""
    e = 2.0 / p
    out = []
    for i in range(n):
        t = 2 * math.pi * i / n
        s, c = math.sin(t), math.cos(t)
        out.append((cx + rx * math.copysign(abs(s) ** e, s),
                    yc - ry * math.copysign(abs(c) ** e, c), z))
    return out


def _se_xy(t, rx, ry, p):
    """Unit superellipse offsets for a given angle."""
    e = 2.0 / p
    s, c = math.sin(t), math.cos(t)
    return (math.copysign(abs(s) ** e, s), math.copysign(abs(c) ** e, c))


def _append_box(bm, loc, size, bevel=0.010, segments=1, rot=None):
    """One chamfered box. `loc` is the centre, `size` the full extents."""
    tmp = bmesh.new()
    bmesh.ops.create_cube(tmp, size=1.0)
    for vt in tmp.verts:
        vt.co.x *= size[0]
        vt.co.y *= size[1]
        vt.co.z *= size[2]
    b = min(bevel, 0.42 * min(size))
    if b > 0:
        bmesh.ops.bevel(tmp, geom=list(tmp.edges), offset=b, segments=segments,
                        profile=0.5, affect='EDGES')
    m = Matrix.Translation(loc)
    if rot is not None:
        m = m @ rot
    bmesh.ops.transform(tmp, matrix=m, verts=list(tmp.verts))
    me = bpy.data.meshes.new("t_box")
    tmp.to_mesh(me)
    tmp.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)


def _append_cyl(bm, loc, radius, length, axis='Y', segments=10, radius2=None):
    tmp = bmesh.new()
    r2 = radius if radius2 is None else radius2
    bmesh.ops.create_cone(tmp, cap_ends=True, cap_tris=False, segments=segments,
                          radius1=radius, radius2=r2, depth=length)
    rot = Matrix.Identity(4)
    if axis == 'Y':
        rot = Matrix.Rotation(math.radians(90), 4, 'X')
    elif axis == 'X':
        rot = Matrix.Rotation(math.radians(90), 4, 'Y')
    bmesh.ops.transform(tmp, matrix=Matrix.Translation(loc) @ rot,
                        verts=list(tmp.verts))
    me = bpy.data.meshes.new("t_cyl")
    tmp.to_mesh(me)
    tmp.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)


def _append_tube(bm, pts, radii, segments=10):
    """Tapered lofted tube through a polyline - used for bare arms, where a
    grid of rings reads as a limb but a sphere reads as a toy."""
    n = len(pts)
    rings = []
    for i, (p, r) in enumerate(zip(pts, radii)):
        p = Vector(p)
        a = Vector(pts[max(0, i - 1)])
        b = Vector(pts[min(n - 1, i + 1)])
        t = (b - a).normalized()
        ref = Vector((0.0, 1.0, 0.0))
        if abs(t.dot(ref)) > 0.95:
            ref = Vector((1.0, 0.0, 0.0))
        u = t.cross(ref).normalized()
        v = u.cross(t).normalized()
        ring = []
        for j in range(segments):
            ang = 2 * math.pi * j / segments
            q = p + u * (r * math.cos(ang)) + v * (r * math.sin(ang))
            ring.append((q.x, q.y, q.z))
        rings.append(ring)
    _new_loft(bm, rings, cap0=True, cap1=True)


def _append_plate(bm, outline, y0, thickness, bevel=0.012, segments=1):
    """Extrude a convex X/Z outline along +Y into a chamfered armour plate."""
    tmp = bmesh.new()
    vs = [tmp.verts.new((x, y0, z)) for (x, z) in outline]
    face = tmp.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(tmp, geom=[face])
    moved = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(tmp, verts=moved, vec=(0.0, thickness, 0.0))
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    if bevel > 0:
        bmesh.ops.bevel(tmp, geom=list(tmp.edges), offset=bevel,
                        segments=segments, profile=0.5, affect='EDGES')
    bmesh.ops.triangulate(tmp, faces=[f for f in tmp.faces if len(f.verts) > 4])
    me = bpy.data.meshes.new("t_plate")
    tmp.to_mesh(me)
    tmp.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)


def _inset_outline(outline, k=0.74):
    """Shrink a convex outline toward its centroid - used to build the raised
    centre plate that gives a lame or a pad a visible bevelled edge."""
    cx = sum(p[0] for p in outline) / len(outline)
    cz = sum(p[1] for p in outline) / len(outline)
    return [(cx + (x - cx) * k, cz + (z - cz) * k) for (x, z) in outline]


# All 3D gear is flat-shaded: faceted armour next to the voxel body reads as a
# deliberate era choice, a smooth blob next to it reads as a mistake.
SMOOTH_BONES = set()


HELM_Z = wz(355.0)
VIS_Z = wz(465.0)
BRT_Z = wz(572.0)
PAU_Z = wz(872.0)
CHEST_Z = wz(880.0)
BELT_Z = wz(968.0)
KNEE_Z = wz(1130.0)
BOOT_Z = wz(1210.0)


# ---------------------------------------------------------------- helmet
# The head under the armour is a 1.30 m wide hollow VOXEL RING, so the helmet is
# deliberately oversized: it clears the ring by 5-7 cm on every side and adds
# the front-to-back depth the flat head does not have.
#
# It is THREE shells that step against each other, not one dome:
#   jaw block   - widest mass, chin forward           z 0.640 .. 0.986
#   crown shell - the main cranium                     z 0.952 .. 1.700
#   crown cap   - a boxy plate stepping out on top     z 1.640 .. 1.814
# Those two horizontal steps are what stop the head reading as a ball.
DOME_PROFILE = [
    (0.952, 0.700, 0.318, -0.004),
    (1.060, 0.716, 0.326, -0.008),
    (1.180, 0.718, 0.328, -0.008),
    (1.300, 0.708, 0.323, -0.004),
    (1.400, 0.678, 0.310, 0.002),
    (1.500, 0.622, 0.286, 0.008),
    (1.590, 0.548, 0.252, 0.014),
    (1.670, 0.446, 0.206, 0.018),
    (1.700, 0.402, 0.186, 0.020),
]

JAW_PROFILE = [
    (0.640, 0.352, 0.206, 0.014),
    (0.700, 0.508, 0.262, -0.002),
    (0.760, 0.626, 0.302, -0.018),
    (0.840, 0.694, 0.330, -0.028),
    (0.910, 0.734, 0.348, -0.034),
    (0.986, 0.756, 0.360, -0.036),
]

CAP_PROFILE = [
    (1.640, 0.522, 0.240, 0.014),
    (1.694, 0.508, 0.234, 0.018),
    (1.744, 0.460, 0.212, 0.020),
    (1.784, 0.372, 0.172, 0.022),
    (1.814, 0.236, 0.112, 0.022),
]
HELM_N = 16
DOME_P = 2.8
JAW_P = 3.2
CAP_P = 3.4


def _sample(profile, z):
    """Linear radius (rx, ry, yc) at height z for a profile table."""
    if z <= profile[0][0]:
        return profile[0][1:]
    if z >= profile[-1][0]:
        return profile[-1][1:]
    for a, b in zip(profile, profile[1:]):
        if a[0] <= z <= b[0]:
            t = (z - a[0]) / (b[0] - a[0])
            return tuple(a[i] + (b[i] - a[i]) * t for i in (1, 2, 3))
    return profile[-1][1:]


def _dome_at(z):
    return _sample(DOME_PROFILE, z)


def _patch(bm, radius_fn, t0, t1, nt, zlim, nz, out=0.018, inn=-0.030, p=2.0):
    """Armour panel that follows a shell: sampled on (angle, z) so it hugs the
    dome or torso, standing `out` proud and reaching `inn` inside."""
    outer, inner = [], []
    for i in range(nt):
        u = i / (nt - 1.0)
        t = math.radians(t0 + (t1 - t0) * u)
        za, zb = zlim(u)
        sx, cy = _se_xy(t, 1.0, 1.0, p)
        col_o, col_i = [], []
        for j in range(nz):
            v = j / (nz - 1.0)
            z = za + (zb - za) * v
            rx, ry, yc = radius_fn(z)
            col_o.append(((rx + out) * sx, yc - (ry + out) * cy, z))
            col_i.append(((rx + inn) * sx, yc - (ry + inn) * cy, z))
        outer.append(col_o)
        inner.append(col_i)
    _append_patch(bm, outer, inner)


def _ring_band(bm, z0, z1, rx, ry, thick, cy=0.0, cx=0.0, n=16, p=2.8):
    rings = []
    for i in range(n):
        t = 2 * math.pi * i / n
        sx, cy_ = _se_xy(t, 1.0, 1.0, p)
        rings.append([
            (cx + rx * sx, cy - ry * cy_, z0),
            (cx + rx * sx, cy - ry * cy_, z1),
            (cx + (rx - thick) * sx, cy - (ry - thick) * cy_, z1),
            (cx + (rx - thick) * sx, cy - (ry - thick) * cy_, z0),
        ])
    _new_loft(bm, rings, closed=True)


# The visor opening: a wide band across the face that arches in the middle and
# tapers at the ends, the way a real full-face helmet's visor does.
VIS_HALF = 50.0
VIS_TOP = 1.332
VIS_BOT = 1.002
BROW_TOP = 1.448


def _vis_lim(u):
    k = (2.0 * u - 1.0) ** 2
    return (VIS_BOT + 0.050 * k, VIS_TOP - 0.060 * k)


# Crown ridge: sampled along the crown's own sagittal outline so the ridge
# follows the shell instead of guessing an ellipse through it.
def _crown_path():
    lo, hi = 1.470, 1.680
    pts = []
    steps = 6
    for i in range(steps):
        z = lo + (hi - lo) * i / (steps - 1.0)
        rx, ry, yc = _dome_at(z)
        pts.append((yc - ry, z))
    rx, ry, yc = _sample(CAP_PROFILE, 1.700)
    for i in range(5):
        z = 1.694 + (1.806 - 1.694) * i / 4.0
        rx, ry, yc = _sample(CAP_PROFILE, z)
        pts.append((yc - ry, z))
    rx, ry, yc = _sample(CAP_PROFILE, 1.812)
    pts.append((yc, 1.812))
    for i in range(4, -1, -1):
        z = 1.694 + (1.806 - 1.694) * i / 4.0
        rx, ry, yc = _sample(CAP_PROFILE, z)
        pts.append((yc + ry, z))
    for i in range(steps - 1, -1, -1):
        z = lo + (hi - lo) * i / (steps - 1.0)
        rx, ry, yc = _dome_at(z)
        pts.append((yc + ry, z))
    return pts


CROWN_PATH = _crown_path()


def _crown_ridge(bm, i0, i1, height=0.034, base=0.030):
    """A raised centre ridge between two indices of CROWN_PATH."""
    seg = CROWN_PATH[i0:i1]
    rings = []
    for k, (y, z) in enumerate(seg):
        p0 = seg[max(0, k - 1)]
        p1 = seg[min(len(seg) - 1, k + 1)]
        ty, tz = p1[0] - p0[0], p1[1] - p0[1]
        ln = math.hypot(ty, tz) or 1.0
        ny, nz = -tz / ln, ty / ln
        if ny * (y + 0.014) + nz * (z - 1.20) < 0:
            ny, nz = -ny, -nz
        rx = 0.40 * _dome_at(z)[0]
        w0 = min(0.098, rx)
        w1 = w0 * 0.52
        rings.append([
            (-w0, y - ny * base, z - nz * base),
            (-w1, y + ny * height, z + nz * height),
            (w1, y + ny * height, z + nz * height),
            (w0, y - ny * base, z - nz * base),
        ])
    _new_loft(bm, rings, cap0=True, cap1=True)


def _mk_helmet(_z=None):
    """Slate jaw block + crown shell + crown cap, cheek guards, brow shelf,
    segmented crown ridge and side cheek pods."""
    def make(bm):
        _new_loft(bm, [_se_ring(z, rx, ry, yc, n=HELM_N, p=JAW_P)
                       for (z, rx, ry, yc) in JAW_PROFILE])
        _new_loft(bm, [_se_ring(z, rx, ry, yc, n=HELM_N, p=DOME_P)
                       for (z, rx, ry, yc) in DOME_PROFILE])
        _new_loft(bm, [_se_ring(z, rx, ry, yc, n=HELM_N, p=CAP_P)
                       for (z, rx, ry, yc) in CAP_PROFILE])
        # cheek guards: two stacked panels per side, split by a real gap
        for s in (1, -1):
            _patch(bm, _dome_at, s * 61.0, s * 96.0, 7,
                   lambda u: (1.176, 1.372), 5, out=0.046, inn=-0.040, p=DOME_P)
            _patch(bm, _dome_at, s * 64.0, s * 94.0, 7,
                   lambda u: (0.998, 1.158), 5, out=0.040, inn=-0.040, p=DOME_P)
            # cheek pod, mounted on the jaw block
            _append_cyl(bm, (s * 0.736, -0.186, 0.862), 0.100, 0.044,
                        axis='X', segments=10)
        # rear exhaust block
        _append_box(bm, (0.0, 0.372, 1.080), (0.340, 0.104, 0.196), 0.022, 1)
        # rear panel: gives the back of the helmet its own plate
        _patch(bm, _dome_at, 150.0, 210.0, 7,
               lambda u: (0.992, 1.268), 6, out=0.036, inn=-0.042, p=DOME_P)
        # brow shelf: juts 48 mm forward over the visor, hard shadow line
        _patch(bm, _dome_at, -60.0, 60.0, 17,
               lambda u: (_vis_lim(u)[1] + 0.008, BROW_TOP), 4,
               out=0.048, inn=-0.040, p=DOME_P)
        for (i0, i1) in ((0, 6), (7, 13), (14, 20)):
            _crown_ridge(bm, i0, i1)
        # brow crest: a fin down the centre of the brow, over the visor's bridge
        _patch(bm, _dome_at, -8.0, 8.0, 3,
               lambda u: (VIS_TOP - 0.012, BROW_TOP + 0.010), 4,
               out=0.076, inn=-0.030, p=DOME_P)
        _chamfer(bm, 0.013)
    return make


def _mk_visor(_z=None):
    """Glossy green glass, flush with the shell and under a 48 mm brow shelf -
    so it reads as a deep window rather than a sticker on a ball."""
    def make(bm):
        _patch(bm, _dome_at, -VIS_HALF, VIS_HALF, 17, _vis_lim, 5,
               out=0.008, inn=-0.048, p=DOME_P)
    return make


def _mk_breather(_z=None):
    """Respirator muzzle: a chamfered wedge clamped over the mouth."""
    def make(bm):
        outline = [(-0.184, 0.792), (-0.168, 0.886), (-0.108, 0.948),
                   (0.108, 0.948), (0.168, 0.886), (0.184, 0.792),
                   (0.136, 0.740), (-0.136, 0.740)]
        _append_plate(bm, outline, -0.474, 0.170, 0.016, 2)
        _append_plate(bm, [(-0.204, 0.896), (0.204, 0.896),
                           (0.178, 0.944), (-0.178, 0.944)],
                      -0.356, 0.048, 0.010, 1)
        _chamfer(bm, 0.009)
    return make


def _mk_arms(side):
    """Bare arm: a lofted tube that replaces the flat voxel staircase with a
    real limb. It fully encloses the voxel arm, so no paper-thin tiles show."""
    def make(bm):
        s = side
        pts = ((s * 0.300, 0.0, 0.650),
               (s * 0.340, -0.004, 0.560),
               (s * 0.386, -0.006, 0.470),
               (s * 0.384, -0.004, 0.398),
               (s * 0.336, 0.0, 0.328))
        radii = (0.082, 0.084, 0.078, 0.068, 0.068)
        _append_tube(bm, pts, radii, segments=12)
        _append_cyl(bm, (s * 0.300, -0.002, 0.640), 0.082, 0.052,
                    axis='Z', segments=12)
        _chamfer(bm, 0.008)
    return make


# ---------------------------------------------------------------- torso
# One profile drives the cuirass, the abdominal ridges and the belt, so the
# separate plates can never drift out of alignment. (z, rx, ry, yc)
TORSO_PROFILE = [
    (0.330, 0.220, 0.184, 0.006),
    (0.400, 0.228, 0.190, 0.002),
    (0.455, 0.236, 0.198, -0.002),
    (0.520, 0.240, 0.202, -0.006),
    (0.585, 0.238, 0.200, -0.009),
    (0.635, 0.216, 0.182, -0.006),
    (0.670, 0.180, 0.154, 0.000),
]


def _torso(z):
    return _sample(TORSO_PROFILE, z)


def _half_loft(bm, prof, side, gap=0.014, n=8, p=2.4):
    """Half of a body of revolution, cut on the X=0 plane - the cuirass's two
    halves, separated by a real centre seam."""
    rings = []
    for (z, rx, ry, yc) in prof:
        ring = []
        for i in range(n + 1):
            t = math.radians(180.0 * i / n)
            sx, cy = _se_xy(t, 1.0, 1.0, p)
            ring.append((side * (rx * sx + gap), yc - ry * cy, z))
        rings.append(ring)
    _new_loft(bm, rings, cap0=True, cap1=True)


def _mk_chest(_z=None):
    """Green cuirass: two mirrored halves with a centre seam, layered pectoral
    plates, a flared collar, and stacked abdominal ridge plates below."""
    def make(bm):
        prof = [(z,) + _torso(z) for z in
                (0.448, 0.492, 0.536, 0.580, 0.622, 0.650, 0.672)]
        for side in (1, -1):
            _half_loft(bm, prof, side)
        # pectoral plates, proud of each half
        for s in (1, -1):
            _patch(bm, _torso, s * 9.0, s * 74.0, 7,
                   lambda u: (0.500, 0.648), 6, out=0.030, inn=-0.026, p=2.4)
            _patch(bm, _torso, s * 18.0, s * 66.0, 6,
                   lambda u: (0.520, 0.632), 5, out=0.046, inn=0.014, p=2.4)
        _chamfer(bm, 0.012)
        # collar / gorget: a ring that flares above the cuirass
        rx, ry, yc = _torso(0.652)
        _ring_band(bm, 0.626, 0.680, rx + 0.022, ry + 0.022, 0.036,
                   cy=yc, n=16, p=2.4)
        # abdominal ridge plates: three separate bands, 5 mm gaps between them
        for (a, b) in ((0.358, 0.388), (0.393, 0.423), (0.428, 0.450)):
            _patch(bm, _torso, -112.0, 112.0, 13,
                   lambda u, a=a, b=b: (a, b), 2, out=0.018, inn=-0.020, p=2.4)
        _chamfer(bm, 0.008)
    return make


def _mk_pauldrons(_z=None):
    """Layered spaulders: three overlapping lames per shoulder, each wider and
    deeper than the one above it, so the silhouette flares down the arm."""
    LAMES = (
        ((-0.176, 0.664), (-0.180, 0.722), (-0.288, 0.744), (-0.358, 0.716),
         (-0.350, 0.668), (-0.258, 0.652), -0.180, 0.352),
        ((-0.190, 0.600), (-0.206, 0.680), (-0.372, 0.704), (-0.430, 0.660),
         (-0.412, 0.594), (-0.278, 0.576), -0.202, 0.398),
        ((-0.216, 0.532), (-0.242, 0.618), (-0.414, 0.642), (-0.466, 0.588),
         (-0.430, 0.548), (-0.290, 0.538), -0.222, 0.436),
    )

    def make(bm):
        for s in (1, -1):
            for lame in LAMES:
                outline = [(s * x, z) for (x, z) in lame[:6]]
                y0, th = lame[6], lame[7]
                _append_plate(bm, outline, y0, th, 0.018, 1)
                # raised centre plate: a 26%-inset copy standing 16 mm proud
                centre = _inset_outline(outline, 0.74)
                _append_plate(bm, centre, y0 - 0.016, th + 0.032, 0.012, 1)
        _chamfer(bm, 0.010)
    return make


def _mk_belt(_z=None):
    """Green tactical belt with four pouches and their flaps."""
    def make(bm):
        _ring_band(bm, 0.292, 0.368, 0.286, 0.228, 0.056, cy=0.004,
                   n=16, p=2.6)
        _chamfer(bm, 0.010)
        for s in (1, -1):
            for (px, pw) in ((0.116, 0.090), (0.206, 0.078)):
                _append_box(bm, (s * px, -0.212, 0.318),
                            (pw, 0.086, 0.104), 0.014, 1)
                _append_box(bm, (s * px, -0.218, 0.352),
                            (pw + 0.012, 0.072, 0.030), 0.010, 1)
    return make


def _mk_belt_shells(_z=None):
    """Red-tipped shell loops standing proud of the belt."""
    def make(bm):
        for s in (1, -1):
            for px in (0.052, 0.162, 0.252):
                k = max(0.0, 1.0 - (px / 0.286) ** 2)
                y = 0.004 - 0.228 * math.sqrt(k)
                _append_cyl(bm, (s * px, y - 0.004, 0.392), 0.017, 0.052,
                            axis='Z', segments=8)
        _chamfer(bm, 0.005, 30.0)
    return make


def _mk_pants(_z=None):
    """Green trouser legs, tapered into the belt so nothing pokes through."""
    def make(bm):
        for s in (1, -1):
            cx = s * 0.168
            rings = [_se_ring(z, rx, ry, yc, cx=cx, n=12, p=2.5)
                     for (z, rx, ry, yc) in (
                         (0.038, 0.116, 0.092, 0.000),
                         (0.128, 0.124, 0.100, -0.002),
                         (0.226, 0.132, 0.108, -0.004),
                         (0.300, 0.108, 0.096, -0.004),
                     )]
            _new_loft(bm, rings, cap0=True, cap1=True)
        _chamfer(bm, 0.012)
    return make


def _mk_knees(_z=None):
    """Slate knee pads: a narrow plate so the green trousers stay visible on
    both sides, with a stepped concentric boss and a shin lip below."""
    def make(bm):
        for s in (1, -1):
            _append_plate(bm, [(s * 0.086, 0.286), (s * 0.258, 0.286),
                               (s * 0.268, 0.216), (s * 0.242, 0.150),
                               (s * 0.100, 0.150), (s * 0.074, 0.214)],
                          -0.174, 0.106, 0.016, 1)
            _append_plate(bm, [(s * 0.092, 0.148), (s * 0.250, 0.148),
                               (s * 0.232, 0.098), (s * 0.110, 0.098)],
                          -0.148, 0.086, 0.012, 1)
            # moulded round boss: a shallow disc with a raised rim, plus two
            # horizontal ridge bars across the pad
            _append_cyl(bm, (s * 0.168, -0.181, 0.222), 0.054, 0.016,
                        axis='Y', segments=12)
            _append_cyl(bm, (s * 0.168, -0.192, 0.222), 0.032, 0.010,
                        axis='Y', segments=12)
            for z in (0.166, 0.264):
                _append_box(bm, (s * 0.168, -0.180, z),
                            (0.156, 0.020, 0.017), 0.006, 1)
        _chamfer(bm, 0.010)
    return make


def _mk_boots(_z=None):
    """Slate boots: main shell, toe cap and sole ledge."""
    def make(bm):
        for s in (1, -1):
            _append_box(bm, (s * 0.168, -0.020, 0.096),
                        (0.236, 0.276, 0.128), 0.018, 2)
            # toe cap: steps out and down from the shaft
            _append_box(bm, (s * 0.168, -0.164, 0.058),
                        (0.224, 0.116, 0.112), 0.018, 2)
            # heel block
            _append_box(bm, (s * 0.168, 0.078, 0.056),
                        (0.212, 0.086, 0.108), 0.016, 1)
            # sole ledge
            _append_box(bm, (s * 0.168, -0.026, 0.012),
                        (0.256, 0.330, 0.024), 0.008, 1)
        _chamfer(bm, 0.008)
    return make


def _mk_gloves(side):
    """Black leather glove: fist, knuckle plate, cuff and two strap bands."""
    def make(bm):
        s = side
        _append_box(bm, (s * 0.330, -0.034, 0.302),
                    (0.150, 0.176, 0.126), 0.018, 2)
        _append_box(bm, (s * 0.402, -0.034, 0.312),
                    (0.026, 0.140, 0.082), 0.012, 1)
        _append_box(bm, (s * 0.342, -0.026, 0.372),
                    (0.132, 0.146, 0.048), 0.012, 1)
        for z in (0.268, 0.332):
            _append_box(bm, (s * 0.330, -0.034, z),
                        (0.158, 0.184, 0.020), 0.008, 1)
        _chamfer(bm, 0.007)
    return make


def _mk_trim_head(_z=None):
    """Gunmetal detail on the helmet: the visor bezel's lower bar, the
    respirator grille and the pod faces."""
    def make(bm):
        _patch(bm, _dome_at, -58.0, 58.0, 17,
               lambda u: (0.982, _vis_lim(u)[0] - 0.008), 3,
               out=0.038, inn=-0.034, p=DOME_P)
        for s in (1, -1):
            for z in (0.826, 0.862, 0.898):
                _append_box(bm, (s * 0.762, -0.186, z),
                            (0.016, 0.148, 0.022), 0.005, 1)
        _chamfer(bm, 0.008)
        # dark gasket in the inside corner of the jaw/crown step
        rx, ry, yc = _dome_at(0.972)
        _ring_band(bm, 0.958, 1.000, rx + 0.018, ry + 0.018, 0.030,
                   cy=yc, n=HELM_N, p=DOME_P)
        # dark gasket between the two stacked cheek panels
        for s in (1, -1):
            _patch(bm, _dome_at, s * 60.0, s * 97.0, 7,
                   lambda u: (1.148, 1.186), 2, out=0.028, inn=-0.030, p=DOME_P)
        # rear exhaust slats
        for z in (1.020, 1.080, 1.140):
            _append_box(bm, (0.0, 0.422, z), (0.264, 0.018, 0.026), 0.006, 1)
        # respirator grille: three slats standing off the muzzle face
        for z in (0.808, 0.854, 0.900):
            _append_box(bm, (0.0, -0.482, z), (0.252, 0.020, 0.026), 0.006, 1)
    return make


def _mk_trim_body(_z=None):
    """Gunmetal detail on the body: the flexible under-suit that shows through
    the panel gaps, the centre seam channel, buckle, rivets and boot straps."""
    def make(bm):
        rings = []
        for z in (0.318, 0.372, 0.430, 0.482):
            rx, ry, yc = _torso(z)
            rings.append(_se_ring(z, rx - 0.014, ry - 0.014, yc, n=14, p=2.4))
        _new_loft(bm, rings, cap0=True, cap1=True)
        # centre seam channel, recessed behind the cuirass halves
        _append_box(bm, (0.0, -0.142, 0.566), (0.062, 0.092, 0.216), 0.010, 1)
        _chamfer(bm, 0.007)
        # belt buckle
        _append_box(bm, (0.0, -0.238, 0.330), (0.104, 0.038, 0.086), 0.010, 1)
        _append_box(bm, (0.0, -0.254, 0.330), (0.048, 0.016, 0.048), 0.006, 1)
        for s in (1, -1):
            # knee boss centre bolt
            _append_cyl(bm, (s * 0.168, -0.198, 0.222), 0.009, 0.010,
                        axis='Y', segments=8)
            # chest rivets, seated on the curved cuirass
            for (x, z) in ((0.106, 0.616), (0.172, 0.572), (0.106, 0.526)):
                rx, ry, yc = _torso(z)
                k = max(0.0, 1.0 - (x / (rx + 0.024)) ** 2)
                y = yc - (ry + 0.024) * math.sqrt(k)
                _append_cyl(bm, (s * x, y - 0.002, z), 0.013, 0.020,
                            axis='Y', segments=8)
            # pauldron rivets
            for (x, z) in ((0.222, 0.706), (0.300, 0.712), (0.338, 0.684)):
                _append_cyl(bm, (s * x, -0.184, z), 0.016, 0.018,
                            axis='Y', segments=8)
            # glove knuckle guard
            _append_box(bm, (s * 0.398, -0.038, 0.292),
                        (0.026, 0.150, 0.062), 0.010, 1)
            # boot strap
            _append_box(bm, (s * 0.168, -0.036, 0.124), (0.252, 0.312, 0.022),
                        0.007, 1)
    return make


def _mk_lava(_z=None):
    """Glowing lava chunks scattered around the boots."""
    CHUNKS = ((0.352, -0.118, 0.020, 0.088, 0.088, 0.044),
              (0.286, 0.086, 0.014, 0.062, 0.070, 0.030),
              (0.028, -0.096, 0.016, 0.058, 0.066, 0.034),
              (-0.238, -0.164, 0.012, 0.070, 0.074, 0.028),
              (-0.372, 0.052, 0.018, 0.080, 0.082, 0.040),
              (-0.060, 0.128, 0.012, 0.066, 0.060, 0.026))

    def make(bm):
        for (x, y, z, sx, sy, sz) in CHUNKS:
            _append_box(bm, (x, y, z), (sx, sy, sz), 0.012, 1)
        _chamfer(bm, 0.006)
    return make


# ---------------------------------------------------------------- weapons
# Real 3D weapons sized to sit in front of the cuirass (its front face is
# around y = -0.21), held in the forward arm pose.
WPN_Y = -0.46


def _mk_shotgun(_z=None):
    """Chunky twin-barrel shotgun: fat barrels, short, wood furniture."""
    def make(bm):
        _append_box(bm, (0.00, WPN_Y, 0.50), (0.24, 0.12, 0.13), 0.012)
        for z in (0.552, 0.462):
            _append_cyl(bm, (0.27, WPN_Y, z), 0.043, 0.36, axis='X', segments=14)
        _append_box(bm, (0.02, WPN_Y - 0.07, 0.455), (0.06, 0.06, 0.09), 0.008)
        _chamfer(bm, 0.006)
    return make


def _mk_shotgun_wood(_z=None):
    """Pump slide + stock, in wood - what makes it read as a shotgun."""
    def make(bm):
        _append_box(bm, (0.24, WPN_Y - 0.05, 0.44), (0.17, 0.10, 0.09), 0.012)
        _append_box(bm, (-0.21, WPN_Y + 0.02, 0.472), (0.22, 0.11, 0.16), 0.016)
        _append_box(bm, (-0.02, WPN_Y - 0.08, 0.432), (0.07, 0.06, 0.10), 0.010)
        _chamfer(bm, 0.006)
    return make


def _mk_mg(_z=None):
    """Long, thin-barrelled machine gun: slim barrel, big offset drum."""
    def make(bm):
        _append_box(bm, (0.00, WPN_Y, 0.50), (0.18, 0.10, 0.09), 0.010)
        _append_cyl(bm, (0.37, WPN_Y, 0.505), 0.018, 0.56, axis='X', segments=10)
        _append_cyl(bm, (0.66, WPN_Y, 0.505), 0.026, 0.05, axis='X', segments=10)
        _append_box(bm, (-0.19, WPN_Y + 0.02, 0.485), (0.18, 0.09, 0.10), 0.012)
        _append_box(bm, (0.17, WPN_Y - 0.06, 0.445), (0.05, 0.05, 0.09), 0.008)
        _chamfer(bm, 0.005)
    return make


def _mk_mg_drum(_z=None):
    """Brass drum magazine - the machine gun's silhouette giveaway."""
    def make(bm):
        _append_cyl(bm, (-0.02, WPN_Y - 0.05, 0.437), 0.105, 0.11, axis='Y', segments=16)
        _chamfer(bm, 0.006)
    return make


def _mk_sword_hilt(_z=None):
    """Crucible-style grip and crossguard, held upright."""
    def make(bm):
        _append_cyl(bm, (0.10, WPN_Y, 0.42), 0.030, 0.20, axis='Z', segments=10)
        _append_box(bm, (0.10, WPN_Y, 0.305), (0.075, 0.075, 0.05), 0.010)   # pommel
        _append_box(bm, (0.10, WPN_Y, 0.535), (0.30, 0.065, 0.05), 0.010)    # crossguard
        _chamfer(bm, 0.005)
    return make


def _mk_sword_blade(_z=None):
    """Broad tapered energy blade standing above the shoulder."""
    def make(bm):
        outline = [(0.015, 0.560), (0.185, 0.560), (0.130, 1.080), (0.070, 1.080)]
        _append_plate(bm, outline, WPN_Y - 0.016, 0.032, 0.008, 1)
        _chamfer(bm, 0.004)
    return make


def _mk_muzzle(_z=None):
    def make(bm):
        _append_box(bm, (0.60, WPN_Y + 0.015, 0.505), (0.11, 0.10, 0.10), 0.006)
        _append_box(bm, (0.71, WPN_Y + 0.015, 0.505), (0.10, 0.05, 0.05), 0.005)
        _append_box(bm, (0.60, WPN_Y + 0.015, 0.595), (0.05, 0.05, 0.10), 0.005)
    return make


EXTRA_PRIMS = {
    "helmet":       ((507.0, 340.0), "head",   _mk_helmet(),      "fredo_helm"),
    "visor":        ((507.0, 500.0), "head",   _mk_visor(),       "fredo_visor"),
    "breather":     ((507.0, 628.0), "head",   _mk_breather(),    "fredo_helm"),
    "trim_head":    ((507.0, 420.0), "head",   _mk_trim_head(),   "fredo_trim"),
    "armor":        ((507.0, 880.0), "body",   _mk_chest(),       "fredo_doom"),
    "pauldrons":    ((507.0, 856.0), "body",   _mk_pauldrons(),   "fredo_doom"),
    "trim_body":    ((507.0, 940.0), "body",   _mk_trim_body(),   "fredo_trim"),
    "belt":         ((507.0, 968.0), "body",   _mk_belt(),        "fredo_doom"),
    "belt_shells":  ((507.0, 984.0), "body",   _mk_belt_shells(), "fredo_lava"),
    "pants":        ((507.0, 1120.0), "body",  _mk_pants(),       "fredo_doom"),
    "knees":        ((507.0, 1108.0), "root",  _mk_knees(),       "fredo_helm"),
    "boots":        ((507.0, 1210.0), "root",  _mk_boots(),       "fredo_helm"),
    "glove_l":      ((303.0, 1060.0), "arm_l", _mk_gloves(-1),    "fredo_glove"),
    "glove_r":      ((711.0, 1060.0), "arm_r", _mk_gloves(1),     "fredo_glove"),
    "arm_skin_l":   ((303.0, 900.0),  "arm_l", _mk_arms(-1),      "fredo_skin"),
    "arm_skin_r":   ((711.0, 900.0),  "arm_r", _mk_arms(1),       "fredo_skin"),
    "shotgun":      ((500.0, 940.0),  "body",  _mk_shotgun(),     "fredo_metal"),
    "shotgun_wood": ((500.0, 940.0),  "body",  _mk_shotgun_wood(), "fredo_wood"),
    "mg":           ((492.0, 940.0),  "body",  _mk_mg(),          "fredo_metal"),
    "mg_drum":      ((492.0, 940.0),  "body",  _mk_mg_drum(),     "fredo_brass"),
    "sword_hilt":   ((375.0, 950.0),  "body",  _mk_sword_hilt(),  "fredo_metal"),
    "sword_blade":  ((560.0, 925.0),  "body",  _mk_sword_blade(), "fredo_fx"),
    "muzzle":       ((724.0, 933.0),  "body",  _mk_muzzle(),      "fredo_fx"),
}
# every toggleable piece, in the order doom-in staggers them on. Head first:
# the character's head is a bare voxel ring underneath, and leaving it naked
# for half the transformation is the one thing that looks wrong.
DOOM_KIT = ("helmet", "visor", "trim_head", "breather", "armor", "pauldrons",
            "arm_skin_l", "arm_skin_r", "glove_l", "glove_r", "belt",
            "belt_shells", "trim_body", "pants", "knees", "boots", "lava")

MUZZLE = [(704.0, 913.0, 40.0, 40.0),        # muzzle flash star
          (680.0, 921.0, 24.0, 24.0),
          (744.0, 921.0, 24.0, 24.0)]

# shotgun (his signature)
SHOTGUN = [(280.0, 920.0, 76.0, 44.0),     # stock
           (356.0, 914.0, 74.0, 54.0),     # receiver
           (430.0, 926.0, 92.0, 34.0),     # pump
           (522.0, 922.0, 172.0, 22.0),    # barrel
           (694.0, 918.0, 30.0, 30.0)]     # muzzle

# machine gun
MG = [(286.0, 916.0, 74.0, 46.0),          # stock
      (360.0, 918.0, 86.0, 86.0),          # drum magazine
      (446.0, 928.0, 220.0, 24.0),         # barrel
      (666.0, 922.0, 34.0, 34.0)]          # muzzle

# Crucible-style energy sword
SWORD_HILT = [(330.0, 930.0, 90.0, 40.0),  # grip
              (420.0, 916.0, 26.0, 68.0)]  # guard
SWORD_BLADE = [(446.0, 904.0, 200.0, 42.0),  # blade
               (646.0, 914.0, 32.0, 26.0)]   # tip

EXTRA_PRIMS["lava"] = ((507.0, 1226.0), "root", _mk_lava(), "fredo_lava")


PROPS = {
    "thinking":  {"slabs": prop_bubble(),    "center": (944.0, 254.0), "parent": "root"},
    "analyzing": {"slabs": prop_magnifier(), "center": (744.0, 930.0), "parent": "body"},
    "planning":  {"slabs": [(700.0, 906.0, 112.0, 140.0), (724.0, 940.0, 64.0, 9.0),
                            (724.0, 964.0, 64.0, 9.0), (724.0, 988.0, 38.0, 9.0)],
                  "center": (756.0, 976.0), "parent": "body"},
    "working":   {"slabs": [(694.0, 1006.0, 156.0, 14.0), (680.0, 976.0, 14.0, 34.0),
                            (850.0, 976.0, 14.0, 34.0)],
                  "center": (772.0, 990.0), "parent": "body"},
    "complete":  {"slabs": [(704.0, 936.0, 20.0, 20.0), (724.0, 916.0, 20.0, 20.0),
                            (744.0, 894.0, 20.0, 20.0), (764.0, 872.0, 20.0, 20.0),
                            (744.0, 914.0, 20.0, 20.0), (724.0, 934.0, 20.0, 20.0)],
                  "center": (734.0, 904.0), "parent": "body"},
    "error":     {"slabs": [(700.0, 850.0, 22.0, 76.0), (700.0, 946.0, 22.0, 22.0)],
                  "center": (711.0, 890.0), "parent": "head"},
    # --- wardrobe: these are what make FREDO feel like a butler
    "hat":       {"slabs": prop_hat(),       "center": (507.0, 58.0),  "parent": "head"},
    "monocle":   {"slabs": prop_monocle(),   "center": (657.0, 518.0), "parent": "head"},
    "glasses":   {"slabs": prop_glasses(),   "center": (507.0, 518.0), "parent": "head"},
    "steam":     {"slabs": prop_steam(),     "center": (726.0, 76.0),  "parent": "head"},
    "burst":     {"slabs": prop_burst(),     "center": (507.0, 880.0), "parent": "root"},
    "flash":     {"slabs": [(487.0, 860.0, 40.0, 40.0),
                            (467.0, 872.0, 20.0, 16.0), (527.0, 872.0, 20.0, 16.0),
                            (499.0, 840.0, 16.0, 20.0), (499.0, 900.0, 16.0, 20.0)],
                  "center": (507.0, 880.0), "parent": "root"},
}


# ---- spark particles: one bone each, so they can scatter independently -------
PARTICLE_NAMES = [f"p{i:02d}" for i in range(14)]
for _i, _nm in enumerate(PARTICLE_NAMES):
    _a = 2 * math.pi * _i / len(PARTICLE_NAMES)
    _px = 507.0 + 72.0 * math.cos(_a)
    _py = 880.0 + 72.0 * math.sin(_a)
    _sz = 18.0
    PROPS[_nm] = {
        "slabs": [(_px - _sz / 2, _py - _sz / 2, _sz, _sz)],
        "center": (_px, _py),
        "parent": "root",
        "dir": (math.cos(_a), math.sin(_a)),
    }

# Petite moustache whose tips point DOWN, tiled so no blocks overlap.
PARTS["mustache"] = [(433.0, 652.0, 24.0, 14.0), (457.0, 643.0, 30.0, 15.0),
                     (487.0, 634.0, 40.0, 16.0),
                     (527.0, 643.0, 30.0, 15.0), (557.0, 652.0, 24.0, 14.0)]

# ---------------------------------------------------------------- scene reset
def purge(name):
    old = bpy.data.collections.get(name)
    if old:
        for obj in list(old.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(old)


for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
purge("FREDO")
for act in list(bpy.data.actions):
    bpy.data.actions.remove(act)
# materials survive object deletion and get suffixed (.001) on rebuild, which
# silently breaks name-based lookups (e.g. the preview tint).
for mat in list(bpy.data.materials):
    if mat.name.lower().startswith("fredo"):
        bpy.data.materials.remove(mat)

coll = bpy.data.collections.new("FREDO")
bpy.context.scene.collection.children.link(coll)
sc = bpy.context.scene
sc.unit_settings.system = 'METRIC'
sc.unit_settings.scale_length = 1.0
sc.render.fps = FPS


WHITE = (1.0, 1.0, 1.0)


def make_material(name, color, emit, strength=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = 0.3
    if "Metallic" in b.inputs:
        b.inputs["Metallic"].default_value = 0.05
    b.inputs["Emission Color"].default_value = (*emit, 1.0)
    b.inputs["Emission Strength"].default_value = strength
    mat.diffuse_color = (*emit, 1.0)
    return mat


# Palette: each object group gets its OWN material, so accessories are not
# forced to Fredo's colour. Body/accent ship neutral so a runtime can tint them;
# wardrobe/effects carry their own intended colour out of the box.
#
# The third column is BOTH the legacy tint multiplier and the emission strength.
# Armour must be lit, not self-illuminated: a surface that emits its own colour
# has no shading gradient, which is precisely what makes CG read as a toy. So
# every doom-only material ships with emission ~0 and relies on the PBR pairs in
# FINISH. Only things that are supposed to glow keep a strength.
PALETTE = [
    ("fredo_body",   (1.000, 1.000, 1.000), 1.00),   # runtime-tinted
    ("fredo_accent", (1.000, 1.000, 1.000), 1.00),   # runtime-tinted
    ("fredo_limb",   (1.000, 1.000, 1.000), 1.00),   # arms + legs (skin in doom)
    ("fredo_boot",   (1.000, 1.000, 1.000), 1.00),   # feet (leather in doom)
    ("fredo_hat",    (0.160, 0.200, 0.270), 0.90),   # bowler
    ("fredo_hair",   (0.620, 0.660, 0.700), 0.95),   # grey moustache
    ("fredo_metal",  (0.850, 0.660, 0.220), 1.10),   # monocle / glasses
    ("fredo_fx",     (0.450, 0.950, 1.000), 1.20),   # steam, burst, sparks
    ("fredo_doom",   (0.330, 0.560, 0.100), 0.03),   # green armour plates
    ("fredo_helm",   (0.330, 0.370, 0.430), 0.03),   # slate helmet / knees
    ("fredo_visor",  (0.140, 0.640, 0.240), 0.14),   # green visor glass (glows)
    ("fredo_trim",   (0.105, 0.120, 0.135), 0.03),   # gunmetal hardware
    ("fredo_glove",  (0.048, 0.050, 0.060), 0.02),   # black leather / under-suit
    ("fredo_skin",   (0.780, 0.548, 0.404), 0.02),   # bare arms in doom mode
    ("fredo_lava",   (0.560, 0.075, 0.015), 0.90),   # lava chunks
    ("fredo_wood",   (0.300, 0.180, 0.100), 0.02),   # shotgun furniture
    ("fredo_brass",  (0.620, 0.450, 0.120), 0.03),   # machine-gun drum
]

MATERIALS = {name: make_material(name, col, col, strength) for name, col, strength in PALETTE}
MAT_ORDER = [name for name, _, _ in PALETTE]
MAT_INDEX = {name: i for i, name in enumerate(MAT_ORDER)}

# Physically-based finish per material: (metalness, roughness).
# Armour reads as painted/anodised metal rather than flat cartoon colour:
# a painted plate is a dielectric coat over metal, so metalness stays mid-range
# and the roughness does the work. Bare hardware and glass go their own way.
FINISH = {
    "fredo_helm":  (0.32, 0.46),   # painted slate armour
    "fredo_doom":  (0.30, 0.48),   # painted green plate
    "fredo_visor": (0.10, 0.09),   # glossy glass
    "fredo_trim":  (0.85, 0.32),   # bare gunmetal hardware
    "fredo_glove": (0.02, 0.66),   # black leather / rubber
    "fredo_skin":  (0.00, 0.54),   # bare arms
    "fredo_lava":  (0.00, 0.70),   # magma
    "fredo_metal": (0.90, 0.35),   # brass monocle / glasses
    "fredo_wood":  (0.00, 0.72),   # shotgun furniture
    "fredo_brass": (0.90, 0.30),   # machine-gun drum
    "fredo_boot":  (0.70, 0.40),
}
for _n, (_m, _r) in FINISH.items():
    _mat = MATERIALS.get(_n)
    if _mat:
        _b = _mat.node_tree.nodes["Principled BSDF"]
        if "Metallic" in _b.inputs:
            _b.inputs["Metallic"].default_value = _m
        _b.inputs["Roughness"].default_value = _r
PREVIEW_TINT = CYAN

mat_cyan = MATERIALS["fredo_body"]
mat_bright = MATERIALS["fredo_accent"]

# ---------------------------------------------------------------- armature
arm_data = bpy.data.armatures.new("FREDO_Armature")
arm = bpy.data.objects.new("FREDO_Rig", arm_data)
coll.objects.link(arm)
arm.show_in_front = True

bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
BONE_LEN = 0.12
all_bones = dict(PARENT)
for prop_name, spec in PROPS.items():
    all_bones[f"prop_{prop_name}"] = spec["parent"]
for extra_name, (centre, parent, _slabs, _mat) in EXTRA_BONES.items():
    all_bones[extra_name] = parent
for extra_name, (centre, parent, _maker, _mat) in EXTRA_PRIMS.items():
    all_bones[extra_name] = parent

for name in all_bones:
    eb = arm_data.edit_bones.new(name)
    if name == "root":
        eb.head, eb.tail = (0, 0, 0), (0, 0, 0.18)
    elif name in EXTRA_PRIMS:
        cx_, cy_ = EXTRA_PRIMS[name][0]
        eb.head = (wx(cx_), 0, wz(cy_))
        eb.tail = (eb.head.x, 0, eb.head.z + 0.05)
    elif name in EXTRA_BONES:
        cx_, cy_ = EXTRA_BONES[name][0]
        eb.head = (wx(cx_), 0, wz(cy_))
        eb.tail = (eb.head.x, 0, eb.head.z + 0.05)
    elif name.startswith("prop_"):
        cx_, cy_ = PROPS[name[len("prop_"):]]["center"]
        eb.head = (wx(cx_), 0, wz(cy_))
        eb.tail = (eb.head.x, 0, eb.head.z + 0.05)
    else:
        px, py = BONE_HEAD_REF[name]
        eb.head = (wx(px), 0, wz(py))
        eb.tail = (eb.head.x, 0, eb.head.z + BONE_LEN)
    eb.roll = 0.0
for name, parent in all_bones.items():
    if parent:
        arm_data.edit_bones[name].parent = arm_data.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')

# ---------------------------------------------------------------- one skinned mesh
def seams(x, y, w, h):
    out = []
    xs, cur = [], x
    while cur < x + w - 0.01:
        nxt = min(cur + 40.0, x + w)
        xs.append((cur, nxt)); cur = nxt
    ys, cur = [], y
    while cur < y + h - 0.01:
        nxt = min(cur + 40.0, y + h)
        ys.append((cur, nxt)); cur = nxt
    for (x0, x1) in xs:
        for (y0, y1) in ys:
            gx = 0.0 if len(xs) == 1 else 2.0
            gy = 0.0 if len(ys) == 1 else 2.0
            out.append((x0, y0, max(0.6, (x1 - x0) - gx), max(0.6, (y1 - y0) - gy)))
    return out


bm_all = bmesh.new()
vert_ranges = {}      # bone -> [(start, end)]
face_ranges = []      # (start, end, material_index)
flat_faces = []       # face ranges that must stay faceted (N64 look)


def add_slabs(bone, slabs, depth, bevel, mat_name, y_offset=0.0):
    bm = bmesh.new()
    for (x, y, w, h) in slabs:
        m = (Matrix.Translation((wx(x + w / 2.0), y_offset, wz(y + h / 2.0)))
             @ Matrix.Diagonal((w / S, depth, h / S, 1.0)))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel,
                        segments=1, profile=0.5, affect='EDGES')
    tmp = bpy.data.meshes.new("tmp_part")
    bm.to_mesh(tmp)
    bm.free()

    v0, f0 = len(bm_all.verts), len(bm_all.faces)
    bm_all.from_mesh(tmp)
    v1, f1 = len(bm_all.verts), len(bm_all.faces)
    bpy.data.meshes.remove(tmp)

    vert_ranges.setdefault(bone, []).append((v0, v1))
    face_ranges.append((f0, f1, MAT_INDEX[mat_name]))


def part_material(name):
    if name == "mustache":
        return "fredo_hair"
    if name in ("arm_l", "arm_r", "leg_l", "leg_r"):
        return "fredo_limb"
    if name in ("foot_l", "foot_r"):
        return "fredo_boot"
    return "fredo_accent" if name.startswith("eye") else "fredo_body"


def prop_material(name):
    if name in ("monocle", "glasses"):
        return "fredo_metal"
    if name in ("steam", "burst", "flash") or (name.startswith("p") and name[1:].isdigit()):
        return "fredo_fx"
    if name == "hat":
        return "fredo_hat"
    return "fredo_body"


def add_prim(bone, maker, mat_name):
    """Append smooth 3D geometry (spheres/rounded boxes) to the shared mesh."""
    bm = bmesh.new()
    maker(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    tmp = bpy.data.meshes.new("tmp_prim")
    bm.to_mesh(tmp)
    bm.free()
    v0, f0 = len(bm_all.verts), len(bm_all.faces)
    bm_all.from_mesh(tmp)
    v1, f1 = len(bm_all.verts), len(bm_all.faces)
    bpy.data.meshes.remove(tmp)
    vert_ranges.setdefault(bone, []).append((v0, v1))
    face_ranges.append((f0, f1, MAT_INDEX[mat_name]))
    if bone not in SMOOTH_BONES:
        flat_faces.append((f0, f1))   # voxel-era faceting for blocky gear


for name, slabs in PARTS.items():
    expanded = []
    for r in slabs:
        expanded.extend(seams(*r))
    add_slabs(name, expanded, 0.036, 0.0018, part_material(name))

for prop_name, spec in PROPS.items():
    expanded = []
    for r in spec["slabs"]:
        expanded.extend(seams(*r))
    add_slabs(f"prop_{prop_name}", expanded, 0.030, 0.0014, prop_material(prop_name), y_offset=-0.014)

# face rig geometry: sits just proud of the face so it never z-fights
for extra_name, (centre, parent, slabs, mat_name) in EXTRA_BONES.items():
    expanded = []
    for r in slabs:
        expanded.extend(seams(*r))
    add_slabs(extra_name, expanded, 0.028, 0.0012, mat_name, y_offset=-0.010)

# smooth 3D gear (doom armour) - same skinned mesh, different construction style
for extra_name, (centre, parent, maker, mat_name) in EXTRA_PRIMS.items():
    add_prim(extra_name, maker, mat_name)

mesh = bpy.data.meshes.new("FREDO_mesh")
bm_all.to_mesh(mesh)
bm_all.free()
mesh.shade_smooth()
# N64-style faceting: 3D gear keeps flat normals so every facet reads
for (f0, f1) in flat_faces:
    for i in range(f0, f1):
        mesh.polygons[i].use_smooth = False
for _name in MAT_ORDER:
    mesh.materials.append(MATERIALS[_name])

for (f0, f1, idx) in face_ranges:
    for f in range(f0, f1):
        mesh.polygons[f].material_index = idx

body = bpy.data.objects.new("FREDO_Body", mesh)
coll.objects.link(body)

for bone, ranges in vert_ranges.items():
    vg = body.vertex_groups.new(name=bone)
    for (v0, v1) in ranges:
        vg.add(list(range(v0, v1)), 1.0, 'REPLACE')

body.parent = arm
mod = body.modifiers.new("Armature", 'ARMATURE')
mod.object = arm
mod.use_vertex_groups = True

# ---------------------------------------------------------------- clips
# EXTRA_PRIMS is part of the toggleable set too: leaving it out left the whole
# Doom kit keyed at scale 1 in every clip, so the armour was permanently on.
VARIANT_BONES = list(EXTRA_BONES.keys()) + list(EXTRA_PRIMS.keys())
HIDE_BONES = [f"prop_{p}" for p in PROPS] + VARIANT_BONES
ANIM_BONES = [b for b in all_bones if b not in HIDE_BONES]
L = 16


def key(bone, frame, rot=None, loc=None, scale=None):
    pb = arm.pose.bones[bone]
    pb.rotation_mode = 'XYZ'
    if rot is not None:
        pb.rotation_euler = tuple(math.radians(a) for a in rot)
        pb.keyframe_insert("rotation_euler", frame=frame)
    if loc is not None:
        pb.location = loc
        pb.keyframe_insert("location", frame=frame)
    if scale is not None:
        pb.scale = scale
        pb.keyframe_insert("scale", frame=frame)


ZERO = (0.001, 0.001, 0.001)


def show_prop(name, frames):
    bone = f"prop_{name}"
    key(bone, 1, scale=ZERO)
    for f in frames:
        key(bone, f, scale=(1, 1, 1))


def show_bone(bone, frames):
    key(bone, 1, scale=ZERO)
    for f in frames:
        key(bone, f, scale=(1, 1, 1))


def eyes(left, right=None):
    """Swap the whole eye shape. Every shape is hidden first, then the chosen
    one is shown - so a state reads as exactly one expression."""
    right = right or left
    for b in ["eye_l", "eye_r"] + [f"eye_{v}_{s}" for v in EYE_VARIANTS for s in ("l", "r")]:
        key(b, 1, scale=ZERO)
        key(b, L, scale=ZERO)
    if left == "none":
        return
    for side, kind in (("l", left), ("r", right)):
        bone = ("eye_" + side) if kind == "open" else f"eye_{kind}_{side}"
        key(bone, 1, scale=(1, 1, 1))
        key(bone, L, scale=(1, 1, 1))


def blink(eye, start):
    key(eye, 1, scale=(1, 1, 1))
    key(eye, start, scale=(1, 1, 1))
    key(eye, start + 1, scale=(1, 0.08, 1))
    key(eye, start + 3, scale=(1, 1, 1))
    key(eye, L, scale=(1, 1, 1))


def build_clips():
    out = {}

    def idle():
        key("root", 1, loc=(0, 0, 0)); key("root", 8, loc=(0, 0, 0.016)); key("root", L, loc=(0, 0, 0))
        key("head", 1, rot=(0, 1.5, 0)); key("head", 8, rot=(0, -1.5, 0)); key("head", L, rot=(0, 1.5, 0))
        blink("eye_l", 6); blink("eye_r", 6)
    out["idle"] = idle

    def talk():
        key("head", 1, rot=(0, 0, 0)); key("head", 4, rot=(3, 2, 0))
        key("head", 9, rot=(-2, -2, 0)); key("head", L, rot=(0, 0, 0))
        key("tie", 1, rot=(0, 0, 0)); key("tie", 5, rot=(4, 0, 0)); key("tie", L, rot=(0, 0, 0))
        blink("eye_l", 11); blink("eye_r", 11)
    out["talk"] = talk

    def happy():
        eyes("arc")
        for f, dz, sq in ((1, 0, 1.0), (4, 0.055, 1.06), (8, 0, 1.0), (12, 0.045, 1.05), (L, 0, 1.0)):
            key("root", f, loc=(0, 0, dz), scale=(sq, 1, 2 - sq))
        key("head", 1, rot=(0, 3, 0)); key("head", 8, rot=(0, -3, 0)); key("head", L, rot=(0, 3, 0))
    out["happy"] = happy

    def thinking():
        key("head", 1, rot=(-2, -6, 0)); key("head", 10, rot=(-2, -3, 0)); key("head", L, rot=(-2, -6, 0))
        key("root", 1, loc=(0, 0, 0)); key("root", 8, loc=(0, 0, 0.01)); key("root", L, loc=(0, 0, 0))
        show_prop("thinking", (2, L))
        show_prop("monocle", (2, L))
    out["thinking"] = thinking

    def analyzing():
        key("head", 1, rot=(0, -4, 4)); key("head", 8, rot=(0, -4, 1)); key("head", L, rot=(0, -4, 4))
        show_prop("analyzing", (2, L))
        show_prop("monocle", (2, L))
    out["analyzing"] = analyzing

    def planning():
        key("head", 1, rot=(5, 0, 0)); key("head", 8, rot=(1, 0, 0)); key("head", L, rot=(5, 0, 0))
        show_prop("planning", (2, L))
        show_prop("glasses", (2, L))
    out["planning"] = planning

    def working():
        key("arm_l", 1, rot=(0, 7, 0)); key("arm_l", 8, rot=(0, -7, 0)); key("arm_l", L, rot=(0, 7, 0))
        key("arm_r", 1, rot=(0, -7, 0)); key("arm_r", 8, rot=(0, 7, 0)); key("arm_r", L, rot=(0, -7, 0))
        key("head", 1, rot=(4, 0, 0)); key("head", L, rot=(4, 0, 0))
        show_prop("working", (2, L))
        show_prop("glasses", (2, L))
    out["working"] = working

    def complete():
        key("root", 1, loc=(0, 0, 0)); key("root", 5, loc=(0, 0, 0.07))
        key("root", 10, loc=(0, 0, 0.01)); key("root", L, loc=(0, 0, 0))
        key("head", 1, rot=(0, 2, 0)); key("head", 8, rot=(0, -2, 0)); key("head", L, rot=(0, 2, 0))
        show_prop("complete", (3, L))
        show_prop("hat", (3, L))
    out["complete"] = complete

    def greeting():
        key("head", 1, rot=(0, 0, 0)); key("head", 3, rot=(-13, 0, 0))
        key("head", 7, rot=(3, 0, 0)); key("head", L, rot=(0, 0, 0))
        key("tie", 1, rot=(0, 0, 0)); key("tie", 5, rot=(6, 0, 0)); key("tie", L, rot=(0, 0, 0))
        show_prop("hat", (2, L))
        for f, r in ((1, 0), (3, -5), (9, 2), (L, 0)):
            key("prop_hat", f, rot=(0, r, 0))
    out["greeting"] = greeting

    def listening():
        key("head", 1, rot=(-6, 5, 0)); key("head", 8, rot=(-7, 3, 0)); key("head", L, rot=(-6, 5, 0))
        blink("eye_l", 4); blink("eye_r", 4)
    out["listening"] = listening

    def playful():
        key("root", 1, rot=(0, 0, 0)); key("root", 4, rot=(0, 4, 0))
        key("root", 12, rot=(0, -4, 0)); key("root", L, rot=(0, 0, 0))
        key("head", 1, rot=(0, 0, 3)); key("head", 8, rot=(0, 0, -3)); key("head", L, rot=(0, 0, 3))
    out["playful"] = playful

    def joking():
        key("arm_l", 1, rot=(0, 0, 0)); key("arm_l", 5, rot=(0, 14, 0)); key("arm_l", L, rot=(0, 0, 0))
        key("arm_r", 1, rot=(0, 0, 0)); key("arm_r", 5, rot=(0, -14, 0)); key("arm_r", L, rot=(0, 0, 0))
        key("head", 1, rot=(0, 0, 0)); key("head", 5, rot=(-4, 0, 0)); key("head", L, rot=(0, 0, 0))
    out["joking"] = joking

    def error():
        key("root", 1, loc=(0, 0, 0)); key("root", 3, loc=(0, 0, -0.02)); key("root", 8, loc=(0, 0, 0))
        key("head", 1, rot=(0, 0, 0)); key("head", 3, rot=(6, 0, -4))
        key("head", 9, rot=(-2, 0, 2)); key("head", L, rot=(0, 0, 0))
        show_prop("error", (2, L))
    out["error"] = error

    # Dissolve order: extremities first, then the trunk, so the figure
    # "unbuilds" from the outside in. Arrival runs it backwards.
    DISSOLVE = ["foot_l", "foot_r", "leg_l", "leg_r", "eye_l", "eye_r",
                "head", "arm_l", "arm_r", "tie", "body"]
    STEP = 0.8
    ZERO = (0.001, 0.001, 0.001)

    def teleport_out():
        # 1-5  anticipation: crouch, then a push-off as the body lifts
        key("root", 1, loc=(0, 0, 0.0), scale=(1, 1, 1))
        key("root", 3, loc=(0, 0, -0.045), scale=(1.07, 1, 0.89))
        key("root", 5, loc=(0, 0, 0.07), scale=(0.95, 1, 1.09))
        key("root", 9, loc=(0, 0, 0.13), scale=(1, 1, 1))
        key("root", L, loc=(0, 0, 0.17), scale=(1, 1, 1))
        # eyes widen for a beat, head tips up as it goes
        for e in ("eye_l", "eye_r"):
            key(e, 4, scale=(1.35, 1, 1.25))
            key(e, 7, scale=(1, 1, 1))
        key("head", 5, rot=(-11, 0, 0))
        # staggered dissolve with a small pop before each part vanishes
        for i, bone in enumerate(DISSOLVE):
            f = 6 + i * STEP
            key(bone, 1, scale=(1, 1, 1))
            key(bone, f, scale=(1.16, 1.16, 1.16))
            key(bone, f + 2, scale=ZERO)
            key(bone, L, scale=ZERO)
        # energy ring expands outward
        key("prop_burst", 1, scale=ZERO)
        key("prop_burst", 4, scale=(0.25, 0.25, 0.25))
        key("prop_burst", 10, scale=(1.45, 1.45, 1.45))
        key("prop_burst", 13, scale=ZERO)
        key("prop_burst", L, scale=ZERO)
    out["teleport-out"] = teleport_out

    def teleport_in():
        # arrives from above and settles into the landing
        key("root", 1, loc=(0, 0, 0.17), scale=(1, 1, 1))
        key("root", 9, loc=(0, 0, 0.05), scale=(1, 1, 1))
        key("root", 12, loc=(0, 0, -0.02), scale=(1.06, 1, 0.94))
        key("root", L, loc=(0, 0, 0), scale=(1, 1, 1))
        # parts snap in one after another with an overshoot
        for i, bone in enumerate(reversed(DISSOLVE)):
            f = 1 + i * STEP
            key(bone, 1, scale=ZERO)
            key(bone, f, scale=ZERO)
            key(bone, f + 2.5, scale=(1.18, 1.18, 1.18))
            key(bone, f + 4.5, scale=(1, 1, 1))
            key(bone, L, scale=(1, 1, 1))
        key("head", 2, rot=(-9, 0, 0))
        key("head", 11, rot=(2, 0, 0))
        key("head", L, rot=(0, 0, 0))
        # ring contracts to nothing
        key("prop_burst", 1, scale=(1.55, 1.55, 1.55))
        key("prop_burst", 6, scale=(0.85, 0.85, 0.85))
        key("prop_burst", 9, scale=ZERO)
        key("prop_burst", L, scale=ZERO)
    out["teleport-in"] = teleport_in

    # ---- funny: double-take, wink, hat tip
    def funny():
        for f, r in ((1, (0, 0, 0)), (3, (-15, 0, 0)), (5, (7, 0, 0)),
                     (7, (-6, 0, 0)), (L, (0, 0, 0))):
            key("head", f, rot=r)
        key("eye_r", 1, scale=(1, 1, 1)); key("eye_r", 8, scale=(1, 1, 1))
        key("eye_r", 9, scale=(1, 0.08, 1)); key("eye_r", 13, scale=(1, 1, 1))
        key("eye_r", L, scale=(1, 1, 1))
        for f, dz in ((1, 0), (10, 0.06), (14, 0), (L, 0)):
            key("root", f, loc=(0, 0, dz))
        show_prop("hat", (2, L))
        show_prop("monocle", (2, L))
        for f, r in ((1, 0), (8, -9), (13, 3), (L, 0)):
            key("prop_hat", f, rot=(0, r, 0))
    out["funny"] = funny

    # ---- angry: fast head shake, steam puff, arms up
    def angry():
        eyes("chev")
        for f, r in ((1, (0, 0, 0)), (2, (0, 7, 0)), (4, (0, -7, 0)),
                     (6, (0, 6, 0)), (8, (0, -4, 0)), (11, (2, 2, 0)), (L, (0, 0, 0))):
            key("head", f, rot=r)
        for f, dz in ((1, 0), (3, -0.022), (6, 0.01), (L, 0)):
            key("root", f, loc=(0, 0, dz))
        key("arm_l", 1, rot=(0, 0, 0)); key("arm_l", 4, rot=(0, 17, 0)); key("arm_l", L, rot=(0, 0, 0))
        key("arm_r", 1, rot=(0, 0, 0)); key("arm_r", 4, rot=(0, -17, 0)); key("arm_r", L, rot=(0, 0, 0))
        for f, s in ((1, 0.001), (2, 1.0), (6, 0.55), (9, 1.0), (13, 0.001), (L, 0.001)):
            key("prop_steam", f, scale=(s, s, s))
        show_prop("hat", (2, L))
    out["angry"] = angry

    # ---- uwu: closed smiling eyes, gentle sway
    def uwu():
        eyes("arc")
        key("head", 1, rot=(0, -4, 0))
        key("head", 8, rot=(0, 4, 0))
        key("head", L, rot=(0, -4, 0))
        key("root", 1, loc=(0, 0, 0))
        key("root", 5, loc=(0, 0, 0.03))
        key("root", L, loc=(0, 0, 0))
    out["uwu"] = uwu

    # ---- confused: one wide 'o', one lid -> o_0
    def confused():
        eyes("round", "lid")
        key("head", 1, rot=(0, -7, -6))
        key("head", 9, rot=(0, -7, 6))
        key("head", L, rot=(0, -7, -6))
    out["confused"] = confused

    # ---- skeptical: half-lidded side-eye
    def skeptical():
        eyes("lid")
        key("head", 1, rot=(2, 5, 0))
        key("head", 10, rot=(2, -5, 0))
        key("head", L, rot=(2, 5, 0))
    out["skeptical"] = skeptical

    # ---- silly: ':v' mouth and a wobble
    def silly():
        eyes("open")
        # swap the resting smile for the ':v'
        key("mouth_smile", 1, scale=ZERO)
        key("mouth_smile", L, scale=ZERO)
        show_bone("mouth_v", (1, L))
        key("head", 1, rot=(0, 0, -6))
        key("head", 6, rot=(0, 0, 6))
        key("head", 12, rot=(0, 0, -4))
        key("head", L, rot=(0, 0, 0))
        key("root", 1, loc=(0, 0, 0))
        key("root", 6, loc=(0, 0, 0.025))
        key("root", L, loc=(0, 0, 0))
    out["silly"] = silly

    # ---- squint: squeezed '><' , laughing hard
    def squint():
        eyes("chev")
        key("head", 1, rot=(-4, 0, 0))
        key("head", 5, rot=(2, 0, 0))
        key("head", 9, rot=(-4, 0, 0))
        key("head", L, rot=(0, 0, 0))
        key("root", 1, loc=(0, 0, 0))
        key("root", 5, loc=(0, 0, 0.035))
        key("root", L, loc=(0, 0, 0))
    out["squint"] = squint

    # ---- emotion states: face-led, small body beat -------------------------
    def love():
        eyes("heart")
        key("head", 1, rot=(0, -3, 0))
        key("head", 8, rot=(0, 3, 0))
        key("head", L, rot=(0, -3, 0))
        key("root", 1, loc=(0, 0, 0))
        key("root", 5, loc=(0, 0, 0.04))
        key("root", L, loc=(0, 0, 0))
    out["love"] = love

    def sad():
        eyes("sad")
        key("head", 1, rot=(6, 0, 0))
        key("head", 8, rot=(8, 0, 0))
        key("head", L, rot=(6, 0, 0))
        key("root", 1, loc=(0, 0, 0))
        key("root", 8, loc=(0, 0, -0.02))
        key("root", L, loc=(0, 0, 0))
    out["sad"] = sad

    def surprised():
        eyes("round")
        key("head", 1, rot=(0, 0, 0))
        key("head", 3, rot=(-10, 0, 0))
        key("head", 9, rot=(-6, 0, 0))
        key("head", L, rot=(0, 0, 0))
        key("root", 1, loc=(0, 0, 0))
        key("root", 3, loc=(0, 0, 0.05))
        key("root", L, loc=(0, 0, 0))
    out["surprised"] = surprised

    def sleepy():
        eyes("lid")
        key("head", 1, rot=(8, 0, -2))
        key("head", 9, rot=(10, 0, 2))
        key("head", L, rot=(8, 0, -2))
        key("root", 1, loc=(0, 0, 0))
        key("root", 8, loc=(0, 0, -0.015))
        key("root", L, loc=(0, 0, 0))
    out["sleepy"] = sleepy

    # ---- secret doom mode ------------------------------------------------
    def face_off():
        eyes("none")
        key("mouth_smile", 1, scale=ZERO)
        key("mouth_smile", L, scale=ZERO)

    def _embers():
        for i, nm in enumerate(PARTICLE_NAMES):
            dx, dz = PROPS[nm]["dir"]
            f0 = 1 + (i % 7) * 0.7
            key(f"prop_{nm}", 1, scale=ZERO, loc=(dx * 0.04, -0.04, 0))
            key(f"prop_{nm}", f0, scale=ZERO, loc=(dx * 0.04, -0.04, 0))
            key(f"prop_{nm}", f0 + 1.0, scale=(0.75, 0.75, 0.75), loc=(dx * 0.05, 0.0, 0))
            key(f"prop_{nm}", L, scale=ZERO, loc=(dx * 0.09, 0.22, 0))

    def _doom_gear(*weapons):
        for b in DOOM_KIT + weapons:
            show_bone(b, (1, L))
        # held-weapon pose: swing the arms forward so the hands meet the weapon
        key("arm_l", 1, rot=(-62, 0, -14))
        key("arm_l", L, rot=(-62, 0, -14))
        key("arm_r", 1, rot=(-62, 0, 14))
        key("arm_r", L, rot=(-62, 0, 14))

    def _doom_body():
        key("head", 1, rot=(2, 2, 0))
        key("head", 8, rot=(2, -2, 0))
        key("head", L, rot=(2, 2, 0))
        key("root", 1, loc=(0, 0, 0))
        key("root", 8, loc=(0, 0, 0.02))
        key("root", L, loc=(0, 0, 0))
        _embers()

    def doom_in():
        face_off()
        for f, ry in ((1, 0), (2, 9), (4, -9), (6, 7), (8, -5), (10, 3), (L, 0)):
            key("head", f, rot=(-4, ry, 0))
        # the kit snaps on feet-first; 16 pieces into the last 8 frames
        for i, nm in enumerate(DOOM_KIT + ("shotgun",)):
            f0 = 4.0 + i * 0.5
            key(nm, 1, scale=ZERO)
            key(nm, f0, scale=ZERO)
            key(nm, f0 + 1.5, scale=(1.35, 1.35, 1.35))
            key(nm, f0 + 3.5, scale=(1, 1, 1))
            key(nm, L, scale=(1, 1, 1))
        key("root", 1, loc=(0, 0, 0), scale=(1, 1, 1))
        key("root", 3, loc=(0, 0, -0.03), scale=(1.08, 1, 0.92))
        key("root", 7, loc=(0, 0, 0.05), scale=(0.95, 1, 1.08))
        key("root", L, loc=(0, 0, 0), scale=(1, 1, 1))
        _embers()
    out["doom-in"] = doom_in

    def doom_idle():
        face_off()
        _doom_gear("shotgun", "shotgun_wood")
        _doom_body()
    out["doom-idle"] = doom_idle

    def doom_sword():
        face_off()
        _doom_gear("sword_hilt", "sword_blade")
        _doom_body()
    out["doom-sword"] = doom_sword

    def doom_mg():
        face_off()
        _doom_gear("mg", "mg_drum")
        _doom_body()
    out["doom-mg"] = doom_mg

    def doom_shoot():
        face_off()
        _doom_gear("shotgun", "shotgun_wood")
        key("head", 1, rot=(2, 0, 0))
        key("head", 8, rot=(2, 0, 0))
        key("head", L, rot=(2, 0, 0))
        # three shots: recoil kick + muzzle flash
        for f in (2.0, 6.0, 10.0):
            key("muzzle", 1, scale=ZERO)
            key("muzzle", f, scale=ZERO)
            key("muzzle", f + 0.5, scale=(1.3, 1.3, 1.3))
            key("muzzle", f + 2.0, scale=ZERO)
            key("muzzle", L, scale=ZERO)
            key("root", f, loc=(0, 0, 0))
            key("root", f + 0.5, loc=(0.028, 0, -0.008), scale=(0.97, 1, 1.03))
            key("root", f + 2.0, loc=(0, 0, 0), scale=(1, 1, 1))
        key("root", 1, loc=(0, 0, 0), scale=(1, 1, 1))
        key("root", L, loc=(0, 0, 0), scale=(1, 1, 1))
        _embers()
    out["doom-shoot"] = doom_shoot

    def doom_out():
        face_off()
        for nm in ("shotgun", "mg", "sword_hilt", "sword_blade", "muzzle") + DOOM_KIT[::-1]:
            key(nm, 1, scale=(1, 1, 1))
            key(nm, 7, scale=(0.001, 0.001, 0.001))
            key(nm, L, scale=ZERO)
        for f, ry in ((1, 0), (2, 8), (4, -8), (6, 5), (L, 0)):
            key("head", f, rot=(0, ry, 0))
        key("root", 1, loc=(0, 0, 0))
        key("root", 3, loc=(0, 0, 0.04))
        key("root", L, loc=(0, 0, 0))
    out["doom-out"] = doom_out

    return out


arm.animation_data_create()
arm.animation_data.action = None
clips = build_clips()

PROP_BONES = HIDE_BONES
for name, builder in clips.items():
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    # Normalise first: every clip keys EVERY animated bone at its rest pose, so
    # no channel can leak in from whichever clip played before it (glTF only
    # writes keyed properties - an untouched channel would hold a stale pose).
    for bone in ANIM_BONES:
        for f in (1, L):
            key(bone, f, rot=(0, 0, 0), loc=(0, 0, 0), scale=(1, 1, 1))
    # every prop starts hidden in every clip; the builder reveals what it needs
    for pb_name in PROP_BONES:
        key(pb_name, 1, scale=(0.001, 0.001, 0.001))
        key(pb_name, L, scale=(0.001, 0.001, 0.001))
    builder()
    # only cheerful states wear the smirk; idle and the working states stay bare
    if name in {"happy", "uwu", "love", "complete", "greeting", "funny"}:
        show_bone("mouth_smile", (1, L))
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.name = name
    track.mute = True
    arm.animation_data.action = None

bpy.context.view_layer.update()

# ---------------------------------------------------------------- camera / lights
cam_data = bpy.data.cameras.new("FREDO_cam")
cam_data.type = 'ORTHO'
cam_data.ortho_scale = TARGET_HEIGHT_M / 0.76   # extra headroom for the hat
cam = bpy.data.objects.new("FREDO_Camera", cam_data)
coll.objects.link(cam)
cam.location = (0.0, -6.0, TARGET_HEIGHT_M * 0.5)
cam.rotation_euler = (math.radians(90), 0, 0)
sc.camera = cam


def area_light(name, loc, energy, size, color):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy = energy
    ld.size = size
    ld.color = color
    ld.use_shadow = False
    lo = bpy.data.objects.new(name, ld)
    coll.objects.link(lo)
    lo.location = loc
    lo.rotation_euler = (Vector((0, 0, 0.9)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()


# Three-point rig for a 1.8 m character a couple of metres away. The armour is
# physically based (metalness 0.45-0.85), so it needs real specular sources and
# something in the world to reflect - a near-black world turned every metal
# surface into a dark silhouette in the first pass.
area_light("key", (-1.5, -1.9, 1.55), 42, 1.1, (1.0, 0.96, 0.90))
area_light("rim", (1.9, 0.9, 1.10), 26, 1.0, (0.62, 0.86, 1.0))
area_light("fill", (0.4, -2.4, -0.9), 9, 1.8, (0.66, 0.84, 1.0))
area_light("kick", (-1.9, 1.5, 0.35), 12, 0.9, (0.55, 0.80, 1.0))

world = bpy.data.worlds.new("FREDO_world")
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.030, 0.042, 0.062, 1.0)
bg.inputs["Strength"].default_value = 1.0
sc.world = world

sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = 512
sc.render.resolution_y = 640
sc.render.film_transparent = True
try:
    sc.eevee.taa_render_samples = 24
except Exception:
    pass

comp = bpy.data.node_groups.new("FREDO_compositor", "CompositorNodeTree")
comp.interface.new_socket(name="Image", in_out='OUTPUT', socket_type='NodeSocketColor')
rl = comp.nodes.new("CompositorNodeRLayers")
glare = comp.nodes.new("CompositorNodeGlare")
grout = comp.nodes.new("NodeGroupOutput")
for candidate in ("Bloom", "Fog Glow"):
    try:
        glare.inputs["Type"].default_value = candidate
        break
    except Exception:
        continue
glare.inputs["Threshold"].default_value = 0.85
glare.inputs["Strength"].default_value = 0.3
glare.inputs["Size"].default_value = 0.22
glare.inputs["Saturation"].default_value = 1.3
comp.links.new(rl.outputs["Image"], glare.inputs["Image"])
comp.links.new(glare.outputs["Image"], grout.inputs["Image"])
sc.compositing_node_group = comp
sc.render.use_compositing = True

bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT)

# ---------------------------------------------------------------- export
bpy.ops.object.select_all(action='DESELECT')
arm.select_set(True)
body.select_set(True)
bpy.context.view_layer.objects.active = arm

export_err = None
try:
    bpy.ops.export_scene.gltf(
        filepath=GLB_OUT, export_format='GLB', use_selection=True,
        export_animations=True, export_animation_mode='ACTIONS',
        export_apply=True, export_yup=True, export_skins=True,
    )
except Exception as e:
    export_err = f"{type(e).__name__}: {e}"

mesh.calc_loop_triangles()
result = {
    "units": "1 unit = 1 m, origin at ground",
    "height_m": TARGET_HEIGHT_M,
    "bones": len(all_bones),
    "verts": len(mesh.vertices),
    "tris": len(mesh.loop_triangles),
    "materials": len(mesh.materials),
    "vertex_groups": len(body.vertex_groups),
    "clips": sorted(clips.keys()),
    "clip_count": len(clips),
    "glb": GLB_OUT if export_err is None else f"FAILED: {export_err}",
    "glb_bytes": os.path.getsize(GLB_OUT) if export_err is None else 0,
    "blend": BLEND_OUT,
}
