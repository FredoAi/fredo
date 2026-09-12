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
