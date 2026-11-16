# headless-ingest — Regression

Durable regression suite for the **headless ingest daemon** (`fredo ingest`). Seeded at issue
**#2992**. This suite is the "must not change" baseline for the feature's non-goals plus links to
the overlapping durable suites. Any future spec touching the supervisor, OTLP receivers, the
RTDB row pipeline, the control plane, or the autostart settings runs this suite and extends it.

> **Verification policy: LIVE** — receipts reference a `telemetry_spans` live read (PG-backed via
> the managed `psql`) plus process/port/registry observations. The default-path rows run with
> **every new env seam unset**; a gated receipt never substitutes for the unset control.

## No-change baseline

- [ ] **R-1: default GUI boot is byte-identical when the new env seams are unset.**
  Boot the GUI with `FREDO_PG_LOCK_DIR` / `FREDO_INGEST_*` unset; compare the resolved data dir,
  lock path, and boot behavior against `main`.
  **Expected:** identical dirs/behavior; the default lock path (`<app_data_dir>/postgres.lock`)
  is unchanged (G-296). **FAIL:** any default-path change when the seams are unset.

- [ ] **R-2: OTLP receiver contract unchanged (status codes, transport tags, classification).**
  Deliver the same payloads as `main` to `4317`/`4318`; diff the receiver responses and the
  classified rows.
  **Expected:** identical status codes, transport tagging, and `IngestClassifier` output; no new
  event type or payload field. **FAIL:** any receiver/classification drift.

- [ ] **R-3: RTDB row pipeline unchanged.**
  `infrastructure/rtdb/*`, `RowDelivery`/`RowDeliveryBatch` wire types, and the flush/merge/prune
  semantics are byte-identical except for the AppHandle-free extraction (`run_writer_task_core`,
  `prune_with_knobs_core`) whose GUI call sites delegate.
  **Expected:** identical batching/prune cadence and gate semantics; emission only via the
  classifier. **FAIL:** a behavioral change on the GUI path.

- [ ] **R-4: supervisor lifecycle invariants preserved.**
  Re-run `.opencode/tests/postgres-lifecycle/` R-1…R-8 unchanged (bounded start/stop, marker
  sweep, guaranteed teardown).
  **Expected:** all green; the new attach path never starts/stops/sweeps a headless postmaster.
  **FAIL:** any regression in the supervisor's owned-cluster lifecycle.

- [ ] **R-5: settings contract unchanged.**
  The PostgreSQL `settings` schema and the `postgres.password`/`postgres_pid` keys are unchanged; the
  GUI and daemon read one credential.
  **Expected:** same schema/keys; no data-plane table added to the settings store. **FAIL:** schema or
  key drift.

- [ ] **R-6: pool sizing unchanged.**
  `PG_POOL_MAX_CONNECTIONS = 8`, `acquire_timeout = 5 s`; the daemon uses the same
  `build_pg_pool`.
  **Expected:** unchanged constants and pool behavior. **FAIL:** a silent pool-size change.

- [ ] **R-7: existing tests stay green; none deleted or weakened (G-281/G-290).**
  Run `cargo test --locked` (CI-parity toolchain, G-282) including the #2989 spike test
  (`tests/spike_2989_headless_ingest.rs`) and every existing supervisor/store test.
  **Expected:** all green; no assertion removed/relaxed. **FAIL:** any deleted/weakened test or
  red suite.

- [ ] **R-8: builds stay green.**
  `cargo check --locked`, `cargo clippy --locked -- -D warnings`; `pnpm --filter @fredo/ui build`.
  **Expected:** zero warnings/errors. **FAIL:** any red gate.

## Linked suites (overlapping surface)

- [ ] **L-1: `.opencode/tests/postgres-lifecycle/`** — supervisor bounded start/stop, orphan
  sweep, guaranteed teardown. Run unchanged; the daemon reuses these paths.
- [ ] **L-2: `.opencode/tests/postgres-cutover/` and `.opencode/tests/postgres-stores/`** — the
  PG-backed store/read contract the daemon's classifier writes through.
- [ ] **L-3: `.opencode/tests/event-persistence/`** — per-contract store + hydration; the
  Mission-Monitor replay path (`useEventRows(..., { replay: true })`).
- [ ] **L-4: `.opencode/tests/settings/`** — the Settings feature window the autostart toggle
  lands in; ensure the new `ingest` section does not regress sibling sections.
- [ ] **L-5: `.opencode/tests/persistence-spike/`** — the #2989 headless recipe the daemon
  builds on; its spike test must remain present.

## Notes

- A headless daemon that changes any GUI-owned-cluster behavior (R-2/R-4) is a regression FAIL,
  not a feature.
- G-280: an orphan `postgres.exe` left by `dev-env Down` is an environment artifact — record it,
  never fail this suite on it.
