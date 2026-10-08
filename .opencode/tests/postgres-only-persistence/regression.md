# postgres-only-persistence — Regression

> "Must not change" baseline for the PostgreSQL-as-the-ONLY-database domain (spec #3005). Run on every
> testing phase that touches the store layer, app startup, the settings control plane, the keychain,
> the RTDB row pipeline, or Mission Monitor.
>
> **Verification policy: LIVE** — the app-boot + restart + row-pipeline invariants are only observable
> on a running app; the Tester's Evidence MUST reference `telemetry_spans` (or a rendered live receipt /
> row-table read). A static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** every live leg is time-bounded, torn down via
> `.opencode/scripts/dev-env.ps1 -Action Down`; never a bare `postgres`/`pg_ctl`. The named failure
> mode is the #2948 ~11 h `pg.stop()` hang.

## Must NOT change (regression invariants)

- [ ] **R-1 (single persistence system):** after the change, PostgreSQL is the ONLY durable store — no
  `.db` file is created or read under the app-data dir on any boot; the SQLite driver crate is absent
  from `Cargo.toml`/`Cargo.lock`/`cargo tree`.
  **Edge / FAIL:** any `.db` created/read; the SQLite driver crate in the tree.

- [ ] **R-2 (`telemetry_spans` strictly READ-ONLY):** readers use `begin_read_only`; the RTDB/declared
  backfill never writes `telemetry_spans`.
  **Edge / FAIL:** a write reaching `telemetry_spans`; a read path requiring write perms.

- [ ] **R-3 (canonical backfill markers verbatim):** `rtdb.backfill.completed` and
  `rtdb.backfill.provider.completed.v2` are unchanged — they gate the one-time canonical
  re-derivation of `chat_rows`/`tool_use_rows`/`agent_session_rows`.
  **Edge / FAIL:** a renamed/deleted marker; a re-derivation on every boot.

- [ ] **R-4 (settings command signatures):** `get_setting`/`save_setting`/`get_control_setting`/
  `save_control_setting` keep their signatures (now cache-backed); `storage_engine_status` still returns
  `{ engine, ready, fallbackReason }`; `pg_supervisor_status` unchanged.
  **Edge / FAIL:** a removed command; a frontend consumer broken (`controlSettingAccessor.ts`).

- [ ] **R-5 (RTDB row-pipeline contract):** classifier/merge/flush/query semantics + the wire types
  (`RowDelivery`/`RowDeliveryBatch`) are unchanged; emission is ONLY via
  `EventBus.emit_row_delivery_batch`; `useEventRows(eventType, args, options)` signature + merge
  semantics unchanged.
  **Edge / FAIL:** a new event type/payload field; a direct `app_handle.emit()` row delivery.

- [ ] **R-6 (Mission Monitor renders from the store — live):** the app still boots and Mission Monitor
  still lists live sessions and renders chat/tools/tokens from the declared `sessions` rollup;
  `useDeliverySessions` remains the consumer (`useSessionHistory.ts:126`).
  **Edge / FAIL:** a blank Mission Monitor while a qualifying declared row exists.

- [ ] **R-7 (fresh-install-only, no carry):** a legacy SQLite file is never read/carried/migrated; there
  is no reverse PG→SQLite export; existing control-plane settings are dropped (defaults re-seeded on PG).
  **Edge / FAIL:** any carry; a resurrected backout path.

- [ ] **R-8 (keychain contract):** the PG loopback password is read/written only via the OS keychain;
  the GUI and headless share the SAME credential; the managed server still starts and the pool DSN still
  embeds the (keychain) secret.
  **Edge / FAIL:** the password persisted/logged; a GUI/headless credential divergence.

- [ ] **R-9 (build gates):** `cargo check --locked` zero warnings AND `cargo clippy --locked -- -D
  warnings` AND `cargo test --locked` green; if UI is touched, `pnpm --filter @fredo/ui build` exits 0.
  **Edge / FAIL:** `cargo check` green but clippy red (check alone does NOT clear the clippy gate).

- [ ] **R-10 (architecture boundaries):** `tauri::async_runtime::spawn` (never `tokio::spawn`); no
  cross-feature import; row-pipeline code stays in `infrastructure/rtdb/`.
  **Edge / FAIL:** a `tokio::spawn` or a feature→feature import.

- [ ] **R-11 (no unbounded run introduced):** the bounded stop + watchdog + fallback + sweep layers
  still hold; the boot key remains a synchronous file read (no async-in-sync deadlock).
  **Edge / FAIL:** any await without a finite bound; an async read of the boot key.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-12:** inherit and run `.opencode/tests/postgres-stores/regression.md` — the store layer this
  spec removes SQLite from.
- [ ] **R-13:** inherit and run `.opencode/tests/mission-monitor/regression.md` — the row-pipeline /
  Mission Monitor surface (functional F-6 mirrors the E2E leg).
- [ ] **R-14:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` — the managed server
  lifecycle + ports unchanged.
- [ ] **R-15:** inherit and run `.opencode/tests/event-persistence/` regression legs (when present).

## Pinned references (G-283/G-320)

- The **legacy SQLite file hash** in functional F-4 is sourced from the artifact itself (the fake file
  written under `.opencode/tmp/3005/appdata-legacy/fredo.db`) — a named artifact, not a bare `main` path.
- The **gate DENY tokens** in functional F-5 are sourced from the enforcement script's own token table
  (`.opencode/scripts/check-sqlite-retired.ps1`, ST-9) — not from prose.
- Any spec-branch baseline referenced by a leg pins the SHA stamped by the dev-env manifest at test time
  (`Served commit: spec/3005 @ <sha>`); no fallback names a bare `main` path a later commit can delete.
- The `FREDO_PG_PASSWORD_FILE` sentinel literal is the tester's own synthetic value (e.g.
  `qa-3005-sentinel-<guid8>`), never a live secret.
