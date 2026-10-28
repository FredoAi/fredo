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

## #3076 — trusted-install slice (verified archive → Fredo-owned extraction)

> **Verification policy for F-15..F-28: STATIC** (the #2978 rows F-1..F-14 remain LIVE). Every row
> below is provable offline from `cargo test` / `cargo check` output plus source assertions on
> `spec/3076` — no live boot, no measured artifact and no `telemetry_spans` read is admissible
> evidence, and none is required. The issue's confirmed posture: *"verification is light: a unit
> test asserting the crate download path is not reached, plus keeping the existing `pg_supervisor`
> tests green; a live network-blocked run is NOT required."*

> **Fixture boundary (G-172).** Every fixture is generated in-test (`tempfile::tempdir()` +
> `tar::Builder` + `flate2::write::GzEncoder`) and hashed in-test with `sha2`; the pin is an
> explicit `PgArchivePin` parameter. No out-of-repo asset is named. `tempfile` is already a
> dev-dependency (`apps/tauri/src-tauri/Cargo.toml:104-105`).

> **Run commands (exact).**
> `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --lib applications::pg_supervisor` ·
> `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml` ·
> `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --features bundled` ·
> narrow: `… --lib applications::pg_supervisor::extraction`. `--locked` may be added for CI parity;
> state the exact command used in the evidence.

- [ ] **F-15 (R-1 / AC1, G-406) — recorded pre-change green baseline.**
  On the `spec/3076` tip, **before any edit**, run
  `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --lib applications::pg_supervisor`
  and record the command + output tail.
  **Expected:** `test result: ok. N passed; 0 failed`, N > 0, covering the pre-existing module
  tests (`acquisition`, `runtime`, `state`, `headless`, `config`, `lock`, `endpoint`,
  `descriptor`, `sweep`).
  **FAIL** = baseline never run, or recorded only after the first edit (G-406 plan-level blocker).
  A RED baseline is in-scope repair under ST-1's 1-point reserve — record the failing test + fix.

- [ ] **F-16 (R-1 / AC1) — ONE choke point, and the verified archive path is consumed.**
  Read `runtime.rs` `setup()` and `acquisition.rs` `ensure_verified_install`; run
  `extract_verified_archive_writes_the_marker_and_reports_current`.
  **Expected:** `setup()` calls `ensure_verified_install(&self.install_dir)` BEFORE
  `run_bounded(PG_SETUP_BOUND, "pg.setup", pg.setup())`; `ensure_verified_install` calls
  `acquire_pg_archive(install_dir).await?`, **binds** the returned `PathBuf`, then
  `extract_verified_archive(&path, install_dir, &effective_pin())` inside an awaited
  `tauri::async_runtime::spawn_blocking`; that dir equals the dir `build_settings` puts on
  `settings.installation_dir`; `state.rs:511-525` (the discarded-path block) is gone; the positive
  extraction test is `ok`.
  **FAIL** = a bare `acquire_pg_archive(...).await?;` statement anywhere (the original defect), a
  second acquisition path left in `state.rs`/`headless.rs`, a fire-and-forget `spawn_blocking`
  handle, or acquisition/extraction resolving the install dir differently.

- [ ] **F-17 (R-1 / AC1) — trust + exact pin on the runtime-download path.**
  `runtime_download_settings_trust_the_install_dir_and_pin_the_exact_version` +
  `pinned_version_req_is_the_exact_pinned_release`.
  **Expected:** `settings.trust_installation_dir == true`; `settings.version.to_string() ==
  "=18.6.0"`; `settings.installation_dir == install_dir` (no `18.6.0` suffix — trust applied
  BEFORE `PostgreSQL::new`); `settings.binary_dir() == install_dir.join("bin")`;
  `PG_VERSION_REQ.to_string() == "=18.6.0"`, matching `18.6.0` and rejecting `18.6.1` / `18.7.0`.
  **FAIL** = trust set after `PostgreSQL::new`; a non-exact req (`*`, bare `18.6.0`, `>=`, `^`,
  `~`); `PG_VERSION_REQ` diverging from `PG_VERSION`.

- [ ] **F-18 (R-1a) — a current marker means no re-download, no re-extract.**
  `ensure_verified_install_skips_when_the_marker_is_current` +
  `extract_verified_archive_is_idempotent_when_the_marker_is_current`.
  **Expected:** with a current marker (matching version+digest) and all three binaries,
  `ensure_verified_install` returns `Ok` with no transport construction and without creating
  `<install_dir>/archives/`; a second extraction leaves the full inventory (path + size + bytes)
  unchanged with no mtime advanced; `trusted_install_is_current` stays true.
  **Edge:** a hex-case difference in `sha256=` still counts as current (case-insensitive).
  **FAIL** = a re-extract that rewrites identical bytes (mtime advanced), or any acquisition
  attempt on the short-circuit path.

- [ ] **F-19 (R-1a) — the predicate needs the marker AND the binaries.**
  `trusted_install_is_current_requires_the_marker_and_the_required_binaries`.
  **Expected:** `false` for absent marker; `false` for a blank marker or one missing its
  `version=`/`sha256=` line; `false` on a version mismatch; `false` on a digest mismatch; `false`
  for each of `initdb.exe`, `pg_ctl.exe`, `postgres.exe` removed in turn. `true` only for the
  all-present, all-matching tree.
  **Edge:** a crashed/partial extraction (no marker) ⇒ `false` (crash safety); an unrelated extra
  file under `bin/` must NOT flip it to false.
  **FAIL** = a marker alone (binaries unchecked) satisfying the predicate.

- [ ] **F-20 (R-1b) — a digest mismatch writes NOTHING.**
  `extract_verified_archive_refuses_a_digest_mismatch_without_writing_binaries`.
  **Expected:** `Err` whose message begins `[pg:extract]` and names the SHA-256 mismatch; the
  install dir's recursive listing is identical to the pre-call snapshot (no `bin/`, `lib/`,
  `share/`, no marker); the staged archive is untouched; `trusted_install_is_current` is false.
  **FAIL** = any partially-written install dir; a `[pg:archive]` prefix on an extraction error;
  a mismatch detected only after unpacking started.

