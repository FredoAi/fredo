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
