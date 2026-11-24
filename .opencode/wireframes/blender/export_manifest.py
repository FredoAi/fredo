"""Emit a runtime manifest for fredo-character.glb by reading the GLB itself,
so the contract can never drift from the asset."""
import json
import struct
import sys
import os

BASE = os.path.dirname(os.path.abspath(__file__))
GLB = os.path.join(BASE, "fredo-character.glb")
OUT = os.path.join(BASE, "fredo-character.manifest.json")

NON_LOOPING = {"teleport-out", "teleport-in", "doom-in", "doom-out"}
PROPS_BY_CLIP = {
    "thinking":     ["thinking", "monocle"],
    "analyzing":    ["analyzing", "monocle"],
    "planning":     ["planning", "glasses"],
    "working":      ["working", "glasses"],
    "complete":     ["complete", "hat"],
    "error":        ["error"],
    "greeting":     ["hat"],
    "funny":        ["hat", "monocle"],
    "angry":        ["steam", "hat"],
    "teleport-out": ["burst"],
    "teleport-in":  ["burst"],
}

with open(GLB, "rb") as f:
    data = f.read()

offset = 12
gltf = None
while offset < len(data):
    clen, ctype = struct.unpack_from("<II", data, offset)
    chunk = data[offset + 8: offset + 8 + clen]
    if ctype == 0x4E4F534A:
        gltf = json.loads(chunk.decode("utf-8"))
    offset += 8 + clen + ((4 - clen % 4) % 4)

acc = gltf["accessors"]
nodes = gltf["nodes"]

clips = []
for anim in sorted(gltf.get("animations", []), key=lambda a: a["name"]):
    dur = 0.0
    for s in anim["samplers"]:
        a = acc[s["input"]]
        if a.get("max"):
            dur = max(dur, float(a["max"][0]))
    name = anim["name"]
    clips.append({
        "name": name,
        "duration": round(dur, 3),
        "loop": name not in NON_LOOPING,
        "prop": PROPS_BY_CLIP.get(name, []),
    })

# Every joint of the skin, not a hand-maintained subset: the skeleton is the
# authority on how many bones the asset has, so this cannot drift again.
joints = gltf.get("skins", [{}])[0].get("joints", [])
bones = [nodes[i].get("name") for i in joints if i < len(nodes)]

tris = 0
for mesh in gltf["meshes"]:
    for prim in mesh["primitives"]:
        if "indices" in prim:
            tris += acc[prim["indices"]]["count"] // 3

manifest = {
    "asset": "fredo-character",
    "version": 1,
    "generator": gltf["asset"].get("generator"),
    "file": os.path.basename(GLB),
    "bytes": os.path.getsize(GLB),
    "units": "metres",
    "height": 1.8,
    "origin": "ground, between the feet (the figure faces -Y in Blender)",
    "forward": "+Z after glTF Y-up conversion (-Y in Blender)",
    "triangles": tris,
    "meshes": len(gltf["meshes"]),
    "skins": len(gltf.get("skins", [])),
    "materials": [m["name"] for m in gltf["materials"]],
    "bones": bones,
    "clips": clips,
}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)

print(f"wrote {OUT}")
print(f"clips: {len(clips)}  bones: {len(bones)}  materials: {len(manifest['materials'])}")
for c in clips:
    tag = "loop" if c["loop"] else "once"
    prop = f"  props={','.join(c['prop'])}" if c["prop"] else ""
    print(f"  {c['name']:14s} {c['duration']:.2f}s  {tag}{prop}")
