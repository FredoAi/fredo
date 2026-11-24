# resident-shell — Regression Tests

> "Did we break existing behaviour?" — the must-not-change baseline for the resident single-instance
> shell (#3192). Run on every testing phase that touches window lifecycle, the tray, the IPC pipe, the
> PG supervisor, or the row pipeline.
>
> **RT-1 and RT-2 are `static` negatives** (prove-a-negative / artifact reads: a chord that must not
> exist, a persistence surface that must not be added). Every other row is verified on the served
> `spec/3192` build at the tested commit.

## RT-1 (static) — no fourth platform chord, no app-level key binding

- [ ] **RT-1** — Read `apps/ui/src/shared/window-system/platformChords.ts` and
  `chordSuppression.ts` at the tested commit and diff them against the base.
  **Expected:** the chord table contains only `primary+space`, `primary+tab`, `primary+shift+tab`
  (three, no more); no new chord, no bare-key binding, no per-application key table, no focus-trap
  change; `chordSuppression` keeps the precedence `terminal > modal > text-entry > none` and its
  `[data-fredo-terminal-root="true"]` selector. A new chord is a FAIL even if it "only" opens Fredo.
  **Edge:** a comment or doc that MENTIONS a fourth chord is not a violation — the scan targets the
  chord table and the capture-phase listener, not prose.

## RT-2 (static) — no new persistence

- [ ] **RT-2** — Diff every changed path and inspect the added code/config.
  **Expected:** NO new store, key, table, file, or directory. The slice reads only existing surfaces:
  PostgreSQL (`telemetry_spans`, `*_rows`, settings KV), `settingsService` (existing keys such as
  `Fredo_layout_zones`), localStorage dev mirror. No DDL, no new settings key, no new file format, no
  new sidecar/JSON document, no `--background` flag (ST-2 #3193 owns windowless startup).
  **Edge:** a Rust `#[cfg(test)]` constant or an in-memory `AtomicBool` (`ResidentShellState`) is
  NOT persistence; the check is for durable state, not for variables.

## RT-3 — the row pipeline is untouched

- [ ] **RT-3** — `git diff --stat <base>..<tip> -- apps/tauri/src-tauri/src/infrastructure/rtdb/`
  and grep for any new emission path.
  **Expected:** the diff is EMPTY; rows are still emitted ONLY through
  `EventBus.emit_row_delivery_batch` (`infrastructure/comm/bus.rs`); the classifier, merge, flush,
  query and subscription modules are byte-identical.
  **Edge:** the recorded residual (a destroyed webview leaves its query registrations behind —
  `rtdb/subscriptions.rs`) is an OBSERVATION (E-9), never a reason to touch `rtdb/` here.

## RT-4 — teardown order and the structural single-owner invariants are unchanged

- [ ] **RT-4** — Diff `RunEvent::Exit` (`apps/tauri/src-tauri/src/lib.rs`) and the PG/OTLP startup.
  **Expected:** the `RunEvent::Exit` body and order are untouched (companion engine → bounded
  embedded-PostgreSQL stop with the `taskkill /T /F` fallback → Doom take-and-drop);
  `PgDataDirLock` is still acquired before any sweep/postmaster start; the OTLP receivers still bind
  loopback 127.0.0.1 and fail the START (never the process) on a bind error.
  **Edge:** the new `ExitRequested` handler must not change what `RunEvent::Exit` does — it only
  decides whether the exit is prevented.

## RT-5 — exit-policy gate (unit pin, non-AC)

- [ ] **RT-5** — Run the ST-1 unit tests (and read the handler).
  **Expected:** `ResidentShellState::default().tray_installed() == false`;
  `RunEvent::ExitRequested { code: None, .. }` calls `api.prevent_exit()` ONLY when
  `tray_installed()` is true; `code: Some(_)` is always allowed; `mark_tray_installed` is called ONLY
  after `TrayIconBuilder::build` returns `Ok`. Paste the test names + green output.
  **Edge:** a tray-install failure must leave `tray_installed` false (pre-feature close semantics) —
  no seam exists to force a live failure (named blocker, QA-4).

## RT-6 — command-surface discipline

- [ ] **RT-6** — Read the three gates for `open_main_window`, `app_lifecycle_status`, `quit_app`.
  **Expected:** each command is present in `generate_handler![]` (`lib.rs`), in
  `COMMAND_MANIFEST` (`runtime/command_manifest.rs`) and in the grant set
  (`permissions/app/default.toml` as `allow-open-main-window`, `allow-app-lifecycle-status`,
  `allow-quit-app`); the drift-guard test is green; the capability still matches ONLY
  `main`/`terminal`/`doom`/`app-*` (never `installed-*`); `quit_app` is wired to NO visible control
  (the tray is the only visible quit surface).
  **Edge:** a new command reachable from an `installed-<id>` window is a FAIL (the #3147 boundary).

## RT-7 — one tray icon, no new asset

- [ ] **RT-7** — Inspect the tray install path and the assets.
  **Expected:** exactly ONE tray icon per process; `install_tray` is called once from `setup`; the
  built `TrayIcon` + `Menu` are held in managed state for the process lifetime (refcounted drop
  removes the icon — no explicit removal needed); the icon comes from
  `app.default_window_icon()` (or the shipped `icons/32x32.png` contingency) — NO new icon asset is
  added; macOS sets the template-image flag.
  **Edge:** a second launch adds no second icon (F-4); a failed build leaves `tray_installed` false.

## RT-8 — existing suites stay green (no weakened assertion)

- [ ] **RT-8** — Run the Rust and UI suites at the tested commit.
  **Expected:** `cargo test` (comm/IPC/PG-supervisor/terminal suites) and
  `pnpm --filter @fredo/ui test:run` green; the shipped `useEventRows` ready-marker tests
  (`ready does NOT resolve on subscribe return alone (replay: true)`, `ready resolves only on the
  MATCHING marker — a foreign queryId settles nothing`) are unchanged and green; no existing
  assertion deleted or weakened; no new `#[allow(...)]`.
  **Edge:** `cargo-nextest` may be absent on this host — substitute `cargo test` and DISCLOSE the
  runner swap against CI's `cargo nextest run` (G-282); run with the env DOWN (the running exe locks
  the target).

## Related suites that overlap this surface (run their regression rows too)

- `.opencode/tests/multi-env-isolation/regression.md` — per-env pipes/ports/data dirs; the
  single-instance guard must stay PER-ENVIRONMENT (E-2).
- `.opencode/tests/postgres-lifecycle/` + `postgres-cluster-permission/` — the postmaster lifecycle
  and lock behaviour the quit teardown depends on.
- `.opencode/tests/desktop-shell/regression.md` — launcher/chrome surface (must be visually
  unchanged by a reopen: parity with a cold launch).
- `.opencode/tests/headless-ingest/` — the OTLP receivers + `telemetry_spans` raw-persist path the
  AC1 leg proves against.
- `.opencode/tests/webview-security-boundary/` — capability boundary: the three new grants belong to
  the built-in window class only.
- `.opencode/tests/fredo-cli/` — the `fredo` CLI client and its per-env `FREDO_CLI_PIPE` resolution.

## Suite-level pass/fail

PASS = RT-1…RT-8 all green. FAIL = a new chord/binding, a new persistence surface, an `rtdb/` diff,
a changed teardown order/ownership invariant, a command reachable from an `installed-*` window, a
second tray icon, or a weakened/deleted existing assertion.
