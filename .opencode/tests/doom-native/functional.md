# doom-native — Functional Test Cases (Spec #3023)

> Durable functional suite (feature domain `doom-native`). One `- [ ]` case per requirement;
> observable expected outcome per case. Formalizes the Implementation Plan #3023 `### QA Plan`.
> This suite is a NEW feature domain (a **full rewrite** of `applications/doom`): the
> RESTful-DOOM out-of-process engine, loopback HTTP bridge, MSYS2 from-source provisioning,
> vendored GPL source, and Freedoom acquisition are replaced by a **native in-process** engine
> on the bundled `apps/tauri/src-tauri/doom/DOOM1.WAD` (shareware, 4,196,020 bytes).
>
> **Verification policy: live** — a running-system / UI-rendering feature. The tester's Evidence
> MUST reference `telemetry_spans` (a live-query result: NON-ZERO count + recent `max(ingested_at)`;
> app-pool read preferred, G-307; managed `psql` on the PG default as a DISCLOSED fallback, G-284)
> at round start AND after the drive. **Doom emits NO OTLP span — the query proves the live
> pipeline, not the feature; DISCLOSE it.** A static-only PASS is a FALSE PASS (G-033).
>
> **Evidence mechanics.** Live rows cite: (a) the `telemetry_spans` reference; (b) a screenshot/DOM
> receipt; and, for teardown/security rows, (c) a **process-list check** (`tasklist` / process
> inventory — zero `restful-doom.exe` / separate engine image, only `fredo.exe`) and (d) a
> **port check** (`Get-NetTCPConnection -State Listen` / `netstat -ano` — no Doom API listener).
>
> **Step-driven runtime (G-316).** The native runtime is expected lockstep/step-driven: a lockstep
> runtime does NOT advance while idle, so every "advances" row is STEP-DRIVEN — drive a step through
> the parity control surface, then re-sample. Never an idle-frame / wall-clock motion assertion.
>
> **Real execution, not a stub/script (G-314).** AC4's offline fresh-install row needs the native
> engine to ACTUALLY run and play; a committed-but-never-run script or a stub is never a PASS (G-033).
>
> **Error-path levers (G-275/G-300).** `FREDO_DOOM_FAIL_ENGINE_SPAWN=1` (retained/adapted
> `failure_seam.rs`, forces native engine start failure) and a WAD-path override
> (e.g. `FREDO_DOOM_WAD_PATH`) → a tester-written copy under `.opencode/tmp/3023/wad/` (missing /
> truncated / garbage). The SHIPPED WAD is never mutated. Any error edge with no lever is a
> static/unit pin marked non-AC.
>
> **Map-set reality.** `DOOM1.WAD` is single-episode (E1M1–E1M9). The campaign model MUST match:
> resume within E1 only; NO E2/E4. `save.rs:70` (`DOOM_CAMPAIGN_LAST_EPISODE = 4`) must be rescoped.
>
> **Scratch:** `.opencode/tmp/3023/`. Env overrides via the `dev-environment` skill
> (`dev-env.ps1 -EnvVar`, single delimited / helper-script form). **Real-engine scope:** live
> game legs run the NATIVE in-process engine — there is no stub engine for the happy path.

## AC1 — native in-repo implementation, no separate engine, no loopback bridge

- [ ] F-1 (AC1, REQUIRED) **Native runtime live frame.** Activate Doom Mode (`iddqd`) from the fresh
  pre-feature state (G-265, no `doom` window / no Doom tile); capture DOM + screenshot + process
  inventory + port check.
  - EXPECTED: (a) `doom-frame-canvas` paints REAL `DOOM1.WAD` pixels — a dense/full-frame diff
    between two frames a **driven STEP** apart is non-zero (G-213/G-216), corroborated by a vision
    read + screenshot under `.opencode/tmp/3023/e2e/`; (b) exactly ONE `fredo.exe` and ZERO
    `restful-doom.exe` / separate engine image in the process inventory; (c) the runtime code lives
    under `apps/tauri/src-tauri/src/applications/doom`; (d) the `starting`→`ready` phase is
    observable; (e) no second OS window.
  - Edge: a stub or an unrun committed script standing in = FALSE PASS (G-314/G-033);
    entry reachable from the fresh pre-feature state.
