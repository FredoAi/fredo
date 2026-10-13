# theme-contrast-drain — functional

> Executable checklist for Spec #3035 (contrast/colour defects on Settings → Database,
> Settings → Layout, and the PostgreSQL app), plus the #3033 contrast-ledger drain.
> The QA Plan table in the Implementation Plan is the plan; these are the worked cases.
> Every pass needs a live observation from the running app on `spec/3035`
> (`tauri_webview_find_element` computed styles / `tauri_webview_screenshot`) + the gate.
> Presets: dark `classic (base — no preset)` and `light-default` ("Light Default").

## Settings → Database (`apps/ui/src/applications/settings-app/components/PostgresSettings.tsx`)

- [ ] F-1 (REQ-AC1.1): Port radio-card **Automatic/Fixed** — read `RadioCard.ItemText` (`fg.default`) + `ItemDescription` (`fg.muted`) `color`, and the `ItemControl` `borderColor`/`bg`. Expected: text ratio **≥4.5:1**, unselected border **≥3:1**; selected card differs from unselected in **both** border (`var(--accent-primary)`) and fill (12% accent tint). Edge: `_hover`, `_focusWithin`, `disabled` (`controlsDisabled`), both presets.
- [ ] F-2 (REQ-AC1.2): **Log verbosity** select (`settings-postgres-log-verbosity`) — text **≥4.5:1**, border **≥3:1**, both presets, no dark-on-dark. Edge: disabled, focus.
- [ ] F-3 (REQ-AC1.3): Helper/caption text (`Field.HelperText` :460/:525; status strip `fontSize` sm/xs `fg.muted` :430/:433/:437) — **≥4.5:1** on `bg.surface` and on `bg.subtle`. Edge: `drifted`/`unavailable`/`error` strip variants, both presets.

## Settings → Layout (`apps/ui/src/applications/settings-app/components/LayoutSettings.tsx`)

- [ ] F-4 (REQ-AC2.1): **"New layout"** (`layout-new-button`) — label **≥4.5:1**, border **≥3:1**, and **visibly distinct from a disabled** control (border + label differ). Edge: hover/focus (global outline border rule), both presets.
- [ ] F-5 (REQ-AC2.2): **active-layout row** — `Active` pill (`bg accent.default`/`color fg.onAccent`), name (`fg.default`), `N zones · template` (`fg.muted`), edit/delete ghost icons. Expected: text **≥4.5:1**, icons **≥3:1**; active row distinguished by accent left-border + 8% tint. Edge: inactive row, icon hover, **G-170** (elements present at resting rect), both presets.

## PostgreSQL app (`apps/ui/src/applications/database-client/components/`)

- [ ] F-6 (REQ-AC3.1): `Test connection` (`db-conn-test`), `Cancel` (`db-conn-cancel`), `Save` (`db-conn-save`), `Export CSV`/`Export JSON` (`db-export-csv`/`-json`), `Run`/`Run all` (`db-query-run`/`db-query-run-all`) — enabled labels **≥4.5:1**, borders **≥3:1**; **disabled** variant visibly distinct (Save pre-test, Export at 0 columns, Run with no connection). Both presets.
- [ ] F-7 (REQ-AC3.2): caption "Run executes the selection, or the statement at the caret." (`SqlEditor.tsx:290-292`) at narrowest panel/window width — `scrollWidth ≤ clientWidth` **and** rect fully inside the toolbar `HStack` (no clip). Both presets.
- [ ] F-8 (REQ-AC3.3): shipped controls are `Run` + `Run all`; the backlog's "Run selection" maps to these. Both legible with the `LuPlay` icon.

## Evidence & ledger

- [ ] F-9 (REQ-AC4): before/after screenshots for **3 surfaces × 2 presets** under `.opencode/tmp/3035/e2e/`; BEFORE via the baseline leg or the documented fallback.
- [ ] F-10 (REQ-AC5a): each AC1/AC2/AC3 backlog defect reproduced vs the pre-fix tip and classified **STILL-PRESENT** or **FIXED-ALREADY (dropped)**.
- [ ] F-11 (REQ-AC5b): zero `NativeSelect` component usages under `applications/`; raw-colour scan green (no new `#hex`/`rgba(`/`var(--x)N`).
- [ ] F-12 (REQ-DRAIN): `pnpm --filter @fredo/ui contrast:gate` green with `CONTRAST_BASELINE.length === 0` (or WCAG-exempt only, mechanism named) and `BASELINE_MAX === 0`; stale-row check passes (the gate fails on any stale entry).
- [ ] F-13 (REQ-NFR): `pnpm --filter @fredo/ui build` exit 0 (zero TS errors) + gate green.

## Promoted exploratory findings (round 1 — spec/3035 @ 1118d46)

- [ ] F-14 (REQ-AC2.1 / AC2.2 / AC3.1 / AC3.3 — CONFIRMED FAIL, round 1): the global outline rule
      `button[data-variant="outline"]` (`system.ts:103,114`) is INERT — installed Chakra v3.34.0
      emits **no** `data-variant` on any rendered button (live `document.querySelectorAll('[data-variant]').length === 0`;
      the selector text is in the emitted CSS but matches nothing), and the companion
      `button { color: inherit }` (`system.ts:95`) loses to Chakra's recipe rule by layer order
      (`@layer reset, base, tokens, recipes`). Expected: enabled outline/ghost labels **≥4.5:1**
      and outline borders **≥3:1**. Actual (dark `classic`): `layout-new-button` label **1.082**,
      `db-conn-test` **1.082**, `db-conn-cancel` **1.082**, `db-query-run-all` **1.191**,
      active-row edit/delete icons **1.135**; (light) outline border **1.194**.
      Repro: open Settings → Layout and the PostgreSQL app in `classic (base — no preset)` and read
      the computed `color` / `border-color` of the enabled controls.
- [ ] F-15 (REQ-AC1.1 — unenumerated pair, round 1): `fg.muted` on the **selected** radio-card tint
      is not a gate row and is accent-dependent — **4.663** with the classic accent, **4.821** with
      `light-default`, but **4.45 (< 4.5)** with a custom `#ff5a00` accent. Repro: Settings → Database,
      read `ItemDescription` computed `color` over the ancestor-composited tint.
