# installable-apps — Smoke Tests

App-boots + core-path sanity for the installed-application surface. Run in the isolated DEV instance
on the spec tip, after `pnpm install --frozen-lockfile` if the spec added a UI dependency.

## Prerequisites

- `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3147 -EnvId <id> -EnvSlot <n> -RequireIsolation` reports ready (never `Restart`, G-328). **For a #3145 run, substitute `-Spec 3145` and capture to `.opencode/tmp/3145/e2e/`.**
- `tauri_driver_session start` connected at the env's MCP port (a decimal-string `appIdentifier`).
- Screenshot dir exists: `.opencode/tmp/3147/e2e/`.
- Both fixture generators have been run once and their output dirs recorded.
- A fresh isolated boot can take 3–5 min before first paint (G-386) — wait it out; do not call it a wedge.

## Cases

- [ ] **S-1 — App window renders.** `tauri_webview_dom_snapshot(type="structure")` on `main` returns a non-empty `<body>` (child element count > 0).
- [ ] **S-2 — No console errors.** `tauri_read_logs(source="console", lines=50)` before and after the core path shows no `Error:`, `Uncaught`, `Maximum update depth exceeded`, `Content Security Policy`, or `Refused to execute` entry. Check it TWICE — on first paint and after the open/close cycle.
- [ ] **S-3 — The feature surface is reachable.** Settings opens with `[data-testid="settings-nav-installed-apps"]` present; clicking it renders `[data-testid="installed-apps-pane"]` containing `[data-testid="installed-apps-install-button"]` with accessible name **"Install application package..."**.
- [ ] **S-4 — The launcher section is reachable.** Opening the launcher (Ctrl+Space) reveals `[data-testid="launcher-installed-apps-section"]`; with zero installed apps it renders an empty/absent state without throwing (record which), and after an install it lists one `[data-testid="launcher-installed-app"]` per installed app.
- [ ] **S-5 — The core path in one pass.** Install the valid package → the entry appears → open it → a window labelled `installed-<id>` exists with `[data-testid="installed-app-root"]` rendered → close it → the window is gone → re-open it → it renders again.
  - EXPECT: every step observed; no host restart; console clean; the host PID is unchanged across the cycle.
- [ ] **S-6 — No `installed-*` window at startup.** On a fresh boot with at least one installed app present, `tauri_manage_window action="list"` shows NO label starting `installed-` and the host log carries no `fredoapp` serve line before the first open (R-5.1's discriminator, smoke level — the full row is F-5.1). **Read the serve log per the Serve-line receipt in `functional.md`:** grep `<env-root>/logs/dev-env-stdout.log` for `fredoapp`, current boot only (primary, documented at `dev-environment` SKILL.md:234); `tauri_read_logs(source="system", …)` only if that source exists in this driver — optional, never required. **A zero line count only counts as evidence if the same log demonstrably carries a line AFTER the first open** (that is what makes the instrument real); if no instrument yields a line even after an open, record an **ARTIFACT defect** to report — never a silent PASS.
- [ ] **S-7 — Capture captured.** `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3146/e2e/smoke.jpeg")` succeeds and shows the rendered shell (not a blank/white webview); a **native capture** of the child window (`installed-<id>`, via `PrintWindow` / OS screenshot — **not** `tauri_webview_screenshot(windowId="installed-<id>")`, which times out) shows the app's own interface **and its `QA3146-FIXTURE` header line**.
- [ ] **S-8 — Both build gates green.** `pnpm --filter @fredo/ui build` ⇒ `EXITCODE=0`; `cargo check --locked` (from `apps/tauri/src-tauri`) ⇒ `EXITCODE=0` with zero `warning:` lines. Use `run-exitcode.ps1 -Command "<cmd>"` to capture the exit code in this sandbox.
- [ ] **S-9 — The pane's two empty/loaded states.** With zero installed apps, `[data-testid="installed-apps-empty"]` renders and `[data-testid="installed-apps-list"]` is absent; after installing one app the list renders and the empty state is gone (F-6.3's smoke-level leg).
- [ ] **S-10 — The authoring kit boots from a bare directory (#3145).** From a directory containing nothing but the copied kit (no `node_modules`, no checkout): `node <kit>/fredo-authoring/bin/fredo-app.mjs --help` ⇒ exit `0` and lists **exactly** `check` and `pack`; `node <kit>/fredo-authoring/bin/fredo-app.mjs check <a valid package dir> --json` ⇒ exit `0` with `violations: []`; and the theme package's **committed drift-gate command**, quoted verbatim from `packages/fredo-theme/package.json`'s `scripts` entry (do not invent a flag) ⇒ exit `0`.
  - EXPECT: all three exit `0` from the bare directory; no `pnpm`/`npm`/`cargo` invocation anywhere in the sequence; the `--help` verb list is exactly two. Use `run-exitcode.ps1 -Command "<cmd>"` for each `EXITCODE=`.
  - EDGE: a kit that needs `node_modules`, a registry install, or the repo root on the resolution path is a FAIL of NFR-3 — record the exact failing import. A third verb in `--help` means a scaffolder shipped (a named non-goal, and it voids the exam's F-8.1 discrimination — report it, do not accept it).

## Expected outcome

S-1..S-10 all PASS on the spec tip. A capability-denied error on a `main`/`terminal`/`doom`/`app-*`
window is a regression (see `regression.md` R-2) — do not dismiss it as an environment wedge until
the G-046/G-067 ladder has been tried and disclosed.

A failing S-5 blocks the whole round: the remaining functional rows need a working install → open →
close → re-open cycle. Record the failing step and the console/log evidence, and mark the dependent
rows `UNVERIFIED (blocked by S-5)` rather than driving them against a broken cycle.
