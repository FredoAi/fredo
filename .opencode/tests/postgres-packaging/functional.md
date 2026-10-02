# postgres-packaging — Functional

Durable functional suite for the **embedded-PostgreSQL packaging & install** feature domain
(acquisition mode, SHA-pinned integrity, measured footprint, Windows distribution quality, release
gate). Seeded at issue **#2978** (slice 5 of 6; builds on slices 1–4: `postgres-lifecycle` #2974,
`postgres-stores` #2975/#2976, `postgres-migration` #2977). Inherited and extended by slice 6
(#2979) and any later packaging change.

> **This is a NEW domain**, distinct from the spike's `embedded-postgres-migration` (#2964, a
> **static** spike-deliverable suite with no telemetry/span/UI surface). This slice has live
> surfaces: app boot, a real 164,026,008 B acquisition transfer, induced error paths, no-console-flash
> observation, and measured installer/footprint numbers.

> **Evidence policy: LIVE.** The boot + Mission Monitor E2E (F-13), the acquisition transfer (F-3),
> the error paths (F-4/F-5), and the measured numbers (F-8/F-10/F-11/F-12) are provable ONLY by
> observing a running/measured artifact. The Tester's Evidence MUST reference a live receipt (DOM
> snapshot, screenshot, measured bytes, `psql` row, `telemetry_spans`). A static-only PASS is a
> FALSE PASS.

> **G-284 PG read lever (disclosed substitution).** The `telemetry-query` skill is SQLite-only and
> CANNOT read the PostgreSQL store. For every live PG read use the managed `psql`
> (`%APPDATA%\com.fredo.app\postgres-install\18.6.0\bin\psql.exe`) via the allowlisted wrapper
> (`run-exitcode.ps1`), URI built from `pg_supervisor_status` (`{state, port, pid, dataDir}`) + the
> `postgres.password` AppStore key (`PG_PASSWORD_KEY`). A missing lever is a TOOLING GAP to `block`
> on — never a reason to fail a live leg. The `telemetry_spans` cross-check (F-13) uses the
> `telemetry-query` skill (SQLite-side).

