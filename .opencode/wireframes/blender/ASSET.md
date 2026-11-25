# FREDO character asset

Game-ready character for the FREDO companion, authored in Blender and exported
as a single GLB for a web runtime (three.js / react-three-fiber).

> **Start here:** [`GUIDE.md`](./GUIDE.md) — how it works, how to edit it, how to
> add states and objects. [`STYLE_RULES.md`](./STYLE_RULES.md) — the art direction
> rules that keep it coherent. This file is the technical handoff contract.

## Files

| File | Purpose |
|---|---|
| `fredo-character.glb` | **The asset.** Mesh + skeleton + every clip. |
| `fredo-character.manifest.json` | Runtime contract: clip names, durations, loop flags, props. |
| `fredo-character.blend` | Source scene. |
| `build_character.py` | Reproducible builder (run through the Blender addon socket). |
| `preview.html` | Interactive viewer — clip switching, camera views, zoom, colour. |
| `inspect_glb.py` | Validates the GLB container. |
| `export_manifest.py` | Regenerates the manifest from the GLB itself. |

## Tinting and per-object colour

Each object group has its **own material**, so accessories do not have to share
Fredo's colour:

| Material | Covers | Ships as |
|---|---|---|
| `fredo_body` | head ring, face, arms, legs, tie | **white** — tint it |
| `fredo_accent` | eyes, face-rig shapes, mouth | **white** — tint it |
| `fredo_limb` | base arms and legs | **white** — tint it |
| `fredo_boot` | base feet | **white** — tint it |
| `fredo_hair` | moustache | grey |
| `fredo_hat` | bowler | dark slate |
| `fredo_metal` | monocle, glasses, doom weapon props | brass |
| `fredo_fx` | steam, burst ring, sparks | bright cyan |
| `fredo_doom` | doom cuirass, spaulders, belt, trousers | green |
| `fredo_helm` | doom helmet, knee pads, boots | slate blue-grey |
| `fredo_visor` | doom visor glass | green |
| `fredo_trim` | doom gunmetal: bezel, grille, rivets, buckle | near-black metal |
| `fredo_glove` | doom gloves and under-suit | black leather |
| `fredo_skin` | doom bare arms | tan |
| `fredo_lava` | doom lava chunks, belt shell tips | red |

Tint body + accent to the user's colour, then override any object individually:

```js
const tint = (mat, hex) => {
  const c = new THREE.Color(hex);
  mat.color.copy(c);
  mat.emissive.copy(c);
};
tint(materials.fredo_body, userColour);
tint(materials.fredo_accent, userColour);
tint(materials.fredo_metal, '#c9a227');   // brass
```

Never bake the body colour into the asset — it is a runtime choice
(`#55ddea` by default).

## Clips

- **Units:** 1 Blender unit = 1 metre. Character is **1.8 m** tall.
- **Origin:** ground level, centred between the feet.
- **Facing:** −Y in Blender → **+Z** after glTF Y-up conversion.
- **Mesh:** one skinned mesh, quad-based, **~43 k triangles** (43,104), **17 material slots**.
- **Skeleton:** 77 bones (body joints, face shapes, props, wardrobe).
- **Colour:** materials ship **neutral white**. Tint at runtime:

```js
const c = new THREE.Color(userColour);
mesh.material.color.copy(c);
mesh.material.emissive.copy(c);
```

Never bake a colour into the asset — the brand cyan is a runtime choice
(`#55ddea` by default).

## Clips

32 clips, 12 fps, 1.33 s each. All loop seamlessly (`last pose == first pose`)
except the teleports.

**Activity**

| Clip | Loop | Wardrobe / props |
|---|---|---|
| `idle` | yes | — |
| `talk` | yes | — |
| `listening` | yes | — |
| `greeting` | yes | hat |
| `thinking` | yes | thought bubble, monocle |
| `analyzing` | yes | magnifier, monocle |
| `planning` | yes | clipboard, glasses |
| `working` | yes | tray, glasses |
| `complete` | yes | check, hat |
| `error` | yes | exclamation |
| `playful` | yes | — |
| `joking` | yes | — |

**Emotion** (face-led, small body beat)

| Clip | Eyes |
|---|---|
| `happy` | `∩ ∩` closed smile |
| `uwu` | `∩ ∩` gentle sway |
| `love` | heart eyes |
| `sad` | drooping eyes, head down |
| `surprised` | wide `o o`, pop up |
| `sleepy` | half-lidded, head droop |
| `skeptical` | `¬ ¬` half-lidded side-eye |
| `confused` | `o _` one wide, one lid |
| `silly` | open eyes + `:v` mouth |
| `squint` | `> <` squeezed, laughing |
| `angry` | `> <` + steam + hat |
| `funny` | wink + hat tip |

**Special**

| Clip | Loop | FX |
|---|---|---|
| `teleport-out` | once | burst ring, flash, 14 sparks |
| `teleport-in` | once | burst ring, flash, 14 sparks |

**Secret — doom mode (Doomguy)**

| Clip | Loop | What happens |
|---|---|---|
| `doom-in` | once | convulsion, helmet / visor / pauldrons / shotgun slam on (1.35× overshoot), sparks |
| `doom-idle` | yes | menacing sway holding the shotgun, rising embers |
| `doom-sword` | yes | idle with the glowing energy sword |
| `doom-mg` | yes | idle with the machine gun |
| `doom-out` | once | the whole kit retracts, shake, settle |