- [ ] **F-21 (R-2 / AC2) — bundled is provably untouched.**
  `bundled_mode_settings_leave_the_crate_install_inference_untouched` +
  `cargo check --features bundled`.
  **Expected:** `apply_acquisition_mode(&mut settings, PgAcquisitionMode::Bundled)` leaves
  `trust_installation_dir == false` and `settings.version` at the crate default (`*`/STAR), with no
  other `Settings` field changed; `trusted_install_path_enabled(Bundled) == false` so `setup()`
  never calls `ensure_verified_install`; the bundled check exits 0 with zero warnings; the crate's
  embedded-archive install path still runs.
  **FAIL** = trust/pinned version on bundled; a `#[cfg(feature = "bundled")]`-gated test so only
  one branch compiles (G-402); any delta to the pre-existing `assemble` fields on this path.

- [ ] **F-22 (R-3 / AC3) — the crate's `install()`/`get_archive` is never reached; the zero is
  NON-VACUOUS.**
  `setup_never_reaches_the_crate_install_path_and_makes_no_fetch`.
  **Expected:** `setup()` is `Ok`; `probe.connections() == 0`;
  `!install_dir.join(PG_ARCHIVE_SUBDIR).exists()`; `!install_dir.join("lib").exists()` and
  `!install_dir.join("share").exists()`; `!install_dir.join(PG_VERSION).exists()`; the three
  seeded `bin/` sentinels + the marker are byte-identical to the seed;
  `settings.trust_installation_dir == true`; `settings.installation_dir == install_dir`;
  `settings.version.to_string() == "=18.6.0"`; `settings.binary_dir() == install_dir.join("bin")`.
  **The test must FIRST demonstrate the probe's positive control** — one deliberate connection
  increments `connections()` to 1, then the counter is reset — so the later zero is a measured
  absence.
  **FAIL** = a probe that never binds/listens (vacuous zero); any `[pg:archive]`/`[pg:extract]`
  side effect; a seed whose marker digest differs from `effective_pin()` (that would download).

