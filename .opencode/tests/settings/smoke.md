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

---

## #2868 extension — Settings-as-app-window smoke

> Issue #2868 retires the modal + floating gear; Settings opens as a `FredoFeatureClass` window
> from the launcher grid. **G-136:** S-3 ("the gear opens the dialog") is SUPERSEDED by S-10/S-11
> (launcher tile → feature window); the historical PASS is preserved. Live policy — screenshot +
> console-clean at each step; rendered-webview receipt per G-108, no fabricated `telemetry_spans`.

- [ ] S-10: Settings app reachable — press Ctrl+Space (or focus `input[role="searchbox"]`) to reveal
      `#fredo-launcher-grid[role="grid"]`, click `[role="button"][aria-label="Settings"]`; assert a
      `div[role="group"][aria-label="Settings"]` feature window with `header.fredo-window__header`
      title "Settings" renders its nav (Companion / Appearance / Fredo Setup / Telemetry);
      `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update
      depth exceeded`.

- [ ] S-11: The floating gear is gone — on a clean desktop scan for
      `IconButton[aria-label="Settings"]` at bottom-right and for a settings
      `chakra-dialog__content` modal; assert NEITHER exists; the launcher tile is the sole entry;
      console clean.

- [ ] S-12: Window controls quick path — click `[aria-label="Minimize Settings"]` then restore via
      the launcher tile (same single window); click `[aria-label="Close Settings"]`; assert the
      frame + its `useWindows()` entry are gone and re-open works; console clean.

- [ ] S-13: Companion gate quick path in the window — with the backend not ready, open Settings →
      Companion; assert `[data-testid="companion-setup-wizard"]` renders ONLY (no toggle/auto-return/
      tip); screenshot succeeds; console clean.

### #2868 testing round 1 (spec/2868 @ 90da8de) — results

> Verdict: **PASS**. Detail in `.opencode/tmp/2868/tests-runs.md` / `## Tests Runs (round 1)`.

- **S-10 PASS (live).** Ctrl+Space / searchbox focus reveals the grid; clicking the Settings tile opens `div[role="group"][aria-label="Settings"]` with title "Settings" + nav; screenshot succeeded; console clean.
- **S-11 PASS (live).** No floating gear (`button[aria-label="Settings"]` = 0) and no settings `chakra-dialog__content`; the launcher tile is the sole entry.
- **S-12 PASS (live).** Minimize → restore via the launcher tile (same single window) → Close (frame + `useWindows()` entry gone) → re-open works; console clean.
- **S-13 PASS (live).** On first open (probe in flight) the Companion section rendered `companion-setup-wizard` ONLY; on ready it swapped to `companion-controls`; console clean.

## #2892 extension — send-during-reply settings quick paths

> Quick paths for the two new Companion settings. The full matrix lives in `functional.md`
> F-41..F-47 / `regression.md` R-17..R-20. **Verification policy: live.**

- [ ] S-14: **Both controls render with defaults.** Open Settings -> Companion on a fresh profile;
      read `[data-testid="companion-send-during-reply"]` and
      `[data-testid="companion-reply-leave-grace"]`. **Expected:** the select reads `queue`, the
      grace number input reads `2` (seconds); screenshot succeeds; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-15: **Persistence quick path.** Set the select to `interrupt` and the grace field to `10`
      (seconds = 10000 ms); reload the webview; re-open Settings -> Companion. **Expected:** both
      values are still shown (`interrupt` / `10`), and `localStorage` holds
      `Fredo_companion_send_during_reply='interrupt'` +
      `Fredo_companion_reply_leave_grace_ms='10000'`; screenshot succeeds; console clean.
- [ ] S-16: **Theme quick path.** With the section open, switch dark↔light and a non-default accent.
      **Expected:** both controls re-tint token-native with no stale color and the select stays a
      themed control (NOT a native unstyled `<select>`); screenshot succeeds; console clean.

### #2892 testing round 1 — result

- [ ] _(pending — the Tester records the round verdict + per-row evidence here; do not pre-fill)_
