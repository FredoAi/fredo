# webview-security-boundary — Smoke Tests

App-boots + boundary sanity for the hardened webview. Run in the isolated DEV instance, then once
against the production-policy bundle. Standard boilerplate, adapted (the "feature surface" here is
the whole app shell + the capability/CSP boundary).

## Prerequisites

- `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3077 -EnvId <id> -EnvSlot <n> -RequireIsolation` reports ready.
- `tauri_driver_session start` connected at the manifest `ports.mcp`.
- Screenshot dir exists: `.opencode/tmp/3077/e2e/`.

## Cases

- [ ] S-1 — **App window renders (DEV).** `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>` (child element count > 0). First paint can take 3–5 min in a fresh isolated env (G-386) — wait, do not call it a wedge.
- [ ] S-2 — **No console errors (DEV).** `tauri_read_logs(source="console", lines=50)` before and after the boundary probes shows no `Error:`, `Uncaught`, `Maximum update depth exceeded`, or `Content Security Policy`/`Refused to execute inline script` entry.
- [ ] S-3 — **All four window labels work (DEV).** `tauri_manage_window action="list"` shows `main`; open Terminal, open Doom, and open any application (`app-*`). EXPECT: every window opens; no capability-denied error in the console (core:* / event / window perms survived the hardening).
- [ ] S-4 — **Boundary probes respond (DEV).** `tauri_webview_execute_js` returns a value and `typeof window.__TAURI__ === 'object'` (bridge channel alive); `window.__TAURI_INTERNALS__.invoke('plugin:shell|execute', …)` rejects with an ACL `not allowed` error.
- [ ] S-5 — **Screenshot captured.** `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3077/e2e/smoke.jpeg")` succeeds; the image shows the rendered app shell (not a blank/white webview).
- [ ] S-6 — **Production-policy bundle boots.** Launch `target/debug/fredo.exe` (after `pnpm --filter @fredo/tauri exec tauri build --debug`). EXPECT: the process is alive and `tauri_manage_window action="list"` (driver at `"16931"`) lists `main`. DOM/screenshot tools are expected to be unavailable in the RELEASE binary by construction — that is AC4, not a smoke failure; for release smoke use native window enumeration.

## Expected outcome

S-1..S-6 all PASS on the spec tip. Any capability-denied error on a `main`/`terminal`/`doom`/`app-*`
window is a regression (see `regression.md`) — do not dismiss it as an environment wedge until the
G-046/G-067 ladder has been tried and disclosed.

---

## #3078 smoke — static legs (NO instance required)

#3078's verification policy is `static`: these three legs replace the app-boot smoke for that spec.
Do not start a DEV instance or attach a driver for them.

- [ ] **S-7 — the new seam test groups exist and are green.** `cargo nextest run
  --manifest-path apps/tauri/src-tauri/Cargo.toml -E 'test(seam) or test(validate_setting) or
  test(export_seam) or test(cli_export_target)'`.
  - EXPECT: `EXITCODE=0`; quote the summary (`N tests run: N passed, 0 failed`) and the listed test
    names — at least one per group: terminal seam presence/absence, `validate_setting_value`, the
    export seam decision, and the CLI target rule.
  - EDGE: a zero-match filter is recorded and reported (a missing group is a suite gap, not a
    silent pass); if `nextest` is unavailable, `cargo test` with the same filters is an acceptable
    substitute — record which ran.

- [ ] **S-8 — the #3077 static boundary baseline still reads the same.** Re-read F-1, F-3, F-6, F-9,
  F-10 (capabilities, mcp-bridge, `shell:allow-open`, CSP + `withGlobalTauri`, `__TAURI__`).
  - EXPECT: identical results to their last recorded evidence; #3078 adds no capability/CSP change
    (R-26 in `regression.md`).
  - EDGE: any drift is a cross-spec regression — report it against the config surface, not #3078's
    seams.

- [ ] **S-9 — both build profiles are clean.** Re-run `cargo check` and `cargo check --release` and
  quote both `EXITCODE` values plus the `warning:` line count (0/0).
  - EXPECT: `0`/`0`; no `#[allow(...)]` added.
  - EDGE: a cached release run is corroborated by F-18's `cargo test --release --lib`.

## Expected outcome (#3078)

S-7..S-9 all PASS on the spec tip. S-1..S-6 remain the #3077 smoke and are not re-run for a
static-policy spec.