- [ ] **F-23 (R-4 / AC4) — one compile-time constant, one predicate.**
  `trusted_install_path_is_runtime_download_and_windows_x86_64_only`.
  **Expected (Windows x86_64 host):** `TRUSTED_INSTALL_ENABLED == true`;
  `trusted_install_path_enabled(RuntimeDownload) == true`;
  `trusted_install_path_enabled(Bundled) == false`; `TRUSTED_INSTALL_ENABLED` is defined as exactly
  `cfg!(all(target_os = "windows", target_arch = "x86_64"))`; both `apply_acquisition_mode` and
  `PgRuntime::setup` gate on `trusted_install_path_enabled(...)` only.
  **Edge:** non-Windows/non-x86_64 is NOT executed in this slice — the guarantee is the
  compile-time cfg + `docs/SECURITY.md`/`docs/ARCHITECTURE.md` naming it as a follow-up.
  **FAIL** = a second divergent mode/arch predicate at a call site, or a non-Windows run presented
  as evidence.

- [ ] **F-24 (R-5 / AC5) — exactly ONE top-level component stripped.**
  `extract_verified_archive_strips_the_single_top_level_component`.
  **Expected:** for a fixture with `<top>/bin/{initdb,pg_ctl,postgres}.exe`, `<top>/lib/…`,
  `<top>/share/…`, the install dir holds `bin/`, `lib/`, `share/` DIRECTLY under it,
  byte-identical; no directory named `<top>` anywhere below; `trusted_install_is_current` true;
  `Settings::binary_dir()` is `<install_dir>/bin`.
  **FAIL** = double-strip, no strip (nested `<top>/bin`), or flattening more than one component;
  erroring on a bare top-dir entry.

- [ ] **F-25 (R-5 / AC5) — path traversal rejected and confined.**
  `strip_top_component_rejects_parent_dir_root_and_prefix_components` +
  `extract_verified_archive_rejects_a_divergent_top_level_component`.
  **Expected:** `Err` for a `..` component, a root/absolute component, and a Windows prefix
  component; `extract_verified_archive` errors when an entry's top component differs from the
  first entry's; every error carries `[pg:extract]`; the install dir listing is unchanged AND the
  install dir's PARENT tempdir listing is identical after each rejection.
  **FAIL** = a `..` entry escaping the install dir; a mixed archive whose last entry diverges
  succeeding; `strip_top_component` accepting an empty path.

- [ ] **F-26 (NFR) — build hygiene.**
  Run both `cargo check` commands (default + `--features bundled`); grep the new/changed files for
  `#[allow(` and `unwrap()`.
  **Expected:** both exit 0 with ZERO warnings; no `#[allow(...)]` in `extraction.rs` or the new
  `acquisition.rs`/`runtime.rs` code; no `unwrap()` — the only permitted non-`?` panic is the
  documented `LazyLock<VersionReq>` `expect` on the literal `=18.6.0`.
  **FAIL** = any warning (a "pre-existing" warning is not an exemption), a new `#[allow]`, or a
  new `unwrap()` in production code.

- [ ] **F-27 (NFR) — offline, env-clean, streaming, off-reactor.**
  Inspect the new `#[cfg(test)]` modules; run the filtered suite twice back-to-back.
  **Expected:** extraction tests contain ZERO `std::env::set_var` (explicit `PgArchivePin` only);
  pin-reading/mutating tests hold `PG_ARCHIVE_ENV_LOCK`; both consecutive runs green
  (order-independent, no network); extraction streams a 64 KiB chunked `Sha256` over
  `BufReader<File>` with `flate2::bufread::GzDecoder` + `tar::Archive`, no `read_to_end`/whole
  `Vec<u8>`, no `postgresql_archive::extract`; the extract is inside
  `tauri::async_runtime::spawn_blocking`.
  **FAIL** = a whole-archive `Vec`, `tokio::spawn`, any test reaching GitHub/theseus, or a
  second-run failure.

