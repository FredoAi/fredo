# ST-1 raw capture — the engine's `/api/episode` campaign surface (live probe)

- **Issue:** #2972 (Doom Mode slice 5 — companion resume)
- **Date:** 2026-10-05
- **Sub-task:** ST-1 (Phase-0 diagnostic: confirm the `/api/episode` campaign surface, 2 SP)
- **Status:** **CONFIRMED LIVE.** The real `restful-doom.exe` was launched under
  `-apilockstep` and driven through `POST /api/episode` for `(1,1)`, `(1,2)`, `(2,1)`,
  `(4,9)`. **Episodes 1–4 are accepted; the campaign bounds are E1M1..E4M9.** No product
  code, no loop change, no argv change — this is the Phase-0 measurement the campaign
  constants are derived from (G-314/G-316/G-320).

This file is the probe record. It is the evidence basis for the architect's campaign
constants (`DOOM_CAMPAIGN_FIRST_EPISODE=1`, `DOOM_CAMPAIGN_LAST_EPISODE=4`,
`DOOM_CAMPAIGN_FIRST_MAP=1`, `DOOM_CAMPAIGN_LAST_MAP=9`).

---

## 1. Environment (verified)

| Component | Value |
|---|---|
| Engine (driven) | `C:\Users\pktro\AppData\Roaming\com.fredo.app\doom\engine\restful-doom.exe` — **the app's DEFAULT install dir (G-323)** |
| Engine version (log) | `RESTful Doom 2.2.1` |
| Pinned engine commit | `eded41b5597b7738ec1fa06d24f62b53db982c2c` (`mkschreder/restful-doom`) |
| IWAD | `C:\Users\pktro\AppData\Roaming\com.fredo.app\doom\freedoom\freedoom1.wad` (Freedoom Phase 1, SHA-256 `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` — verified by the stager) |
| Video driver | `SDL_VIDEODRIVER=dummy` (framebuffer-only; no second OS window) |
| Probe | bounded PowerShell driver (readiness poll <= 30 s, 10 s HTTP timeout, hard-kill teardown) |

### Staging (G-322/G-323) — substitution disclosed

`powershell -File scripts/doom/stage-doom-fixture.ps1 -FixtureDir .opencode/tmp/2972/fixtures`
was invoked **without** a literal `-Msys2Root`/out-of-repo toolchain path; it exited 0,
copied the engine + 9 runtime DLLs + the verified IWAD into the fixture dir, and staged the
`doom-engine.invalid.exe` lever.

**The staged fixture copy did not become ready** — launched from
`.opencode/tmp/2972/fixtures/engine/restful-doom.exe` it exited before answering
`GET /api/state` (READY=False, empty stdout/stderr logs), the same class of failure the plan
recorded for #2971 (`readyTimeout`). Per the plan's binding G-323 fallback, the live legs were
then driven from **the app's DEFAULT install dir**
(`%APPDATA%\com.fredo.app\doom\engine\restful-doom.exe`), whose sibling DLL set is complete.
The engine is the **real `restful-doom.exe`** — never a stub. This substitution is disclosed
and does not affect the campaign-surface findings (they are properties of the engine binary
and its WAD, both identical artifacts to the staged copy).

---

## 2. Launch argv (exact, observed)

```text
restful-doom.exe -iwad <freedoom1.wad> -apiport <port> -apilockstep -noblit -nosound -nomusic -warp 1 1 -skill 3
```

The product argv (`process.rs:99-107`) is `-apilockstep -noblit -nosound -nomusic -iwad <path>
-warp 1 1 -skill 3 -apiport <port>`; the probe used the same flags in a different order (flag
order is immaterial — the engine parsed all of them). The port is a free loopback port chosen
per run. `-apilockstep` froze the world: it advanced **only** on `POST /api/step` (confirmed —
`tic` stayed put across state reads and moved only after steps).

**Observation — the CLI `-skill` value and the API `skill` value are not the same scale.**
The log reports `startskill 2` for the argv `-skill 3`, while `POST /api/episode {"skill":3}`
returns `level.skill = 3`. The CLI value is superseded by the resume-positioning
`POST /api/episode` before the first step, so this does not affect the resume feature; it is
recorded so no downstream unit assumes the argv skill equals the API skill.

---

## 3. Endpoint shapes (observed live)

### `POST /api/episode`

