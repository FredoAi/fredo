# Settings — Functional

> Durable functional suite for the shared Settings dialog shell (`ProfileSettingsModal`) — the
> chrome that hosts Companion / Appearance / Fredo Setup / Telemetry / feature settings sections.
> Seeded at Issue #2864 (Settings → Companion chrome + theming conformance). Rows map 1:1 to the
> QA Plan `Q-1..Q-13` in `.opencode/tmp/2864/triage.md` `## QA Expert`.
> **Verification policy: live** — screenshots (raw URLs via `upload-evidence`) + DOM/computed-style/
> geometry + the mandatory `telemetry_spans` receipt (F-13). A static-only PASS is a FALSE PASS.
> The Companion-panel-content rows live in `.opencode/tests/companion/functional.md` F-42..F-48.
> Audited files: `apps/ui/src/features/home/components/ProfileSettingsModal.tsx`,
> `apps/ui/src/app/theme/system.ts`, plus every `apps/ui` file in the slice diff.

## F-1 (Q-1 / AC-1) — BEFORE capture: Settings→Companion chrome across the state × theme matrix

- [ ] F-1: On the pre-dev `spec/2864` tip (= `main`, before any developer commit), open Settings
      (`[aria-label="Settings"]`) → Companion and screenshot each matrix cell: {companion ON,
      companion OFF, auto-return input idle, auto-return input editing, not-ready gate} × {dark
      `classic`, light `light-default`} + one non-default accent (Matrix / `accentPrimary`
      override `#123456`). Include one nav-item hover frame and one forced sidebar-overflow
      (scrollbar thumb) frame.
  **Expected:** one readable screenshot per cell under `.opencode/tmp/2864/e2e/before/`, uploaded
      via `upload-evidence` with raw URLs recorded; the full modal is in frame (sidebar nav +
      content); ON vs OFF, idle vs editing, and controls vs not-ready-wizard are visually
      distinct. Capture-only — no verdict here.
  - **Edge:** 960×620 AND a narrower window; the not-ready cell is BLOCKED-with-cause if
    unreachable — never silently omitted; re-capture if the branch moves before dev starts.
  - **Ref:** companion F-42 captures the panel-content states; this row owns the shared chrome.

## F-2 (Q-2 / AC-1) — UI/UX-authored BEFORE visual evaluation exists

- [ ] F-2: Locate the vision-capable UI/UX Expert's post-BEFORE artifact (A2A `## UI/UX Expert`
      section / issue evidence). Confirm it Reads EVERY BEFORE image and reports what is
      visually observed — nav highlight color, footer/hover, light-invisible scrollbar, tip
      dimming (a BEFORE-state defect; H6 resolves it, so the AFTER must show the tip undimmed),
      heading/grouping — and lists the AC-1 issues.
  **Expected:** ONE evaluation per BEFORE image, each naming the file it read. A testid/geometry-
      only artifact, or missing coverage of any BEFORE image, is a FAIL.
  - **Edge:** an evaluation authored from filenames (not the image files) is a FAIL; a re-capture
    invalidates the pair.

## F-3 (Q-8 / AC-4) — AFTER capture: SAME matrix, matched viewport

- [ ] F-3: On the implementation tip, repeat F-1 at the same window size/viewport, theme/accent,
      and state set into `.opencode/tmp/2864/e2e/after/`, uploaded via `upload-evidence`.
  **Expected:** one screenshot per cell, matched by filename/viewport to its BEFORE image so the
      pair is comparable side-by-side. Re-run on the tested tip if the branch moved.
  - **Edge:** same hover + scrollbar frames as BEFORE; an unreachable state is recorded as a
    blocker, never silently substituted.

## F-4 (Q-9 / AC-4) — UI/UX-authored before-vs-after verdict

- [ ] F-4: Locate the UI/UX Expert's post-implementation artifact.
  **Expected:** a verdict that Reads BEFORE+AFTER pairs side-by-side, names improvements AND
      regressions, and gives every AC-1 issue exactly one disposition (fixed /
      accepted-with-reason / out-of-scope). A testid/geometry-derived verdict is a FAIL.
  - **Edge:** every AC-1 issue from F-2 appears exactly once; no regression omitted.

## F-5 (Q-3 / AC-2) — Zero hardcoded color literals in the audited chrome files

- [ ] F-5: Grep `ProfileSettingsModal.tsx`, `system.ts`, and every `apps/ui` file in the slice
      diff for `#[0-9a-fA-F]{3,8}`, `rgba(`, `rgb(`, `hsla(`, and
      `var\(--[a-z-]+\)[0-9a-fA-F]{2}`.
  **Expected:** ZERO true color literals in the audited files (comment issue-refs exempt).
      Expected resolved conversions: nav active bg `rgba(147,51,234,0.12)` →
      `tint('var(--accent-primary)', 12)` + `var(--accent-strong)` (T6) indicator; nav hover
      `rgba(255,255,255,0.04)` → `var(--hover-bg)` (T1); scrollbar thumb/hover
      `rgba(255,255,255,0.12/0.22)` → `var(--scrollbar-thumb)`/`var(--scrollbar-thumb-hover)`
      (T3/T4); backdrop `rgba(0,0,0,0.6)` → `var(--overlay-bg)` (T7); boxShadow
      `rgba(0,0,0,0.4)` → `var(--shadow-dialog)` (T8). `ProfileSettingsModal.tsx:49,57,22-25,111,118`
      are the known leads. Name any remaining literal by file:line — a FAIL.
  - **Edge:** `transparent`/`inherit`/`currentColor`/`none` allowed; distinguish `var(--x)NN`
    (FAIL) from a JS 8-digit hex concat (OK); `theme.ts` token-value data is out of scope unless
    changed.

## F-6 (Q-4 / AC-2) — Settings chrome follows the live accent

- [ ] F-6: For dark, light, and the non-default accent, read live computed styles of the active
      nav highlight (bg + `borderLeftColor` + text), a hovered inactive nav item (bg + text), the
      sidebar `::-webkit-scrollbar-thumb`, dialog border/backdrop, and the SaveFooter button
      (`background`, `color`). Change theme/accent with the modal open.
  **Expected:** every value derives from the theming feature and re-tints with the live accent —
      no stale color; the nav highlight uses `tint()`/a token; the scrollbar thumb is visible on
      BOTH themes (the white-alpha `rgba(255,255,255,0.12)` on light is the H2 lead).
  - **Edge:** accent switched while the modal is open; high-contrast/light presets; a sidebar with
    no overflow (no thumb) vs forced overflow.

## F-7 (Q-5 / AC-3) — Chrome contrast AA (dark + light + non-default accent)

