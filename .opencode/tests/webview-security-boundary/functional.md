# webview-security-boundary — Functional Tests

Durable functional suite for Fredo's **Tauri webview security boundary**: the capability
surface (shell plugin, dev-only MCP bridge), the production CSP / `withGlobalTauri`, and the
dev production split. Seeded by Spec #3077 (config-only hardening); extend it when a later spec
touches `apps/tauri/src-tauri/capabilities/`, `tauri.conf.json`, `tauri.dev.conf.json`, or the
external-link sites.

Verification policy is **live for the #3077 rows (F-1..F-14)**: every such row asserts an
observable on a running artifact (DEV instance and/or a bundled build), not only on files. A
static-only run is not a verdict for them.

**The `#3078` section at the end of this file is `static`** (build artifacts + compile-time cfg
structure + headless unit matrices). Its rows are NOT satisfied by a running-app probe — a
`tauri_driver_session` / `tauri_webview_*` / `execute_js` receipt is not an instrument for them.

## Modes (tested as a pair)

| Mode | How | `withGlobalTauri` | CSP | MCP bridge |
|------|-----|-------------------|-----|------------|
| **DEV** | `dev-env.ps1 -Action Up -Spec 3077 -EnvId <id> -EnvSlot <n> -RequireIsolation` | `true` (dev override) | `devCsp` (inline script allowed) | registered (debug assertions) |
| **PROD-POLICY** | `pnpm --filter @fredo/tauri exec tauri build --debug`, run `target/debug/fredo.exe` | `false` | production `csp` (custom protocol) | registered (debug assertions) |
| **RELEASE** | `pnpm --filter @fredo/tauri build`, run `target/release/fredo.exe` | `false` | production `csp` | **not registered** (no port) |

## AC1 / R-1 — no shell spawn/execute privilege

- [ ] F-1 (static): Exact-path-read `apps/tauri/src-tauri/capabilities/` (directory listing, never Glob — G-024). EXPECT: exactly `default.json` + `mcp-bridge-dev.json`; neither contains `shell:allow-spawn` / `shell:allow-execute`; repo grep for `@tauri-apps/plugin-shell|plugin:shell|ShellExt|on_new_window` hits only `apps/tauri/package.json:17`, `apps/tauri/src-tauri/Cargo.toml:50`, `Cargo.lock`, `apps/tauri/src-tauri/src/lib.rs:167`; zero `apps/ui/src/**` hits.
- [ ] F-2 (live, DEV): fire `window.__TAURI_INTERNALS__.invoke('plugin:shell|execute', {program:'cmd',args:['/c','echo x > .opencode/tmp/3077/e2e/shell-probe-marker.txt']})` (store to `window.__probe`, read back in a second `execute_js`); repeat `plugin:shell|spawn` and `plugin:shell|open`; repeat on `main` and one `app-*` window. EXPECT: each resolves `{done:true, ok:false}` with an ACL `not allowed`/`shell` error; sentinel file **absent**; no new `cmd.exe` child of `fredo.exe`.

## AC2 / R-2 — MCP bridge is dev-only

- [ ] F-3 (static): Grep every capability file for `mcp-bridge`; parse `mcp-bridge-dev.json`; read `gen/schemas/capabilities.json`. EXPECT: only `mcp-bridge-dev.json` names it; `identifier:"mcp-bridge-dev"`; `permissions` exactly `["mcp-bridge:default"]`; `platforms`/`windows` equal to `default.json`; `default.json` zero hits; generated manifest lists exactly `default` + `mcp-bridge-dev`.
- [ ] F-4 (live, DEV): `tauri_driver_session start` at the manifest `ports.mcp` (decimal string); `tauri_manage_window action="list"`; `tauri_webview_execute_js` returning a value; `typeof window.__TAURI__ === 'object'`. EXPECT: all four succeed (dev capability live + evidence channel intact). Disclose a bridge port auto-scan instead of failing.
- [ ] F-5 (live, RELEASE): launch `target/release/fredo.exe` with `FREDO_MCP_BASE_PORT=16932`; `Test-NetConnection 127.0.0.1 -Port 16932` (and 9223); `tauri_driver_session start` at `"16932"`. EXPECT: `TcpTestSucceeded : False`; driver connect fails; no `WebSocket server listening` in the release process log. Do **not** run this row against the `--debug` bundle.

