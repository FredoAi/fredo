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
