# webview-security-boundary — Regression Tests

The "must not change" baseline for webview hardening. Everything here is a **non-goal** of the
config-only hardening: the app must behave exactly as before apart from the removed privileges.

> **Cross-suite link:** overlaps `desktop-shell` (window shell / window management),
> `window-manager` and `application-data` (application windows and their stores), and
> `setup` (Setup Wizard link surface). Any change to `capabilities/`, `tauri.conf.json`, or
> `tauri.dev.conf.json` must run those suites' regression files too.

## R-1 — Window labels and core permissions unchanged

- [ ] R-1: `capabilities/default.json` still has `"platforms": ["linux","macOS","windows"]` and `"windows": ["main","terminal","doom","app-*"]`. EXPECT: byte-equal arrays (both capability files).
- [ ] R-2: `capabilities/default.json` still grants `core:default`, `core:event:allow-listen`, `core:event:allow-emit`, `core:window:allow-start-dragging`, `core:window:allow-set-title`, `core:window:allow-create`, `core:window:allow-close`. EXPECT: all seven present; the only removals are the three `shell:allow-*` entries and `mcp-bridge:default`.
- [ ] R-3: Window management works: open/close a Terminal window, a Doom window, and an `app-*` window in DEV. EXPECT: all open and close without a capability-denied error (`core:window:allow-create`/`allow-close` intact).

## R-2 — Rust plugin wiring frozen (config-only spec)

- [ ] R-4: `apps/tauri/src-tauri/src/lib.rs:167` still registers `.plugin(tauri_plugin_shell::init())` (the plugin stays registered; only the ACL grant is gone). EXPECT: line present and unchanged.
- [ ] R-5: `lib.rs:169-179` still gates the mcp-bridge registration on `#[cfg(debug_assertions)]` (`bind_address("127.0.0.1")`, `base_port(env_config.mcp_base_port)`). EXPECT: unchanged — this is the release-inertness mechanism.
- [ ] R-6: No files under `apps/tauri/src-tauri/src/**` changed by this spec. EXPECT: only config files (`capabilities/*.json`, `tauri.conf.json`, `tauri.dev.conf.json`), launchers (`apps/tauri/package.json`, `.opencode/scripts/dev-env.ps1`), the regenerated `gen/schemas/capabilities.json`, and docs.

## R-3 — Dependencies and build profiles unchanged

- [ ] R-7: `apps/tauri/src-tauri/Cargo.toml:86` `tauri-plugin-mcp-bridge = "0.12"` remains a **non-optional** `[dependencies]` entry; `Cargo.toml:50` `tauri-plugin-shell = "2"` unchanged; no new npm/Rust dependency.
- [ ] R-8: `apps/tauri/package.json` `build` script is unchanged (no `--config`), `dev:release` unchanged (no bridge, no `__TAURI__`); only `dev` gains the dev override.

## R-4 — Every window still renders and loads its scripts

- [ ] R-9: In DEV and in the `--debug` production-policy bundle, every window opens and its entry document loads with no `Content-Security-Policy` refusal and no `Refused to execute inline script` (scripts load from `/src/main.*` / built assets, not inline).
- [ ] R-10: The bundled app still renders the main UI (native screenshot in the `--debug` bundle; DOM screenshot in DEV) — `style-src 'unsafe-inline'` retained, so Chakra/emotion styles still apply (no unstyled page).

## R-5 — Config contract

- [ ] R-11: `app.security.capabilities` remains **absent** from `tauri.conf.json` (no explicit id list). EXPECT: both capability files are auto-loaded; `gen/schemas/capabilities.json` contains exactly `default` + `mcp-bridge-dev`.
- [ ] R-12: `tauri.conf.json` has no other changed key besides `app.security.csp`, `app.security.devCsp` (new), `app.withGlobalTauri` (true→false) — productName/version/identifier/build/bundle/macOS/NSIS all byte-identical.

## R-6 — External-link baseline (documented pre-existing defect)

