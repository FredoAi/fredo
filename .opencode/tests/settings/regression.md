# Settings — Regression

> "Must not change" baseline for the shared Settings dialog shell (`ProfileSettingsModal`).
> Seeded at Issue #2864. Run on every testing phase that touches the settings dialog.
> **Verification policy: live** — the tester's Evidence MUST reference `telemetry_spans`
> (a live-query result) for live verdicts.

## Invariants (must NOT change)

- [ ] **R-1 (modal shell / navigation):** The dialog still opens from the gear
      (`[aria-label="Settings"]`), renders the sidebar nav (Companion, Appearance, Fredo Setup,
      Telemetry + discovered feature sections), 960×620 geometry, the close button, and the
      section-switch remount (`SettingsSaveProvider key={activeSection}`). The chrome recolor
      must not change layout/nav order/labels. Cross-ref `.opencode/tests/desktop-chrome/`
      F-19 and `.opencode/tests/app-dock/` S-4.
- [ ] **R-2 (section content unchanged):** Appearance (`ThemingSettings` + `DockPositionSettings`),
      Fredo Setup (`SetupWizard`), and Telemetry (`TelemetrySettings`) content is functionally
      unchanged by the chrome recolor. Reference `.opencode/tests/theming/` F-1..F-10,
      `.opencode/tests/app-dock/` F-1, app feature settings sections.
- [ ] **R-3 (SaveFooter contract + T5 on-accent):** The unified save footer still shows only when
      a panel registers a save fn (`useSettingsSave` / `SettingsSaveContext.saveFn`) and hides
      otherwise (`SaveFooter` returns null) — the recolor must not change its show/hide semantics.
      The four panels that DO register a save fn (`RunCliSettings.tsx:25`,
      `WorkItemsSettings.tsx:107`, `DiagramSettings.tsx:54`, `ModelStorageSettings.tsx:28`) render
      their Save button with a label legible on the accent bg via the T5 foreground token
      `var(--accent-contrast)` (never a literal `white`); a literal-`white`/white-on-pale-accent
      regression is a FAIL.
- [ ] **R-4 (token contract):** No hardcoded hex/rgba/hsla and no `var(--x)NN` alpha-append is
      introduced in the chrome files; colors use theme tokens/CSS vars/`tint()`. Reference
      `.opencode/tests/theming/` R-7.
- [ ] **R-5 (no test weakening):** No existing assertion is weakened, disabled, or deleted. Any
      refreshed assertion is explicitly owned per G-125 (named test + reason) — a silently
      relaxed test is a FAIL.