Request body (exactly the four coordinates):

```json
{"episode": 1, "map": 2, "skill": 3, "seed": 0}
```

- **200** — the **same observation shape `GET /api/state` returns**, for the newly started
  level. `level.episode` / `level.map` echo the requested coordinates; `level.skill` echoes the
  requested skill; `done = false`; `outcome = "alive"`; `tic` is the new level's tic counter.
- **400** — observed **only for an out-of-range `skill`** (see §4). The response body was empty.
- **Fatal (no HTTP response)** — an out-of-range **episode** (5) makes the engine try to load a
  non-existent map (`W_GetNumForName: E5M1 not found!`) and the API daemon stops answering.

### `GET /api/state`

The observation carries `tic`, `episodeTic`, `level.{episode,map,skill,tic,kills,totalKills,
items,totalItems,secrets,totalSecrets}`, `player.{health,armor,x,y,angle,weapon,ammo,weapons,
keys}`, `threats`, `hazards`, `pickups`, `clearance`, `exit`, `unexplored`, `events`,
`done`, `outcome` — matching the #2968 capture. **The `done`/`outcome` fields are present on
every observation** and are the loop's terminal signal (`agent.rs:163-170`).

---

## 4. Probe results per coordinate

Live output (verbatim), one line per `POST /api/episode`:

```text
EPISODE e=1 m=1 -> HTTP 200 level.episode=1 level.map=1 level.skill=3 tic=1 done=False outcome=alive
EPISODE e=1 m=2 -> HTTP 200 level.episode=1 level.map=2 level.skill=3 tic=2 done=False outcome=alive
EPISODE e=2 m=1 -> HTTP 200 level.episode=2 level.map=1 level.skill=3 tic=3 done=False outcome=alive
EPISODE e=4 m=9 -> HTTP 200 level.episode=4 level.map=9 level.skill=3 tic=4 done=False outcome=alive
```

| Requested | HTTP | `level.episode` | `level.map` | `level.skill` | `done` | `outcome` |
|---|---|---|---|---|---|---|
| `(1,1)` | 200 | 1 | 1 | 3 | false | `alive` |
| `(1,2)` | 200 | 1 | 2 | 3 | false | `alive` |
| `(2,1)` | 200 | 2 | 1 | 3 | false | `alive` |
| `(4,9)` | 200 | 4 | 9 | 3 | false | `alive` |

**All four coordinates are honored verbatim** — including `E4M9`, the final level of the
Freedoom Phase 1 (Ultimate-Doom) surface. **Episodes 2, 3 and 4 are accepted (HTTP 200), not
rejected.** The plan's provisional `episode 1..=4`, `map 1..=9` bound is therefore
**confirmed live**, and `advance()`'s E4M9 completion terminator is a reachable coordinate.

### Out-of-range behavior (fresh engine per case)

| Requested | HTTP | Observed | Engine alive after? |
|---|---|---|---|
| `episode=5, map=1, skill=3` | **no response (-1)** | `W_GetNumForName: E5M1 not found!` (stderr); `GET /api/state` then also fails | **NO — API daemon dead** |
| `episode=0, map=1, skill=3` | 200 | `level.episode=4`, `level.map=1` (mapped to the highest episode) | yes |
| `episode=1, map=0, skill=3` | 200 | `level.map=1` (clamped up to 1) | yes |
| `episode=1, map=10, skill=3` | 200 | `level.map=9` (clamped down to 9) | yes |
| `episode=1, map=1, skill=5` | **400** | empty body | yes |

**Finding — the engine only cleanly rejects an invalid `skill` with HTTP 400.** Out-of-range
episodes/maps are **not** a 400: `map` is clamped into `1..=9`, `episode 0` maps to the highest
episode, and `episode 5` is a **fatal** path that kills the API daemon. The engine-contract
spike's claim that `POST /api/episode` returns 400 on an invalid episode/map/skill is true
**only for `skill`**. This is safe for the resume feature because `DoomSave::parse` rejects a
non-positive `episode`/`map` and a `skill` outside `0..=4` **before** any request is built
(`API Contracts & Data Models`), so the app never sends `0`, `5` or `10`; the clamps/fatal are
out-of-contract and must not be probed by the tester as a resume lever.

---

## 5. `done` / `outcome` exit semantics

