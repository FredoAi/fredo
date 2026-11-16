# ST-1 raw capture — Doom action vocabulary + per-step RTT (live probe)

- **Issue:** #2969 (Doom Mode slice 2 — companion autonomous play)
- **Date:** 2026-10-04
- **Sub-task:** ST-1 (Phase-0 LIVE action-vocabulary + progress-shape probe, 2 SP)
- **Status:** **CONFIRMED LIVE.** The real staged `restful-doom.exe` was launched
  under `-apilockstep` and its accepted action-object vocabulary, step-body bounds,
  per-step RTT, and progress shape were measured end-to-end. No model call, no loop,
  no product behavior — this is the Phase-0 measurement the persona/script/observable
  are authored against (G-028/G-314).

This file is the probe record; the pinned machine-readable vocabulary lives in
`apps/tauri/src-tauri/src/features/doom/actions.rs`.

---

## 1. Environment (verified)

| Component | Value |
|---|---|
| Engine (staged) | `C:\Users\pktro\AppData\Roaming\com.fredo.app\doom\engine\restful-doom.exe` |
| Engine build | Slice-1 `scripts/doom/build-restful-doom.ps1` (already staged; idempotent short-circuit) |
| Pinned engine commit | `eded41b5597b7738ec1fa06d24f62b53db982c2c` (`mkschreder/restful-doom`) |
| IWAD | `C:\Users\pktro\AppData\Roaming\com.fredo.app\doom\freedoom\freedoom1.wad` (Freedoom 0.13.0, SHA-256 pinned in `scripts/doom/stage-doom-fixture.ps1`) |
| Video driver | `SDL_VIDEODRIVER=dummy` (framebuffer-only; no second OS window — slice-1 finding) |
| Probe | `.opencode/tmp/2969/restful-doom-probe.ps1` (gitignored, bounded, hard teardown) |

The engine binary and IWAD are **not committed and not bundled** (packaging rule). The
in-repo producer is `scripts/doom/{build-restful-doom,stage-doom-fixture}.ps1`; the
staged app-data artifact is the resolver's candidate, already present on this host.

---

## 2. Launch argv (exact)

```text
restful-doom.exe -iwad <freedoom1.wad> -apiport 6666 -apilockstep -noblit -warp 1 1 -skill 3 -nosound -nomusic
```

(`-apiport` not `-port`; `-apilockstep` freezes the world so it advances ONLY on
`POST /api/step`.)

---

## 3. Endpoint shapes observed

| Request | Result |
|---|---|
| `GET /api/state` | **200** JSON; first poll after the port opened |
| `POST /api/player/actions` `<action object>` | **201** Created on an accepted action; **400** `{"error": "..."}` on a rejected one |
| `POST /api/step` `{"tics":1,"actions":[...]}` | **200** post-step observation; **400** on `tics` outside 1-350 or an invalid action |
| `POST /api/step` `{"tics":1,"actions":[]}` | **200** (a step with no actions still advances) |

Observed 400 bodies: `"invalid action type"`, `"turn-to needs an angle"`,
`"angle must be 0-359"`, `"invalid weapon selected"`,
`"amount must be positive and non-zero"`, `"amount must be a number"`,
`"Action type not specified or specified incorrectly"`.

The step body accepts an **array** of action objects applied before the tics run;
`[{"type":"turn-to","angle":90},{"type":"shoot"}]` returned **200**.

---

## 4. Accepted action vocabulary (the full set)

Confirmed live against `POST /api/player/actions` (201) — the same parser
`POST /api/step` uses (`API_PostPlayerAction`, `src/doom/api_player_controller.c`):

| `type` | Fields | Meaning |
|---|---|---|
| `forward` | `amount` (tics, default 10) | hold forward |
| `backward` | `amount` (tics, default 10) | hold backward |
| `turn-left` | `amount` (tics, default 10) | hold turn-left (fixed turn/tic) |
| `turn-right` | `amount` (tics, default 10) | hold turn-right (fixed turn/tic) |
| `strafe-left` | `amount` (tics, default 10) | hold strafe-left |
| `strafe-right` | `amount` (tics, default 10) | hold strafe-right |
| `run` | `amount` (tics, default 10) | hold the speed **modifier**; no effect alone |
| `turn-to` | `angle` (absolute map degrees, 0-359, **required**) | face an absolute angle; the servo closes over following tics |
| `shoot` | `amount` (tics, default 10) | hold fire; the weapon state machine decides |
| `use` | — | press use at the current facing; resolved immediately, ignores `amount`/`angle` |
| `switch-weapon` | `amount` (weapon slot **1-8**, effectively required) | select a weapon by number-key slot |

### Rejected (400) — the negative space (do not emit these)