- [ ] R-13: The five `window.open(url,'_blank')` sites still exist and still behave as before: no external browser opens, no new Tauri window, no shell invocation, no uncaught console error. EXPECT: identical to the pre-change baseline; this is disclosed pre-existing behaviour, **not** a regression introduced by removing `shell:allow-open`.

## R-7 — Docs reflect reality

- [ ] R-14: `docs/SECURITY.md:141-159,210` and `docs/ARCHITECTURE.md:950-965` no longer describe `shell:allow-open`/`spawn`/`execute` or `mcp-bridge:default` as production grants; `mcp-bridge:default` is documented as the dev-only `mcp-bridge-dev` capability with the `#[cfg(debug_assertions)]` gate; the production CSP / `withGlobalTauri:false` / `__TAURI_INTERNALS__`-only rule is recorded. EXPECT: no doc claims external links open.

_Evidence convention: pass keeps `- [x]` + the observed value/file:line; fail leaves `- [ ]` and marks `FAIL` with expected-vs-actual + repro._

---

# #3078 — Rust/IPC seam hardening: the must-not-change baseline

> **Cross-suite links:** overlaps `terminal` (spawn/resume + the `testOverride` recipes),
> `settings` (the KV write surface) and `doom-companion-dataset` (capture/export). Any change to
> `applications/settings/commands.rs`, `applications/terminal/commands.rs`,
> `applications/doom/commands.rs`, `applications/doom/dataset.rs` or `infrastructure/ipc.rs` must
> run those suites' regression files too. **`.opencode/tests/terminal/functional.md` is
> read-only here** — its F-14/F-16 are #3078's R-2.b consumers.

## Terminal — everything except the seam's availability is frozen

- [ ] **R-15** — `resume_terminal_session` behaviour unchanged: it still calls the shared
  `prepare_session` with `None` for the widened last param, still resolves the binary from the
  stored `terminal_copilot_path` and the shell from `terminal_pwsh_path`.
  - EXPECT: source read shows `None` at the resume call site; no new argument on the resume wire;
    a resumed session's launch path is byte-for-byte the pre-spec behaviour.
  - EDGE: a reordered or re-defaulted param at the resume site is a FAIL even if spawn compiles.

- [ ] **R-16** — the Copilot-only PowerShell 6+ prerequisite gate is semantically unchanged and
  still driven by `pwsh_major` in debug builds.
  - EXPECT: the gate still fires only for `SessionKind::Copilot`; the debug path forwards
    `test_pwsh_major` into `prepare_session`; the non-Windows no-op still consumes the param
    (no unused-param warning — `clippy -D warnings` covers it).
  - EDGE: the control spawn (no override) still launches on a host with `pwsh ≥ 6` — the override's
    effect stays non-vacuous.

- [ ] **R-17** — the debug wire contract is unchanged: `SpawnTestOverride` keeps
  `#[serde(rename_all = "camelCase")]` with `binary` and `pwsh_major`, and still derives `Default`.
  - EXPECT: `{}`, `{"binary":"…"}`, `{"pwshMajor":5}` all deserialize; unknown fields are ignored.
  - EDGE: renaming a key or dropping `Default` silently breaks recipes F-14/F-16.

- [ ] **R-18** — `lib.rs` registration is unchanged for all four commands: `spawn_terminal_session`
  (one entry, no cfg), `save_setting`, `save_control_setting`, `export_doom_dataset`.
  - EXPECT: one `invoke_handler` entry per command, identical names/paths as pre-spec; no `#[cfg]`
    appears in `lib.rs` for any of the four.
  - EDGE: a cfg-gated registration would make the release build lose the command entirely.

## Settings — readers and the store are untouched

- [ ] **R-19** — `get_setting` / `get_control_setting` unchanged; `SettingsStore` itself unchanged
  by this spec.
  - EXPECT: both readers still take `key` only and return `Result<Option<String>, String>`; no
    validation is applied to reads; `infrastructure/storage/mod.rs` shows no spec-authored change
    (the diff touches `applications/settings/commands.rs` only).
  - EDGE: validating on READ would silently hide a previously stored value — a FAIL.

