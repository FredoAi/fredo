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
      dimming, heading/grouping — and lists the AC-1 issues.
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
      Expected conversions: nav active bg `rgba(147,51,234,0.12)` → `tint('var(--accent-primary)',
      12)`/token; nav hover `rgba(255,255,255,0.04)` → token/`tint`; scrollbar thumb
      `rgba(255,255,255,0.12/0.22)` → token/`tint`; backdrop `rgba(0,0,0,0.6)` + boxShadow
      `rgba(0,0,0,0.4)` → token/`tint`. `ProfileSettingsModal.tsx:49,57,22-25,111,118` are the
      known leads. Name any remaining literal by file:line — a FAIL.
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
  - **Edge:** `white`-on-accent buttons (H7) must still pass on a light accent or use a
    contrast-safe token; selected-nav label on its highlight.

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
      has light+dark values and does not alter existing consumers. Cross-ref
      `.opencode/tests/theming/` R-11..R-13.
  - **Edge:** user-preset save/discard; stale `localStorage` preset id clamps.

## F-13 (Q-13 / LIVE) — Mandatory `telemetry_spans` + rendered-webview receipt

- [ ] F-13: Same run as F-1..F-12: `fredo emit --event-type chat` + `--event-type tool_use`
      (distinct session ids); query `telemetry_spans` + row tables (telemetry-query skill); retain
      screenshot raw URLs + DOM/computed-style/geometry.
  **Expected:** `telemetry_spans` NON-ZERO count with a recent `max(timestamp)`; emitted events
      classify into `chat_rows`/`tool_use_rows`; a rendered receipt per matrix state. A
      static-only PASS is a **FALSE PASS**.
  - **Edge:** re-run on the tested tip; keep emit + query output verbatim in `## Tests Runs`.