- [ ] **R-6 (no re-render loop / console clean):** Opening/closing the dialog, switching sections,
      and switching theme/accent introduce no `Maximum update depth exceeded`/`Uncaught`/`Error:`
      in the console (AGENTS.md #523 pattern).

## Overlapping prior-feature suites (run alongside)

- `.opencode/tests/theming/` — the token→var→theme flow the chrome now exclusively follows
  (F-1..F-13, R-1..R-13).
- `.opencode/tests/companion/` — the Companion panel content + not-ready wizard (F-42..F-48,
  R-24..R-26).
- `.opencode/tests/app-dock/` — Appearance section + Dock position (F-1, S-6).
- `.opencode/tests/desktop-chrome/` — settings gear entry + chrome z-order (F-19).
- `.opencode/tests/llama-setup/` — the Companion not-ready wizard prerequisite actions.

### #2864 testing round 1 (spec/2864 @ f2c8923, product 5c0fb5b) — results

- **R-1 PASS (live).** Gear opens the dialog; sidebar nav (Companion/Appearance/Fredo Setup/Telemetry + Features) renders; 960×620 content; close button present; section remount via `SettingsSaveProvider key={activeSection}` intact.
- **R-2 PASS (live).** Appearance (ThemingSettings + DockPositionSettings), Fredo Setup, Telemetry render light+dark; no functional change observed.
- **R-3 PASS (live).** `SaveFooter` shows only for the four panels that register a save fn; the Run CLI Save button uses `--accent-contrast` (white on purple 5.38:1 dark; #0c1117 on cyan 9.96:1 light) — no literal `white` regression.
- **R-4 PASS (static).** No hardcoded hex/rgba/hsla and no `var(--x)NN` introduced in the chrome files.
- **R-5 PASS (static).** No existing assertion weakened/disabled/deleted; ST-5 is ADD-only (33 tests green).
- **R-6 PASS (live).** No `Maximum update depth exceeded`/`Uncaught`/`Error:` across open/close/section-switch/theme-switch (one tester-introduced transient-probe error, excluded).

---

## #2865 extension — the dialog shell + sibling sections must not change

> Issue #2865 is a VISUAL/UX audit of the Companion not-ready wizard rendered inside this dialog.
> Run alongside R-1..R-6. The shell, nav order/labels, geometry, section content, SaveFooter
> contract, and token contract must be unchanged by the wizard visual refactor.

- [ ] **R-7 (dialog shell / nav unchanged):** the gear still opens the 960×620 dialog; sidebar nav
      order/labels (Companion, Appearance, Fredo Setup, Telemetry + Features) unchanged; the
      section-switch remount via `SettingsSaveProvider key={activeSection}` intact; no orphan nav
      item. Reference R-1 + functional F-19.
  - **Edge:** open/close + rapid section churn; the modal open across the wizard→controls swap.

- [ ] **R-8 (sibling sections unchanged + wizard content contract):** Appearance / Fredo Setup /
      Telemetry content is functionally unchanged; the not-ready gate still renders ONE wizard
      (no toggle/tip duplication); the frozen `data-testid`/`data-state` hooks retained
      (`companion-setup-wizard`, `companion-step-*`, `data-server-state`). A dropped hook / second
      wizard / orphan section = FAIL.
  - **Edge:** the wizard's visual treatment may change; its behavior/state vocabulary and the
    sibling sections' behavior must not.

- [ ] **R-9 (token contract + build gates + no test weakening):** no hardcoded hex/rgba/hsla and no
      `var(--x)NN` introduced in the slice diff; `pnpm --filter @fredo/ui build` exit 0; `pnpm
      --filter @fredo/ui test:run` green; no existing assertion weakened/disabled/deleted (any
      refreshed assertion owned per G-125). Reference R-4/R-5 + functional F-17/F-20.

---

## #2868 extension — the retired modal shell must not take settings capability with it (G-136)

> Issue #2868 deletes `ProfileSettingsModal` + `FloatingSettingsButton` and moves Settings into a
> `FredoFeatureClass` window opened from the launcher grid. **G-136 reconciliation:** R-1 ("dialog
> still opens from the gear") and R-7 ("gear still opens the 960×620 dialog") pin the RETIRED
> container — their live expectations are SUPERSEDED by R-10..R-16. Historical records above are
> preserved verbatim. R-2..R-6 (content / Save contract / token contract / build) remain in force
> for the migrated content. Verification policy: live (rendered-webview receipt per G-108; NO
> fabricated `telemetry_spans`).

- [ ] **R-10 (SUPERSEDES R-1/R-7 — the entry is the launcher grid, not the gear):** Settings is
      reachable ONLY via the launcher tile (`[role="button"][aria-label="Settings"]`) and opens a
      `div[role="group"][aria-label="Settings"]` feature window. The floating `IconButton`
      `aria-label="Settings"` and the `ProfileSettingsModal` (`role="dialog"`, 960×620) are GONE
      from the running app and the codebase. Reference functional F-21/F-37/F-39.
  - **Edge:** no gear over a maximized window; no residual modal `chakra-dialog__content`; the
    launcher grid is the sole entry.

- [ ] **R-11 (section content unchanged by the container swap):** Companion
      (`CompanionSettingsPanel`), Appearance (`ThemingSettings` + `DockPositionSettings`), Fredo
      Setup (`SetupWizard`), Telemetry (`TelemetrySettings`), and every discovered
      `f.hasSettings && f.renderSettings` section render functionally unchanged in the new window.
      Reference functional F-29/F-30; cross-ref `.opencode/tests/theming/`.

- [ ] **R-12 (SaveFooter contract preserved):** the unified Save footer still shows only when a
      panel registers a save fn (`useSettingsSave` / `SettingsSaveContext.saveFn`) and hides
      otherwise; the four registering panels (`RunCliSettings`, `WorkItemsSettings`,
      `DiagramSettings`, `ModelStorageSettings`) keep their `var(--accent-contrast)` label; the
      per-section provider reset (`SettingsSaveProvider key={activeSection}`) is retained.
      Reference functional F-31/F-32.

- [ ] **R-13 (companion readiness gate preserved):** while not ready OR the first readiness probe is
      in flight, Companion renders the wizard ONLY and never the normal controls; on ready the
      controls swap in place. Reference functional F-35/F-36 + companion R-25/R-27 + llama-setup.

- [ ] **R-14 (token contract for the new container):** the new Settings feature/chrome files carry
      ZERO hardcoded hex/`rgba(`/`rgb(`/`hsla(` and NO `var(--x)NN` alpha-append; colors use theme
      tokens / CSS vars / `tint()`. Cross-ref R-4 + functional F-40.

- [ ] **R-15 (no re-render loop / console clean):** opening/closing the Settings window, switching
      sections, and switching theme/accent introduce no `Maximum update depth exceeded` /
      `Uncaught` / `Error:`. Cross-ref R-6 + functional F-30/F-36.

- [ ] **R-16 (no test weakening / build gates):** `pnpm --filter @fredo/ui build` exit 0 zero TS
      errors; `pnpm --filter @fredo/ui test:run` green; no existing assertion
      weakened/disabled/deleted (a refreshed assertion owned per G-125). Tests referencing the
      deleted `ProfileSettingsModal`/`FloatingSettingsButton` are updated in the same scope and
      named. Reference R-5 + functional F-37.
