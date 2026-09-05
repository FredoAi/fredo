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
