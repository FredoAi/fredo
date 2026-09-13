# Settings — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the shared Settings
> dialog shell (`ProfileSettingsModal`). Seeded at Issue #2864. Runs on a running Fredo desktop
> app; live policy — screenshot + console-clean at each step.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Settings surface reachable — the gear (`[aria-label="Settings"]`) opens the dialog; the sidebar nav (Companion / Appearance / Fredo Setup / Telemetry) renders.
- [ ] S-4: Companion section accessible — Settings → Companion renders the visibility toggle + auto-return input + Teleport tip (or the not-ready wizard); no orphan section.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2864/e2e/smoke.jpeg")` succeeds.
- [ ] S-6: Theme re-tint quick path — switch dark↔light with the dialog open; the chrome + Companion panel re-tint with no stale color; screenshot succeeds; console clean.

### #2864 testing round 1 (spec/2864 @ f2c8923, product 5c0fb5b) — results

- **S-1 PASS.** Non-empty DOM (125 indexed elements, `body.theme-classic` → `#root`).
- **S-2 PASS.** Console error-level empty of product errors (one tester-introduced transient-probe `TypeError` at `:77` from a timed-out async execute_js — not a product error); no `Uncaught`/`Maximum update depth exceeded`.
- **S-3 PASS.** The gear opens the dialog; sidebar nav renders (Companion / Appearance / Fredo Setup / Telemetry + `FEATURES` group).
- **S-4 PASS.** Companion renders the ready controls or the not-ready wizard — no orphan section.
- **S-5 PASS.** Screenshots captured (`tester-*.png`, uploaded).
- **S-6 PASS.** dark↔light re-tint with the dialog open; no stale color; console clean.

## #2865 extension — wizard-in-dialog smoke

- [ ] S-7: Gate quick path — with the backend not ready, open Settings → Companion; the dialog
      renders the wizard ONLY (no toggle/tip/auto-return) in dark `classic` AND light
      `light-default`; screenshot succeeds; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.

- [ ] S-8: Sibling quick path — with the wizard open, switch to Fredo Setup and back; both sections
      render correctly in the same dialog with no orphan section/crash; screenshot succeeds.

- [ ] S-9: Visual artifacts + gates — `.opencode/tmp/2865/visual-eval-before.md` +
      `before-after-verdict.md` exist; BEFORE/AFTER frames use DISTINCT `before-*`/`after-*` names;
      `pnpm --filter @fredo/ui build` exit 0; the frozen `companion-setup-wizard` hook is present.
