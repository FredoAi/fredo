# postgres-packaging — Regression

> "Must not change" baseline for the **embedded-PostgreSQL packaging & install** domain (slice 5 of
> 6, issue **#2978**). These invariants MUST hold after the slice — any FAIL is a regression. Run on
> every testing phase that touches the acquisition mode, the archive integrity path, the bundle
> config, the Windows spawn/log path, or the release gate.

> **Verification policy: live** — the boot / footprint / spawn invariants are only observable on a
> running/measured artifact; the Tester's Evidence MUST reference a live receipt (measured bytes, a
> DOM snapshot, a `telemetry_spans` read, a process observation). A static-only PASS is a FALSE PASS.

> **G-284 substitution disclosed:** the `telemetry-query` skill is SQLite-only and cannot read the PG
> store; live PG reads use the managed `psql` + the URI from `pg_supervisor_status` +
> `postgres.password`.

> **G-263 SAFETY:** every live leg is time-bounded and torn down via
> `.opencode/scripts/dev-env.ps1 -Action Up -Spec 2978` / `-Action Down`; never an unbounded run;
> never a bare `postgres`/`pg_ctl`. The named failure mode is the #2948 ~11 h `pg.stop()` hang.

## Must NOT change (regression invariants)

- [ ] **R-1 (both feature branches build and boot):** the crate default (`runtime-download`, no
  `bundled`) AND the `bundled` feature build must both compile and boot the app. A packaging change
  must never leave one branch unbuildable.
  **Edge / FAIL:** `bundled` enabled by default; a `[features]` entry that breaks the default build;
  a `tauri.conf.json` bundle change that only works on one branch.

- [ ] **R-2 (the extracted payload is the same either way):** a `bundled` build does NOT shrink the
  on-disk footprint — the distribution extracted into the app data dir is ~164,026,008 B (~156 MiB)
  in BOTH modes. `bundled` moves the acquisition point (build time), it does not eliminate the
  extracted payload.
  **Edge / FAIL:** a claim that `bundled` removes the on-disk footprint; a measured extract that
  differs between modes.

- [ ] **R-3 (integrity never degrades):** the archive is verified against a pinned digest (or Fredo's
  SHA-256 streaming engine) BEFORE it is used; a mismatch deletes the artifact and errors — it never
  extracts. This is the Companion `model_download` bar (`Range` resume, digest pin,
  delete-on-mismatch).
  **Edge / FAIL:** an unverified extract; a mismatch that leaves a partial tree; a retry that
  silently accepts corrupt bytes.

