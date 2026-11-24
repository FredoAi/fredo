"""Inspect a .glb without any dependencies - parse the container and summarise
what a web runtime (three.js / Babylon / R3F) will actually receive."""
import json
import struct
import sys

path = sys.argv[1] if len(sys.argv) > 1 else \
    "C:/Code/fredo/.opencode/wireframes/blender/fredo-character.glb"

with open(path, "rb") as f:
    data = f.read()

magic, version, length = struct.unpack_from("<III", data, 0)
assert magic == 0x46546C67, "not a GLB"

offset = 12
gltf = None
bin_len = 0
while offset < length:
    clen, ctype = struct.unpack_from("<II", data, offset)
    chunk = data[offset + 8: offset + 8 + clen]
    if ctype == 0x4E4F534A:
        gltf = json.loads(chunk.decode("utf-8"))
    elif ctype == 0x004E4942:
        bin_len = clen
    offset += 8 + clen + ((4 - clen % 4) % 4) * 0

acc = gltf.get("accessors", [])


def anim_duration(anim):
    dur = 0.0
    for s in anim.get("samplers", []):
        a = acc[s["input"]]
        if "max" in a and a["max"]:
            dur = max(dur, float(a["max"][0]))
    return dur


print(f"file            {path.split('/')[-1]}  ({len(data):,} bytes, bin chunk {bin_len:,})")
print(f"glTF version    {version}  generator={gltf.get('asset', {}).get('generator')}")
print(f"extensions      {gltf.get('extensionsUsed', [])}")
print(f"nodes           {len(gltf.get('nodes', []))}")
print(f"meshes          {len(gltf.get('meshes', []))}")
print(f"materials       {len(gltf.get('materials', []))}")
print(f"skins           {len(gltf.get('skins', []))}")
print(f"cameras         {len(gltf.get('cameras', []))}   (should be 0)")

# material detail
print("\nmaterials:")
for m in gltf.get("materials", []):
    pbr = m.get("pbrMetallicRoughness", {})
    emissive = m.get("emissiveFactor", [0, 0, 0])
    strength = m.get("extensions", {}).get("KHR_materials_emissive_strength", {}).get(
        "emissiveStrength")
    print(f"  {m.get('name'):22s} base={pbr.get('baseColorFactor')}  "
          f"emissive={[round(v, 3) for v in emissive]}  strength={strength}")

# node tree: are the parts children of bone nodes?
names = [n.get("name", "?") for n in gltf.get("nodes", [])]
bone_like = [n for n in names if n in (
    "root", "body", "head", "eye_l", "eye_r", "tie", "arm_l", "arm_r",
    "leg_l", "leg_r", "foot_l", "foot_r")]
print(f"\nbone nodes      {len(bone_like)} -> {sorted(bone_like)}")

mesh_nodes = [n for n in gltf.get("nodes", []) if "mesh" in n]
print(f"mesh nodes      {len(mesh_nodes)}")
orphans = [n.get("name") for n in mesh_nodes if "skin" not in n]
print(f"  unskinned     {len(orphans)}")

print(f"\nanimations      {len(gltf.get('animations', []))}")
for a in gltf.get("animations", []):
    chans = len(a.get("channels", []))
    dur = anim_duration(a)
    paths = sorted({c["target"]["path"] for c in a.get("channels", [])})
    targets = len({c["target"]["node"] for c in a.get("channels", [])})
    print(f"  {a.get('name'):14s} {dur:5.2f}s  channels={chans:3d}  nodes={targets:3d}  paths={paths}")
