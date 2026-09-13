# Theming — Exploratory

> Unscripted probes the Tester runs beyond the functional cases. A confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note).

## Probes to try

- [ ] **E-1:** Select a light-toned preset (Light Default / Paper / Solarized / Arctic / Sunset) and inspect the mission-monitor node + subagent chrome. Does the residual dark `--node-bg`/`--edge-gradient`/`--accent-subagent` look intentional/acceptable, or is it a glaring mismatch? (Given the Architect's scope boundary this residual is EXPECTED; probe whether it is acceptable UX or should be a scope change.)
- [ ] **E-2:** Rapidly switch presets back-to-back (e.g. Cyberpunk → Matrix → Dracula → Synthwave) while watching the console. Any "Maximum update depth exceeded", stale CSS vars, or lag? (AGENTS.md #523 re-render-loop pattern.)
- [ ] **E-3:** Set an override on a preset, then manually edit `localStorage` to inject a bogus preset id (e.g. `Fredo_theme_preset = 'nope'`) and reload. Does the app clamp gracefully (no crash) and fall back to a known preset?
- [ ] **E-4:** Apply a monospace/terminal preset (Matrix / Terminal Green) that sets `fontPrimary`/`fontBase`. Is the preset's text color readable against its chosen mono stack (≥4.5:1) in the current theme?
- [ ] **E-5:** Keyboard-drive the preset radio group (arrow keys, Home/End, Enter/Space). Does it follow the radiogroup pattern, keep one tab stop, and announce selection to screen readers? (WCAG 2.1.1/2.1.2.)
- [ ] **E-6:** After customizing a token on top of a preset, does the summary/`Modified` indicator correctly clear when all per-token diffs are reverted, and does the selected card stay marked (not silently deselected)?
- [ ] **E-7 (#2842):** With a preset + a per-token override both applied, rapidly change the override across several values. Does the readout track the override live with no redraw lag and no "Maximum update depth exceeded"?
- [ ] **E-8 (#2842):** Manually edit `localStorage['Fredo_theme_preset']` to a bogus id (e.g. `'nope'`) while the readout is visible, then reload. Does the app clamp gracefully (base fallback), and does the readout clear (or reflect base) rather than crash?
- [ ] **E-9 (#2842):** Keyboard-drive the readout chips (Tab to a chip, Enter/Space to open the color picker, arrows). Is each chip focusable with a visible focus ring and an accessible name naming the token? (WCAG 2.1.1/2.1.2/4.1.2.)
- [ ] **E-10 (#2842):** Apply High Contrast, then Monochrome. Is each swatch distinguishable from its chip border/surface, and is the token label/hex text legible over the chip (≥3:1) rather than swallowed by the swatch color?
- [ ] **E-11 (#2842):** At the 960px dialog width, apply a preset then layer overrides on all 12 tokens. Does the readout stay within the content area (no horizontal scroll / clipping), and do long hex/font values wrap cleanly?

## #2864 extension — token-derivation probes

- [ ] **E-12:** **Undefined CSS-var audit.** Grep the audited Settings files (and their shared
      chrome) for every `var(--…)` reference and cross-check each against a `setProperty`/CSS
      definition. Any token referenced but never defined is a finding — record the consumer
      file:line and the computed fallback. (The pre-#2864 `--hover-bg` gap is the canonical
      example; it is resolved by T1, so re-scan for any NEW undeclared `var()`.)
- [ ] **E-13:** **Global-token light/dark regression sweep.** If a token is added/remapped, switch
      dark↔light and compare computed colors on unrelated surfaces (desktop shell, launcher,
      mission-monitor node chrome). Any surface that shifts unintentionally is a finding.
- [ ] **E-14:** **Accent override persistence + chrome re-tint.** Set an `accentPrimary` override,
      reload, and open Settings. Does the chrome re-tint on boot with no flash of the old accent
      and no stale literal? Any stuck color is a finding (promotes to F-12).

### #2864 testing round 1 (spec/2864 @ f2c8923) — findings

- **E-12 CONFIRMED FINDING (promotes to functional F-14) — semantic-token runtime resolution gap.** The audited wizard cards style text with Chakra semantic tokens (`fg.muted` at `SetupStepCard.tsx:178,204`, `ModelFilesStepCard.tsx:383,461,484,637`, etc.). At runtime those resolve to **stock Chakra** values, not the Fredo CSS vars `system.ts` maps: `getComputedStyle(document.documentElement).getPropertyValue('--chakra-colors-fg-muted')` = **`#52525b`** (stock `gray.600`) and `--chakra-colors-fg-subtle` = **`#a1a1aa`** (stock `gray.400`), while `--text-secondary` = `#888888` / `--text-subtle` = `color-mix(#888 65%, #ccc 35%)`. `--chakra-colors-fg-default` and `--chakra-colors-bg-hover`/`--chakra-colors-fg-onAccent`/`--chakra-colors-accent-solid` are **empty**. Consequence: the not-ready-gate dark card body/path text (`fg.muted` → `#52525b`) computes **1.53:1** on the success-tinted card (`rgb(42,59,53)`) — far below AA. **Pre-existing** (the wizard card token usage is unchanged by #2864; ST-4 touched only header/buttons/hover) and recorded as accepted residual R3; flagged for a follow-up (the custom `system` semanticToken bridge is not applied to these token names at runtime).
- **E-13 FINDING — regression-free.** `--card-hover-bg` (#3a3a3a), `--node-bg` (#2d2d2d), `--accent-subagent` (#6366f1) unchanged dark↔light; new derived tokens resolve per theme.
- **E-14 FINDING — regression-free.** An `accentPrimary` override set via the shipped Appearance color picker re-tints the Settings chrome immediately, persists, and clears via "Reset to theme defaults" with no stale color.
