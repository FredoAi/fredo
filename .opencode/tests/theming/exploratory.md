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

## #2865 extension — semantic-token bridge probes (R3 residual in scope)

> Unscripted probes for issue #2865. A confirmed finding PROMOTES to `functional.md` as a new `F-`
> row (keep the origin note). **G-136 reconciliation:** E-12's confirmed finding above was
> dispositioned "Pre-existing; follow-up scope" — #2865 brings it IN SCOPE, so these probes now
> gate the slice. The historical E-12 record is preserved; it is not deleted.

- [ ] **E-15 — Semantic-token resolution re-scan.** After the fix, read
      `getComputedStyle(document.documentElement)` for `--chakra-colors-fg-muted`/`-fg-subtle`/
      `-fg-default`/`-bg-hover`/`-fg-onAccent`/`-accent-solid` and compare with
      `--text-secondary`/`--text-subtle`/`--hover-bg`/`--accent-contrast`. Any token still resolving
      to a stock Chakra value or empty is a finding (promotes to F-15).

- [ ] **E-16 — Token-name vs direct-var consumer audit.** Grep the repo for remaining consumers of
      the previously-broken token names. If the bridge is repaired, they should now resolve; if a
      consumer was migrated to `var(--…)`, confirm no half-migrated surface renders a stale color.
      Any inconsistent consumer is a finding (promotes to F-15/R-14).

- [ ] **E-17 — Unrelated-surface sweep after a bridge change.** If `system.ts` changes, re-read
      computed colors on unrelated surfaces (desktop shell, launcher, mission-monitor node chrome,
      settings nav) dark↔light. Any surface that shifts unintentionally is a finding (promotes to
      R-14).

- [ ] **E-18 — Light-theme wizard error card.** In light theme + the non-default accent, force a
      step error; is the error card border/fill/text legible (≥4.5:1 text, ≥3:1 non-text) and does
      the Retry affordance stay distinct? Any failure is a finding (promotes to F-17).

- [ ] **E-19 — Accent override + wizard re-tint.** Set/clear an `accentPrimary` override with the
      wizard open (running + error states); does every accent-linked surface re-tint live with no
      stale color and no console error?       Any stale color is a finding (promotes to F-17/F-18).

## #2899 extension — procedural desktop background probes

> Unscripted probes for issue #2899. A confirmed finding PROMOTES to `functional.md` as a new `F-`
> row (keep the origin note).

