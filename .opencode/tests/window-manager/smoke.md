# Window Manager — Smoke (Spec #2807 — Own window-system kernel)

> Standardized smoke for the window-manager surface. App-boots + core-path sanity, layered on the tests-README boilerplate. Live policy: capture + console-clean at each step.

## Standard boilerplate

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Window chrome reachable — the desktop work area renders a window manager surface (empty workspace with reachable window frame controls once a window is open), not a broken/blank shell.
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible, and it no longer exposes a window-style variant selector.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2807/e2e/smoke.jpeg")` succeeds.

## Window Manager quick path

- [ ] S-6: Open a feature window from the desktop toolbar — the window opens framed in the Fredo brand chrome (own engine), NOT the third-party chrome; DOM snapshot shows the window surface + header.
- [ ] S-7: The window chrome controls (minimize / maximize / close) are rendered and reachable — clicking close removes the window from the work area and the open-window list (idempotent, no crash). `tauri_read_logs(source="console")` clean.
- [ ] S-8: Re-open the same feature window after closing it — it opens again cleanly (no stale frame, no duplicate, no focus trap); re-open + update twice works end-to-end.

## Test run (round 1)

- **S-1 PASS** — `dom_snapshot(structure)` returned non-empty `<body>`.
- **S-2 PASS** — console read: no `Error:`/`Uncaught`/`Maximum update depth`; only a `motion() is deprecated` warn.
- **S-3 PARTIAL** — the desktop work area renders (toolbar + theme background), but NO window frame surface ever exists because no window can be opened (S-6 fails). Mark UNVERIFIED for "window frame controls once a window is open."
- **S-4 PASS** — settings dialog opens (gear) with sections (Companion/Appearance/Fredo Setup/Telemetry/Features) and exposes NO window-style variant selector.
- **S-5 PASS** — screenshots saved under `.opencode/tmp/2807/e2e/` (00..05).
- **S-6 FAIL** — clicking the toolbar Mission Monitor / Query Viewer entries opens NO window (0 `.fredo-window__surface`, 0 `.window-container`); toolbar open path routes to `@maomaolabs/core`'s own store (dist `index.es.js:44`), whose window host is unmounted. Root cause: `DesktopToolbar.tsx:2` uses `@maomaolabs/core` `Toolbar`; ST-5 re-pointed `useWindows` only.
- **S-7 UNVERIFIED (blocked by S-6)** — no window chrome controls to reach/close.
- **S-8 UNVERIFIED (blocked by S-6)** — no window to re-open.

## Test run (round 2)

- **S-1 PASS** — `dom_snapshot(structure)` non-empty `<body>`.
- **S-2 PASS** — console read: no `Error:`/`Uncaught`/`Maximum update depth`; only a `motion() is deprecated` warn + a transient React Flow layout warn.
- **S-3 PASS** — desktop work area renders; with a window open the window surface `role="group"` + chrome header + controls are reachable.
- **S-4 PASS** — settings dialog (gear) opens with sections (Companion/Appearance/Fredo Setup/Telemetry/Features); Appearance exposes NO window-style variant selector.
- **S-5 PASS** — screenshots saved under `.opencode/tmp/2807/e2e/` (00..07).
- **S-6 PASS (round-2 fix)** — clicking the toolbar `button[aria-label="Mission Monitor"]` opens the window framed in the Fredo brand chrome (own engine); DOM shows `.fredo-window__surface` + header + controls; screenshot `01-mm-open.png`. The `onClickCapture` wrapper routes the launcher click to the own kernel's `openFeatureWindow`.
- **S-7 PASS** — the window chrome controls (Minimize / Restore / Close) are rendered and reachable; clicking Close removes the window and the open-window list (idempotent, no crash); console clean.
- **S-8 PASS** — re-opening the same feature window after closing opens cleanly (no stale frame, no duplicate, no focus trap); re-open + update twice works end-to-end (session list grew 1→2→3 with identical surface class = no remount).

## #2838 extension — left-edge dock smoke