> **G-263 SAFETY (named failure mode: the #2948 ~11 h `pg.stop()` hang).** NEVER run an unbounded
> binary. Every live leg starts/stops through the sanctioned lever
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2978` / `-Action Down`
> (kill-never-wait on expiry; `-EnvVar NAME=value` for env seams); never a bare `postgres`/`pg_ctl`.
> The first-run acquisition is a real 164,026,008 B transfer — bound the whole run (≤ 900 s) with a
> finite outer timeout. An observed unbounded/blocking wait is a FAIL, not a skip.

> **Induction levers (G-275) — BINDING names (G-255), owned by S2.** `FREDO_PG_DATA_DIR` (SHIPPED,
> `features/pg_supervisor/mod.rs:65`) → `.opencode/tmp/2978/pgdata/`. Added by this slice (inert when
> unset): `FREDO_PG_INSTALL_DIR` → `.opencode/tmp/2978/pg-install/`; `FREDO_PG_ARCHIVE_URL` →
> `.opencode/tmp/2978/acq-offline/` (unreachable endpoint); `FREDO_PG_ARCHIVE_SHA256` and/or a
> truncated archive under `.opencode/tmp/2978/acq-corrupt/`. If S2 does not ship these seams the
> AC2/AC4 rows ship UNVERIFIED.

> **G-130 real transfer class.** F-3 reproduces the real volume/timing class — a real archive
> transfer OR a deliberately idle/slow stream with a partial at a realistic offset (≥ 50% of
> 164,026,008 B), never only a fast KB-scale stub.

## Cases

- [ ] **F-1 (REQ-1 / AC1) — acquisition mode explicit, build-time enforced, priced.**
  Read `apps/tauri/src-tauri/Cargo.toml:52-56`; build the default branch and the `bundled` branch;
  read `cargo metadata` / `cargo tree -e features -p postgresql_embedded`.
  **Expected:** exactly ONE shipped mode. Default `runtime-download` (no `bundled` feature enabled;
  installer growth ~0 B; first-run 164,026,008 B fetch). `bundled` (a Cargo feature enabling
  `postgresql_embedded/bundled`; installer +54,048,768 B; no first-run network; one build-time
  fetch). The chosen mode is recorded with its measured installer/footprint consequence.
  **FAIL** = both features enabled, a runtime-selected mode, or an unrecorded consequence.

- [ ] **F-2 (REQ-2 / AC1, Q-1, G-123) — the choice is recorded before the mode is fixed; BOTH
  branches are exercisable.**
  Read the recorded decision; build + boot each branch.
  **Expected:** the recorded artifact names the offline-first answer (Q-1) and the shipped mode;
  BOTH branches build and boot; the recorded choice matches the built feature set.
  **Edge/FAIL:** Q-1 unanswered and the mode silently defaulted (must be recorded PENDING with Q-1
  named); recorded choice ≠ built branch.

- [ ] **F-3 (REQ-3 / AC2, G-130) — SHA-pinned streaming acquisition with `Range` resume at a
  realistic partial offset.**
  Acquire the archive (runtime-download) with a seeded partial at ≥ 50% of 164,026,008 B; observe the
  GET and the digest.
  **Expected:** a `Range: bytes=<offset>-` GET; the streaming SHA-256 is seeded from the on-disk
  prefix BEFORE the GET; the final digest equals the pinned digest; skip-if-verified does not
  re-fetch a complete archive; the run completes within its finite bound.
  **FAIL** = a full re-fetch on resume, a digest over only the streamed suffix, or an idle fixture
  that never reproduces the real transfer class.

- [ ] **F-4 (REQ-4 / AC2, G-275) — a digest mismatch DELETES the artifact and surfaces an actionable
  error.**
  Point the acquisition at `.opencode/tmp/2978/acq-corrupt/` (truncated/corrupt archive) or override
  `FREDO_PG_ARCHIVE_SHA256`.
  **Expected:** the artifact is DELETED; a structured, actionable error surfaces; the distribution
  is NOT extracted; the app does not silently proceed.
  **FAIL** = a retained partial/mismatched artifact, an extraction despite the mismatch, or an error
  with no action.

- [ ] **F-5 (REQ-5 / AC4, G-275) — a first-run network failure surfaces a clear, retryable error and
  never leaves a half-extracted distribution.**
  Point the archive URL at an unreachable endpoint (`FREDO_PG_ARCHIVE_URL`) with install dir
  `.opencode/tmp/2978/acq-offline/`; run first launch.
  **Expected:** a clear, RETRYABLE error; NO half-extracted distribution (the install dir holds no
  partial tree); a retry after restoring the network completes; the failure is bounded.
  **FAIL** = a silent half-extract, a non-retryable error, or an unbounded wait.

- [ ] **F-6 (REQ-6 / AC3, G-275) — the app launches without a console flash.**
  Launch the GUI with the embedded server enabled; enumerate console windows / observe process
  creation.
  **Expected:** no console window appears on launch; the postmaster is spawned hidden (creation
  flag / wrapper). Exercise a cold first run (acquisition + initdb) AND a warm run, in both modes.
  **FAIL** = a console flash, or no seam to observe the spawn flags (named blocker + sub-task).

- [ ] **F-7 (REQ-7 / AC3) — the server log tail is available.**
  Locate + tail the server log after a live run.
  **Expected:** a server log tail exists at a known path with recent lines, readable by standard
  tooling. **FAIL** = no log artifact, or a log that cannot be tailed.

- [ ] **F-8 (REQ-8 / AC3) — unpacked footprint + steady-state data-dir growth measured and recorded.**
  Measure the unpacked install footprint; measure steady-state data-dir growth under the tuned
  retention/autovacuum configuration over a defined window.
  **Expected:** unpacked footprint ~156 MiB (164,026,008 B extracted) measured + recorded;
  steady-state data-dir growth measured under the tuned config and recorded.
  **FAIL** = a restated spike number with no re-measurement, or a transient (non-steady-state)
  measurement.

- [ ] **F-9 (REQ-9 / AC4, G-123) — `bundled` needs no runtime network; the build-time fetch is
  documented as outside Fredo's integrity surface.**
  Build `--features bundled`; disable runtime network; boot; inspect the build-time fetch
  documentation.
  **Expected:** no runtime network for the archive; the build-time fetch is documented as outside
  Fredo's integrity surface (or replaced by a SHA-pinned resource); the documentation is present.
  **FAIL** = a hidden runtime fetch, or absent/hand-wavy documentation.

- [ ] **F-10 (REQ-10 / AC5) — install delta measured and matches the declared mode.**
  Measure the installer size for both branches; observe first-run behavior.
  **Expected:** a BEFORE/AFTER/Δ byte table — `runtime-download` ~0 B growth + a bounded first-run
  download; `bundled` +54,048,768 B + no first-run network; the extracted payload is ~164,026,008 B
  either way. **FAIL** = a restated spike number, or a delta that does not match the declared mode.

- [ ] **F-11 (REQ-11 / AC5) — steady-state data-dir reported against +60,565,072 B.**
  Measure the steady-state data dir; compare to the baseline.
  **Expected:** the position is stated verbatim **MITIGATE + RE-MEASURE**; a measured number is
  recorded; a mitigation is implemented (autovacuum/WAL sizing + the existing retention prunes).
  **FAIL** = a restatement with no re-measurement, or no mitigation implemented.

- [ ] **F-12 (REQ-12 / AC5) — peak RSS MITIGATE.**
  Measure peak RSS before/after the tuned server memory knobs.
  **Expected:** a number table vs the #2948 baseline (8.2× / +232.7 MiB); the position stated
  verbatim **MITIGATE**; the single-client desktop knobs implemented, not described.
  **FAIL** = a restatement with no re-measurement, or absent knobs.

- [ ] **F-13 (REQ-13 / HUMAN MANDATORY DIRECTIVE, G-256) — boot + Mission Monitor E2E (LIVE).**
  After the packaging/install changes, boot the app in BOTH modes; drive a LIVE agent action so OTLP
  spans ingest (real OpenCode via Terminal — `fredo emit` writes NO spans); open Mission Monitor;
  cross-check `telemetry_spans` at the same instant.
  **Expected:** the app BOOTS in both modes; Mission Monitor lists the live session and renders chat
  / tools / tokens / graph; `telemetry_spans` returns the landed rows for that session at the same
  instant; no console errors. Modeled on `mission-monitor` F-54 / `postgres-migration` F-12.
  **FAIL** = a blank panel while rows exist, a boot failure after the packaging change, a static-only
  receipt, or only one mode exercised. **This leg applies to this slice AND every following Postgres
  slice.**

- [ ] **F-14 (REQ-14 / NFR) — zero-warning build gates + bundle config intact.**
  Run `cargo check --locked`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`, and
  `cargo check --features bundled`; inspect `tauri.conf.json:53-54`.
  **Expected:** all gates green on BOTH feature branches; zero warnings; no `#[allow(...)]`;
  `externalBin`/`resources` unchanged or correctly declared for the chosen mode.
  **FAIL** = check green but clippy red (does NOT clear the gate), or a bundle-config change that
  breaks the other mode.

## Non-functional

- [ ] **N-1 (boundedness):** every external-runtime step is finite (G-263); the named failure mode is
  the #2948 ~11 h `pg.stop()` hang; no unbounded/blocking wait (F-3/F-5/F-6).
- [ ] **N-2 (integrity):** the acquisition is digest-pinned; a mismatch deletes and errors; no partial
  extract (F-3/F-4/F-5).
- [ ] **N-3 (footprint budgets):** unpacked ~156 MiB, data-dir vs +60,565,072 B, RSS vs 8.2× — each
  measured and recorded with its verbatim position (F-8/F-10/F-11/F-12).
- [ ] **N-4 (build hygiene):** F-14 green on both feature branches; Windows-first.
- [ ] **N-5 (no row-pipeline regression):** F-13 green; the packaging change does not alter the RTDB
  row pipeline (emission still ONLY via `EventBus.emit_row_delivery_batch`).

## Suite-level pass/fail

PASS = F-1..F-14 green with LIVE evidence (a measured byte receipt; a `telemetry_spans` read; a DOM
snapshot / screenshot; a process observation) and N-1..N-5 holding. Any of: a mode not build-time
enforced; a mode recorded without the Q-1 answer (and not marked PENDING); a corrupt/truncated
acquisition that extracts a partial distribution; a first-run failure that leaves a half-extracted
tree; a console flash; no server log tail; a restated spike number where a re-measurement is named; a
static-only receipt on F-13; or an unbounded/blocking wait = **FAIL**.