- [x] **E-20 — Rapid chooser churn.** Cycle None → each background → None repeatedly; watch for
      re-render loops (`Maximum update depth exceeded`), stale paint, or lag (AGENTS.md #523).
- [x] **E-21 — Reduced-motion + strobe probe.** Toggle `prefers-reduced-motion: reduce` live; confirm
      the selection crossfade snaps to 0 ms and no recipe introduces continuous animation/`@keyframes`
      (all six ship static). Sample consecutive frames for high-frequency luminance inversion
      (flash/strobe) — any finding promotes to F-25.
      **[G-136 SUPERSEDED (#2905): the "all six ship static / no continuous animation" premise is
      inverted — animated built-ins are now required. The reduced-motion + strobe intent stands; see
      E-28/E-30 and F-32/F-34.]**
- [x] **E-22 — Stale/garbage persistence sweep.** Inject `''`, `null`, `undefined`, an object, and a
      removed id into the background persistence key; restart each time. Confirm a safe None fallback
      with no crash/blank desktop (promotes to F-23).
- [x] **E-23 — Input/z-order stress.** With a background active, drag/resize/minimize/restore
      windows, open two windows, and click + type across them. Confirm no input interception and the
      background never paints above content (promotes to F-24).
- [x] **E-24 — Worst-case contrast.** Light preset + pale accent + the brightest background; measure
      shell chrome (ticks, clock, tiles) contrast; any pair below AA is a finding (promotes to F-24).
- [x] **E-25 — Sustained idle soak.** Leave the app idle with a background active for several
      minutes; sample process CPU/GPU and memory growth. Any unbounded growth or sustained high usage
      is a finding (promotes to F-25).

### #2899 testing round 1 (spec/2899 @ c846e2e7) — findings

- **E-20 — regression-free.** 15 rapid clicks (all 7 options ×2 cycles + None): zero `window.onerror`, each selection repainted the layer, `localStorage` tracked, console clean (no "Maximum update depth exceeded"). No re-render loop.
- **E-21 — regression-free, with a named limitation (no promotion).** No `@keyframes`/continuous animation anywhere in the slice; backdrop computed `animation-name: none`, `transition-duration: 0s`. The OS `prefers-reduced-motion` flag is `false` and the Tauri MCP driver exposes no media-emulation API, so the toggle could not be exercised live — non-blocking because there is no animation to suppress (all six descriptors ship static). The UI/UX §7 180 ms selection crossfade was **not implemented** (design/implementation delta — no AC requires it).
- **E-22 — regression-free.** Injected `banana` into both `localStorage` and AppStore → safe None fallback after a cold restart, no crash/blank desktop. `''`/`null`/removed-id normalization pinned by `background.invariants.test.tsx` (e) + `backgroundRegistry.test.ts`.
- **E-23 — regression-free.** With Aurora active across two window surfaces and a maximized/floating window, `elementFromPoint` always returned window content, never the backdrop; typed input delivered.
- **E-24 — FINDING (disclosed residue, no promotion).** Light-preset legibility confirmed on the post-switch frame; the background sits behind opaque windows so it cannot alter window-content contrast. The chooser's `--text-secondary` `#888888` on `--card-bg` `#2d2d2d` 12px captions measure **3.89:1** (< AA) — but the pre-existing DockPosition helper text measures identically (3.89:1), and the pair is background-invariant, so this is a pre-existing theming caption characteristic, not a #2899 regression. Recorded in the verdict as a disclosed residual.
- **E-25 — regression-free.** 90 rAF frames @ avg 16.5 ms (p95 16.7, max 16.8) and JS heap 37,920→36,965→36,966 KB over the soak — no unbounded growth.

## #2905 extension — animated procedural background probes

> Unscripted probes for issue #2905 (revises #2899). A confirmed finding PROMOTES to `functional.md`
> as a new `F-` row (keep the origin note). **G-136:** the #2899 probes that assumed a static-only
> slice (E-21) are superseded for animated built-ins.

- [ ] **E-26 — Rapid option churn with animation.** Cycle None → each animated background → None
      repeatedly (≥3 full cycles); watch the console for `Maximum update depth exceeded`, stale
      paint, orphaned animations (an `getAnimations()` entry surviving a switch), or lag
      (AGENTS.md #523). Any finding promotes to F-35/F-32.

- [ ] **E-27 — Sustained animation soak.** Leave a procedural background active for several minutes;
      sample rAF cadence + heap at start/middle/end. Any unbounded growth, cadence decay, or
      runaway GPU/CPU is a finding (promotes to F-35).

- [ ] **E-28 — Reduced-motion path (named blocker).** Read
      `window.matchMedia('(prefers-reduced-motion: reduce)').matches` and attempt to flip it live;
      record that the live flip is UNVERIFIED with the Tauri-driver named blocker (G-050/#2870).
      Confirm via the product-unit/static pin that the animated descriptors are gated under reduce;
      any animation still running under reduce is a finding (promotes to F-34).

- [ ] **E-29 — None round-trip + persistence.** After a full animation session, select None, confirm
      the backdrop DOM is absent and the desktop matches the BEFORE capture, cold-restart, then
      reselect a procedural option and cold-restart again. Any residual paint, non-persistence, or
      stale-id crash is a finding (promotes to F-36).

- [ ] **E-30 — Strobe / high-frequency luminance probe.** With animation running, capture ≥8
      consecutive synchronous frames of the backdrop region and compute per-frame mean luminance;
      look for full-frame inversions or a flicker rate that could trigger photosensitivity. Any
      finding promotes to F-34.

- [ ] **E-31 — Reporter dark/brown worst-case contrast.** Apply the reporter's dark/brown preset
      (record the id) + a procedural background; sample shell chrome + window text contrast. Any
      pair below AA is a finding (promotes to F-30).

- [ ] **E-32 — Animation + theme/accent churn.** Switch dark↔light and set/clear the accent override
      while the animation runs; watch for a stopped animation, a frozen frame, stale color, or a
      re-render loop. Any finding promotes to F-31/F-32.