- [ ] F-2 (AC1) **No loopback HTTP engine bridge.** Static grep of the doom module + live port check.
  - EXPECTED: `apps/tauri/src-tauri/src/applications/doom` has 0 hits for `reqwest`/`tiny_http`/
    `TcpListener`/`/api/state`; `client.rs` is removed; no `-apiport` argv; the port check shows no
    Doom API listener owned by `fredo.exe`; `tauri.conf.json` `connect-src` is unchanged.
  - Edge: no runtime socket bound for the game; webview CSP unchanged.

## AC2 — bundled `DOOM1.WAD`, no Freedoom download, no retail path

- [ ] F-3 (AC2) **Bundled WAD is the game data.** Live run + WAD identity.
  - EXPECTED: the run renders from `apps/tauri/src-tauri/doom/DOOM1.WAD`; the resolved path is that
    bundled file; record its SHA-256 (source the literal from the enforcing artifact, G-320) and
    byte size (4,196,020); no network fetch during boot/play.
  - Edge: WAD path resolves with no stored setting; offline boot (F-7) still plays.
- [ ] F-4 (AC2) **No Freedoom download; no retail-WAD path.** Static grep + live offline + negative lever.
  - EXPECTED: `acquisition.rs` absent; the tree contains no Freedoom acquisition/URL/SHA; no
    retail-WAD selection UI, setting, or documented path. A retail WAD supplied via any retained env
    seam is ignored or refused — never loaded.
  - Edge: retail-WAD env/setting must not switch the data source; offline boot still playable.

## AC3 — parity surface + autonomous bounded end-to-end play

- [ ] F-5 (AC3) **Parity surface vs `gunnargrosch/doom-mcp`.** Enumerate the native
  observation/control surface and diff against the Architect's pinned parity table.
  - EXPECTED: every capability in the Architect-fixed doom-mcp reference functional surface has a
    corresponding native operation — observation (state), control (step/advance + the action/input
    set), level/episode control, and frame/observation. Document the exact method/path per item.
  - Edge: a surface item with no native equivalent = AC3 gap; capability present but not
    observable/addressable = gap. **CONDITIONAL** — if the Architect's parity table is absent, return
    a NAMED blocker, never a PASS (G-053).
- [ ] F-6 (AC3, REQUIRED) **Autonomous bounded end-to-end play.** From the fresh pre-feature state,
  enter Doom Mode; make NO further input; sample `get_doom_autoplay_status` ≥3×.
  - EXPECTED: the companion autonomously plays THROUGH the native parity surface with ZERO user
    input; the run is BOUNDED (`get_doom_autoplay_status` reaches a terminal phase within
    `DOOM_AUTOPLAY_MAX_STEPS`); the world advances STEP-DRIVEN (G-316); frames render live.
  - Edge: a single observation read alone does NOT advance; budget exhaustion ends cleanly; no
    orphan after the run.

## AC4 — offline fresh-install playable; removal set absent

- [ ] F-7 (AC4, REQUIRED, G-314) **Offline fresh-install playable — real execution.** Fresh install
  dir + NO network; enter Doom Mode.
  - EXPECTED: the native engine actually RUNS and plays with NO toolchain download and NO
    from-source build; the run renders/plays from the bundled WAD; no `vendor/`+`scripts/doom/`
    build is invoked; no MSYS2/toolchain acquisition occurs.
  - Edge: a committed-but-never-run script or a stub is NOT a PASS; a pre-staged leftover is not the
    fresh path — clear scratch first (G-319).
- [ ] F-8 (AC4) **Removal set absent.** Tree pins + a live boot that never builds/downloads.
  - EXPECTED: `vendor/restful-doom/` absent; `scripts/doom/` absent; `provision.rs` absent;
    `acquisition.rs` absent; GPL corresponding-source resources absent (no `doom/source/` in
    `tauri.conf.json` bundle resources); `mod.rs`/`lib.rs` carry no dangling references; the live
    boot performs zero downloads and zero builds.
  - Edge: no committed engine binary or non-open WAD; no orphan toolchain process.

## AC5 — persistence (E1 set), resume, typed errors, no crash / no orphan