## AC3 / R-3 — `shell:allow-open` removed, links baseline-parity

- [ ] F-6 (static): grep `capabilities/` for `shell:allow-open`; grep product source for `plugin:shell|open`, `shell.open`, `on_new_window`; read the five call sites. EXPECT: zero capability hits and zero product hits; each site still has `window.open(<url>, '_blank')` at `SetupWizard.tsx:226`, `JiraDetailPanel.tsx:88`, `jira/IssueCreatedSuccess.tsx:24`, `AzdoDetailPanel.tsx:73`, `azdo/WorkItemSuccess.tsx:23`.
- [ ] F-7 (live, DEV): `window.open('https://example.com','_blank')`; window list before/after; console read. EXPECT: returns `null`; window labels unchanged (no new Tauri window); no `Error:`/`Uncaught`/`Content Security Policy` console entry; no shell sentinel. **A browser NOT opening is the pre-existing baseline — never a FAIL.**
- [ ] F-8 (live, per-site): click the Setup Wizard install-docs link (reachable); activate the Jira/Azdo sites only if a connection/work item exists in the booted env. EXPECT: activated sites show all F-7 observables; a non-reachable site is recorded "mechanism-verified, not UI-driven" (static call-site + F-7 probe) with the limitation disclosed; double-click queues no window.

## AC4 / R-4 — production CSP + `withGlobalTauri:false`

- [ ] F-9 (static): `ConvertFrom-Json apps/tauri/src-tauri/tauri.conf.json`; split both policies. EXPECT: `csp` `script-src` = `'self' blob: 'wasm-unsafe-eval'` (no `'unsafe-inline'`, no `'unsafe-eval'`); `style-src 'unsafe-inline'` retained; `img-src`/`connect-src`/`worker-src blob:`/`default-src` byte-identical to baseline; `devCsp` exists and differs only by `script-src 'unsafe-inline'`; `withGlobalTauri === false`.
- [ ] F-10 (static): grep `apps/ui/src` and `apps/tauri/src` for `__TAURI__`. EXPECT: zero hits (`__TAURI_INTERNALS__` hits are expected and not a violation).
- [ ] F-11 (live, DEV): structure snapshot; console; `typeof window.__TAURI__`. EXPECT: body has children; no `Refused to execute inline script`/CSP console entry; `typeof window.__TAURI__ === 'object'`.
- [ ] F-12 (live, PROD-POLICY): launch the `--debug` bundle with `FREDO_MCP_BASE_PORT=16931`, attach driver at `"16931"`, `execute_js`; then `tauri_manage_window action="list"` + native screenshot. EXPECT: `execute_js` fails with `__TAURI__ not available` (positive proof of `withGlobalTauri:false` under production CSP); window list still shows `main`; screenshot shows the window. Run this probe LAST for that instance.

## AC5 / R-5 — builds clean + boots in both modes

- [ ] F-13 (builds): `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui build"`, `cargo check`, `cargo check --release` (from `apps/tauri/src-tauri`). EXPECT: all `EXITCODE=0`; zero TS errors; zero `warning:` lines; no new `#[allow(...)]`.
- [ ] F-14 (live, both): DEV boot with `main`, `terminal`, `doom`, one `app-*` window functional; release exe launches with `main` visible (native enumeration) and driver cannot connect; debug-bundle exe launches with `main` visible. EXPECT: all windows functional, console clean, no app-script CSP refusal.

## Required test data

