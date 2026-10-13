# Contrast Gate — Functional

> Formalizes the `## QA Expert` QA Plan rows `Q-1..Q-10` from `.opencode/tmp/3033/triage.md`
> (EARS R-1..R-5, AC1..AC5). Every case lists the observable expected outcome and required test
> data. **Verification policy: static** — this feature is a vitest suite + CI wiring; its ACs are
> proven by running `pnpm --filter @fredo/ui contrast:gate` and reading committed config/artifacts.
> No running app, no DOM, no telemetry. The oracle for the floor/baseline cases is the **pure
> `evaluateContrast` return value** — never a live read.

## Matrix (R-1 / AC1)

- [ ] **F-1 (R-1 / AC1, Q-1):** Run `pnpm --filter @fredo/ui contrast:gate`; in
      `apps/ui/src/app/theme/contrast/__tests__/contrastGate.test.ts` call `buildContrastMatrix()`.
      Assert every `PRESET_IDS` × declared `SurfaceId` × `ControlState` combination is represented
      and each row carries `key` (`<presetId>|<surface>|<state>|<pairId>`), `presetId`, `surface`,
      `state`, `pairId`, `kind`, `ratio`, `floor`; assert the run reports
      preset/surface/state/pair/ratio per row.
      **Expected:** command exits 0 on the tip (green once #3035 lands); row count = 19 presets ×
      declared surfaces × states; all 8 fields present on every row; keys unique.
      **Edge:** `'classic (base — no preset)'` present and distinct from the 18 preset rows;
      `themes.turbo` absent (base locked to `classic`); duplicate `key` = FAIL; declared surface/state
      with zero rows = FAIL.

## Absolute floor (R-2 / AC2)

- [ ] **F-2 (R-2 / AC2, Q-2):** For every matrix row assert `ratio >= floor` OR the row's `key` ∈
      `CONTRAST_BASELINE`; assert `floor === BODY_FLOOR` (4.5) for `kind: body` and `=== UI_FLOOR` (3)
      for `large|ui|border|focus`. Assert the `light-default` primary focus pair
      (`accent.focusRing`×{canvas,surface}; `accent.strong`×subtle) is floor-checked at **3 — not a
      `no-worse-than-control` Δ≤0.2 tier** — and appears in `CONTRAST_BASELINE` keyed to `#3035` on
      the tip.
      **Expected:** every `floor` is an absolute constant; the primary focus pair is present,
      `kind: focus`, `floor: 3`, baselined until #3035 lands; no tolerance tier in `evaluate.ts`/
      `matrix.ts`.
      **Edge:** all 19 presets checked (not only `light-default`); grep `evaluate.ts`/`matrix.ts` for
      `no-worse-than-control`/`tolerance`/Δ≤0.2 — any hit = FAIL; `kind: large` also uses 3.

- [ ] **F-3 (R-2.b / AC2, Q-3):** Pure: `evaluateContrast([...buildContrastMatrix(), injectedRow],
      CONTRAST_BASELINE, BASELINE_MAX)` where `injectedRow` has a fresh `key` at `ratio: 1.2`.
      **Expected:** `violations` contains the injected key (absent from the baseline) → the
      evaluation FAILs; the suite asserts a non-empty new-violation set.
      **Edge:** injected key equal to a baselined key → baselined, NOT a new violation (key identity);
      `ratio === floor` exactly → not a violation (boundary); just below floor → violation.

- [ ] **F-4 (R-2.c / AC2, Q-4):** Pure: `scanRawColors([{ path:
      'src/applications/__injected__/Bad.tsx', source: 'const c = "#ff0000";' }])` → ≥1 violation
      (`kind: 'hex'`); positive control `scanRawColors([{ path: <allowlisted path>, source:
      <allowlisted literal> }])` → 0.
      **Expected:** injected hardcoded colour in a non-allowlisted application path is reported; an
      allowlisted path yields none.
      **Edge:** `rgba(`/`hsl(` (`kind: 'function'`) and `var(--x)55` (`kind: 'var-alpha-append'`); a
      literal inside a comment is stripped and NOT reported; a UI-chrome literal is NOT allowlistable.

## Raw-colour scan (R-3 / AC3)

- [ ] **F-5 (R-3 / AC3, Q-5):** `defaultScanTargets()` must include
      `apps/ui/src/app/theme/system.ts` and every `apps/ui/src/applications/**/*.{ts,tsx}`. Scan the
      real tree: assert a source under `applications/` with a literal is reported; an allowlisted path
      yields none; every `RAW_COLOR_ALLOWLIST` entry is `{file, kind, since}` with `kind ∈
      {terminal-ansi, canvas-3d, node-identity, test-fixture}`.
      **Expected:** coverage spans `applications/**` + `system.ts`; the real tree yields 0
      unallowlisted violations on the tip; allowlist entries schema-valid.
      **Edge:** `apps/ui/src/shared/**` OUT of scope day one (do NOT assert coverage there); allowlist
      matches by `file` (a listed file does not license a NEW literal); distinguish `var(--x)NN` from a
      JS 8-digit hex concat; a UI-chrome literal (`OptimizelyFlagsPanel.tsx:85-129`) is NOT
      allowlistable (tokenise under #3034/#3035).

## CI wiring (R-4 / AC4)

- [ ] **F-6 (R-4 / AC4, Q-6):** Read `.github/workflows/validate.yml`: the `ui-validate` job must
      contain a step named exactly `Contrast gate` running `pnpm --filter @fredo/ui contrast:gate`
      after the `test:run` step, inside the `ui` path-filtered job whose aggregate `validate` check is
      required.
      **Expected:** the named step exists and runs on any UI-touching PR; a violation fails
      `ui-validate` → `validate` (required) → merge blocked.
      **Edge:** step name exact (legible failure); the gate also runs implicitly inside `test:run`
      (both green); `validate` not made non-required; no new workflow file added; a non-UI PR
      legitimately skips `ui-validate`.

## Control classes + states (R-5 / AC5)

- [ ] **F-7 (R-5 / AC5, Q-7):** Assert the matrix contains rows for outline buttons
      (`control-outline`), selects (`select`), radio cards (`radio-card`), and the `disabled` +
      `selected` states — for every shipped preset; each such surface has ≥1 pair for the required
      states. The **opacity-composited** disabled/hover control appearances (H1: select `opacity:0.5`,
      radio-card `0.55`, solid-control hover `0.9`) are recorded as explicit **composed** pairs and
      floor-checked (baselined if below); the radio-card *label* uses `fg.muted` at the **4.5 body
      floor** (not 3).
      **Expected:** outline/select/radio-card surfaces and disabled/selected states present per
      surface across all 19 presets; composed opacity states are explicit pairs, not assumed token reads.
      **Edge:** a required surface/state with zero rows = FAIL (vacuous); `hover`/`focus` also present
      on radio-card; every one of the 19 presets carries the control rows; rows cite real declarations
      (`system.ts:18-20`, `LayoutSettings.tsx:71-89` canonical `selectStyles`,
      `AppPresentationSettings.tsx:100-124`); the light-toned `fg.muted` label on `--card-bg` is a
      4.5-body pair that may legitimately land in the baseline; `RadioCard.ItemIndicator`
      (`AppPresentationSettings.tsx:123`) declares no `colorPalette` (stock palette) — record it or
      route to #3035, do NOT assume it resolves from the accent.

## Baseline semantics (green-on-day-one + fails-new)

- [ ] **F-8 (baseline, Q-8):** Pure: evaluate the full matrix against an EMPTY baseline with
      `max = matrixViolationCount + 1`; assert every below-floor row is a NEW violation.
      **Expected:** an unbaselined violation is a FAIL (the day-one mechanism).
      **Edge:** empty baseline + `max: 0` → any violation fails; `baselined` contains only baseline keys.

- [ ] **F-9 (baseline, Q-9):** Pure: `evaluateContrast(matrixMinusOneBaselinedRow, CONTRAST_BASELINE,
      BASELINE_MAX)`; assert the removed entry is in `staleBaseline`.
      **Expected:** a baseline entry whose row is no longer a violation is STALE → FAIL (ratchet-down).
      **Edge:** an entry present AND still violating → not stale; a baseline `key` absent from the
      matrix → stale.

- [ ] **F-10 (baseline, Q-10):** Pure: `evaluateContrast(rows, [...CONTRAST_BASELINE, extraEntry],
      BASELINE_MAX)` FAILs because `baseline.length > max`. Assert `BASELINE_MAX ===
      CONTRAST_BASELINE.length` (frozen at the day-one count) and every entry's `issue` is a positive
      integer referencing a live issue (`#3035`).
      **Expected:** exceeding the cap FAILs; the cap equals the frozen day-one violation count; every
      entry has a live `issue`.
      **Edge:** `baseline.length === max` passes; `max` is the frozen constant (not recomputed at test
      time); `issue: 0`/missing = FAIL.

## Gates

- [ ] **F-11 (NF):** `pnpm --filter @fredo/ui contrast:gate` (green); `pnpm --filter @fredo/ui
      test:run` green with the gate included; `pnpm --filter @fredo/ui build` exit 0 (zero TS errors);
      no new runtime/test dependency (package.json diff = the `contrast:gate` script only).
      **Expected:** all three green; gate file duration < ~5 s (inside the 15 s per-file budget).
      **Edge:** no existing assertion weakened/disabled/deleted; `globalFocusVisible.test.ts`
      byte-identical except the ST-1 import swap.