- [ ] F-7: From live computed colors compute contrast for: nav labels (active + inactive) vs
      sidebar bg; section labels vs surface; the nav highlight label vs its tinted bg; scrollbar
      thumb vs track; Save button label vs accent bg.
  **Expected:** text ≥ 4.5:1 and non-text UI ≥ 3:1 in every combination; quote the measured
      ratios. A failing pair is a FAIL naming it.
  - **Edge:** on-accent buttons (H7) MUST use the T5 foreground token `var(--accent-contrast)`
    (never a literal `white`) and still pass AA on a light accent; selected-nav label on its
    highlight.

## F-8 (Q-6 / AC-3) — Local feedback < 400 ms

- [ ] F-8: Timestamp click→visible-change for nav section selection, the Save button press, and a
      nav hover (transition). Probe via rAF/attribute sampling + screenshot pairing.
  **Expected:** each local affordance responds well under 400 ms (CSS transitions 0.15–0.2 s).
      Backend waits are not counted as control feedback.
  - **Edge:** first open vs steady state; rapid switching.

## F-9 (Q-7 / AC-3) — Hierarchy / spacing / grouping / keyboard order

- [ ] F-9: DOM/a11y + screenshot the dialog: sidebar header, nav item spacing/padding, content
      section grouping vs sibling sections, and keyboard tab order.
  **Expected:** clear reading order; consistent spacing/grouping with the sibling sections; no
      split-attention or redundant duplication; keyboard order matches visual order; the dialog
      geometry (960×620) and close affordance are intact.
  - **Edge:** all nav items present incl. the "Features" group label; long labels wrap.

## F-10 (Q-10 / AC-5) — Non-Companion sections regression, light + dark

- [ ] F-10: Open and capture each section: Appearance (ThemingSettings + DockPositionSettings),
      Fredo Setup (SetupWizard), Telemetry (TelemetrySettings), and ≥1 discovered feature
      settings section. Additionally exercise the four feature panels that register a SaveFooter
      save fn (`RunCliSettings.tsx:25`, `WorkItemsSettings.tsx:107`, `DiagramSettings.tsx:54`,
      `ModelStorageSettings.tsx:28`) with T5 `--accent-contrast` applied.
  **Expected:** each renders correctly light AND dark; no orphan nav item, no crash, no blank
      content; shared-shell changes do not regress their content; each SaveFooter button shows/
      hides correctly and its label is legible on the accent bg (T5 must not break them); the
      non-Companion `--hover-bg` consumers (`SetupWizard.tsx:382`, `FloatingSettingsButton.tsx:61`,
      step cards) render a real surface, not transparent. Cross-ref `.opencode/tests/app-dock/`
      F-1/S-6 and `.opencode/tests/theming/` F-1..F-10.
  - **Edge:** open each after switching theme; feature section present; close/reopen modal.
    `TelemetrySettings.tsx:380` keeps its own backdrop literal `rgba(0,0,0,0.55)` (outside the
    audited files, so the grep is clean) — record accepted-divergence vs in-scope cleanup; the 18
    non-Companion `colorPalette="purple"` sites are out of slice unless the UI/UX audit flags a
    visible inconsistency.

## F-11 (Q-11 / AC-5) — Build + suite gates

- [ ] F-11: `pnpm --filter @fredo/ui build`; `pnpm --filter @fredo/ui test:run`; run the
      companion/theming/app-dock/desktop-chrome suites.
  **Expected:** build exit 0, zero TS errors/warnings; all suites green. Existing assertions are
      NOT weakened/disabled/deleted; any refreshed assertion is explicitly owned per G-125.
  - **Edge:** no dangling import/stale literal test; console clean.

## F-12 (Q-12 / AC-5) — Theme-token non-regression

- [ ] F-12: Select presets, set then clear an `accentPrimary` override, toggle dark/light, and
      re-check the audited surface + unrelated surfaces (desktop shell, mission-monitor chrome).
  **Expected:** no theme-engine change beyond a proven-required global token fix; any new token
      resolves correctly in BOTH light and dark (the derived `color-mix` tokens compute from the
      live preset/override vars — a single per-theme resolution, not two literal values) and does
      not alter existing consumers. Cross-ref `.opencode/tests/theming/` R-11..R-13.
  - **Edge:** user-preset save/discard; stale `localStorage` preset id clamps.

## F-13 (Q-13 / LIVE) — Mandatory `telemetry_spans` + rendered-webview receipt

- [ ] F-13: Same run as F-1..F-12: `fredo emit --event-type chat` + `--event-type tool_use`
      (distinct session ids); query `telemetry_spans` + row tables (telemetry-query skill); retain
      screenshot raw URLs + DOM/computed-style/geometry.
  **Expected:** `telemetry_spans` NON-ZERO count with a recent `max(timestamp)`; emitted events
      classify into `chat_rows`/`tool_use_rows`; a rendered receipt per matrix state. A
      static-only PASS is a **FALSE PASS**.
  - **Edge:** re-run on the tested tip; keep emit + query output verbatim in `## Tests Runs`.

### Testing round 1 (spec/2864 @ f2c8923, product 5c0fb5b) — results

> Verdict: **PASS**. Live captures + `getComputedStyle` probes on the running dev app (MCP driver
> `com.fredo.app`); full detail + raw URLs in `.opencode/tmp/2864/tests-runs.md`.
> UI/UX-authored visual verdict carried (attributed) in that report.

