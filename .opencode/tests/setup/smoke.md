# setup — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the Fredo Setup surface.
> Runs on a running Fredo desktop app on `spec/3010`. **Verification policy: live.**

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Setup surface reachable — on boot NO Setup window auto-opens; the launcher tile `#fredo-launcher-grid [role="button"][aria-label="Fredo Setup"]` exists exactly once, and activating it opens `div[role="group"][aria-label="Fredo Setup"]` rendering `SetupWizard`.
- [ ] S-4: Settings→Fredo Setup reachable — open Settings; the `plugin-setup` nav item (label `Fredo Setup`) renders `<SetupWizard/>`.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3010/e2e/smoke.jpeg")` succeeds.
- [ ] S-6: Live receipt — `telemetry_spans` non-zero with a recent timestamp from the env's `ports.pg` (the live-policy gate; a static-only PASS is a FALSE PASS).

## #3198 — set of quick paths

> Seeded at triage for Spec #3198. Quick paths only; full assertions live in the named
> `functional.md` rows.

- [ ] S-7: **V1 gate quick path** — boot with `-EnvVar "PATH=…\fixtures\shim-opencode-1x"`
      (`dev-env.ps1 -Action Up -Spec 3198 -EnvId spec3198 -EnvSlot <n>`), open the Setup
      surface. EXPECTED: the OpenCode step shows an ERROR naming the found version and
      `opencode upgrade --major`; no success state, no plugin write. Full assertions F-9/F-13.
- [ ] S-8: **V2 install quick path (after #3197)** — `fredo setup --install-plugin` on a real
      2.x host. EXPECTED: one `[fredo]` line naming `…\.config\opencode\plugins\fredo.js` and
      "global"; the installed hash equals `apps/opencode-plugin/dist/index.js`. Full
      assertions F-14/F-15.
- [ ] S-9: **Capture quick path (after #3197)** — Terminal → one bounded OpenCode turn →
      `telemetry_spans` has ≥1 row for that session. Full assertions F-17.