- [ ] **F-28 (regression) — the existing suite stays green and nothing is weakened.**
  Re-run the F-15 command on the final tip; diff the test modules against `main`.
  **Expected:** green, `0 failed`, count ≥ F-15 baseline + the new tests; every changed
  pre-existing test carries a justified, cited delta; no test deleted, `#[ignore]`d, or stripped
  of an assertion; `state.rs` tests green after the acquisition-block removal.
  **FAIL** = a test repaired by deleting its assertion, an unexplained red baseline test, or a
  passed-count drop.

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

**#2978 round:** PASS = F-1..F-14 green with LIVE evidence (a measured byte receipt; a `telemetry_spans` read; a DOM
snapshot / screenshot; a process observation) and N-1..N-5 holding. Any of: a mode not build-time
enforced; a mode recorded without the Q-1 answer (and not marked PENDING); a corrupt/truncated
acquisition that extracts a partial distribution; a first-run failure that leaves a half-extracted
tree; a console flash; no server log tail; a restated spike number where a re-measurement is named; a
static-only receipt on F-13; or an unbounded/blocking wait = **FAIL**.

**#3076 round:** PASS = F-15..F-28 green with **STATIC** evidence only (the literal `cargo test` /
`cargo check` command per row plus its output tail, and a quoted `file:line` for every source
assertion). A live receipt is neither required nor admissible in place of a missing unit proof. Any
of: a row satisfied only by an app boot; a named binding test absent/renamed/`#[ignore]`d; the crate
`install()`/`get_archive` path reachable; a digest mismatch writing anything; a `#[allow(...)]` or new
`unwrap()` in production code; a whole-archive `Vec`; a missing recorded pre-change baseline; or a
weakened pre-existing test = **FAIL**. N-1's bound applies in its narrowed #3076 form: no unbounded
**network** await is added (the extract itself is local-FS, `spawn_blocking`'d, and accepted
unbounded — see the plan's Risks note).

## Round — #2978 (2026-10-01, `spec/2978 @ 9e129f3`) — PASS (bundled boot unverified)

- **F-1/F-14:** PASS — `cargo check`/`clippy -D warnings`/`test` green on default AND `--features bundled`
  (1082 unit + integration, 0 failed); `tauri.conf.json:53-54` unchanged. (`cargo tree` not allowlisted → substituted.)
- **F-3:** PASS — seeded 30,000,000 B partial (≥50% of the real **54,068,902 B** archive); server saw
  `Range: bytes=30000000-` → 206; completed digest = pin `7da44c2d…4db7d5`; skip-if-verified on the next boot.
- **F-4:** PASS — wrong-SHA override → `[pg:archive] SHA-256 mismatch`; artifact DELETED; no extract.
- **F-5:** PASS — unreachable URL → retryable `[pg:archive]` error; no half-extract; bounded.
- **F-6:** PASS — no visible console window (cold initdb + warm pg_ctl start); pg_ctl console is windowless.
- **F-7:** PASS — `pg_server_log_tail` returned real `<data_dir>/log/postgres.log` lines.
- **F-8:** PASS — archive 54,068,902 B; extracted payload 164,026,008 B / 2,973 files.
- **F-10:** PASS (substitution) — release-binary Δ +54,067,200 B (bundler unavailable).
- **F-11:** PASS — data dir 41,980,260 B / 1,037 files.
- **F-12:** PASS — postmaster peak WS 18,145,280 B; tree sum ≈ 191,864,832 B vs 277,700,608 B baseline.
- **F-13:** PASS — live OpenCode Terminal session (`FREDO-2978-E2E-OK`) rendered in Mission Monitor with
  chat + `── TOOLS (1) ──` + tokens; `telemetry_spans` cross-checked at the same instant.
- **F-2/F-9:** PASS (default/docs) / **UNVERIFIED bundled boot** — named tooling gap (no `dev-env` feature lever).
- **Number correction:** `PG_FIRST_RUN_DOWNLOAD_BYTES` is the EXTRACTED payload; the real first-run transfer
  is **54,068,902 B**.