- [ ] **R-20** — the frontend is untouched: no `apps/ui/src` change and the four sensitive keys
  still have zero writers there.
  - EXPECT: `git diff --stat origin/main...HEAD -- apps/ui/src` is empty; grep `apps/ui/src` for the
    four key names ⇒ 0 matches.
  - EDGE: adding an export button/dialog or a settings field for these keys is out of scope (AC4 is
    about the Rust command's path binding).

## Doom dataset — export semantics other than the target rule are frozen

- [ ] **R-21** — the export write is still atomic (temp sibling then `fs::rename`), still guarded by
  `export_in_progress` (eviction deferred), still local-only (no socket, no child process), and
  still never mutates a source file.
  - EXPECT: the rewritten unit tests still assert (a) the target appears complete, (b) the source
    bytes are unchanged before/after, (c) no partial file on failure; `dataset.rs`'s temp-then-rename
    block is unchanged.
  - EDGE: `export_is_local_only_and_never_mutates_the_source` must survive the signature change
    (target is now pre-resolved by the caller) — a deleted test is a FAIL.

- [ ] **R-22** — an empty dataset is still a typed `requestFailed` with no partial file.
  - EXPECT: `export_dataset(&writer, fmt, Some(<target>))` on an empty dir ⇒
    `code == DoomErrorCode::RequestFailed`, message contains `empty`, target absent.
  - EDGE: a pre-resolved target that already exists must not be truncated before the empty-check.

- [ ] **R-23** — the `CliCommand::DoomExportDataset` wire shape is unchanged
  (`{"type":"doom_export_dataset","format":…,"out":…}`) and the existing `ipc.rs` wire tests stay
  green.
  - EXPECT: `infrastructure/ipc.rs` variant definition + its tests pass unchanged; only the
    dispatch target changed (to `export_doom_dataset_cli`); the `ok:false` + `data` error envelope is
    unchanged.
  - EDGE: changing the wire shape would break `fredo doom export-dataset` clients — a FAIL.

- [ ] **R-24** — capture/rotation/retention and the default-path naming are untouched:
  `DOOM_DATASET_EXPORT_DIR == "exports"`; the default remains
  `<dir>/exports/doom-dataset-<ts>.<ext>`; caps (32 MiB file / 256 MiB total / 500k records) and the
  opt-in gate are unchanged.
  - EXPECT: constants byte-identical; `default_export_path` still delegates to `default_export_name`;
    capture still writes nothing while the gate is OFF.
  - EDGE: `default_export_name` is additive (`dataset.rs` only) — moving the timestamp format is a
    regression for `doom-companion-dataset` F-4.

## Build profile — the mechanism's precondition

- [ ] **R-25** — `apps/tauri/src-tauri/Cargo.toml` still has NO `[profile.*]` table (and still
  `[features] default = []`).
  - EXPECT: `Select-String -Pattern '^\[profile\.'` ⇒ 0 matches; `debug-assertions` is not
    overridden anywhere, so `release` ⇒ `debug_assertions = false` and dev/test ⇒ `true`.
  - EDGE: adding `[profile.release] debug-assertions = true` would silently re-enable the seam in
    shipped builds — the single most dangerous regression in this spec.

## #3077 boundary baseline

- [ ] **R-26** — the #3077 rows still pass unchanged: F-1 (no shell capability), F-3 (mcp-bridge
  dev-only), F-6 (`shell:allow-open` absent), F-9 (CSP + `withGlobalTauri:false`), F-10 (zero
  `__TAURI__` in product source). #3078 is additive to the same boundary.
  - EXPECT: those static rows read identically on the spec tip; the only new files are the #3078
    rows/sections here.
  - EDGE: a capability/CSP edit in this spec is both an F-35 FAIL and an R-26 FAIL (the config
    surface belongs to #3077).

_Evidence convention (this section): quote the `file:line` text, the grep count or the exit code;
"no change" without a quoted artifact is not evidence._

