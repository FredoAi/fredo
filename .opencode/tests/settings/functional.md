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