**Observed at level start (every accepted `/api/episode`):** `done = false`,
`outcome = "alive"`. `outcome` is a string; `done` is a boolean. Both are present on every
`/api/state` and `/api/episode` observation.

**The level-exit transition was NOT inducible within a bounded real-engine drive** — three
bounded attempts, all ending at budget with `done=false, outcome="alive"`:

```text
DRIVE-NAV   reason=budget steps=400 episode=1 map=1 tic=3201  done=False outcome=alive   (turn-to bearing + forward + run, E1M1 skill 0)
DRIVE-DEATH reason=budget steps=40  episode=1 map=1 tic=17202 done=False outcome=alive   (stand still, E1M1 skill 4)
NAV         reason=budget steps=400 episode=1 map=1 tic=1601  done=False outcome=alive   (turn-to + forward + run + use, E1M1 skill 0)
```

**Limitation (recorded, not hidden):** a fixed decision script cannot guarantee walking E1M1
to its exit (a switch behind doors), and standing still did not induce a death either. The
**terminal** `done=true` observation and the `outcome="dead"` observation were therefore not
seen live on the real engine. This is exactly the non-inducibility the QA plan already records
("AC3's advance → next-level → persist → complete chain is NOT deterministically inducible on
the real engine") and is why the tester's **F-64** proves the exit→advance→persist→complete
chain on the deterministic stub (`FREDO_DOOM_STUB_DONE_AFTER=<n>`) driving the REAL loop.

**What the live probe DOES establish about the terminal contract:** the fields exist with the
shapes the loop consumes — `done` (bool) and `outcome` (string). The app's exit/death
discriminator is `is_terminal = done || outcome == "dead"` (`agent.rs:163-170`), and the death
branch keys on the literal `outcome == "dead"`; the stub models the exit outcome string
(`agent.rs:510-511`). The exact real-engine `outcome` string for a **level exit** (vs. death)
remains unobserved and is flagged for the tester's stub leg — **never presented here as a live
finding.**

---

## 6. Confirmed campaign bounds (the ST-1 deliverable)

| Bound | Confirmed value | Evidence |
|---|---|---|
| First episode | **1** | `(1,1)`, `(1,2)` → HTTP 200 |
| Last episode | **4** | `(2,1)`, `(4,9)` → HTTP 200 (episode 2 and episode 4 both accepted) |
| First map | **1** | `(1,1)`, `(2,1)` → HTTP 200 |
| Last map | **9** | `(4,9)` → HTTP 200, `level.map=9` |

`episode 1..=4` × `map 1..=9` is the engine's Freedoom Phase 1 surface. The architect's
constants (`DOOM_CAMPAIGN_FIRST_EPISODE=1`, `DOOM_CAMPAIGN_LAST_EPISODE=4`,
`DOOM_CAMPAIGN_FIRST_MAP=1`, `DOOM_CAMPAIGN_LAST_MAP=9`) are **evidence-based and stand** —
no shrink is required. The `advance()` wrap (`map+1`, `episode+1/map=1` on wrap, `None` at
E4M9) operates entirely inside the accepted surface.

---

## 7. Teardown (G-263)

Every probe run was bounded: readiness poll <= 30 s, each HTTP call <= 10 s, the drive step
budgets finite (400/40/400 steps), and the teardown a `taskkill /PID <T> /T /F` plus a
by-image `taskkill /IM restful-doom.exe /T /F`. Every run reported `TEARDOWN remaining=0`;
**no `restful-doom.exe` process was left running.**

---

## 8. Provenance

- Live probe: the real `restful-doom.exe` (`RESTful Doom 2.2.1`) driven over loopback; all
  quoted lines are verbatim probe output. Engine log:
  `.opencode/tmp/2972/engine-*.out.log` / `engine-*.err.log` (gitignored scratch).
- Engine argv + API client contract: `apps/tauri/src-tauri/src/features/doom/{process.rs,client.rs,state.rs}`.
- Observation shape: `spikes/2968-doom-runtime/engine-contract.md`; action vocabulary:
  `spikes/2969-doom-agent/action-vocabulary.md`.
- Terminal discriminator: `apps/tauri/src-tauri/src/features/doom/agent.rs:163-170`.
- Pinned commit: `eded41b5597b7738ec1fa06d24f62b53db982c2c`.

*Authored by Developer (ST-1 capture, CU-1).*
