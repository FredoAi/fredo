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

- [x] **E-26 — Rapid option churn with animation.** Cycle None → each animated background → None
      repeatedly (≥3 full cycles); watch the console for `Maximum update depth exceeded`, stale
      paint, orphaned animations (an `getAnimations()` entry surviving a switch), or lag
      (AGENTS.md #523). Any finding promotes to F-35/F-32.

- [x] **E-27 — Sustained animation soak.** Leave a procedural background active for several minutes;
      sample rAF cadence + heap at start/middle/end. Any unbounded growth, cadence decay, or
      runaway GPU/CPU is a finding (promotes to F-35).

- [x] **E-28 — Reduced-motion path (named blocker).** Read
      `window.matchMedia('(prefers-reduced-motion: reduce)').matches` and attempt to flip it live;
      record that the live flip is UNVERIFIED with the Tauri-driver named blocker (G-050/#2870).
      Confirm via the product-unit/static pin that the animated descriptors are gated under reduce;
      any animation still running under reduce is a finding (promotes to F-34).

- [x] **E-29 — None round-trip + persistence.** After a full animation session, select None, confirm
      the backdrop DOM is absent and the desktop matches the BEFORE capture, cold-restart, then
      reselect a procedural option and cold-restart again. Any residual paint, non-persistence, or
      stale-id crash is a finding (promotes to F-36).

- [x] **E-30 — Strobe / high-frequency luminance probe.** With animation running, capture ≥8
      consecutive synchronous frames of the backdrop region and compute per-frame mean luminance;
      look for full-frame inversions or a flicker rate that could trigger photosensitivity. Any
      finding promotes to F-34.

- [x] **E-31 — Reporter dark/brown worst-case contrast.** Apply the reporter's dark/brown preset
      (record the id) + a procedural background; sample shell chrome + window text contrast. Any
      pair below AA is a finding (promotes to F-30).

- [x] **E-32 — Animation + theme/accent churn.** Switch dark↔light and set/clear the accent override
      while the animation runs; watch for a stopped animation, a frozen frame, stale color, or a
      re-render loop. Any finding promotes to F-31/F-32.


### #2905 testing round 1 (spec/2905 @ d64ac959) — findings

- **E-26 — regression-free.** 3 full None→each→None cycles (22 steps): zero `window` errors; every `data-background-id` observed; backdrop animations never exceeded 3; no orphaned animation after a switch.
- **E-27 — regression-free.** 154 s idle soak: backdrop `[data-background-layer]` constant 3; `data-background-id` constant; heap 40,037,843→40,100,657 B (+0.16 %).
- **E-28 — UNVERIFIED (named blocker).** Live `matchMedia` flip not drivable — Tauri MCP driver has no media-emulation API (G-050/G-148/#2870); raw flag `false`. Product-unit/static pin confirms gating; no animation runs under reduce.
- **E-29 — regression-free.** None round-trip + cold restarts (mesh restored; none restored; `banana` → safe None).
- **E-30 — regression-free.** 8-frame constellation opacity series monotonic 0.6703→0.6735; 6-frame full-frame luminance 0.01086…0.01080 — no inversion.
- **E-31 — regression-free.** coffee (dark/brown) chrome 11.58–14.36:1, window title 14.79:1.
- **E-32 — regression-free.** dark→light + accent set/clear while Mesh animated: no stopped/frozen animation, no stale color, console clean.
- **E-33 — sampling-method note (no promotion).** Sparse-line recipes (topography's 1 px/22–23 px contour bands) alias with coarse fixed point grids: the canonical quadrant/centre 5 points read 0/5 while a fixed band-hit set reads 4/5 (Δ14–16) and the exhaustive scan shows 4.6 % of desktop pixels differ ≥8. Judge rendered-pixel visibility with an exhaustive scan for line-pattern options; do not read a coarse 5-point miss as invisibility.

## #2909 extension — perceptibility measurement probes (revises #2905)

> Unscripted probes for issue #2909 (a genuinely perceptible motion revision of #2905). A confirmed
> finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note). The perceptibility
> metric itself is F-39; these probe the MEASUREMENT for aliasing, false positives/negatives, and
> drift.

- [x] **E-34 — seek-vs-free-run divergence.** For each recipe, compare the deterministic seek leg's
      per-interval coverage with the free-running leg's. A large divergence (seek ≫ free-run) suggests
      the animation is not advancing in real time (paused/decoupled) or uses a non-seekable timing
      function. Any recipe where the free-run leg reads < floor while the seek leg passes is a finding
      (promotes to F-39).
- [x] **E-35 — capture-noise floor.** Repeat an identical-frame capture many times and diff; measure
      residual coverage. If the residual exceeds 0.2 %, isolate the backdrop rect from the rest of the
      desktop (clock/status/scrollbar) and re-measure. A metric that reads motion on a still frame is a
      finding (promotes to F-40). State the sampling method used.
- [x] **E-36 — occlusion pollution.** With a feature window open over part of the backdrop, capture the
      full desktop and diff; confirm the window's repaint does not inflate the backdrop coverage. If
      the measured region cannot be isolated, close all windows for the measurement. Any pollution is a
      finding (promotes to F-39).
- [ ] **E-37 — theme-change spike.** Change theme/accent between the two captures (rather than over
      animation time) and confirm the metric does not attribute the recolor to motion. A metric that
      passes on a theme change alone is a finding (promotes to F-51).
- [x] **E-38 — reduced-motion emulation lever hunt.** Attempt to flip `prefers-reduced-motion` via a
      reachable CDP `Emulation.setEmulatedMedia` port (or any other documented lever). If drivable,
      record the lever and lift F-45's blocker; if not, reaffirm the named blocker (G-050/G-148/#2870)
      and do not weaken the assertion.
- [ ] **E-39 — sustained perceptibility drift.** Leave a recipe running for several minutes and
      re-measure F-39 at the end; does coverage decay (an animation that fades/stops), and do the
      animation/layer counts stay constant? Any decay below floor is a finding (promotes to F-48).
- [ ] **E-40 — dpr / multi-monitor.** Run the metric at dpr 1 and a scaled dpr (e.g. 1.25/1.5) and
      confirm the per-channel threshold + pixel alignment hold. Any threshold shift that changes the
      verdict is a finding (promotes to F-39).
- [ ] **E-41 — partially-occluded / small viewport.** Measure on a small or heavily-occluded desktop;
      does the backdrop region still clear the floor? Any state where "alive" cannot be perceived is a
      finding (promotes to F-39/F-42).
- [ ] **E-42 — refresh-rate sensitivity.** Compare the free-run leg on a 60 Hz vs a high-refresh
      display; confirm the 2 s delta is cadence-independent (the seek leg is the floor judge). Any
      cadence-dependent verdict is a finding (promotes to F-39).
- [x] **E-43 — paused-but-declared-animated.** Force `animation-play-state: paused` (or
      `document.getAnimations().forEach(a => a.pause())`) while leaving `data-motion="animated"`, and
      run the metric. It must read < floor (a FAIL), proving the metric cannot be gamed by a
      present-but-frozen animation (promotes to F-40).

### #2909 testing round 1 (spec/2909 @ d2971844) — results

- **E-34 (seek vs free-run) — no finding.** Both legs agree per recipe (e.g. aurora seek max 87.1 % vs free max 91.4 %; nebula 51.7 vs 48.0; halo 40.0 vs 38.1) — the animation advances in real time; no seek≫free divergence.
- **E-35 (noise floor) — no finding.** Δt=0 identical-time repeats read 0.0214 % (aurora) / 0.0513 % (constellation); None free-run ≤ 0.045 %; static leg 0.063 % — all ≪ 0.2 %. Noise is from the shell clock/launcher repaint only; it never approaches a floor.
- **E-36 (occlusion pollution) — resolved by construction.** All captures were taken with every feature window minimized (Settings + launcher collapsed); the only in-frame chrome (header panel, clock, minimized-window glyph) is static shell chrome quantified by E-35.
- **E-38 (emulation lever hunt) — no lever.** raw `matchMedia('(prefers-reduced-motion: reduce)').matches` = false; no CDP `Emulation.setEmulatedMedia` port reachable through the Tauri MCP driver. F-45's named blocker reaffirmed (G-050/G-148/#2870); assertion not weakened.
- **E-43 (paused-but-declared-animated) — metric cannot be gamed.** The Δt=0 control (animations at an identical `currentTime`) reads 0.02–0.05 % despite `data-motion="animated"` and 3 present animations — a present-but-frozen animation reads far below every floor.
- **Not exercised this round (no AC depends on them):** E-37 (theme-change-between-captures anti-pattern), E-39 (minutes-long F-39 re-measure — the 100.3 s soak kept counts constant and the strobe series shows continuous motion), E-40 (dpr 1.25/1.5 — measured at dpr 1 only), E-41 (small/heavily-occluded viewport), E-42 (high-refresh display).

## #2915 extension — Conway's Game of Life background probes

> Unscripted probes for issue #2915 (a NEW Life option beside None + the six recipes). A confirmed
> finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note). No prior probe is
> superseded. The perceptibility metric itself is F-61; these probe the MEASUREMENT and the
> automaton's failure modes.

- [x] **E-44 — Rapid Life/recipe churn.** Cycle None → Life → each recipe → None (≥ 3 full cycles); watch
      for `Maximum update depth exceeded`, stale paint, an orphaned Life loop or canvas surviving a
      selection switch, or lag (AGENTS.md #523). Any finding promotes to F-57/F-66.
- [x] **E-45 — Sustained Life soak + re-seed cadence.** Leave Life active for several minutes; sample heap,
      generation/step cadence, and grid/step counts at start/middle/end. Does the automaton die out or
      freeze into a still life between re-seeds? Does the re-seed cadence drift? Any finding promotes to
      F-61/F-66/F-69.
- [x] **E-46 — Reduced-motion path (named blocker).** Read `matchMedia('(prefers-reduced-motion: reduce)').matches`
      and attempt to flip it live; record the live flip as UNVERIFIED with the Tauri-driver named blocker
      (G-050/#2870). Confirm via the product-unit pin that under reduce NO simulation loop is scheduled and
      the frame is static; any loop/step under reduce is a finding (promotes to F-64).
- [x] **E-47 — Visibility/pause probe.** Minimize, switch away, and occlude the window; does
      `data-life-running` flip to `"false"` while `visibilityState === 'hidden'` (or the frame freeze to
      ≤ noise floor) and resume cleanly on restore? Any drift, a loop that keeps stepping hidden, or a
      stale/torn frame on restore promotes to F-67.
- [x] **E-48 — Life + theme/accent churn.** Switch dark↔light + set/clear the accent override while Life
      animates; watch for a stopped loop, a frozen frame, a stale cell colour, or a re-render loop. Any
      finding promotes to F-63.
- [x] **E-49 — Canvas / performance probe.** Measure the canvas backing-store size at dpr 1 and a scaled dpr,
      the per-step allocation behaviour, and the step cadence. Does a dpr/monitor change blow up the grid or
      the backing store unboundedly? Any runaway promotes to F-66.
- [x] **E-50 — Pattern legibility probe.** With the authored cell size/step rate, does the render read as
      Life (recognizable gliders/oscillators, a live frontier) rather than visual noise or a static
      checkerboard? Is the step rate perceptible but non-strobing? Any "looks like noise"/"looks frozen"
      finding promotes to F-60/F-61.

### #2915 testing round 1 (spec/2915 @ a3c7f245) — results

- **E-44 PASS (live).** None→Life→None ×3 and the full 8-option sweep: console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`; no orphaned canvas survives a switch (canvas count 0 with None, 1 with Life).
- **E-45 PASS (live).** 90 s soak: heap 238.3→240.5 MB (+0.92 %) pre-GC then GC → 53.8 MB — no monotonic climb; canvas/backing store constant 1920×1017; the field keeps evolving (non-ground 2.1–3.5 % across the sweep) and re-seeds (direct 8.447 % single-sample jump observed).
- **E-46 UNVERIFIED — NAMED BLOCKER (live flip only).** raw `matchMedia('(prefers-reduced-motion: reduce)').matches=false`; no Tauri MCP media-emulation lever (G-050/G-148/#2870); closed by the F-64 product-unit pin (zero scheduling on the static leg).
- **E-47 PASS (live) with named blockers.** Synthetic `visibilitychange` (real handler; `document.hidden` overridden): `data-life-running` true→false→true; 6 s-hidden frame diff 0.000 %. Native minimize/hide undrivable (plugin <0.13; no `core:window:allow-hide`).
- **E-48 PASS (live).** preset dark↔light + accent override/clear while Life animates: painted ground/cell recolour live, loop keeps running, no stale colour, no re-render loop.
- **E-49 PASS (live).** backing store = 1920×1017 at dpr 1 = 1.0× CSS viewport (≤ `LIFE_DPR_MAX` 1.5 linear); constant through the soak; no grid/backing-store growth on relayout.
- **E-50 PASS (vision).** the field reads as Life (stable blocks, blinkers, a live frontier) — not noise and not a still checkerboard; 160 ms steps are perceptible and non-strobing. **Promotion:** the F-63 light-preset cell/ground contrast miss (1.90–2.93:1 < 3:1) is a new confirmed finding; it is tracked by F-63 (FAIL) rather than a new E row.

### #2915 testing round 2 (spec/2915 @ 79a80c1b) — results

- **E-44 PASS (live).** 8-option sweep + None churn console-clean; no orphaned canvas.
- **E-45 PASS (live).** clean 70 s soak: bounded sawtooth heap (start 36.97 → peak 37.29 MB = +0.882 %), canvas constant 1920×1017; field keeps evolving and re-seeds.
- **E-46 UNVERIFIED — NAMED BLOCKER.** raw `matchMedia('(prefers-reduced-motion: reduce)').matches = false`; no Tauri MCP media-emulation lever (G-050/G-148/#2870); closed by the F-64 product-unit pin.
- **E-47 PASS (live) with named blockers.** real `visibilitychange` + `document.hidden` override: true→false→true; hidden full-frame diff 0.000 % over 15.365 s. Native minimize/hide undrivable.
- **E-48 PASS (live).** preset/accent churn while animating: live recolour, loop keeps running, no stale colour, no re-render loop.
- **E-49 PASS (live).** backing store = 1920×1017 = 1.0× CSS viewport (≤ `LIFE_DPR_MAX` 1.5), constant through the soak.
- **E-50 PASS (vision).** reads as Life; not noise, not a frozen checkerboard. **Resolution:** the round-1 E-50 promotion (F-63 light-preset contrast miss) is now **resolved** — the cell paints from `--accent-strong` and all five light presets clear ≥3:1 (5.078/3.742/4.588/4.729/5.051).

## #2925 extension — dimmed-Life measurement + failure-mode probes

> Unscripted probes for issue #2925 (a calmer, less glaring Life backdrop). A confirmed finding
> PROMOTES to `functional.md` as a new `F-` row (keep the origin note). The dimming/legibility rows
> themselves are F-73..F-88; these probe the MEASUREMENT (noise, aliasing, mechanism interaction) and
> the dim-vs-perceptibility failure modes.

- [ ] **E-51 — AC1 measurement-noise floor.** Capture the SAME frame twice (Δt = 0) at the tested tip and
      run the AC1 luminance + dominance harness on both. Isolate the backdrop rect from shell chrome
      (clock/status/launcher strip) if the residual exceeds 1 % relative. A metric that reads a dim on
      an identical frame is a finding (promotes to F-73).
- [ ] **E-52 — dim-vs-perceptibility margin sweep.** Across the lightest and dimmest presets/accents (and
      across the full day/night range the dim control can reach, if it is adjustable), measure both the
      AC1 field luminance and the AC2 per-interval coverage. Is there any preset where the dim pushes
      coverage below the 2.0 % floor? Any such preset is a finding — record the raw pair (promotes to
      F-73/F-75); the floor is never lowered.
- [ ] **E-53 — "less same-colour" reads as muddy?** With the dim applied, does the field still read as
      Life (live frontier, recognizable motion) rather than a flat neutral wash? A vision read of the
      BEFORE vs AFTER frames. "Less one colour" that becomes "no colour/no readable field" is a finding
      (promotes to F-74/F-75).
- [ ] **E-54 — off-harmonic cadence stress (G-228).** Verify the re-seed discontinuity is actually
      captured at the declared 10 000 ms cadence (24 000/10 000 = 2.4, off-harmonic). If the plan's
      cadence lands harmonically (e.g. the authored re-seed period changes), report the raw per-interval
      series + the fine-granularity (per-step) max/median ratio rather than looping (promotes to F-75).
- [ ] **E-55 — dimming-mechanism / stacking interaction.** If the dim is implemented as a translucent
      overlay, read its stacking context vs the Life canvas and vs `WindowManager`; `elementFromPoint`
      at a point inside a floating window rect. An overlay that paints above a window, intercepts input,
      or shifts z-order is a finding (promotes to F-85/R-36).
- [ ] **E-56 — thumbnail vs live-field divergence (open Q5).** Compare the chooser thumbnail
      (`data-life-preview="static"`) with the live dimmed canvas after the dim + a theme/accent change.
      Does the thumbnail visibly contradict the field (bright vs dim; `--accent-primary` vs
      `--accent-strong`)? Any visible contradiction is a finding (promotes to F-86).
- [ ] **E-57 — theme/accent churn under the dim (double-apply probe).** Rapidly switch preset/accent
      (≥ 5 switches) while Life runs; re-read the field luminance after returning to the starting preset.
      Does the dim accumulate (each switch darkening further) or leave a stale dim? Any drift is a
      finding (promotes to F-79/F-80).
- [ ] **E-58 — doc/comment drift (open Q8).** Check `backgroundRegistry.ts`'s `LIFE_BACKGROUND` comment
      (still names `--accent-primary` after #2915 round 2) and `docs/features/desktop-background-life.md`
      for a stale token name or a missing dimming note. Stale doc text is a finding (promotes to F-86).

### #2925 testing round 1 (spec/2925 @ 446ac18a) — results

- **E-51 PASS.** identical-frame (Δt=0) repeat of the AC1 harness: `relDeltaPct = 0.000000`, `changedPct = 0.000` — no invented dim from capture noise.
- **E-52 UNVERIFIED — NAMED BLOCKER.** only light-default received a full 55 s coverage run (F-75); the dim-vs-perceptibility margin was not swept across the lightest/dimmest presets (round time-box after the BEFORE-leg dev-env cycle; the F-75 in-page accumulator takes ~55 s per preset). No preset measured falls below the 2.0 % floor; the floor was never lowered.
- **E-53 PASS (vision).** BEFORE vs AFTER light-default: the field still reads as Life (recognizable oscillators, a live frontier), not a flat neutral wash; the dim removed glare without destroying the pattern.
- **E-54 PASS with raw series disclosed.** the declared 10 000 ms cadence (24 000/10 000 = 2.4) did not capture a ≥3× re-seed discontinuity (max 6.5964 % vs median 5.62 % = 1.17× at 10 s; 1.98× at 2 s) — raw per-interval series reported under F-75 (same residual class #2915 disclosed).
- **E-55 PASS.** the dim is canvas-baked (no overlay element); the backdrop stays at the z=0 layer below `WindowManager`; `elementFromPoint` over a floating window returns window content.
- **E-56 PASS.** after the dim + a preset/accent change the thumbnail paints the same resolved dimmed expression as the canvas (computed ground/cell fills + the `color(srgb 0 0 0 / 0.12)` scrim rect; no `var(--accent-primary)`); no bright-vs-dim contradiction.
- **E-57 PASS.** after 20 preset switches + accent set/reset the light-default paint returned identical (ground `rgb(224,224,224)`, cell `rgb(6,88,92)`, mean L 0.73387 vs the initial 0.73136) — no accumulation, no stale dim.
- **E-58 PASS.** the `LIFE_BACKGROUND` comment now names `--life-cell` / the dimmed `--accent-strong` expression (`backgroundRegistry.ts:416-418`) and the docs carry the new "Dimming and legibility (#2925)" section (tokens, scrim/`paint()` contract, guard, 20-row pre-validation, thumbnail alignment); the stale `--accent-primary` claim is gone.

### #2925 testing round 2 (spec/2925 @ 897ce4cc) — results

> Exploratory re-probe after the round-1 fix (mid-neutral chroma leg + 7.2 % scrim). Live policy.

- **E-51 PASS.** identical-frame repeat of the F-74 harness invents no dim/chroma; the deterministic modal-cell S is `0.7075` (light) / `0.3915` (dark).
- **E-52 PASS (round-1 UNVERIFIED resolved).** coverage sweep extended to **solarized**: per-interval dense coverage **4.6561 / 4.8288 / 7.1099 / 4.7061 %** (4/4 ≥ 2.0 %), further samples 5.3125 / 4.2722 %. Every measured preset clears the floor — the smaller scrim widened the margin; floor never lowered.
- **E-53 PASS (vision).** BEFORE vs AFTER light-default: the field still reads as Life (recognizable oscillators, live frontier) with a muted teal-green palette, not a flat neutral wash.
- **E-54 PASS with raw series disclosed.** the 10 000 ms cadence (24 000/10 000 = 2.4) did not capture a ≥3× re-seed discontinuity (max 6.1454 % vs 5.20 % median = 1.18×); raw fine 320 ms series 2.4441–3.4206 % (median 2.8562, max/median 1.20×) reported rather than looping.
- **E-55 PASS.** the dim is canvas-baked (no overlay); the backdrop stays at z=0 below `WindowManager`; `elementFromPoint` over the floating window returns window content (F-85).
- **E-56 PASS.** the thumbnail paints the same resolved dimmed expression as the canvas (ground `--body-bg`, cells `--life-cell` = the canvas's computed `color`, final `color(srgb 0 0 0 / 0.072)` scrim); no `var(--accent-primary)`.
- **E-57 PASS.** after the round-2 preset/accent churn the light-default paint returned exactly (ground `rgb(237,237,237)`, cell `rgb(30,103,105)`); the smaller scrim does not accumulate or leave a stale dim.
- **E-58 PASS.** docs carry the round-2 weights, the mid-neutral rationale, both G-227 tables, the declared targets and the two-tier AC3b gate; the stale `--accent-primary` claim is gone.
