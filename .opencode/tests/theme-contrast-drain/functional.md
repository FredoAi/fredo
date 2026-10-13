# theme-contrast-drain — functional

> Executable checklist for Spec #3035 (contrast/colour defects on Settings → Database,
> Settings → Layout, and the PostgreSQL app), plus the #3033 contrast-ledger drain.
> The QA Plan table in the Implementation Plan is the plan; these are the worked cases.
> Every pass needs a live observation from the running app on `spec/3035`
> (`tauri_webview_find_element` computed styles / `tauri_webview_screenshot`) + the gate.
> Presets: dark `classic (base — no preset)` and `light-default` ("Light Default").
>
> **Round 2 (spec/3035 @ 4862f75)** — re-test after the ST-1 recipe rework. All previously
> failing cases now pass; see `## Tests Runs (round 2)` on the feature issue.

## Settings → Database (`apps/ui/src/applications/settings-app/components/PostgresSettings.tsx`)

- [x] F-1 (REQ-AC1.1): Port radio-card **Automatic/Fixed** — PASS (round 2). dark: selected title 8.214 / desc 4.688, unselected title 8.576 / desc 4.894; selected border `accent.border` 4.088, unselected border `border.default` 4.656; selected≠unselected in three channels (accent-strong border, 8% accent tint `rgb(53,45,60)`, filled `accent.strong` indicator). light: title 16.848/desc 4.823, borders 4.514/5.318.
- [x] F-2 (REQ-AC1.2): **Log verbosity** select (`settings-postgres-log-verbosity`) — PASS (round 2). dark text 8.576, border 4.656; light text 17.833, border 5.318.
- [x] F-3 (REQ-AC1.3): Helper/caption text — PASS (round 2). dark `fg.muted` 4.894 on `bg.surface`; light 5.106. (Exploratory: the light amber `statusWarning` main strip is 2.021 — a status colour, not the `fg.muted` caption this AC names.)

## Settings → Layout (`apps/ui/src/applications/settings-app/components/LayoutSettings.tsx`)

- [x] F-4 (REQ-AC2.1): **"New layout"** (`layout-new-button`) — PASS (round 2, was FAIL: label 1.082 dark). dark label 8.576, border `border.default` 4.656; light label 17.833, border 5.318. Enabled (label `fg.default` + border `border.default`) is distinct from the disabled treatment (`fg.subtle` + `border.subtle`).
- [x] F-5 (REQ-AC2.2): **active-layout row** — PASS (round 2, was FAIL: icons 1.135 dark). dark name 8.214, meta 4.688, pill 5.382, edit/delete icons 8.214; light name 16.848, meta 4.823, pill 9.963, icons 16.848. Active non-colour cues: `aria-current="true"` + "Active" pill + 3px accent left bar.

## PostgreSQL app (`apps/ui/src/applications/database-client/components/`)

- [x] F-6 (REQ-AC3.1): `Test connection` (`db-conn-test`), `Cancel` (`db-conn-cancel`), `Save` (`db-conn-save`), `Export CSV`/`Export JSON` (`db-export-csv`/`-json`), `Run`/`Run all` (`db-query-run`/`db-query-run-all`) — PASS (round 2, was FAIL: outline/ghost labels 1.082 dark). dark enabled `db-conn-test` label 8.576 / border 4.656, enabled `db-conn-cancel` label 8.576; light 17.833 / 5.318. Disabled variants distinct: `Run all`/`Export *` label `fg.subtle` (8.273 dark / 10.163 light) + `border.subtle`, `cursor:not-allowed`; solid `Save`/`Run` keep `fg.onAccent` at 0.5 opacity.
- [x] F-7 (REQ-AC3.2): caption "Run executes the selection, or the statement at the caret." at 820px — PASS (round 2). `scrollWidth 222 == clientWidth 222`, whiteSpace normal, overflow visible, rect fully inside the toolbar `HStack`, wraps 2 lines (36px); toolbar `flex-wrap: wrap` + `align-items: flex-start`. `Run`/`Run all` keep full intrinsic labels (63/59px). Both presets.
- [x] F-8 (REQ-AC3.3): shipped controls are `Run` + `Run all` — PASS (round 2, was FAIL: `Run all` 1.191 dark). `Run` (solid) label 5.382 + white `LuPlay` icon 5.382 (≥3); `Run all` label 8.273 dark / 10.163 light (≥4.5). Both labels present and full.

## Evidence & ledger

- [x] F-9 (REQ-AC4): before/after screenshots for **3 surfaces × 2 presets** — PASS. AFTER (tip): Database, Layout, PostgreSQL app in dark + light. BEFORE: baseline-leg `64c3051` frames.
- [x] F-10 (REQ-AC5a): each AC1/AC2/AC3 backlog defect reproduced vs the pre-fix tip and classified — PASS. STILL-PRESENT pre-fix: `New layout`/outline/ghost chrome, edit/delete icons, `Run all`; FIXED-ALREADY (dropped): the select migration.
- [x] F-11 (REQ-AC5b): zero `NativeSelect` component usages under `applications/` (4 doc-comment hits only); raw-colour scan green.
- [x] F-12 (REQ-DRAIN): `pnpm --filter @fredo/ui contrast:gate` green — 4 files / 46 tests, exit 0; `CONTRAST_BASELINE = []`, `BASELINE_MAX = 0`, `KNOWN_OUT_OF_SCOPE_PAIRS = []`; the new `radio-card|selected|indicator` row is present (`fgToken: accent.strong`).
- [x] F-13 (REQ-NFR): `pnpm --filter @fredo/ui build` exit 0 (`✓ 2664 modules transformed`, zero TS errors) + gate green.

## Promoted exploratory findings (round 1 — spec/3035 @ 1118d46)

- [x] F-14 (REQ-AC2.1 / AC2.2 / AC3.1 / AC3.3 — CONFIRMED FAIL round 1, **FIXED round 2**): the global
      outline rule `button[data-variant="outline"]` (`system.ts:103,114`) was INERT — installed
      Chakra v3.34.0 emits **no** `data-variant` (live `document.querySelectorAll('[data-variant]').length === 0`),
      and `button { color: inherit }` (`system.ts:95`) lost to Chakra's recipe by layer order.
      **Round-2 fix:** the chrome is now delivered by a `theme.recipes.button` override
      (`system.ts:172-200`) in the cascade-winning `@layer recipes`. Live (round 2): dark
      `layout-new-button` 8.576, `db-conn-test` 8.576, `db-conn-cancel` 8.576, edit/delete icons
      8.214, `db-query-run-all` 8.273; light outline border 5.318. `[data-variant]` count is still 0
      (the recipe does not rely on the attribute).
- [x] F-15 (REQ-AC1.1 — unenumerated pair, round 1): `fg.muted` on the **selected** radio-card tint
      is not a gate row and is accent-dependent — round 2 classic dark **4.688**, light **4.823**
      (both ≥4.5). With the round-1 custom `#ff5a00` accent it measured 4.45 (<4.5); that preset is
      not one of the two measurement presets. Retained as an observation, not a gate row.