- [ ] F-9 (AC5) **Persist advance/death/complete on the E1 map set.** Drive a level advance within
  E1 (E1M5 → E1M6), a death, and E1 completion; read `get_doom_save`.
  - EXPECTED: on a level ADVANCE the resume point persists at the new E1 coords; a DEATH restarts
    the same level WITHOUT advancing/persisting; reaching the final map records completion. Every
    persisted/returned coordinate is `episode=1, map∈1..=9` — NO E2/E4 value ever appears.
  - Edge: resume across an E1 map boundary; a save with `episode=2/4` or an out-of-set map is
    rejected (clean run); completion state survives.
- [ ] F-10 (AC5) **Resume on a later activation.** After a persisted E1 point, close the window;
  re-enter Doom Mode; read BEFORE any step.
  - EXPECTED: `get_doom_save` reports the saved E1 coords BEFORE the first step; the native engine
    positions at that level; a full app quit+relaunch also resumes there.
  - Edge: fresh boot + re-enter; a valid save wins over the initial level; a corrupt save yields a
    clean E1M1 start (no crash).
- [ ] F-11 (AC5) **Engine-start failure → typed in-window error; no crash; no orphan.**
  `FREDO_DOOM_FAIL_ENGINE_SPAWN=1`.
  - EXPECTED: the native engine fails to become ready; `doom-error` renders a typed error in-window
    (`role="alert"`, focus→Retry; `data-doom-error-code="engineStartFailed"` if the G-324 hook is
    accepted, else by rendered copy); the app does NOT crash; ZERO orphan process/thread; no Doom
    API listener.
  - Edge: no half-started window; the rest of Fredo normal; unsetting the lever + Retry recovers.
- [ ] F-12 (AC5) **Missing/corrupt WAD → typed in-window error; no crash; no orphan.**
  `FREDO_DOOM_WAD_PATH` → missing, then a truncated/garbage copy under `.opencode/tmp/3023/wad/`.
  - EXPECTED: `doom-error` renders a typed error in-window for BOTH missing
    (`data-doom-error-code="wadMissing"`) and corrupt (`="wadCorrupt"`) — codes per the UI/UX
    proposal; if the G-324 hook is not shipped, assert by rendered copy. No crash, no orphan, no hang.
  - Edge: corrupt = truncated/garbage; Retry with the bundled WAD recovers; the shipped WAD is never
    mutated.
- [ ] F-16 (AC5, UI/UX-requested) **Retry is idempotent — no second engine, no orphan.** From each
  error class (F-11/F-12) click `doom-retry-button` while the failure is still forced, then again
  after clearing it.
  - EXPECTED: a Retry while the failure persists re-renders the SAME typed error with ≤ ONE engine
    attempt and ZERO orphan; a Retry after clearing the lever recovers to a playable run; at NO point
    do two engine instances/threads exist.
  - Edge: rapid double-Retry; Retry while `starting`; process inventory after each Retry = zero
    engine image.

## Non-functional

- [ ] F-13 (NFR, G-263) **No orphan on every exit path** — window close, app exit, start-failure,
  hard-kill+relaunch. EXPECTED: on EVERY path the process inventory shows zero engine image (only
  `fredo.exe`); any thread/task the native engine started is joined/hard-killed; the startup sweep
  reclaims a hard-killed leftover; a reused unrelated PID is never killed.
- [ ] F-14 (NFR, security) **No network listener; loopback-only if any** — port check + CSP pin.
  EXPECTED: no listener bound by `fredo.exe` for a Doom API; if any loopback control surface exists
  it is `127.0.0.1`-only and NOT reachable from the webview.
- [ ] F-15 (NFR, build) **CI-parity build hygiene.** EXPECTED: `cargo check --locked` ZERO warnings;
  `cargo test --locked` green (CI: `cargo nextest run --locked`, `.github/workflows/validate.yml:99-101`);
  `cargo clippy --locked -- -D warnings` clean; `pnpm --filter @fredo/ui build` green if UI touched.
  Edge: no `#[allow(...)]` suppressions; no new warnings.
- [ ] F-LIVE (live-pipeline receipt) Query `telemetry_spans` at round start AND after the drive.
  EXPECTED: NON-ZERO count + recent `max(ingested_at)` BOTH times. Doom emits no span — DISCLOSE.
  Edge: managed-`psql` pool-saturated → app-pool `feature_data_read` substitution, DISCLOSED (G-307).

**Error-class coverage:** `engineStartFailed`→F-11 · `wadMissing`→F-12 · `wadCorrupt`→F-12 · Retry
idempotency→F-16.
