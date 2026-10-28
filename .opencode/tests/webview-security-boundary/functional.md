# webview-security-boundary — Functional Tests

Durable functional suite for Fredo's **Tauri webview security boundary**: the capability
surface (shell plugin, dev-only MCP bridge), the production CSP / `withGlobalTauri`, and the
dev production split. Seeded by Spec #3077 (config-only hardening); extend it when a later spec
touches `apps/tauri/src-tauri/capabilities/`, `tauri.conf.json`, `tauri.dev.conf.json`, or the
external-link sites.

Verification policy is **live**: every row asserts an observable on a running artifact (DEV
instance and/or a bundled build), not only on files. A static-only run is not a verdict.

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
