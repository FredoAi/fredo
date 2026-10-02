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

## Notes

- This suite is reusable across the remaining Postgres slice (6, #2979) and any later packaging
  change. Slice 5 (#2978) settles the acquisition mode + integrity + the release-gate wiring; slice 6
  (#2979) flips the default and removes SQLite. Any later slice that touches the bundle, the
  acquisition path, or the spawn/log path inherits R-1..R-10.