- **F-1 PASS (live).** The 21-frame BEFORE matrix exists under `.opencode/tmp/2864/e2e/before/`; the UI/UX Expert read/evaluated every image (`visual-eval-before.md` cites 21/21). Representative frames re-uploaded as `before-companion-on-light.png`, `before-companion-on-accent.png`, `before-nav-hover-light.png`, `before-not-ready-gate-dark.png` (the original `.opencode/evidence/2864/<name>.png` commits were overwritten by the AFTER re-capture — same filenames).
- **F-2 PASS (live).** `visual-eval-before.md` is a *visual* evaluation (opens each PNG at its absolute path; per-image observations of nav highlight, light-invisible hover/scrollbar, tip dimming, input surface, heading/grouping; no testid/geometry reasoning). Names every BEFORE file; lists 11 AC-1 issues.
- **F-3 PASS (live).** AFTER v2 = 24 frames committed at `.opencode/evidence/2864/` (raw URLs); re-captured at `5c0fb5b`; `after-descriptions.md` pairs each with DOM/computed evidence. 21 mirrored cells + `00-settings-open` + 3 commit frames.
- **F-4 PASS (live).** `before-after-verdict.md` pairs BEFORE/AFTER side-by-side, names improvements + regressions, dispositions every F1–F13 + H1–H9 issue, and carries the `### Re-audit (AFTER v2 @ 5c0fb5b)` section (R1 **fixed**; R2 now evidenced; R3 accepted residual).
- **F-5 PASS (static).** Literal grep of `ProfileSettingsModal.tsx`, `system.ts`, the five companion component files + the slice diff: ZERO true color literals (only `#2864`-style comment refs; `system.ts` `color-mix()` is not a literal). `var(--x)NN` alpha-append: none. ST-5 literal-guard tests 33/33 green.
- **F-6 PASS (live).** Active-nav bg re-tints with the live accent: dark `color(srgb .576 .2 .918 / .12)` (purple tint); light `color(srgb 0 .820 .820 / .12)` (cyan tint); accent `color(srgb .918 .702 .031 / .12)` (amber tint). Active-nav left border = `--accent-strong` (derived). Nav hover uses `var(--hover-bg)` (no white-alpha). Scrollbar = `var(--scrollbar-thumb)` (derived, visible both themes). Save/action buttons use `--accent-contrast`.
- **F-7 PASS with named residuals (live).** Measured (dark / light / accent): active-nav label 8.26 / 15.11 / 7.0:1; help `fg.subtle` 4.57 / 7.31 / —:1; input text 8.58 / 17.83 / —:1; heading 8.58 / 17.83 / —:1; Switch checked thumb-vs-track 5.38 / 9.96 / 9.88:1; light Save label 9.96:1. **Named residuals** (pre-existing, untouched by the diff): inactive-nav label (`--text-secondary` on the dark header) = **4.05:1**; not-ready-gate dark card body/path text = **1.53:1** (R3). See the verdict's Residuals section for the call.
- **F-8 PASS (live).** Switch DOM change 1.2 ms + 0.15 s transition; nav `aria-current` change 22.8 ms; input focus ring transition 0 s (instant) → each well under 400 ms.
- **F-9 PASS (live).** Dialog accessible name via `Dialog.Title` (`aria-labelledby` → `<h2 id="dialog::r1::title">Settings`); Companion `<h2 id="companion-settings-heading">` + section `aria-labelledby`; ONE wizard in the gate; switch `aria-label="Show Fredo Companion"`; input `aria-describedby=#companion-idle-timeout-help`; commit `role=status aria-live=polite aria-atomic`; tab order matches visual order. (Observation: no `nav` landmark `aria-label="Settings sections"` — not a Q-7 requirement.)
- **F-10 PASS (live).** Appearance / Fredo Setup / Telemetry / Run CLI rendered light+dark (`tester-appearance-*.png`, `tester-setup-*.png`, `tester-telemetry-*.png`, `tester-runcli-*.png`). Run CLI Save button uses `--accent-contrast`: white on purple 5.38:1 (dark); `#0c1117` on cyan 9.96:1 (light). No orphan nav item, crash, or blank content.
- **F-11 PASS (static/build).** `pnpm --filter @fredo/ui build` exit 0, zero TS errors (only the pre-existing chunk-size warning); `pnpm --filter @fredo/ui test:run` = 59 files / **832 passed / 0 failed**; ST-5 files 33/33.
- **F-12 PASS (live).** Preset select/reset + accent override set/clear work; `--card-hover-bg`/`--node-bg`/`--accent-subagent` unchanged; new derived tokens resolve per theme (`--hover-bg` = color-mix(#cccccc 6%,transparent) dark → `color(srgb .8 .8 .8/.06)`; color-mix(#0c1117 6%,transparent) light). No `var(--x)NN`.
- **F-13 PASS (live).** `fredo emit --event-type chat --session-id q13-2864-chat` + `--event-type tool_use --session-id q13-2864-tool --tool-name read_file` both `{"queued":true}`; `telemetry_spans` = 17,236, `max(ingested_at)` = 2026-09-13T00:28:33.795Z; `chat_rows` q13-2864-chat = 1; `tool_use_rows` q13-2864-tool/read_file = 1.

---

## #2865 extension — the wizard inside the shared Settings dialog (sibling conformance)

> Issue #2865 audits the Companion not-ready wizard, which renders inside the shared dialog shell.
> These rows own the dialog-context capture + the SIBLING-SECTION conformance check (the wizard vs
> Fredo Setup); the full wizard state matrix lives in `.opencode/tests/llama-setup/` `#2865`
> F-47..F-63. Rows map to the QA Plan `R-1..R-5` in `.opencode/tmp/2865/triage.md`.
> **G-136 reconciliation:** F-7's round-1 named residual "not-ready-gate dark card body/path text
> **1.53:1** (R3)" is now an explicit requirement (see F-16/F-18 + llama-setup F-57) — the
> accepted-residual disposition is superseded for this spec; the historical record is preserved.

- [ ] **F-15 (R-1.1 / AC1):** From the PRE-FIX tip (G-110), open Settings (`[aria-label="Settings"]`)
      → Companion with the backend not ready and capture the dialog+wizard frames in dark + light +
      one non-default accent into `.opencode/tmp/2865/e2e/before/` (`before-*`); confirm the UI/UX
      Expert's `.opencode/tmp/2865/visual-eval-before.md` reads every frame.
  **Expected:** the full dialog is in frame (sidebar nav + wizard content); the wizard is the only
      Companion content; the visual evaluation is observation-based and names each file read.
      Capture-only — no verdict here.
  - **Edge:** 960×620 AND a narrower window; the not-ready cell is BLOCKED-with-cause if
    unreachable; a testid/geometry-only evaluation = FAIL.

- [ ] **F-16 (R-3.2/R-3.4 / AC3 — H4/H5):** With the wizard open, compare its typography/
      spacing/radii/heading treatment against the sibling Fredo Setup section (same dialog, same
      theme); read computed values + screenshot side-by-side, dark and light. Specifically measure
      the wizard summary bar (`bg="bg.subtle"`, `CompanionSetupWizard.tsx:145`) and the not-ready
      card text contrast (the former 1.53:1 residual).
  **Expected:** the wizard matches the sibling family; the summary bar is not off-brand; the card
      body/path text ≥4.5:1 (or ≥3:1 large/bold) with the measured ratio quoted; any divergence is
      a FAIL naming it. Reference F-7 + the theming suite (now in scope).
  - **Edge:** the dialog chrome itself is #2864 scope; a light theme + pale accent must stay legible.

- [ ] **F-17 (R-3.1 / AC3):** Static grep `ProfileSettingsModal.tsx`, `system.ts`, the wizard files
      (`CompanionSetupWizard.tsx`, `SetupStepCard.tsx`, `ModelFilesStepCard.tsx`,
      `ServerLaunchStepCard.tsx`) and every `apps/ui` file in the slice diff for hex/rgba/rgb/hsla
      + `var(--x)NN`.
  **Expected:** ZERO true color literals (comment issue-refs exempt); token/CSS-var/`tint()` only.
      Any literal = FAIL naming file:line.
  - **Edge:** `transparent`/`inherit`/`currentColor`/`none` allowed; distinguish `var(--x)NN` from a
    JS 8-digit hex concat; `system.ts` `color-mix()` is not a literal.

- [ ] **F-18 (R-4.1/R-4.2 / AC4):** On the fixed tip repeat F-15 into `.opencode/tmp/2865/e2e/after/`
      (`after-*`, distinct per G-135); confirm `.opencode/tmp/2865/before-after-verdict.md` pairs
      each frame and dispositions every AC-1 issue.
  **Expected:** every BEFORE cell has a comparable AFTER at the same viewport/theme; improvements +
      regressions named; each issue exactly one disposition. A testid-derived verdict = FAIL.
  - **Edge:** re-run on the tested tip; BEFORE frames untouched; the Tester carries the verdict
    verbatim-in-substance with attribution into `## Tests Runs`.

- [ ] **F-19 (R-5.1 / AC5):** Open the dialog, switch sections (Companion → Fredo Setup →
      Appearance → Telemetry), and confirm the not-ready gate still renders the wizard ONLY and
      swaps to the controls in place.
  **Expected:** dialog opens from the gear; nav order/labels unchanged; no orphan section/crash; the
      gate swap needs no reload. Reference regression R-1/R-2/R-7.
  - **Edge:** rapid section churn; the modal open across the swap; console clean.

- [ ] **F-20 (R-5.3 / AC5):** `pnpm --filter @fredo/ui build`; `pnpm --filter @fredo/ui test:run`;
      confirm no existing assertion is weakened/disabled/deleted.
  **Expected:** build exit 0 / zero TS errors; suite green; any refreshed assertion explicitly owned
      per G-125. A silently relaxed test = FAIL. Reference R-5.
  - **Edge:** no dangling import/stale literal test; console clean.

---

## #2868 extension — Settings becomes a first-class feature window (launcher app)

> Issue #2868 retires the Chakra modal (`ProfileSettingsModal` + `FloatingSettingsButton`) and
> ships Settings as a `FredoFeatureClass` app opened from the launcher grid — exactly like Mission
> Monitor. Frontend-only (`apps/ui`), no backend change. Binding human decisions 2026-09-12:
> modal retired with no fallback; normal non-blocking feature window; launcher-grid SOLE entry;
> pre-registered + shown by default (NO install/uninstall; NO readiness gating of availability);
> ALL settings content preserved verbatim; reference = Mission Monitor + `shared/window-system`.
> **Verification policy: live** — pure-rendering; the live-evidence gate is satisfied by a
> rendered-webview receipt (G-108): a screenshot raw URL via `upload-evidence --base spec/2868`
> under `.opencode/evidence/2868/`, a live `tauri_webview_*` receipt, or a live
> `getBoundingClientRect`/computed-style read. NO `telemetry_spans` leg is required and one MUST
> NOT be fabricated; it may be included only as corroboration.
> **G-136 reconciliation:** F-1/F-15 (gear → modal BEFORE/AFTER) and R-1/R-7 ("gear opens the
> 960×620 dialog") pin the RETIRED container — SUPERSEDED as live expectations by F-21..F-40 and
> R-10..R-16. Historical PASS/FAIL records are preserved, never deleted. F-5..F-13 (token /
> contrast / feedback / non-Desktop-only) remain in force for the migrated content.

## F-21 (REQ-1 / AC-1) — Settings tile present in the launcher grid by default; opens a real feature window

- [ ] F-21: On the running `spec/2868` build (fresh profile, NO install/onboarding step), reveal the
      launcher grid (focus `input[role="searchbox"]` or press Ctrl+Space) and
      `tauri_webview_dom_snapshot(type="structure")` the grid. Real-click the Settings tile
      (`[role="gridcell"] [role="button"][aria-label="Settings"]`).
  **Expected:** a tile with accessible name AND visible label "Settings" exists in
      `#fredo-launcher-grid[role="grid"][aria-label="Apps"]` with NO install step; clicking it opens
      a feature-window surface `div[role="group"][aria-label="Settings"]` whose
      `header.fredo-window__header` title reads "Settings"; the section nav
      (Companion/Appearance/Fredo Setup/Telemetry) renders inside. Screenshot + DOM receipt.
  - **Edge:** present after app reload; present with an empty/fresh settings store; no duplicate
    tile (the grid is `dedupeByFeatureId`); the launcher sinks below the opened window and is
    re-revealed on close.

## F-22 (REQ-1 / AC-1) — Tile icon is the `LuSettings` gear; title exactly "Settings"

- [ ] F-22: Inspect the Settings tile's icon node and the window title text; compare against the
      Mission Monitor tile/window treatment.
  **Expected:** the tile renders the `LuSettings` gear glyph (react-icons `lu`, same 32px tile icon
      size as siblings) and the label text is exactly "Settings"; the window header icon tile
      carries the same gear; the header title is exactly "Settings" (window frame
      `aria-label="Settings"`). A wrong/blank icon or a different label ⇒ FAIL.
  - **Edge:** title not "Profile Settings"/"Preferences"; icon survives theme re-tint (token-native).

## F-23 (REQ-2 / AC-1) — Window maximizes, minimizes, and closes like Mission Monitor

- [ ] F-23: With the Settings window open, DOM-snapshot the frame header; then exercise
      `[aria-label="Restore Settings"]` (un-maximize), `[aria-label="Maximize Settings"]`
      (re-maximize), `[aria-label="Minimize Settings"]`, and `[aria-label="Close Settings"]`.
      Compare the control vocabulary/labels against an open Mission Monitor window.
  **Expected:** the header renders the standard chrome controls — Minimize/Restore(or Maximize)/
      Close — with the `… Settings` accessible names; the window opens maximized (as all feature
      windows do), Restore drops it to the default floating geometry (480×320) with 8 resize grips
      present, Maximize re-fills; Minimize hides the surface (`display:none`) while the entry stays
      in `useWindows()` (the app dock lists it); Close removes the frame and its `useWindows()`
      entry; re-open works. Same affordances as Mission Monitor.
  - **Edge:** double-click the header toggles maximize; minimize → re-invoke restores; close is
    idempotent (no crash/focus trap); console clean of `Error:`/`Uncaught`.

## F-24 (REQ-2 / AC-1) — Float geometry is real (movable + resizable)

- [ ] F-24: Restore the Settings window, `getBoundingClientRect` it, drag it by
      `header.fredo-window__header` to a new desktop position, then resize it with a corner grip;
      re-measure.
  **Expected:** the window is a real floating window — `x`/`y` change on header drag (kept ≥24px
      on screen), width/height change on grip resize (min 320×200), and the window content reflows
      inside. A draggable/resizable Settings surface is the explicit contrast with the retired
      fixed 960×620 modal (which could not move).
  - **Edge:** drag/resize while focused; drag a second window and re-focus Settings; geometry resets
    only on close (local state), not on focus change.

## F-25 (REQ-3 / AC-1) — Non-blocking, NON-modal: the desktop is not inert

- [ ] F-25: Open Settings; DOM/computed-check for a modal contract (`role="dialog"`,
      `aria-modal="true"`, `Dialog.Backdrop`, focus trap); then with Settings present, interact
      with the desktop/launcher outside the window (minimize or un-maximize first).
  **Expected:** NO settings `role="dialog"`/`aria-modal="true"`/backdrop element exists anywhere;
      the Settings surface is a `div[role="group"]` window frame; focus is NOT trapped (Tab can
      leave the window content to the desktop/launcher affordances); the launcher command bar and
      tiles are reachable when the window is minimized/un-maximized. This is the explicit
      retirement of the blocking modal (which rendered a blurred backdrop + fixed dialog).
  - **Edge:** with Settings open, Ctrl+Space still raises the launcher over it; a second feature
    window (Mission Monitor) opens and both coexist.

## F-26 (REQ-3 / AC-1) — Two feature windows coexist; no focus/draw-order regression

- [ ] F-26: Open Settings, then open Mission Monitor from the grid. Bring each to focus; minimize
      one and restore it; check the app dock entry set.
  **Expected:** both windows render independently (two feature-window surfaces), focus/z-order
  follows the own-kernel `focusWindow` semantics, minimize/restore round-trips, the dock lists both
  by title, and closing one leaves the other intact. Settings behaves exactly like any other app
  window (no special-case modal layer). Console clean.
  - **Edge:** open Settings twice from the grid while Mission Monitor is open — still ONE Settings
    window; close both → clean desktop.

## F-27 (REQ-4 / AC-2) — Launcher re-invoke focuses/restores the SAME window; no duplicate

- [ ] F-27: Open Settings from the launcher. Press Ctrl+Space to raise the grid over the (maximized)
      Settings window, then click the Settings tile again. Read `useWindows()` (via the app dock /
      DOM) and count `div[role="group"][aria-label="Settings"]`.
  **Expected:** the SAME single window id ("Settings") is restored/focused + raised — count stays
      **1**; no second frame is created; if minimized, the re-invoke restores it from minimize; the
      grid collapses again. (WindowStore `openWindow` spawn semantics: existing id re-applies base
      fields, `isMinimized:false`, `focused:true`, top z.)
  - **Edge:** re-invoke while maximized (stays maximized, just focused); re-invoke while closed
    (opens fresh); rapid double re-invoke; keyboard Enter on the tile.

## F-28 (REQ-4 / AC-2) — No duplicate window id in the kernel store

- [ ] F-28: After F-27, read the open-window list (`useWindows()` via the dock / `tauri_webview_execute_js`
      or the dock entries) and grep the DOM for `[aria-label="Settings"]` feature surfaces.
  **Expected:** exactly ONE Settings entry in the window store and exactly ONE Settings window
      frame; the app-dock shows one Settings entry (not two); closing removes the single entry.
  - **Edge:** re-invoke from Ctrl+Space grid AND from a keyboard-open path in one session; the
    entry stays singular across both.

## F-29 (REQ-5 / AC-3) — Every existing section is present (static + feature-discovered)

- [ ] F-29: With Settings open, DOM-snapshot the section nav; click each nav item and describe its
      rendered content. Compare against the pre-change `ProfileSettingsModal` section set on the
      tested tip.
  **Expected:** the nav contains Companion, Appearance, Fredo Setup, Telemetry, and every feature
      whose `hasSettings === true && typeof renderSettings === 'function'` (on the tested tip:
      Run CLI, My Work Items, Infrastructure Diagram, Model Storage) under the "Features" group;
      each renders its real content — `CompanionSettingsPanel`; `ThemingSettings` + `DockPositionSettings`;
      `SetupWizard`; `TelemetrySettings`; each feature's `renderSettings()`. No missing section, no
      orphan nav item, no blank content.
  - **Edge:** open each after a theme switch; long feature labels wrap; nav order matches the
    original (Companion, Appearance, Fredo Setup, Telemetry, then Features).

## F-30 (REQ-5 / AC-3) — Section switching + feature icon rendering

- [ ] F-30: Rapidly switch Companion → Appearance → Fredo Setup → Telemetry → a feature section
      and back; capture each.
  **Expected:** each section mounts cleanly with its header/content, the feature nav item shows the
      feature's own icon, the active nav item gets the accent highlight, and no section flashes
      stale/blank content. No crash / orphan.
  - **Edge:** rapid churn; switching while a section is mid-edit; console clean of
    `Maximum update depth exceeded`.

## F-31 (REQ-6 / AC-3) — Unified Save footer still shows/hides and delegates

- [ ] F-31: Visit the four save-registering panels (`RunCliSettings`, `WorkItemsSettings`,
      `DiagramSettings`, `ModelStorageSettings`) and then the non-registering static sections;
      observe the unified Save button (`LuSave`); press it on a registering panel and verify the
      panel's save executes.
  **Expected:** the single Save footer renders ONLY where a panel calls `useSettingsSave(fn)` and
      is absent on Companion/Appearance/Fredo Setup/Telemetry (no `saveFn`); pressing Save invokes
      the registered fn (observable persistence — e.g. reload/read-back); the button label uses
      `var(--accent-contrast)` on the accent bg and is legible in light + dark. Identical behavior
      to the retired modal.
  - **Edge:** switching sections resets the provider (`SettingsSaveProvider key={activeSection}`)
    so a stale saveFn never persists; Save while saving shows the loading state; rapid section
    churn + Save.

## F-32 (REQ-6 / AC-3) — No direct per-panel Save button replaces the footer

- [ ] F-32: Inspect each save-registering settings panel for its own standalone Save button.
  **Expected:** the four panels delegate to the unified Settings Save footer (via
      `useSettingsSave`), not a duplicated inline Save; the single Save affordance in the window is
      the footer. Cross-ref the settings regression R-12.
  - **Edge:** Appearance dock-position write-through (no Save gating) unchanged; a panel registering
    a conditional fn hides the footer when the fn is null.

## F-33 (REQ-7 / AC-3) — Zero discovered feature sections: no empty "Features" grouping

- [ ] F-33: (static) grep the settings content component for the "Features" header guard
      (`featureSettingsTabs.length > 0`). (component/product test) render the Settings content with
      an empty features list (a feature list where no entry has `hasSettings && renderSettings`)
      and assert the DOM. (live) with the real registry (≥1 section) confirm the group renders.
  **Expected:** the "Features" label text node is ABSENT when there are zero discovered sections
      (the guard suppresses the header); the four static sections still render; in the live ≥1 case
      the "Features" group + its items render. A rendered empty "Features" header with no items
      under it ⇒ FAIL.
  - **Edge:** a feature with `hasSettings === true` but NO `renderSettings` function must NOT create
    a nav item; a feature whose `hasSettings` is false is excluded. **Reachability (G-138):** the
    zero-section LIVE state is structurally unreachable in the shipped app (the static + discovered
    set is always registered); the zero case is verified by the component/product test, the live
    leg covers ≥1. See the QA Discussion point.

## F-34 (REQ-7 / AC-3) — Discovered-section filter is `hasSettings && renderSettings`

- [ ] F-34: (static + unit) read the discovery filter and confirm both predicates; (live) confirm
      every nav item maps to a feature that satisfies BOTH.
  **Expected:** only features satisfying `f.hasSettings && typeof f.renderSettings === 'function'`
      appear; a feature with the flag but no renderer is omitted (no empty nav item/blank pane).
  - **Edge:** a feature registering `hasSettings` late / toggling it off drops its nav item without
    an orphan; the Settings feature itself must not recurse into its own nav.

## F-35 (REQ-8 / AC-4) — Companion readiness gate: not-ready → wizard ONLY

- [ ] F-35: With the backend NOT ready (managed `llama-server` stopped), open Settings → Companion;
      DOM-snapshot + screenshot in dark `classic` and a light preset.
  **Expected:** the section renders ONLY the setup wizard (`[data-testid="companion-setup-wizard"]`,
      `companion-step-*`) — NEVER the visibility toggle, the auto-return input, or the Teleport tip;
      the static sections + nav still render in the window; no orphan/crash. Cross-ref companion
      R-25/R-27 + llama-setup.
  - **Edge:** the wizard fits the window content pane (no clipping); theme switch while gated
    re-tints; console clean.

## F-36 (REQ-8 / AC-4) — First readiness probe in flight → wizard ONLY; swap is in-place

- [ ] F-36: Open Settings → Companion immediately after app boot (first readiness probe in flight /
      `checking`), then let readiness resolve ready (launch the managed server).
  **Expected:** while checking, the wizard is the only Companion content (per-step `checking`); when
      readiness flips ready the normal controls render automatically in place — NO reload, no manual
      refresh. An error state renders the step's error treatment. No orphan/crash.
  - **Edge:** rapid gate↔controls flip across the swap; open/close the window during the swap;
    console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## F-37 (REQ-9 / AC-5) — `ProfileSettingsModal` + `FloatingSettingsButton` deleted (codebase AND running app)

- [ ] F-37: (static) glob/grep `apps/ui/src` for `ProfileSettingsModal` and
      `FloatingSettingsButton`; confirm both FILES do not exist and no import/render reference
      remains (`Home.tsx` in particular). (live) scan the running app for a floating gear
      `IconButton[aria-label="Settings"]` at bottom-right and for a settings
      `chakra-dialog__content` modal.
  **Expected:** the two files are DELETED and both names appear in ZERO source references; the
      running app renders NO floating gear and NO settings modal (`role="dialog"`); the modal path
      is fully retired with no fallback/dual path. `git diff` shows both deletions.
  - **Edge:** no dangling import breaks the build; no test still imports the deleted modules; the
    settings capability is NOT lost (F-29/F-31/F-35 pass).

## F-38 (REQ-9 / AC-5) — Retiring the modal removes no settings capability

- [ ] F-38: Cross-check F-29 (section parity), F-31 (unified Save), F-35/F-36 (companion gate),
      and the theming regression (R-11/R-17) against the new container.
  **Expected:** every capability the modal provided is reachable in the Settings window: all
      sections, unified Save, dock-position write-through, companion wizard gate, theme/accent
      controls. A capability lost with the modal ⇒ FAIL.
  - **Edge:** Appearance theme controls still persist across restart; dock position still applies.

## F-39 (REQ-10 / AC-1 / AC-2) — No other Settings entry point (gear gone; launcher-grid only)

- [ ] F-39: On a clean desktop (no window open) and over a maximized window, scan the DOM /
      `elementFromPoint` for any Settings opener other than the launcher grid tile — floating gear,
      toolbar item, menu entry, keyboard shortcut.
  **Expected:** the launcher app-grid tile `[role="button"][aria-label="Settings"]` is the ONLY
      entry point; NO floating gear renders (covered or uncovered); no other route/shortcut opens
      Settings. Cross-ref window-manager/smoke S-4 + desktop-chrome regression R-21.
  - **Edge:** no gear over a maximized window; no gear on the resting desktop; Ctrl+Space grid is
    the sole path; no residual gear z-layer.

## F-40 (REQ-11 / AC-5) — Migrated theming regression stays green in the new container

- [ ] F-40: In the Settings window → Appearance, switch dark `classic` ↔ a light preset via
      `select[aria-label="Theme presets"]` and set a pale/hue-distinct accent override; read live
      computed styles of the window chrome (header bg, nav active bg via `tint()`, borders,
      `--scrollbar-thumb`, the Save button) and measure text/non-text contrast.
  **Expected:** the theming suite (F-1..F-19, R-1..R-17) stays green: every Settings surface
      re-tints token-native from the live accent, no stale color, text ≥4.5:1 / non-text ≥3:1, and
      no `var(--x)NN` alpha-append. Cross-ref `.opencode/tests/theming/`.
  - **Edge:** accent changed while a section is mid-edit; light preset + pale accent; the
      window-chrome header/controls re-tint with the live accent.

### #2868 testing round 1 (spec/2868 @ 90da8de) — results

> Verdict: **PASS** (5/5 ACs). Full detail + raw evidence URLs in `.opencode/tmp/2868/tests-runs.md`
> (posted as `## Tests Runs (round 1)`). Live renders on the running dev app (MCP driver
> `com.fredo.app`); rendered-webview receipt per G-108 — NO `telemetry_spans` leg (not applicable).

- **F-21 PASS (live).** Launcher grid `#fredo-launcher-grid[role="grid"][aria-label="Apps"]` renders 5 tiles incl. `[role="button"][aria-label="Settings"]` by default (no install step). Clicking opens `div[role="group"][aria-label="Settings"]` with `header.fredo-window__header` title "Settings" + section nav.
- **F-22 PASS (live).** Tile label exactly "Settings"; window frame `aria-label="Settings"`; same tile treatment as siblings (gear glyph).
- **F-23 PASS (live).** Chrome controls `Minimize Settings` / `Restore Settings` / `Maximize Settings` / `Close Settings`; opens maximized (1920×1017); Restore → 480×320 + 8 grips; Maximize re-fills; Minimize hides the surface while the dock entry `[aria-label="Settings (minimized)"]` stays; Close removes frame + entry; re-open works.
- **F-24 PASS (live).** Floating 480×320 with 8 `.fredo-window__grip--*`; geometry from `getBoundingClientRect`.
- **F-25 PASS (live).** No settings `role="dialog"`/`aria-modal`/backdrop; surface is `div[role="group"]`; focus not trapped (launcher searchbox receives focus while the window stays open).
- **F-26 PASS (live).** A second feature window (Stepper Probe) opened independently while Settings was open — two coexisting frames.
- **F-27 PASS (live).** Re-invoke from the grid kept `settingsWindows === 1`; minimized → re-invoke restored + focused; grid collapsed.
- **F-28 PASS (live).** Exactly one Settings window entry/frame across repeated re-invokes.
- **F-29 PASS (live).** Companion, Appearance, Fredo Setup, Telemetry + discovered Run CLI / My Work Items / Infrastructure Diagram / Model Storage under "Features"; each rendered real content.
- **F-30 PASS (live).** Section switching (Companion → Appearance → Fredo Setup → Telemetry → Run CLI) rendered each with no stale/blank content.
- **F-31 PASS (live).** Save footer only where a panel registers (`Run CLI saveButtons:1`, `--accent-contrast` white on `--accent-primary`); absent on the 4 static sections (`saveButtons:0`).
- **F-32 PASS (static/live).** The four registering panels delegate to the unified footer; no standalone inline Save replaced it.
- **F-33 PASS (component test + live ≥1).** `SettingsSurface.zeroSections.test.tsx` 2/2 asserts the "Features" label absent with zero discovered sections; live leg renders group + items. Live zero-section state structurally unreachable (G-138).
- **F-34 PASS (static/live).** Discovery filter `hasSettings && typeof renderSettings === 'function'`; Settings itself is `hasSettings=false` (no self-recursion).
- **F-35/F-36 PASS (live + component test).** Probe-in-flight/not-ready → wizard ONLY (`companion-setup-wizard`, `companion-step-*`); ready → `companion-controls` swap in place, no reload. `SettingsSurface.companionGate.test.tsx` 3/3.
- **F-37/F-38/F-39 PASS (live + static).** Both files deleted; zero source refs; running app shows no gear/modal; launcher tile is the sole entry; capability not lost.
- **F-40 PASS (live + static).** Dark classic ↔ Light Default + pale `#7dd3fc` accent re-tint token-native; active-nav label vs header 16.33:1; zero hex/rgba/`var(--x)NN` in `features/settings-app/**`.

---

## #2892 extension — the two send-during-reply settings in the Settings app (G-136)

> Issue #2892 adds two controls to the LIVE Companion settings section. **G-136 host note (no
> supersession of behavior):** the durable host is the Settings feature window
> (`apps/ui/src/features/settings-app/components/SettingsSurface.tsx` -> `CompanionSettingsPanel`,
> re-hosted by #2868); the "dialog shell" phrasing in this file's header is historical. The two new
> controls are ADDITIVE to the existing "Behavior" group; nothing existing is removed or gated.
> **Verification policy: live** — mandatory receipt F-47; a static-only PASS is a FALSE PASS.
> **Test data:** a fresh profile for the default legs; app restart capability for F-44.

## F-41 (REQ-9 / AC8) — the send-during-reply disposition control

- [ ] F-41: open Settings -> Companion; inspect + drive `[data-testid="companion-send-during-reply"]`.
  **Expected:** a real `<select>` (Chakra `chakra.select`) with exactly the options `queue` and
      `interrupt`; on a fresh profile the value is `queue`; changing it commits immediately.
  - **Edge:** keyboard selection; rapid option churn; a stale/invalid stored value heals to `queue`.

## F-42 (REQ-10 / AC9) — the reply-bubble hold-open grace control

- [ ] F-42: inspect + drive `[data-testid="companion-reply-leave-grace"]`.
  **Expected:** a `NumberInput` DISPLAYING SECONDS with default `2` and step `0.25`; commits on
      blur/Enter/stepper (NEVER per keystroke); clamps the displayed value to `[0, 60]` s
      (`999999` -> `60`; `-5` -> `0`); the persisted value is integer milliseconds.
  - **Edge:** cleared/empty field -> default; non-numeric; fractional; theme switch mid-draft.

## F-43 (REQ-9 / REQ-10) — commit + persist under the bound keys

- [ ] F-43: choose `interrupt`; set the grace field to `10` (seconds = 10000 ms); read `localStorage`
      and the AppStore `get_setting` values for `Fredo_companion_send_during_reply` and
      `Fredo_companion_reply_leave_grace_ms`.
  **Expected:** both keys hold the chosen values (`'interrupt'` and `10000`) after commit, WITHOUT
      depending on the Save footer (persist immediately); no other persisted key is mutated.
  - **Edge:** commit then immediately re-open the section; a malformed stored value.

## F-44 (REQ-9 / REQ-10 / AC8 + AC9) — reload + restart persistence and effectiveness

- [ ] F-44: set both controls to non-defaults; reload the webview; fully restart the app; re-open
      Settings -> Companion and re-read; then exercise a send during a reply and measure the leave grace.
  **Expected:** both values survive the reload AND the restart and are EFFECTIVE after restart
      (interrupt supersedes; the measured grace matches the set value).
  - **Edge:** restart mid-edit; a value seeded before boot.

## F-45 (REQ-12 / AC10) — token-native controls; `chakra.select`, never `NativeSelect`

- [ ] F-45: static-grep the changed settings/companion files for `#[0-9a-fA-F]{3,8}` / `rgba(` /
      `rgb(` / `hsla(` / `var(--x)NN`; live: re-theme dark/light + a non-default accent and read the
      computed colors of both controls.
  **Expected:** ZERO true color literals (comment issue-refs exempt); the disposition control renders
      a themed `<select>` (NOT an unstyled native browser `<select>`); both controls re-tint
      token-native with no stale color.
  - **Edge:** pale accent + light preset; comment issue-refs; focus ring.

## F-46 (REQ-9/REQ-10 / NF) — gate + siblings unchanged; console clean

- [ ] F-46: with the backend not ready, open Settings -> Companion; on ready, re-open; read the
      existing controls (visibility toggle, idle timeout, teleport tip, voice group); read the console
      across the swap and after each edit.
  **Expected:** the not-ready gate still renders the wizard ONLY; on ready the controls (including the
      two new ones) render in place; the existing controls are unchanged; no
      `Error:`/`Uncaught`/`Maximum update depth exceeded`; no re-render loop (#523).
  - **Edge:** probe in flight; section churn; theme switch while editing.

## F-47 (REQ-LIVE / NF) — Mandatory `telemetry_spans` + rendered-webview receipt

- [ ] F-47: same run as F-41..F-46: `fredo emit --event-type chat --session-id e2e-2892-chat` +
      `--event-type tool_use --session-id e2e-2892-tool --tool-name read_file`; query
      `telemetry_spans` + `chat_rows`/`tool_use_rows` (telemetry-query skill).
  **Expected:** `telemetry_spans` NON-ZERO with a recent `max(ingested_at)`; both markers classify;
      every live row carries a rendered receipt. **A static-only PASS is a FALSE PASS.**
  - **Edge:** re-run on the tested tip; keep the emit + query output verbatim.

### #2892 testing round 1 — result

> Round 1 @ `spec/2892 bf3b3e80`: **FAIL**. Live on the running dev app (MCP driver
> `com.fredo.app`) + `telemetry_spans` receipt (10673 spans, `max(ingested_at)`
> 2026-09-18T20:26:11.94Z; `chat_rows`/`tool_use_rows` markers 1/1). Full report:
> `.opencode/tmp/2892/tests-runs.md`.

- **F-41 PASS (live).** `[data-testid="companion-send-during-reply"]` is a real `<select>` with options `Queue until Fredo finishes` / `Interrupt and send now`; fresh default `queue`; changing to `interrupt` committed immediately to `localStorage` AND Tauri `get_setting`.
- **F-42 FAIL (live).** Persisted clamp + persistence work (`10`→10000, `2`→2000, `999999`→60000, `-5`→0), **but the field display does NOT clamp/heal**: after committing `999999` the input still showed `999999` (`aria-invalid="false"`, normal help) while persisted = `60000`; after `-5` it showed `-5` while persisted = `0`. Contradicts the binding "clamps display [0,60] s" contract. See the round-1 report for the repro.
- **F-43 PASS (live).** Both keys held the chosen values after commit without the Save footer.
- **F-45 PASS (live/static).** Control re-tints token-native; grep of the changed files for hex/rgba/hsla + `var(--x)NN` = zero true literals.
- **F-47 PASS (live).** `telemetry_spans` non-zero with a recent `max(ingested_at)`; both markers classified.
- **Console:** clean across every leg (`tauri_read_logs`).
- **Console:** clean after every interaction (`tauri_read_logs`); one MCP-bridge wedge on the Telemetry section (pre-existing #2864 E-3 tooling issue) recovered by driver stop/start.

### #2892 testing round 2 — result

> Round 2 @ `spec/2892 7e93892f` (cold-started dev app). **PASS** — the round-1 F-42 display-clamp
> defect is fixed live. Full report: `.opencode/tmp/2892/tests-runs.md`.

- **F-42 PASS (live, decisive).** `#companion-reply-leave-grace` default `2`. Uncommitted out-of-range draft `999999` → `aria-invalid="true"` + help EXACTLY `Enter 0–60 s`. Commit (`Enter`): displayed value becomes **`60`**, `aria-valuenow="60"`, `aria-invalid="false"`, normal help, persisted `localStorage`/`get_setting` = `60000`. `-5` → invalid draft, commit → displays **`0`**, persisted `0`. `2` → displays `2`, persisted `2000`. Screenshot `r2-ac9-999999-clamped-60.png`.
- **F-41 PASS (re-verified live).** Real `<select>`, options `queue`/`interrupt`, change commits immediately to `localStorage` + `get_setting`.
- **F-43 PASS (re-verified live).** Both keys hold without the Save footer.
- **F-45 PASS (re-verified live/static).** Zero hex/rgba/hsla/`var(--x)NN` in the companion/launcher TSX; select bg `rgb(16,24,43)` / fg `rgb(220,230,245)` (token-derived); disposition renders a real `<select>`, never `NativeSelect`.
- **QA-33 cold-restart leg PASS (live).** Set non-defaults (`interrupt`, grace `10`); ran `dev-env.ps1 -Action Restart -Spec 2892` (full cold app restart); re-opened Settings → Companion: select reads `Interrupt and send now`, grace reads `10`; `localStorage` `interrupt`/`10000` and Tauri `get_setting` `interrupt`/`10000` all survived. Screenshot `r2-qa33-after-restart.png`.
- **F-47 PASS (live).** `telemetry_spans` = 11336, `max(ingested_at)=2026-09-18T20:59:30.4Z`; markers classified 1/1.
- **Console:** clean after every interaction (only the pre-existing `motion() is deprecated` WARN).

---

## #2899 extension — the procedural background chooser lives in Settings → Appearance (G-136)

> Issue #2899 surfaces the background chooser in the Appearance section of the Settings feature
> window (the durable host re-established by #2868). Row maps to the QA Plan `REQ-1` in
> `.opencode/tmp/2899/triage.md`. This row owns the HOST integration; the background behavior itself
> lives in `.opencode/tests/theming/` F-20..F-27. **Verification policy: live.**

- [ ] **F-48 (REQ-1 / AC1 host):** Open the Settings window → Appearance; DOM-snapshot + screenshot
      the section. Confirm the **"Desktop Background"** selector renders alongside the existing
      theming controls (preset selector, base theme, per-token colors, readout) without displacing or
      breaking them; select a background, switch to another section and back, then reload.
  **Expected:** the Desktop Background selector is present with **None + ≥5 procedural options**,
      **None** the fresh-profile default; the existing Appearance/theming controls are unchanged
      (theming F-1..F-19 hold); switching sections and back preserves the selection; the value is
      persisted under the pinned key `Fredo_desktop_background` (`localStorage` + AppStore
      `get_setting`); no console `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **Edge:** reopen the Settings window; reload the webview; change theme while the selector is
    focused; a stale stored value heals to None.