| Payload | Status |
|---|---|
| `{"type":"frobnicate"}` | 400 invalid action type |
| `{"type":"turn-to"}` (no angle) | 400 turn-to needs an angle |
| `{"type":"turn-to","angle":360}` | 400 angle must be 0-359 |
| `{"type":"switch-weapon","amount":9}` | 400 invalid weapon selected |
| `{"type":"forward","amount":0}` | 400 amount must be positive and non-zero |
| `{"type":"forward","amount":"x"}` | 400 amount must be a number |
| `{}` (no type) | 400 type not specified |

**Do NOT invent action names.** The RAML `RAML/player_action.raml` `type` example is
**stale**: it lists `shoot | forward | backward | turn-left | turn-right | use |
strafe-left | strafe-right | switch-weapon` and **omits `turn-to` and `run`**, both of
which the live engine accepts. The authoritative parser is
`src/doom/api_player_controller.c` at the pinned commit.

`amount` is the key **hold duration in tics** (`keys_down[key] = amount`, decremented
per tic in `API_AfterTic`); it defaults to 10 when omitted and must be a positive
integer when present.

---

## 5. Per-step RTT (the AC5 target basis)

Measured over N=25 `POST /api/step {"tics":1,"actions":[]}` calls against the live
lockstep engine, wall-clock per request (`Invoke-WebRequest`, same loopback host):

| Run | min | median | max | avg |
|---|---|---|---|---|
| 1 | 9.42 ms | 10.60 ms | 29.82 ms | 12.11 ms |
| 2 | 10.22 ms | 11.95 ms | 31.37 ms | 13.17 ms |
| **3 (reported)** | **10.50 ms** | **12.37 ms** | **25.70 ms** | **13.14 ms** |

**Reported per-step RTT: min 10.50 ms / median 12.37 ms / max 25.70 ms (N=25, tics=1).**

**AC5 derivation.** The engine-only ceiling is `1 / 0.01237 s ≈ 80.8 steps/s` at
`tics=1`. This is the floor on achievable cadence from the engine alone; the real
sustained **decision** rate is lower because each decision also pays the model
round-trip (bounded by `DOOM_AUTOPLAY_DECISION_TIMEOUT_S=30`) or the scripted lever,
plus the 250 ms failure backoff. ST-3/ST-5 own the recorded sustained target constant;
this file supplies the measured engine cost it must be derived from — never a guessed
round number, never an idle-frame rate (G-316).

---

## 6. Progress shape (the composite observable)

A bounded run of 60 `POST /api/step {"tics":1,"actions":[{"type":"forward"},{"type":"run"}]}`
steps from tic 27:

| Field | before | after |
|---|---|---|
| `tic` | 27 | 87 |
| `player.x` | -417 | -418 |
| `player.y` | 183 | 431 |
| `level.kills` | 0 | 0 |
| `level.items` | 0 | 0 |
| `exit.distance` | (absent) | (absent) |
| `player.health` | 100 | 100 |
| `outcome` | alive | alive |

Top-level observation keys:
`tic, episodeTic, level, player, threats, hazards, pickups, clearance, exit,
unexplored, events, done, outcome`.

**Finding — `exit.distance` is fair-play gated and is NOT a reliable from-tic-0
progress component.** The `exit` object exists from the first observation, but its
`distance`/`bearing`/`clearance`/`kind` fields are added only once the exit linedef has
been mapped (`API_RouteIsFair() && (best->flags & ML_MAPPED)`). Early `exit` carries
only route fields, e.g.:

```json
{"pathDistance":0,"goal":"unexplored","routeBearing":-160,"routeDistance":56,"routeClearance":126,"routeIsLift":true}
```

The composite progress observable must therefore be `tic` strictly increases **and**
at least one of `level.kills` / `level.items` / `player.{x,y}` improves — with
`exit.distance` optional (present only after the exit is seen), exactly as the plan's
binding decision 4 allows. In this run the step-driven movement advanced
`player.y` by 248 units, confirming `player.{x,y}` is a live, usable progress component.

---

## 7. Teardown (G-263)

The probe is bounded: launch → poll `/api/state` (<=30 s) → contract legs →
`taskkill /PID <T> /F` → 2 s wait. Each run reported `TEARDOWN remaining=0`; no
`restful-doom.exe` process remained.

---

## 8. Provenance

- Parser (authoritative): `src/doom/api_player_controller.c` (`API_PostPlayerAction`),
  `src/doom/api.c` (`API_RouteRequest`), `src/doom/api_agent.c` (`POST /api/step`).
- RAML: `RAML/doom.raml`, `RAML/player_action.raml` (the `type` example is stale — see §4).
- Pinned commit: `eded41b5597b7738ec1fa06d24f62b53db982c2c`.
- Raw sources:
  `https://raw.githubusercontent.com/mkschreder/restful-doom/eded41b5597b7738ec1fa06d24f62b53db982c2c/`
  (`src/doom/api_player_controller.c`, `src/doom/api.c`, `RAML/player_action.raml`).

*Authored by Developer (ST-1 capture).*