- [ ] **R-4 (no unbounded run / no orphan postmaster — G-263):** no new code path introduces an
  unbounded/blocking wait; the slice-1 bounded stop + watchdog + fallback + sweep layers still hold;
  after every live leg's `-Action Down` no `postgres.exe` this run started survives.
  **Edge / FAIL:** an await without a finite bound; an orphan `postgres.exe` after teardown (the
  #2948 ~11 h `pg.stop()` hang class).

- [ ] **R-5 (release gate unchanged):** the `migration.postgres.completed` marker semantics
  (`infrastructure/storage/migration/mod.rs`) are untouched — the packaging slice wires the
  acquisition mode + the gate into the shipped default (slice 6) but never re-derives, clears, or
  races the marker.
  **Edge / FAIL:** a re-derived/cleared marker; a packaging path that flips the engine without the
  gate.

- [ ] **R-6 (no engine/store/migration regression):** the slice-1..4 surfaces — the supervisor
  lifecycle, the shared pool, the RTDB/Span stores, and the one-shot data migration — behave
  unchanged after the packaging change.
  **Edge / FAIL:** a packaging edit that touches a store path, or a boot that no longer selects the
  engine correctly.

- [ ] **R-7 (RTDB row-pipeline contract unchanged):** `infrastructure/rtdb/*` classifier / merge /
  flush / query semantics and the row wire types (`RowDelivery` / `RowDeliveryBatch`) are unchanged;
  emission remains ONLY via `EventBus.emit_row_delivery_batch`; `useEventRows` merge semantics
  unchanged. Packaging is not a pipeline change.
  **Edge / FAIL:** a row-pipeline semantic hunk, a new event type/payload field, or a direct emit.

- [ ] **R-8 (Windows-first spawn/log quality):** the app launches without a console flash and a
  server log tail exists — the crate-spawn `CREATE_NO_WINDOW` / log-redirection gap (Q-17) must not
  regress either behavior.
  **Edge / FAIL:** a newly introduced console window; a log tail removed/relocated without notice.

- [ ] **R-9 (build gates):** `cargo check --locked` zero warnings AND `cargo clippy --locked -- -D
  warnings` AND `cargo test --locked` green (Windows-first); no `#[allow(...)]`. If UI is touched,
  `pnpm --filter @fredo/ui build` exits 0.
  **Edge / FAIL:** `cargo check` green but clippy red (check alone does NOT clear the clippy gate).

- [ ] **R-10 (bundle config intentional):** `apps/tauri/src-tauri/tauri.conf.json:53-54`
  (`externalBin`, `resources`) is either unchanged or changed ONLY with a stated reason tied to the
  chosen mode — never an incidental change.
  **Edge / FAIL:** an unexplained bundle-config change; a mode that needs a `resources` entry that
  was not added.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-11:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` — the supervisor
  the packaging change must not disturb.
- [ ] **R-12:** inherit and run `.opencode/tests/postgres-stores/regression.md` — the store + pool +
  RTDB preservation contract.
- [ ] **R-13:** inherit and run `.opencode/tests/postgres-migration/regression.md` — the data-migration
  + release-gate surface.
- [ ] **R-14:** inherit and run `.opencode/tests/mission-monitor/regression.md` (incl. R-62, the
  dual-provider rendering mandate) — the Mission Monitor surface the boot row must serve.
- [ ] **R-15:** inherit and run `.opencode/tests/embedded-postgres-migration/regression.md` — the
  spike-era "no production impact" baseline whose static invariants are re-scoped here.

## Must NOT change — #3076 trusted-install slice (R-16..R-26)

> **Verification policy for R-16..R-26: STATIC** (the #2978 rows R-1..R-15 remain LIVE where they
> name a live receipt). These invariants are provable offline from `cargo test`/`cargo check`
> output and source assertions. The slice connects Fredo's SHA-256-verified archive to extraction
> on the `runtime-download` path (Windows x86_64 only).

- [ ] **R-16 (bundled mode is byte-for-byte unchanged):** `trust_installation_dir` stays `false`
  and `settings.version` stays at the crate default (`*`/STAR) on the `bundled` path, so the
  crate's embedded-archive install runs as today. `trusted_install_path_enabled(Bundled)` is
  `false` and `setup()` never calls `ensure_verified_install` there.
  **Edge / FAIL:** trust or a pinned version applied on `bundled`; a new early return that skips
  the crate's embedded install; a bundled-only `#[cfg]` that leaves the other branch uncompiled.

- [ ] **R-17 (the crate's download path is unreachable on runtime-download):**
  `setup_never_reaches_the_crate_install_path_and_makes_no_fetch` stays green — zero
  loopback-probe connections, no `<install>/archives/`, no `<install>/lib` or `<install>/share`,
  no `<install>/<PG_VERSION>` directory, seeded tree byte-identical, `installation_dir` unsuffixed.
  The probe's positive control must still be demonstrated before the zero is asserted.
  **Edge / FAIL:** a vacuous zero (probe never bound); a crate-written version-suffixed tree; any
  fetch through `postgresql_embedded`/`postgresql_archive`.

- [ ] **R-18 (integrity never degrades; nothing is written before verification):** the digest is
  compared against `PgArchivePin` BEFORE any distribution file is written; a mismatch returns
  `[pg:extract]` and leaves the install dir untouched. The pre-existing `[pg:archive]`
  delete-on-mismatch behaviour of the streaming engine is unchanged.
  **Edge / FAIL:** an extract that starts before the hash pass completes; a mismatch that leaves a
  partial tree; a hash sourced from the upstream release's own `.sha256` (the gap this slice
  closes).

- [ ] **R-19 (extraction marker contract):** `<install_dir>/.fredo-pg-extracted` carries
  `version=` and `sha256=` from the pin the caller passed, is written temp-file + rename, and only
  after a fully successful extraction. `trusted_install_is_current` requires the marker AND
  `initdb.exe`/`pg_ctl.exe`/`postgres.exe` under `bin/`.
  **Edge / FAIL:** a marker written before completion (a killed extraction would then be
  trusted); a marker round-trip that loses the version/digest; trusting a tree with no binaries.

- [ ] **R-20 (extraction is path-confined):** no entry of any archive may write outside the
  install dir — `..`, root/absolute and Windows-prefix components are rejected, and a divergent
  top component aborts the extraction with `[pg:extract]` and nothing written.
  **Edge / FAIL:** any file created outside the install dir; an abort that leaves partial content.

- [ ] **R-21 (ONE resolved install dir):** `resolve_install_dir` / `FREDO_PG_INSTALL_DIR` feeds
  acquisition, extraction, `settings.installation_dir` and `binary_dir()` with the same path.
  **Edge / FAIL:** acquisition and extraction resolving the dir independently (extraction would
  land where `initdb` is not looked for); a suffix joined onto the caller's dir.

- [ ] **R-22 (settings construction order):** `apply_acquisition_mode` runs BEFORE
  `PostgreSQL::new(settings)` — the constructor is what applies the version suffix. `assemble`'s
  pre-existing fields (`data_dir`, `port`, `temporary`, `password`, `timeout`, log collector,
  `lc_messages`, `log_min_messages`, username) are unchanged on every path.
  **Edge / FAIL:** trust/version mutated after construction (reads version-suffixed paths);
  any delta to those fields; leaving `settings.timeout` unset (the #2948 ~11 h stop hang).

- [ ] **R-23 (build hygiene):** `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml`
  (default AND `--features bundled`) exits 0 with ZERO warnings; no `#[allow(...)]`; no
  `unwrap()` in new production code (the one documented `LazyLock<VersionReq>` `expect` allowed).
  **FAIL:** a new warning; an `#[allow]` masking one; a new `unwrap()`.

- [ ] **R-24 (non-Windows / non-x86_64 unchanged):** `TRUSTED_INSTALL_ENABLED` is
  `cfg!(all(target_os = "windows", target_arch = "x86_64"))`; on any other target the trusted
  install path is disabled and the crate keeps its self-fetch behaviour. The gap is documented in
  `docs/SECURITY.md` + `docs/ARCHITECTURE.md` as a follow-up.
  **Edge / FAIL:** a second divergent arch/OS predicate; an undocumented (or over-claimed)
  cross-platform guarantee; the docs claiming more than the code does.

- [ ] **R-25 (no reactor block, no ad-hoc spawn):** the extraction runs in
  `tauri::async_runtime::spawn_blocking`; never `tokio::spawn`; no whole-archive `Vec<u8>`
  (streaming, 64 KiB chunks); `PG_CONTROL_TIMEOUT` still bounds every `pg_ctl` command.
  **FAIL:** `tokio::spawn`, a blocking call on the async runtime thread, a whole-archive buffer,
  or a removed control bound.

- [ ] **R-26 (existing pg_supervisor suite green, nothing weakened):** the domain suite
  (`--lib applications::pg_supervisor`) is green on the final tip with `0 failed` and a count ≥
  the pre-change baseline + new tests; no pre-existing test deleted, `#[ignore]`d, or stripped of
  an assertion. A red baseline is repaired inside ST-1's reserve, not deleted.
  **Edge / FAIL:** a test "fixed" by removing its assertion; a passed-count drop; a pre-existing
  test asserting the OLD un-trusted settings left red (that change must be a recorded delta).

## Notes

- This suite is reusable across the remaining Postgres slice (6, #2979) and any later packaging
  change. Slice 5 (#2978) settles the acquisition mode + integrity + the release-gate wiring; slice 6
  (#2979) flips the default and removes SQLite. Any later slice that touches the bundle, the
  acquisition path, or the spawn/log path inherits R-1..R-10.
- **#3076** adds R-16..R-26 for the trusted-install slice: on `runtime-download` Windows x86_64 the
  crate's `install()`/download path must never be reached, and the `bundled`/non-Windows paths must
  stay untouched. These are static invariants — a later slice that re-routes acquisition, changes
  `Settings` trust/version, or touches the extraction marker inherits them.
