# ST-1 raw capture — engine HTTP contract + launch argv

- **Issue:** #2968 · **Date:** 2026-10-03
- **Source of truth:** the fork's RAML 1.0 API spec
  `RAML/doom.raml` at `mkschreder/restful-doom` master, plus its `README.md`.
  Base URI declared in the RAML: `http://localhost:6666`.
- The Rust client is a **shape-agnostic opaque JSON passthrough** (plan), so this capture records the
  upstream contract; it does not require the client to model every field.

## `GET /api/state`

> The whole observation in ONE request: level progress, the player, what is around them sorted by
> distance, how far there is to WALK in six directions, where the exit is, and the events derived
> since this was last read.

**200** `application/json` — example (verbatim from the RAML):

```json
{
  "tic": 574, "episodeTic": 120,
  "level": {"episode": 1, "map": 1, "skill": 3, "tic": 120,
            "kills": 2, "totalKills": 29, "items": 1,
            "totalItems": 37, "secrets": 0, "totalSecrets": 3},
  "player": {"health": 86, "armor": 0, "x": 1286, "y": -3512,
             "angle": 321, "weapon": "pistol", "ammo": 44,
             "keys": []},
  "threats": [{"id": 80, "type": "FORMER HUMAN SERGEANT",
               "distance": 180, "bearing": -12, "visible": true,
               "health": 30, "targetingMe": true}],
  "hazards": [{"id": 26, "type": "Barrel", "distance": 279,
               "bearing": 78, "visible": true, "health": 20}],
  "pickups": [{"id": 31, "type": "Medikit", "distance": 96,
               "bearing": 10, "visible": true}],
  "clearance": {"ahead": 320, "right": 64, "behind": 0,
                "left": 128, "aheadRight": 320, "aheadLeft": 64},
  "exit": {"distance": 2217, "bearing": -53, "kind": "switch",
           "clearance": 0, "spot": {"x": 2944, "y": -4768},
           "pathDistance": 3456, "routeBearing": 7,
           "routeDistance": 35, "routeClearance": 16,
           "blockedBy": {"kind": "door", "bearing": 7,
                         "distance": 17}},
  "events": [{"tic": 118, "type": "hurt", "amount": 15}],
  "done": false, "outcome": "alive"
}
```

The engine's **advanced field** for R-2.3 is the top-level `tic` (and `level.tic` / `episodeTic`).
The plan's UI "promote the advanced field (`tick`/`gametic`/`time` — first present)" should key on
**`tic`** for this engine.

## `POST /api/step`

> Apply actions, run exactly N tics, and answer with the state that results.
> Requires `-apilockstep`, in which the game advances ONLY on this call.

Request body:

```json
{
  "tics": 4,
  "actions": [{"type": "turn-to", "angle": 78}, {"type": "shoot"}]
}
```

| Response | Meaning |
|----------|---------|
| **200** | The **same body `GET /api/state` returns**, after the tics ran. |
| **400** | `tics` outside **1–350**, or an invalid action. |
| **409** | **Not running in lockstep** (i.e. launched without `-apilockstep`). |

`actions` takes exactly what `POST /api/player/actions` takes (action objects, not a scalar).

## `GET /api/frame`

> The 320x200 framebuffer the engine just drew, and the palette it would be shown through.
> Indexed rather than RGB because it is a fifth of the bytes and the expansion is one table lookup on
> the far side. The palette is the CURRENT one, not the PLAYPAL lump.

**200** `application/json` — example (verbatim):

```json
{
  "width": 320, "height": 200, "format": "indexed8",
  "pixels": "<base64, width*height bytes>",
  "palette": "<base64, 768 bytes>"
}
```

**503** — "Graphics are not up yet."

Decoding: base64-decode `pixels` to `width*height` (320×200 = 64,000) bytes of palette indices,
base64-decode `palette` to 768 bytes (256 × RGB), then expand each index → RGB(A). `format` is
`"indexed8"`.

## `POST /api/episode` (restart, reproducible)

```json
{"episode": 1, "map": 1, "skill": 3, "seed": 7}
```

- **200** — the same body `GET /api/state` returns, for the newly started level (`seed` moves the
  engine's random cursors after `G_InitNew`, so two episodes with different seeds diverge).
- **400** — invalid episode, map, skill (0–4), or seed.

## Other endpoints (names only; not consumed by Slice 1)

`GET /api/map` (walkable grid + exit distances) · `GET /api/route` (route working at the player's
cell) · `GET /api/world/movetest` (can a body stand at a point; P_TryMove reason). Human-facing
endpoints also exist (`/api/player`, `/api/players`, `/api/world`, `/api/world/doors`,
`/api/world/objects`) — **not** used by this slice.

## Launch argv (exact)

From the fork's README:

```
src/restful-doom -iwad doom1.wad -apiport 6666 -apilockstep -noblit -warp 1 1 -skill 4 -nosound -nomusic
```

| Flag | Meaning / note |
|------|----------------|
| `-iwad <path>` | The IWAD (Freedoom `freedoom1.wad` for Slice 1). |
| **`-apiport <port>`** | **The port flag — this is `-apiport`, NOT `-port`.** (Correction to the Triage Plan's API-contract block.) |
| `-apilockstep` | Hands the clock to the agent; the game advances ONLY on `POST /api/step`. Without it, step returns **409**. |
| `-noblit` | Keeps rendering into the framebuffer (so `/api/frame` works) while skipping blit/upscale/present. |
| `-warp <episode> <map>` | Doom-1 style (`-warp 1 1`); for Doom-II style (Freedoom Phase 2) use `-warp <map>` only. |
| `-skill <0–4>` | Difficulty. |
| `-nosound -nomusic` | No audio (server/headless use). |
| `-apiverbose` | **Optional.** Turns the per-request access log back on (off by default because at one request per tic it is not a log). |

## Divergences from the Triage Plan (flag for CU-3 / CU-4)

These are the exact reason ST-1 runs first. The plan's downstream shapes were guesses; the real
contract differs:

| Plan said | Real upstream contract | Impact |
|-----------|------------------------|--------|
| Port flag `-port <port>` | **`-apiport <port>`** | ST-3 launch argv must use `-apiport` or the engine binds the wrong port / errors. |
| `GET /api/frame` → `200 image/png` ("raw PNG bytes; Rust base64-encodes") | **`200 application/json`** `{width,height,format:"indexed8",pixels,palette}` | CU-4's canvas cannot `drawImage` a PNG; it must decode indexed8 + palette (or CU-3 expands it). The plan's `DoomFrame { png_base64 }` shape is wrong. |
| `POST /api/step` body `{ "action": <int>, "tic": <int> }` | **`{ "tics": <int>, "actions": [<action objects>] }`** | CU-3's `doom_step(action: i64)` cannot send a scalar `action`; the body must be built as `{tics, actions}`. |
| (not in plan) | `POST /api/episode` restarts a level reproducibly (`{episode,map,skill,seed}`) | Available for later slices; harmless to ignore in Slice 1. |

Both divergences are **contract facts**, not blockers to Slice 1: the Rust client is a shape-agnostic
JSON passthrough, so the shapes can be forwarded as-is. They must, however, be reflected when CU-3 /
CU-4 implement against them (recorded as an open item in the decision doc + dev summary).

## Provenance

- RAML spec: `https://raw.githubusercontent.com/mkschreder/restful-doom/master/RAML/doom.raml`
- README (argv + agent surface): `https://raw.githubusercontent.com/mkschreder/restful-doom/master/README.md`