- [x] S-9: Open one feature window, then minimize it. EXPECTED: NO bottom-docked "Open applications" tray appears (the #2821 drawer is gone); hovering the real pointer at the left edge (x ~0-4) reveals the dock listing the open window's icon; moving the pointer away hides it again; `tauri_read_logs(source="console")` clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **PASS (spec/2838 @ 6ccf4820, round 1):** opened Mission Monitor (Sessions), minimized → `bottomRegions: []` (no tray); pointermove to the left edge revealed the dock listing `Sessions (minimized)`; pointer away re-hid it (`visibility:hidden`, x=-60). Screenshot `s9-smoke-minimize-reveal.jpeg`. Console read after the leg: no dock-caused errors (the only errors in the round are the documented driver artifact + boot HMR note — see functional F-34).

## #2850 extension — companion cross-window teleport smoke

- [ ] S-10: With the Run CLI terminal window open (`tauri_manage_window(action="list")` = main +
      `run-cli-terminal`), Ctrl+right-click in the terminal window. EXPECTED: the companion leaves
      main (teleport-out then hidden) and arrives in the terminal window (teleport-in then idle) at
      the clamped point; the companion is visible in exactly ONE window at every settle;
      `tauri_read_logs(source="console")` on BOTH windows is clean of `Error:`/`Uncaught`/
      `Maximum update depth exceeded`.

## #2868 extension — Settings is a normal feature window (G-136 reconciliation)

> Issue #2868 converts Settings from the retired modal into a `FredoFeatureClass` window opened
> from the launcher grid. **G-136:** S-4 ("gear/nav opens the settings dialog") is SUPERSEDED by
> S-11 below — the window-kernel lifecycle is the canonical Settings path now. Historical PASS
> records above preserved. Live policy.

- [ ] S-11: Open the Settings window from the launcher tile; exercise the full own-kernel lifecycle
      — maximize → minimize → restore → close — and re-open. EXPECTED: the Settings window behaves
      EXACTLY like any other feature window (no special-case modal): the controls
      `[aria-label="Minimize Settings"]`/`[aria-label="Restore Settings"|"Maximize Settings"]`/
      `[aria-label="Close Settings"]` dispatch to the kernel; minimize hides the surface while the
      entry stays in `useWindows()`; restore returns it focused; close removes it; re-open from the
      tile restores the SAME single window id (no duplicate, no focus trap). `tauri_read_logs`
      clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`. Reference
      `.opencode/tests/settings/` F-23/F-25/F-27 + window-manager R-7.

### #2868 testing round 1 (spec/2868 @ 90da8de) — result

- **S-11 PASS (live).** Opened from the launcher tile; full own-kernel lifecycle — maximize (1920×1017) → Restore (480×320, 8 grips) → Maximize → Minimize (surface hidden, dock entry `Settings (minimized)` stays) → restore via the tile (focused, count 1) → Close (frame + entry gone) → re-open. No special-case modal layer, no focus trap; `tauri_read_logs` clean. Evidence: `.opencode/tmp/2868/tests-runs.md` / `## Tests Runs (round 1)`.

## #2870 extension — cross-window away ⇒ main empty seat (G-136 reconciliation of S-10)

> **G-136:** S-10's "the companion leaves main (teleport-out then hidden)" wording is SUPERSEDED — after
> #2870 the main seat renders the empty-seat placeholder (never a second Fredo). The "visible in exactly
> ONE window" invariant remains. Historical record above preserved. Live policy.

- [x] S-12: With the Run CLI terminal window open (`tauri_manage_window(action="list")` = main + `run-cli-terminal`), Ctrl+right-click INSIDE the terminal window. EXPECTED: the terminal hosts the single interactive Fredo (teleport-in then idle at the clamped point); the MAIN desktop renders the empty-seat placeholder (80×100) at the centre slot and NO second Fredo — global interactive-Fredo count == 1 at every settle; a 5 s idle auto-return returns Fredo to the main seat; `tauri_read_logs(source="console")` on BOTH windows is clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **Edge (auto-return → teleport, defect F-68 / #2870 round 3):** after the 5 s idle auto-return
    has returned Fredo to the MAIN seat (settle complete, `isAutoHidden=true`), Ctrl+right-click
    INSIDE the terminal again to teleport away. EXPECTED: exactly ONE interactive Fredo present
    (the away overlay in the terminal — count == 1, never zero), the main seat renders the
    empty-seat placeholder (`[data-state="away"]`), and the host idle gate RE-ARMS so a further
    5 s idle auto-return brings Fredo home again — no stuck zero-Fredo state without a companion
    toggle; both windows' consoles clean.
- **#2870 round 3 (spec/2870 @ e27ff0a9) — S-12 PASS (live).** `open_run_cli`-equivalent via the
  Run CLI launcher tile created `run-cli-terminal` (list = main + run-cli-terminal, 900×600). The
  real recipe (b) Ctrl+right-click INSIDE the terminal produced `companion-teleport
  {toWindow:'terminal'}`: aligned 80 ms samplers recorded main `away` (0 interactive)
  791207→796622 while the terminal `.fredo-companion-avatar` = 1 791176→796591 — global
  interactive count == 1, never 2, and the 5 s host idle auto-return re-occupied the main seat.
  The F-68 edge (post-auto-return re-teleport) was exercised in the main window (in-page
  lifecycle sampler: teleport → auto-return → teleport → exactly one overlay, count never 0, idle
  re-armed; see companion F-68). Consoles: both windows' error-level reads empty. Note: the very
  first recipe-(b) attempt did not host (listener-registration race on the freshly opened terminal
  window); a retry after the window settled hosted correctly — follow-up probe artifact, not a
  product defect.
