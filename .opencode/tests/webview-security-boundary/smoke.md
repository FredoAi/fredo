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
