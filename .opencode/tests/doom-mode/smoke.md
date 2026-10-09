# doom-mode — Smoke Test Cases (Spec #2968)

> Standardized app-boots + core-path sanity boilerplate (adapted to the Doom surface). Runs on this feature's testing phase.
>
> **Verification policy: live** — the smoke receipt includes the `telemetry_spans` live-pipeline reference (non-zero count + recent `max(ingested_at)`; managed `psql` on the PG default, G-284, or a disclosed `telemetry_get_stats` substitution). A static-only smoke cannot pass. Doom emits NO OTLP spans — the check proves the pipeline, not the feature.
>
> **Real-engine scope:** the runtime core-path smoke (S-6) uses the REAL `restful-doom.exe` built by `scripts/doom/build-restful-doom.ps1` (ST-2); the stub is not a valid smoke engine.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3 (SUPERSEDED by #2970 — `doom-entry-button` is removed for secrecy; see S-12): Doom surface reachable via the secret typed trigger `iddqd`; the `doom` window opens (`doom-root` + `doom-window-title`="Doom" present).
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2968/e2e/smoke.jpeg")` succeeds.
- [x] S-6 (PASS 2026-10-05 #2970 r1 — real `restful-doom.exe` reached `doom-status` ready (pid, enginePath), `doom-frame-canvas` rendered real Freedoom pixels; closing left zero `restful-doom.exe`): **Doom runtime core path (REAL engine)** — build + stage `restful-doom.exe` (ST-2); the window reaches `doom-status` `ready`; `doom-frame-canvas` renders real game pixels; `DoomStatus.enginePath` basename == `restful-doom.exe`; closing the window leaves zero `restful-doom.exe`.
- [x] S-7 (PASS 2026-10-05 #2970 r1 — DISCLOSED SUBSTITUTION: psql at the manifest `ports.pg` is unreachable ("too many clients" — embedded PG `max_connections=8` fully consumed by the app pool) and `telemetry_get_stats` exceeds the bridge request timeout; live receipt taken from the app-pool (`feature_data_read` canonical rows) + the OTLP/HTTP ingest of the F-50 seed (4 spans, HTTP 200). G-284/G-307): Live-pipeline receipt — `telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)` (PG via the managed `psql`, or a disclosed `telemetry_get_stats` substitution).
- [x] S-8 (PASS 2026-10-05 #2970 r1 — `storage_engine_status={engine:"postgres",ready:true,fallbackReason:null}`): **PG-default boot** — `storage_engine_status` = PostgreSQL / PG supervisor ready (not SQLite).
- [x] S-9 (PASS 2026-10-05 #2970 r1 — Mission Monitor rendered the seeded session list incl. `e2e-copilot2933` with a gpt-4o node while the secret-activation slice was present): Mission Monitor still renders live sessions with the Doom feature present (the F-MM smoke row).
- [x] S-10 (PASS 2026-10-04 #2969 r1 — `doom-autoplay-toggle` + `doom-autoplay-status` render in the doom window): **Doom autoplay surface reachable** — with the `doom` window open, `doom-autoplay-toggle` and `doom-autoplay-status` render (ST-7 hooks). (Autoplay slice #2969.)
- [x] S-11 (PASS 2026-10-04 #2969 r1 — toggle click → status "Autoplay · step 28 · tic 1164 · alive" → … → "Autoplay complete · 600 steps · alive"; Stop button mounted while running; stop → idle; no console errors; no orphan): **Autoplay start/stop quick path** — with the stub engine + scripted lever, click `doom-autoplay-toggle`: `doom-autoplay-status` shows `Running`; click `doom-autoplay-stop`: phase returns to `Idle`. No console `Error:`/`Uncaught`/`Maximum update depth exceeded`; a bounded run leaves no orphan process.

---

## Secret-activation slice (Spec #2970) — smoke additions

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (non-zero
> count + recent `max(ingested_at)`; managed `psql` at the manifest `ports.pg`, G-284, or a
> disclosed substitution). Doom Mode emits no span. A static-only smoke cannot pass.

- [x] S-12 (PASS 2026-10-05 #2970 r1 — typed `iddqd` → active origin code; `doom` window + real engine `restful-doom.exe` + real pixels): **Secret activation quick path (REAL engine)** — from a fresh pre-feature state (no Doom tile/window), type `iddqd` in the main window: `doom-mode-changed {phase:"active",active:true,origin:"code"}`; the `doom` window opens (`doom-root` + `doom-window-title`="Doom"); `doom-frame-canvas` renders real pixels; `DoomStatus.enginePath` basename == `restful-doom.exe`. (Requires F-49 staging; a stub-only receipt is a FALSE PASS.)
- [x] S-13 (PASS 2026-10-05 #2970 r1 — clicked `doom-exit-button` → `doom-mode-changed {active:false}`, voiceSuppressed false, window closed, zero engine): **Secret exit quick path** — with the mode active, click `doom-exit-button`: `doom-mode-changed {active:false}`; `get_doom_mode_status.voiceSuppressed === false`; the `doom` window closes; zero `restful-doom.exe` within `DOOM_STOP_TIMEOUT_S`.
- [x] S-14 (PASS 2026-10-05 #2970 r1 — while active (voice enabled) `stt_start` → `{started:false,code:"disabled"}`, voiceSuppressed true; after exit `stt_start` → `started:true`): **Suppression observable** — while active, `stt_start` returns `{started:false, code:"disabled"}` and `get_doom_mode_status.voiceSuppressed === true`; after the S-13 exit, `stt_start` proceeds (voice otherwise enabled).
- [x] S-15 (PASS 2026-10-05 #2970 r1 — no Doom/iddqd on the rendered launcher grid/search, Settings sidebar, Settings→Apps, or hotkey listing; `doom-entry-button` absent): **Secrecy** — before activation, no "Doom"/"iddqd" text is rendered on the launcher grid, Settings→Apps list, Settings sidebar, or help/hotkey surfaces; `doom-entry-button` is absent. (Scope: rendered surfaces only, not source/test files.)
- [x] S-16 (PASS 2026-10-05 #2970 r1 — PG ready; MM rendered ≥1 live session; live receipt via the disclosed app-pool substitution (see S-7)): **PG-default boot + Mission Monitor (F-50 gate)** — `storage_engine_status` = PostgreSQL / PG supervisor ready; Mission Monitor renders ≥1 live session with the secret-activation slice present; the live-pipeline receipt is non-zero with a recent `max(ingested_at)`.

---

## Whole-app theme + armored avatar slice (Spec #2971) — smoke additions

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (non-zero count +
> recent `max(ingested_at)`; managed `psql` on the PG default, G-284, or a disclosed app-pool
> fallback, G-307). Doom emits no span. A static-only smoke cannot pass.

- [x] S-17 (PASS 2026-10-05 #2971 r1 — typed `iddqd` (real engine, pid 24460) → `<html class="doom-mode" data-doom-mode="engaged">`; token restyle; `data-doom-armor="true"` + `#fredo-armor`): **Enter quick path (REAL engine)** — re-stage the engine (G-319); from a fresh inactive boot type `iddqd`: `<html class="doom-mode" data-doom-mode="engaged">`; the app surfaces restyle via the token contract; the avatar shows `data-doom-armor="true"` + `#fredo-armor`. (A stub-only receipt is a FALSE PASS.)
- [x] S-18 (PASS 2026-10-05 #2971 r1 — `doom-exit-button` → every `--*` var + body + avatar byte-equal the pre-enter snapshot; no `doom-mode`/`data-doom-armor`; `Fredo_theme_*` unchanged): **Exit quick path** — click `doom-exit-button`: every `--*` var + `document.body` + avatar byte-equal the pre-enter snapshot; no `doom-mode`/`data-doom-armor`; persisted `Fredo_theme_*` keys unchanged.
- [x] S-19 (PASS 2026-10-05 #2971 r1 — no Doom in `ThemePresetSelector`/`allPresets` (18 built-ins); no Doom `SettingsSurface` nav item; no Doom token applied; avatar unarmored): **Secrecy** — before activation, no "Doom" entry in `ThemePresetSelector`/`allPresets`, no Doom `SettingsSurface` nav item, no Doom token applied, avatar unarmored.
- [x] S-20 (PASS 2026-10-05 #2971 r1 — `tauri_read_logs(console)` clean across enter/exit; only a pre-existing `motion()` deprecation WARN): **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded` across the enter/exit legs.

---

## Resume-across-sessions slice (Spec #2972 / updated #3011) — smoke additions

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (non-zero count +
> recent `max(ingested_at)`; app-pool read `application_store_query`, G-284/G-307; `psql` is
> pool-saturated/unreachable — NEVER named). Doom emits no span. A static-only smoke cannot pass.
>
> **Real-engine scope:** the resume quick path (S-21) uses the REAL `restful-doom.exe` re-staged
> per G-319 (readiness gate `get_doom_status.phase="ready"` + `GET /api/state` 200); the stub is
> only for the deterministic advance/completion leg (S-23).

- [ ] S-21 (REAL engine — updated #3011) **Resume quick path** — seed a valid `DoomSave` at E1M2 via `FREDO_DOOM_SAVE_STATE_DIR` (`<dir>/doom-save.json`); re-stage the real engine; enter Doom Mode. EXPECTED: the engine positions at `level.episode=1, level.map=2` (one `POST /api/episode` before the first step); `doom-save-status` renders `E1M2`; the companion steps forward. (A stub-only receipt is a FALSE PASS.)
- [ ] S-22 (updated #3011) **Fresh-start quick path** — with a valid save present, click `doom-fresh-start-button` → confirm (`doom-fresh-start-confirm`). EXPECTED: the run starts at E1M1; before the first advance the prior save (`feature_doom_save` singleton row / state-dir fixture) is unchanged; `doom-save-status` updates to `E1M1` only once the run advances.
- [ ] S-23 (stub — updated #3011) **Advance/complete quick path; ONE row / no append** — stub `FREDO_DOOM_STUB_DONE_AFTER=<n>` on the production PG path (no state-dir env). EXPECTED: a level exit advances + UPSERTS the singleton row (`application_store_query` still returns exactly ONE row); at the final level `phase=completed`, `code="campaignComplete"`, `doom-progress-complete` renders. Disclose the deterministic-stub split.
- [ ] S-24 (F-69 gate — updated #3011) **PG-default boot + Mission Monitor + corrupt-save safety** — boot end-to-end; seed a qualifying session; boot with a corrupt state-dir fixture (`FREDO_DOOM_SAVE_STATE_DIR` → `not json`) or `FREDO_DOOM_SAVE_FORCE_FAIL=read`. EXPECTED: `storage_engine_status` = PostgreSQL / PG supervisor ready; Mission Monitor renders ≥1 live session; the mode enters on a clean run with no crash; `get_control_setting('doom_save_v1')` → null; live-pipeline receipt non-zero + recent `max(ingested_at)`.

---

## Dedicated PostgreSQL feature-store slice (Spec #3011) — smoke additions

> **Verification policy: live** — app-pool read `application_store_query` (G-284/G-307; `psql` NOT
> named) + the `telemetry_spans` receipt. Doom emits no span. A static-only smoke cannot pass.

- [ ] S-25 (REAL engine) **PG save round-trip quick path** — drive a real level transition (production PG path); `application_store_query({applicationId:'doom',tableName:'save'})` returns exactly ONE `id='singleton'` row with the typed columns; `get_doom_save` matches. (A stub-only receipt is a FALSE PASS.)
- [ ] S-26 **No control-plane save key** — `get_control_setting('doom_save_v1')` → null while the save exists in `feature_doom_save`; the IPC monitor shows the save/resume path touching only `doom`/`save`, never the control plane.
- [ ] S-27 (F-MM3011 gate) **Full-restart survival** — after a durable save, fully quit + relaunch; re-enter Doom Mode; `get_doom_save` reports the saved coords BEFORE any step (row read from `feature_doom_save`).

---

## Engine-provisioning slice (Spec #3012) — smoke additions

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (app-pool read,
> G-307; fallback managed `psql` at the manifest `ports.pg`, G-284, DISCLOSED). Doom emits no span.
> A static-only smoke cannot pass. **A stub engine is not a valid smoke engine (G-033/G-314).**

- [ ] S-28 (REAL engine) **First-use provisioning quick path** — fresh install dir (no staged engine) + `FREDO_DOOM_TOOLCHAIN_ROOT` at a usable MSYS2 (the committed script probes internally, G-322); type `iddqd`. EXPECTED: `doom-provision-dialog` → confirm → `doom-provision-progress` reaches `ready`; the REAL `<install_dir>/engine/restful-doom.exe` is built from `vendor/restful-doom/` at the pinned commit and launches (`/api/state` 200); the game renders; ZERO orphans after.
- [ ] S-29 **Cancel / error quick path** — start provisioning, click `doom-provision-cancel` → phase `cancelled`, zero orphans within 5 s; re-enter with `FREDO_DOOM_BUILD_OFFLINE=1` (no usable root) → `doom-provision-error` shows `toolchainUnavailable`, no crash. (Levers G-275/G-300.)
- [ ] S-30 (F-89 gate) **PG-only boot + Mission Monitor** — `storage_engine_status` = PostgreSQL / PG supervisor ready; seed the rollup-qualifying `e2e-copilot2933` OTLP fixture; assert the DECLARED `sessions` row `visibleTurnCount ≥ 1` BEFORE the list; Mission Monitor renders ≥1 `.mm-session-row`; live receipt non-zero + recent `max(ingested_at)`.

---

## Managed-only engine resolution slice (Spec #3013) — smoke additions

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (app-pool read, G-307;
> fallback managed `psql` at the manifest `ports.pg`, G-284, DISCLOSED). Doom emits no span. A
> static-only smoke cannot pass. **A stub engine is not a valid smoke engine (G-033/G-314).**

- [ ] S-31 (REAL engine) **Managed-only quick path** — stage the REAL managed engine; `launch_doom_runtime`. EXPECTED: `DoomStatus.enginePath` == `<install_dir>/engine/restful-doom.exe`; exactly ONE `restful-doom.exe` PID; live frame / `/api/state` 200; no PATH spawn / no download.
- [ ] S-32 **Absent-engine quick path** — `FREDO_DOOM_INSTALL_DIR=.opencode/tmp/3013/fixtures/absent`; type `iddqd`. EXPECTED: `provisionRequired`/`provisionFailed`/`notConfigured`; mode `inactive`; no window; zero engine PID; no download.
- [ ] S-33 **Fail-engine quick path** — `FREDO_DOOM_FAIL_ENGINE_SPAWN=1` over a staged managed engine. EXPECTED: `SpawnFailed` before spawn; zero engine PID; no window. Then the `fail-engine` fixture (MZ-only) → the real spawn failure path → `SpawnFailed`, no substitute.
- [ ] S-34 (F-99 gate) **PG-only boot + Mission Monitor** — `storage_engine_status` = PostgreSQL / PG supervisor ready; seed the rollup-qualifying `e2e-copilot2933` OTLP fixture; assert the DECLARED `sessions` row `visibleTurnCount ≥ 1` BEFORE the list; Mission Monitor renders ≥1 `.mm-session-row`; live receipt non-zero + recent `max(ingested_at)`.
- [ ] S-35 (CI-parity) **Build hygiene** — `cargo check --locked` ZERO warnings; `cargo test --locked` green incl. the `failure_seam` parser unit test; `pnpm --filter @fredo/ui build` green.
