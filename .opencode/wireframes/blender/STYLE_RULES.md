# FREDO avatar — art direction & asset rules

The rules the companion avatar is built by. They exist so that many people can
add states, outfits and props over time without the character drifting into an
inconsistent pile of assets.

Companion to [`ASSET.md`](./ASSET.md), which is the technical handoff contract
(units, origin, clip table, regeneration commands).

---

## 1. One rig, many styles

The avatar is **one skinned mesh on one skeleton**, but each object group may be
built in a different **construction style**. Style is a per-object decision, not
a global one.

| Style | Build method | Use for |
|---|---|---|
| **Voxel / pixel** | `add_slabs` — tiled boxes on the reference grid | Fredo's body, face, wardrobe |
| **Plated 3D** | `add_prim` — lofted shells, extruded chamfered outlines, shell patches | Doom armour, mechanical props |
| **2D drawn** *(future)* | textured billboard plane on a bone | hand-drawn / comic inserts |

All three coexist in the same skinned mesh and the same clip. A deliberately
different style for a special mode is allowed — and often the point — as long as
it is a **bold** difference, not an accidental one. Half-voxel, half-smooth
because nobody decided looks broken; a fully modelled helmet on a pixel body
looks intentional.

**Rule:** pick the style per object, state it in the object's definition, and
keep it consistent within that object. Never mix construction styles *inside*
one object.

### Era shading

"Style" includes how polygons are shaded, not just how they are built. Smooth
normals read as modern CG; **flat, faceted normals** read as N64/PS1-era. The
builder keeps flat normals on all 3D gear (`flat_faces`) while the voxel body
keeps its own look, and 3D gear uses low segment counts and single-segment
chamfers rather than rounded bevels. Choose the era deliberately — a smooth
sphere next to hard-edged plates looks like a mistake, not a style.

## 2. Geometry hygiene

- **Voxel:** tiles never overlap. Overlapping boxes and face-to-face cubes
  produce z-fighting (the "dark square" bug). Leave a ~0.02 unit gap; the
  builder's `seams()` already does this.
- **3D:** panels are closed solids — lofted shells or extruded, chamfered
  outlines. Hard edges get a single-segment chamfer (`_chamfer`), never a round
  bevel; no n-gons; normals recalculated (`recalc_face_normals`) before merging.
  A body of revolution uses a superellipse cross-section, not a circle: a
  circle always reads as a ball, however it is decorated.
- **Both:** everything merges into one mesh with vertex weights of exactly
  `1.0` per bone (rigid skinning). No weight painting, no smearing between parts.
- Bake modifiers. Nothing engine-side depends on a live Blender modifier.

## 3. Colour belongs to the runtime

- Every object group gets **its own material**. Never share one material across
  unrelated objects — it makes per-object colour impossible.
- Body-ish materials (`fredo_body`, `fredo_accent`, `fredo_limb`, `fredo_boot`)
  ship **neutral white** so the app can tint them to the user's colour.
- Wardrobe and effects ship their **intended colour** (brass, gunmetal, lava).
- **Never bake the user's colour into the asset.** A palette swap (doom mode) is
  a runtime material change, not new geometry.
- When adding a material, add it to the palette table in `ASSET.md` in the same
  pass.

## 4. States are clips; moods are a layer

- One **named Action per clip**, stashed as its own NLA strip, exported as a
  glTF animation. Clip name == state name, lowercase, `kebab-case`.
- Activity clips (`idle`, `thinking`, `working`, …) drive the **body**.
- Emotion clips (`happy`, `sad`, `skeptical`, …) drive the **face**.
- They are currently exclusive because both normalise every bone. The intended
  end state is a **face layer**: split the skeleton into `BODY` and `FACE` bone
  sets so an emotion can play *over* an activity (12 activities × 12 emotions
  without authoring 144 clips).
- Special modes (`doom-*`) are ordinary clips plus a runtime palette. The app
  owns whether the easter egg exists; the asset just supplies the poses.

## 5. Clips must not leak

Every clip keys **every animated bone** at its rest pose before its own keys.
glTF only writes properties a clip actually keys, so an untouched channel would
hold whatever the previous clip left (this shipped once as a "greeting shows a
squinted eye" bug).

## 6. Loops and one-shots

- Looping clips: first pose == last pose, or the loop stutters.
- One-shots (`teleport-*`, `doom-in`, `doom-out`) are flagged `loop: false` in
  the manifest and played `LoopOnce` with `clampWhenFinished`.
- The runtime chains them: `doom-in → doom-idle → doom-out → idle`.
- No root drift: in-place clips return the root to the origin.

## 7. Visibility is bone scale

glTF has no visibility channel. Toggleable objects (props, wardrobe, face
shapes, weapons) live on their own bone and animate **scale** `0.001 ↔ 1`.
Never rely on `visible`, `opacity`, or material swaps for presence.

## 8. Faces are shapes, not squints

Eye expressions are real geometry (`arc`, `chev`, `round`, `lid`, `heart`,
`sad`) plus a `mouth` bone. A state shows exactly **one** shape by hiding all of
them and revealing one. Never stack two shapes.

## 9. Units, origin, facing

- 1 Blender unit = 1 metre; character is 1.8 m.
- Origin at ground level, centred between the feet.
- Faces −Y in Blender → **+Z** after glTF Y-up conversion.
- No presentation rotation baked into the asset; framing is the camera's job.

## 10. Rebuild hygiene

- The builder **purges stale materials** before rebuilding. Blender keeps
  materials across runs and silently renames them (`.001`), which breaks
  name-based lookups such as the preview tint.
- Regenerate in this order: build → render → sheets → manifest.
- Verify the GLB with `inspect_glb.py`: one mesh, one skin, no cameras, no
  unskinned nodes, expected clip count.

---

## Checklist for a new object
1. Decide its **style** (voxel / 3D / 2D) and keep it consistent.
2. Give it its **own bone**, parented to the nearest sensible joint.
3. Give it its **own material** — neutral if it should follow the user tint.
4. Add it to `HIDE_BONES` if it is toggleable; show it from clips with
   `show_bone`.
5. Key every relevant bone in every clip (no leakage).
6. Close the loop or flag it as a one-shot.
7. Update `ASSET.md` (materials + clip table) in the same pass.