- Isolated env: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3077 -EnvId <id> -EnvSlot <n> -RequireIsolation`; actual ports from `.opencode/tmp/envs/<id>/manifest.json` (`ports.vite`, `ports.mcp`, `ports.pg`); slot `n≥1` → base `16000+10*(n-1)` with MCP = base+1. Env id from `.opencode/state/env-leases/3077.json`.
- Bundle ports: `16931` (debug), `16932` (release) — pick free ports, never the DEV slot ports.
- Sentinel: `.opencode/tmp/3077/e2e/shell-probe-marker.txt` (must stay absent).
- Screenshots under `.opencode/tmp/3077/e2e/`; upload with `rust-script .opencode/scripts/pipeline-state.rs --issue 3077 --agent tester --action upload-evidence --image <path>` and embed the returned `user-attachments` URL.
- Teardown (run-complete only): `-Action Down -EnvId <id>` then `-Action Clean -EnvId <id> -Spec 3077`.

_Evidence convention: pass keeps `- [x]` + the observed value (window list, error text, exit code, screenshot URL); fail leaves `- [ ]` and marks `FAIL` with expected-vs-actual + repro; a row that cannot run is `UNVERIFIED` with a named blocker — never a PASS._

---

# #3078 — Rust/IPC seam hardening (verification policy: **static**)

Three webview-reachable seams: the terminal **test-override spawn**, the **settings KV write**
(four sensitive path keys), and the **Doom dataset export** (arbitrary file write). Every row
below is provable from a build artifact, a compile-time cfg structure, or a headless unit matrix.

**Command convention.** All `cargo` commands run from the repo root as
`run-exitcode.ps1 -Command "cargo <args> --manifest-path apps/tauri/src-tauri/Cargo.toml"` so the
exit code is quotable. All fixtures live under `.opencode/tmp/3078/qa/` (repo-relative); nothing
outside the repo. **Do not drive a running app for any row in this section.**

## R-1 / AC1 — clean build: debug profile

- [ ] **F-15** — `cargo check`, then `cargo clippy -- -D warnings`, then `cargo nextest run` on the
  spec tip. Paste the three `EXITCODE` values and the nextest summary line.
  - EXPECTED: all three `EXITCODE=0`; `cargo check` prints **zero** lines starting `warning:`;
    clippy exits `0` under `-D warnings` (no `warning:` / `error:` block); nextest summary reads
    `N tests run: N passed, 0 failed, M skipped` with `0 failed` and `N ≥` the ST-5 baseline count.
  - EDGE: a fully cached run may print no warnings because nothing rebuilt (cargo replays cached
    warnings — record the raw tail if the summary is absent). A pre-existing red is ST-5's
    baseline to own (G-406) — never a silent skip. A warning in a file NOT owned by ST-1..ST-3 is
    recorded as pre-existing and is not this row's FAIL (it is still reported).
  - DATA: none beyond the spec tip checkout.

## R-1 / AC1 — clean build: release profile

- [ ] **F-16** — `cargo check --release`.
  - EXPECTED: `EXITCODE=0`, zero `warning:` lines; the record states whether a `Compiling fredo`
    unit appeared (fresh) or the run was cached.
  - EDGE: if fully cached, F-18's `cargo test --release --lib` is the fresh-compile evidence and
    this row records "cached, corroborated by F-18" — NOT a PASS on a cached run alone.
  - DATA: none.

## R-2.a / AC2 — release build declares NO `test_override` argument

- [ ] **F-17** — cfg-structure read of `apps/tauri/src-tauri/src/applications/terminal/commands.rs`:
  `Select-String -Path <file> -Pattern 'fn spawn_terminal_session' -Context 0,10`, plus the
  `SpawnTestOverride` struct and the marker const.
  - EXPECTED: exactly **two** `pub async fn spawn_terminal_session(` definitions. The one preceded
    by `#[cfg(debug_assertions)]` declares `test_override: Option<SpawnTestOverride>`; the one
    preceded by `#[cfg(not(debug_assertions))]` declares exactly `cli, work_dir, cols, rows, app,
    state` and **no** `test_override`. `pub struct SpawnTestOverride` is preceded by
    `#[cfg(debug_assertions)]`. `pub const SPAWN_TEST_SEAM_COMPILED_IN: bool =
    cfg!(debug_assertions);` is present.
  - EDGE: both arms carry `#[tauri::command]` and the identical symbol/path (`lib.rs` registration
    unchanged — R-18); a THIRD definition (wrapper/alias) is a FAIL; the impl signature takes plain
    `Option` test params so `SpawnTestOverride` stays debug-only.
  - DATA: a clean read of the file on the spec tip.

- [ ] **F-18** — release test build (fresh compile proof): `cargo test --release --lib
  spawn_terminal` (release test profile = `bench`, inherits `release` ⇒ `debug_assertions = false`),
  then confirm every test naming `SpawnTestOverride` sits under `#[cfg(debug_assertions)]`.
  - EXPECTED: build + run `EXITCODE=0`; the release-absence marker test runs and asserts
    `SPAWN_TEST_SEAM_COMPILED_IN == false`; the inline test module COMPILES in release — which
    positively proves the `#[cfg(not(debug_assertions))]` arm compiles under
    `debug_assertions = false`.
  - EDGE: marker returns `true` ⇒ the profile assumption is wrong: FAIL against the plan's
    mechanism (report; do not reinterpret). An ungated debug-only test ⇒ the release test build
    fails to compile ⇒ FAIL. A zero-match name filter is recorded and F-16 becomes the compile
    evidence — not a PASS by itself.
  - DATA: none.

## R-2.b / AC2 — debug/test build STILL accepts `testOverride` (G-123 continuous)

- [ ] **F-19** — headless acceptance proof: (i) a debug-profile unit test asserts
  `SPAWN_TEST_SEAM_COMPILED_IN == true`; (ii) `serde_json::from_str::<SpawnTestOverride>(r#"{"binary":"C:\\Nonexistent\\copilot.exe","pwshMajor":5}"#)`;
  (iii) source read of the forwarding order in `spawn_terminal_session_impl`.
  - EXPECTED: (i) `true`; (ii) `Ok` with `binary == Some("C:\\Nonexistent\\copilot.exe")` and
    `pwsh_major == Some(5)` — the EXACT wire keys/values recipes F-14/F-16 send; (iii) `test_binary`
    is promoted AHEAD of `store.cached_get(COPILOT_PATH_KEY)` (`.or_else(…)`-style) and
    `test_pwsh_major` is forwarded into `prepare_session(…)`.
  - EDGE: camelCase wire keys (`testOverride`, `binary`, `pwshMajor`) unchanged; `Default` derive
    retained so `{}` still deserializes; `prepare_session`'s widened last param is `None` on
    `resume_terminal_session` (R-15); the Copilot-only PowerShell gate still keys on `pwsh_major`.
  - DATA: none (the payload literal above is the fixture).

- [ ] **F-20** — committed debug-reachability recipes:
  `git diff --exit-code origin/main...HEAD -- .opencode/tests/terminal/functional.md`, then read
  `:136-144` (F-14) and `:148-154` (F-16) of that file.
  - EXPECTED: diff `EXITCODE=0` (file untouched); F-14 still invokes `spawn_terminal_session` with
    `testOverride:{ binary:'C:\\Nonexistent\\copilot.exe' }`; F-16 with
    `testOverride:{ pwshMajor: 5 }`. These are R-2.b's UI-level consumers and are **referenced, not
    re-driven** here (their live execution belongs to the `terminal` suite's testing phase).
  - EDGE: a non-zero diff is a FAIL — the seam's consumer must not be "fixed" instead of the seam.
  - DATA: the committed `.opencode/tests/terminal/functional.md` (read-only; never edit it).

## R-2.c / AC2 — a release build cannot bind the value

- [ ] **F-21** — grep `test_override` inside the `#[cfg(not(debug_assertions))]` arm (expect 0
  matches) and read every assignment to `binary_override`.
  - EXPECTED: zero `test_override` occurrences inside the release arm; the only executable inputs
    are `store.cached_get(COPILOT_PATH_KEY)` (Copilot sessions) and PATH resolution
    (`resolve_binary`); the release arm calls the impl with literal `None, None`.
  - EDGE: do **not** assert an IPC error — an undeclared Tauri argument is simply never bound
    (serde/Tauri ignore unknown fields), so the claim is the ABSENT argument, not a rejection. A
    payload carrying `testOverride` therefore has no effect, which is exactly R-2.c.
  - DATA: none.

## R-3.a / AC3 — the four sensitive keys reject non-absolute / control-char / `..` values

- [ ] **F-22** — `validate_setting_value` rule matrix: 4 keys × 3 rules = **12** rejections with
  exact string equality.
  - EXPECTED: for each (key, rule) the returned `Err` equals —
    control → ``invalid setting value for `<key>`: path must not contain control characters``;
    non-absolute → ``invalid setting value for `<key>`: path must be absolute``;
    `..` → ``invalid setting value for `<key>`: path must not contain `..` components``.
    **12/12 exact.**
  - EDGE: keys `llama_server_path`, `llama_server_companion_dir`, `terminal_copilot_path`,
    `terminal_pwsh_path`. Values — relative `copilot.exe`, `foo\bar.exe`, `.`; control
    `C:\bin\copi\u{0}ot.exe`, `C:\bin\a\u{7f}.exe`; parent `C:\bin\..\..\evil.exe`, `..\evil.exe`.
    **Binding check order control → absolute → `..`**: `C:\a\u{1}..\b.exe` ⇒ the CONTROL message;
    `C:\a\..\b` ⇒ the `..` message. Each cell must be individually identifiable in the run output
    (per-cell test name, or a message naming key + rule); one opaque assertion covering many cells
    is INSUFFICIENT EVIDENCE for those cells.
  - DATA: none.

- [ ] **F-23** — both write planes reject identically and the store is untouched: the same 12
  (key, rule) cells through `persist_control_setting` and through `persist_setting`, then
  `cached_get` per key.
  - EXPECTED: 24/24 return the identical `Err` string as F-22; afterwards
    `store.cached_get(<key>) == None` for all four keys (no write reached either plane); the async
    plane never returns a validation error for an ACCEPTED value (F-26).
  - EDGE: fixture `SettingsStore::open(EngineHandle::new_pending(), tempdir)` — precedent
    `applications/doom/commands.rs:1300` and `applications/pg_supervisor/sweep.rs:187`. No
    PostgreSQL, no network. The async plane cannot reach a real store headlessly (`get`/`set` call
    `engine_or_err()`, `infrastructure/storage/mod.rs:250,269`), so the async discriminator is
    "no validation error" + F-26's no-transformation read.
  - DATA: a `tempfile::tempdir()` settings fixture (created by the test).

- [ ] **F-24** — one shared rule, two thin delegates: read `save_setting`, `save_control_setting`,
  `persist_setting`, `persist_control_setting`, `validate_setting_value`.
  - EXPECTED: both `#[tauri::command]`s are thin (call their `persist_*` delegate with the same
    `key`,`value`); BOTH delegates call `validate_setting_value(key, value)?` BEFORE the store
    write — the control plane is not a bypass; `SENSITIVE_PATH_SETTING_KEYS` is exactly the four
    names; registrations unchanged (`lib.rs:914`, `:920`).
  - EDGE: a duplicated rule (two implementations) is a FAIL (NFR-6); the error type stays
    `Result<(), String>` (no new serializable error struct on the wire); the control plane must not
    "validate then cache anyway".
  - DATA: none.

## R-3.b / AC3 — empty (and whitespace-only) clears

- [ ] **F-25** — for each of the four keys, `""` and `"   "` through both planes.
  - EXPECTED: `Ok(())` on both planes; after the whitespace-only write
    `cached_get(<key>).unwrap().trim() == ""`; `persist_setting` returns `Ok` or a NON-validation
    error.
  - EDGE: the row pins **trim-empty** (the consumer-visible clear), not the stored bytes — a
    normalised `""` is preferred but not gated (decision recorded in the plan's Discussion). The
    mixed probe `"\t\n "` and NBSP `"\u{00A0}"` are covered by E-11.
  - DATA: settings fixture (as F-23).

## R-3.c / AC3 — a valid absolute path is persisted unchanged

- [ ] **F-26** — `C:\Code\fredo\.opencode\tmp\3078\qa\bin\copilot.exe` through both planes.
  - EXPECTED: `validate_setting_value` `Ok`; `persist_control_setting` `Ok` and `cached_get`
    returns the value **BYTE-IDENTICAL** (no trim, no separator rewrite); `persist_setting` returns
    no validation error; the delegate body passes `key`/`value` unmodified to `store.set` (2-line
    body, no transform).
  - EDGE: `" C:\x\copilot.exe"` (leading space) is NOT absolute ⇒ rejected (E-12, UX consequence
    recorded); POSIX `/usr/bin/x` is absolute on Windows too ⇒ accepted; `C:bin\copilot.exe`
    (prefix-only, not absolute) ⇒ rejected.
  - DATA: settings fixture.

## R-3.d / AC3 — every key outside the four round-trips unchanged (no allowlist)

- [ ] **F-27** — `terminal_work_dir` = `..\..\relative\work`; `app_window_presentation` =
  `{"doom":"float"}`; arbitrary key `qa_3078_probe` = `a\u{7f}b..c` (control char + `..`).
  - EXPECTED: all three `Ok` on both planes and byte-identical through `cached_get`; neither
    delegate ever returns a validation error for them.
  - EDGE: **allowlist-creep canary** — an implementation validating "any `*_path` key" or "any
    value containing a separator" FAILS here: `terminal_work_dir` is a real non-listed path key
    (`applications/terminal/open_terminal.rs:32`). `diagram_path` (named in the backlog brief) does
    not exist in the tree; it is substituted with a real key.
  - DATA: settings fixture.

## R-4.a / AC4 — the webview export exposes no path argument

- [ ] **F-28** — read `export_doom_dataset`'s signature, the private `save_dialog`, and
  `infrastructure/ipc.rs`'s dispatch.
  - EXPECTED: `pub async fn export_doom_dataset(` declares exactly `app: AppHandle, format:
    Option<DoomDatasetFormat>` — no `out`, no `PathBuf`, no path-shaped argument; `save_dialog`
    builds `rfd::FileDialog::new().set_file_name(default_export_name(format)).save_file()` inside
    `tauri::async_runtime::spawn_blocking`; `ipc.rs` calls `export_doom_dataset_cli(…)` and never
    the webview command; `grep resolve_export_target` ⇒ **0 hits** (the old absolute-passthrough is
    gone).
  - EDGE: **pinned limitation — "mechanism verified, not UI-driven"**: the native dialog's pixels
    and interaction are not observable headlessly. What is verified is that the webview cannot name
    a path. A driver receipt neither proves nor is required for this AC.
  - DATA: none.

## R-4.b / AC4 — cancel writes nothing and returns the cancel outcome

- [ ] **F-29** — `export_seam_outcome` pure decisions plus the command's cancel arm.
  - EXPECTED: `export_seam_outcome(None, Some("1")) == DoomExportSeam::Cancelled`;
    `export_seam_outcome(Some(<path>), Some("1")) == Cancelled` (cancel outranks the path seam) and
    no file exists at `<path>` afterwards; the command maps `Cancelled → Ok(None)` (read the match
    arm).
  - EDGE: `FREDO_DOOM_EXPORT_CANCEL` = `"true"` / `"0"` / `""` do NOT cancel (only trimmed `"1"`,
    mirroring `wireframe/files.rs:61-63`) — probe E-17. The binding wire outcome is `Ok(None)` —
    not an error and not `Some(result)`.
  - DATA: `.opencode/tmp/3078/qa/export/cancel-probe.jsonl` (asserted ABSENT).

## R-4.c / AC4 — the env seams: path honoured verbatim, precedence CANCEL > path > dialog

- [ ] **F-30** — `export_seam_outcome` matrix plus an `export_dataset` write to an explicit
  absolute target.
  - EXPECTED: `export_seam_outcome(Some(P), None) == DoomExportSeam::Path(P)`;
    `export_dataset(&writer, fmt, Some(Path::new(P)))` writes exactly to `P` (absolute, OUTSIDE the
    dataset dir — the seam is the sanctioned test bypass, not the CLI confinement rule), body
    non-empty, `result.path == P`; one branch order expresses `Cancelled > Path > Dialog`;
    blank/whitespace-only `FREDO_DOOM_EXPORT_PATH` is inert ⇒ `Dialog`.
  - EDGE: the probe value carries no surrounding whitespace so the row does not depend on the trim
    question (the wireframe precedent trims, `wireframe/files.rs:65-72`). `FREDO_DOOM_EXPORT_PATH` =
    a directory or an unwritable path ⇒ typed `requestFailed`, NO partial file (E-16).
  - DATA: seeded dataset writer + `.opencode/tmp/3078/qa/export/seam.jsonl`.

## R-5.a / AC5 — absolute / drive-or-UNC-prefixed / `..` `out` is refused, nothing written

- [ ] **F-31** — `resolve_cli_export_target(dataset_dir, Some(<probe>))` for every form, with a
  before/after recursive listing of `.opencode/tmp/3078/qa/`.
  - EXPECTED: each probe returns `Err` with `code == DoomErrorCode::RequestFailed` (wire
    `requestFailed`) and a `message` equal to exactly ONE pinned constant — absolute
    `C:\Windows\Temp\fredo-3078-escape\evil.jsonl` ⇒ `EXPORT_ABSOLUTE_REFUSED`; `C:evil.jsonl` ⇒
    `EXPORT_PREFIX_REFUSED`; `\\localhost\C$\…\evil.jsonl` and `\\?\C:\…\evil.jsonl` ⇒
    `EXPORT_ABSOLUTE_REFUSED` **or** `EXPORT_PREFIX_REFUSED` (record which); `..\..\escape.jsonl`
    and `nested\..\escape.jsonl` ⇒ `EXPORT_PARENT_REFUSED`. The before/after file listing is
    IDENTICAL.
  - EDGE: exactly one constant per probe (never concatenated); never `Ok`; no file at the refused
    path, at `<dataset_dir>\..\`, or at the process CWD. The typed error reaches the CLI envelope as
    `ok:false` + `data.code` (read `ipc.rs:194-205` — its shape is unchanged). The export rule's
    check ORDER is not pinned by the plan, so the row is class-correct (absolute must not report
    the `..` message, etc.) and accepts either the absolute or prefix constant for UNC.
  - DATA: seeded dataset writer; `.opencode/tmp/3078/qa/` listing snapshot.

## R-5.b / AC5 — a plain relative `out` lands under `<dataset_dir>/exports/`

- [ ] **F-32** — `resolve_cli_export_target(dir, Some("nested/qa-3078.jsonl"))` then
  `export_dataset(&writer, Raw, Some(<that>))`.
  - EXPECTED: `Ok(Some(dir.join("exports").join("nested/qa-3078.jsonl")))`; the export writes it,
    `result.path` starts with `<dir>\exports\`, and the body equals the seeded raw JSONL; nothing
    appears at `<dir>\nested\…` or the CWD.
  - EDGE: parent creation unchanged (`dataset.rs:755-759`); backslash and forward-slash forms
    resolve identically under `exports`; `out = "exports/x.jsonl"` (redundant prefix) lands at
    `exports\exports\x.jsonl` — record it, not a FAIL.
  - DATA: seeded dataset writer.

## R-5.c / AC5 — absent or blank `out` ⇒ the default path

- [ ] **F-33** — `resolve_cli_export_target` with `None`, `Some("")`, `Some("   ")`; then
  `export_dataset(&writer, fmt, None)` for each format.
  - EXPECTED: `Ok(None)` for all three blank forms; the export writes
    `<dir>\exports\doom-dataset-<ts>.<ext>` whose basename matches
    `^doom-dataset-\d{8}T\d{9}Z\.(jsonl|sft\.jsonl|dpo\.jsonl)$`; `default_export_name(fmt)` returns
    the matching `doom-dataset-<ts>.<ext>` for all three formats.
  - EDGE: timestamp is `%Y%m%dT%H%M%S%3fZ` with `.` stripped (`dataset.rs:726-735`) ⇒ 8 digits + `T`
    + 9 digits + `Z`; extensions `jsonl` / `sft.jsonl` / `dpo.jsonl`; `DOOM_DATASET_EXPORT_DIR ==
    "exports"` unchanged.
  - DATA: seeded dataset writer.

## Complex scenario — "dataset export cannot escape its directory" (backlog Gherkin)

- [ ] **F-34** — one composed end-to-end unit test over a seeded dataset dir with the process CWD
  elsewhere.
  - EXPECTED: WHEN an export is requested with an **absolute** path THEN typed `requestFailed` +
    `EXPORT_ABSOLUTE_REFUSED` + no file anywhere; WHEN with a **`..`-bearing** `out` THEN typed +
    `EXPORT_PARENT_REFUSED` + no file; WHEN with a **plain relative** name THEN the ONLY new file in
    the whole tree is under `<dataset_dir>\exports\` — assert the recursive listing delta is
    EXACTLY one path and it starts with `<dataset_dir>\exports\`.
  - EDGE: not a duplicate of F-31/F-32 — it asserts the whole-tree invariant in one run, so a rule
    that refuses the path but still leaves a temp file behind is caught. The seam path leg (F-30) is
    the documented test-only exception and is unreachable from the webview (F-28).
  - DATA: seeded dataset writer; recursive listing of `.opencode/tmp/3078/qa/dataset/`.

## Non-functional

- [ ] **F-35** — diff guardrails.
  `git diff --stat origin/main...HEAD -- apps/tauri/src-tauri/Cargo.toml Cargo.lock`;
  `git diff origin/main...HEAD -- '*.rs'`; `git diff --exit-code origin/main...HEAD -- apps/tauri/src-tauri/tauri.conf.json apps/tauri/src-tauri/tauri.dev.conf.json apps/tauri/src-tauri/capabilities`;
  `git diff --stat origin/main...HEAD -- apps/ui/src`; read the four `lib.rs` registration lines.
  - EXPECTED: no new dependency (`rfd` already at `Cargo.toml:47`); zero added lines matching
    `^\+.*#\[allow`; config/CSP/capability diff `EXITCODE=0`; frontend diff empty; the four command
    registrations unchanged; no `[profile.*]` table added (see R-25 in `regression.md`).
  - EDGE: a version bump of an EXISTING dependency is recorded, not a FAIL; a NEW
    crate/plugin/capability file is a FAIL; adding a `[profile.*]` table is a FAIL (it would
    invalidate the `debug_assertions` mechanism).
  - DATA: the spec branch.

- [ ] **F-36** — docs state the shipped contract (ST-4, G-398): `docs/SECURITY.md`,
  `docs/CLI_GUIDE.md`, `docs/ARCHITECTURE.md:667`/`:987`.
  - EXPECTED: SECURITY.md carries the reachability-hardening note (release-absent spawn seam,
    four-key path validation on BOTH write commands, dialog-scoped webview export +
    `<dataset_dir>/exports/` CLI confinement); CLI_GUIDE documents `--out` (relative ⇒
    `<dataset dir>/exports/`; absolute and `..` rejected; blank ⇒ default); ARCHITECTURE's export
    sentence and `save_setting` description are aligned.
  - EDGE: a doc still claiming an absolute `--out` is honoured, or `save_setting` is an unvalidated
    KV write, is a FAIL (stale claim ⇒ audit restart). `AGENTS.md` / `opencode.json` untouched
    (human-owned).
  - DATA: none.

_Evidence convention (this section): every PASS must quote an `EXITCODE`, a test count, an exact
`file:line` text, an exact error string, or a listing delta. A static PASS with no quoted artifact
is a false PASS._