Modelled on **Doom 64 (N64)**: black armour over a green undersuit, oversized
slate helmet with a green visor, black gloves, green cuirass and trousers, slate
knees and boots, shotgun as the primary weapon (machine gun and energy sword as
variants).

The armour is a **hard-surface plate kit**, not spheres. It is built from:
lofted superellipse shells (the helmet is three stacked shells — jaw block,
crown shell, crown cap — so the silhouette steps instead of reading as one
ball), extruded chamfered outlines (`_append_plate`) and conforming shell
patches (`_patch`). Every plate stands proud of the shell beneath it with a real
5-10 mm gap, so each panel earns its own shadow line; `_chamfer()` bevels only
the silhouette edges, so highlights catch a 6-14 mm lip. Detail geometry —
rivets, grille slats, vent pods, pouch flaps, shell loops, knee bosses — is
built from small chamfered boxes and cylinders.

Placement follows the character's real anatomy: the head is a 1.30 m wide hollow
voxel **ring**, so the helmet is oversized to enclose it and supplies all of the
head's volume. The Doom kit tops out at ~1.85 m; the base character is 1.80 m.

Deliberately no horns: those read as a demon, not the marine.

Trigger in the viewer by typing `doom`; leave with `Esc`. The palette flip is a
runtime material swap, so the GLB stays neutral — the app decides whether the
easter egg exists.

Sequence: `doom-in` → `doom-idle` (loop) → `doom-out` → `idle`. All three are
one-shots except the loop, and the runtime should swap the palette on entry and
restore it on `doom-out` finish.

### Face rig

Eye shapes are real geometry toggled by bone scale — six shapes, `arc`, `chev`,
`round`, `lid`, `heart`, `sad` — plus a `mouth` bone for `:v`. A state shows
exactly one shape by hiding all of them and revealing one (`eyes()` in the
builder), so poses never mix.

### Emotion as a layer (next step)

Activity and emotion clips currently both normalise **every** bone, so only one
can play at a time. To overlay a mood on an activity (working + annoyed), split
the skeleton into `BODY` and `FACE` bones, have activity clips key only BODY and
emotion clips key only FACE, then run two `AnimationAction`s at once — the
standard game face-layer setup.

Props are toggled by **bone scale** (0.001 → 1), because glTF has no visibility
channel. Wardrobe props live on `head`; action props on `body` or `root`.

## Teleport

`teleport-out` and `teleport-in` are the summon/dismiss pair and the primary
interaction. Design:

- **out** — crouch anticipation → push-off → parts dissolve outer-to-inner
  (feet, legs, eyes, head, arms, tie, body) with a 0.8-frame stagger, each part
  popping to 1.16× just before it vanishes; an energy ring expands outward.
- **in** — ring contracts, parts snap in inner-to-outer with a 1.18× overshoot,
  landing squash (1.06 × 0.94) and settle.

Both are marked `loop: false`; the runtime should play them `LoopOnce` and swap
to `idle` on the `finished` event.

## Credits

The doom-mode armour design references **"Posable Doomguy (Blender file)" by
Fjaru** (CC BY 4.0 - https://www.thingiverse.com/thing:4873090) for proportion
and part decomposition (helmet / torso / shoulders / arms / belt / legs / boots).

**No geometry from that model is shipped.** The kit in this asset is an original
reconstruction from voxel slabs and primitive plates; the reference `.blend` is
not committed, bundled, or redistributed. See
[`docs/THIRD_PARTY_NOTICES.md`](../../../docs/THIRD_PARTY_NOTICES.md) section 7.

DOOM and the DOOM logo are trademarks of id Software LLC / ZeniMax Media Inc.
Fredo is not affiliated with, endorsed by, or sponsored by id Software.

**What the reference taught us (kept as design notes).** The model is split into
nine separate parts - helmet (with its own shell / interior / visor materials),
torso, shoulders, arms, belt, belt buckle, legs, boots, head - on a 148-bone
rig, totalling ~108k triangles. Two transferable lessons: armour decomposes
**per body part** (which is exactly our one-bone-one-material structure), and
the **visor is a separate material from the helmet shell** so it can glow
independently. Our kit follows both, at ~1/3 the triangle budget.

## Regenerating

Blender must be running with the official Lab MCP add-on listening on 9876.

```
python blender_client.py build_character.py
python export_manifest.py
python inspect_glb.py
```

Preview: serve the repo root and open the viewer.

```
python -m http.server 8099 --bind 127.0.0.1     # this machine only
python -m http.server 8099 --bind 0.0.0.0       # shareable on the LAN
# http://127.0.0.1:8099/.opencode/wireframes/blender/preview.html
```

### Sharing on a local network

1. Serve with `--bind 0.0.0.0`.
2. Allow the port inbound **from the LAN only** (elevated PowerShell):

```powershell
New-NetFirewallRule -DisplayName "FREDO preview 8099 (LAN)" `
  -Direction Inbound -Protocol TCP -LocalPort 8099 `
  -RemoteAddress LocalSubnet -Action Allow
```

3. Open `http://<your-lan-ip>:8099/.opencode/wireframes/blender/preview.html`.

Caveats: the viewer resolves three.js through the repo's `apps/ui/node_modules`,
so the server root must be the repo root — which also exposes the rest of the
source tree to anyone who can reach the port. Use `-RemoteAddress LocalSubnet`,
stop the server when finished, and prefer a self-contained bundle for anything
wider than a trusted LAN.

VS Code's Ports panel is a *tunnel* (reachable from outside), not LAN sharing —
use `--bind 0.0.0.0` for same-network access.
