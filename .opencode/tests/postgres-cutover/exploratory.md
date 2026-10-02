# postgres-cutover — Exploratory

Unscripted edge/failure probes for the **default PostgreSQL cutover + SQLite-path removal** domain
(issue #2979 and its following slices). A confirmed finding **promotes** to `functional.md` as a new
`F-` row (keep the origin note). The Tester adds probes below beyond the script.

> **Verification policy: live** — probes observe a running app / migration under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever); the named failure mode
> is the #2948 ~11 h `pg.stop()` hang. Never an unbounded run. Kill-never-wait on expiry.

> **Induction levers (G-275) — binding names (G-255):** `FREDO_DATA_DIR` (app-data-dir override →
> in-repo fixture under `.opencode/tmp/2979/`), `FREDO_PG_DATA_DIR` (writable PG data dir),
> `FREDO_MIGRATION_FORCE_MISMATCH` ∈ {`<table>`, `1`/`true`, `<table>:export_error`, `snapshot_fail`},
> `FREDO_STORAGE_ENGINE` (`sqlite`/`postgres`).

## Prompt lines

- [ ] **E-1:** What happens if `migration.postgres.completed` is set but the PG data dir is wiped or
  recreated externally? Does the next startup detect the missing data and re-run, or trust the
  marker and boot on an empty store? Is `fredo.db` still readable for a backout?
- [ ] **E-2:** A fresh install (no `fredo.db`) that is then given a `fredo.db` from another machine —
  does it cut over once, or treat the profile as fresh forever? Is the fresh-start path distinguishable
  from the upgraded path?
- [ ] **E-3:** After the SQLite path is removed, what happens if `FREDO_STORAGE_ENGINE=sqlite` is set?
  Is it a hard, named error (correct) or a silent no-op / crash?
- [ ] **E-4:** Does a downgrade build (pre-cutover) open a `fredo.db` that was written by the
  PostgreSQL build? Confirm the retained file is byte-identical and the accepted data-loss policy is
  actually documented (not just asserted).
- [ ] **E-5:** Is `rollback.verified` sticky across restarts? If a backout is executed and then the
  app is re-cut-over, does the flag correctly reflect the latest exercised backout?
- [ ] **E-6:** On the real corpus, is the per-table bound sized for the largest table
  (`telemetry_metrics` ~10.99M rows) with headroom? What is the observed per-table elapsed vs budget?
- [ ] **E-7:** Does the removal leave any dead code the compiler only keeps because a `cfg`/feature
  still enables it? Run `cargo clippy` with all features and inspect for dead branches.
- [ ] **E-8:** After a hard-kill (Task Manager / power loss) during the cutover, does the startup
  orphan sweep reclaim the postmaster and does the cutover re-run cleanly?
- [ ] **E-9:** Two app instances against the same PG data dir — does the second refuse/attach, or does
  it corrupt the store?
- [ ] **E-10 (console):** `tauri_read_logs(source="console")` after every probe — any `Error:` /
  `Uncaught` / `Maximum update depth exceeded` is a defect that invalidates that leg's evidence.
- [ ] **E-11:** After `dev-env.ps1 -Action Down`, is any `postgres.exe` left alive with no owning app
  (the #2948 teardown-orphan class)? Record PIDs + ports.
