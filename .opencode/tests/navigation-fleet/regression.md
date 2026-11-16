# navigation-fleet — Regression

Feature: NavigationEngine P7 fleet migration (Spec #3121). The "must not change" baseline. Run on
every testing phase that touches `shared/navigation/`, `shared/window-system/` or any of the FIVE
in-scope application folders (`terminal`, `mission-monitor`, `database-client`, `dev-mode`).

> **P8 supersedes (Spec #3122).** The legacy keyboard runtime is DELETED, the eight deprecated
> application trees are deleted, and the boot set is exactly `wireframe`, `terminal`,
> `mission-monitor`, `database-client`, `theming`, `setup`, `settings`, `dev-mode`. Rows below that
> froze the legacy runtime (R-6) or the retired app folders (R-8) are historical for P7 and are
> restated to the current model; the retained observable (key strokes, terminal passthrough, window
> traversal, Wireframe, SQL Studio outcomes) is unchanged.

## Must-not-change baseline (from the Architect's non-goals)

- [ ] R-1: **No key re-tuning and no new key.** Every legacy binding keeps its exact stroke:
      mission-monitor `s`; dev-mode `x`/`v`/`i`/`b`; terminal `F2`; SQL Studio `Ctrl/Cmd+Enter`;
      Mission Monitor detail `Escape`; globals `Ctrl+Space`, `Ctrl+Tab`, `Ctrl+Shift+Tab`. No new key
      is introduced in any of the five surfaces (`app.map` stays keyless), and each migrated surface
      carries zero legacy element-key attributes (the committed `legacyAbsence.test.ts` owns the
      literal token; the surface renders its keys through `data-nav-keycap` / `data-nav-verb-id`).
- [ ] R-2: **No capability added.** No terminal `split`/`new-tab`/`new-window`/`clear`/`kill` verb;
      `terminal.session.copyAuthCommand` is the only copy action. No mission-monitor `n`/`p` session
      navigation (a stale comment only). No new SQL chord and no row-selection behaviour; no new
      dev-mode probe feed or view.
- [ ] R-3: **Terminal passthrough unchanged.** Every keystroke reaches the PTY; no
      `preventDefault`/`stopPropagation`; no exit chord (focus change exits); `Escape` reaches the
      PTY; `data-fredo-passthrough` body hook still driven by
      `shared/navigation/ui/terminalPassthrough.ts` (relocated from the deleted legacy module).
- [ ] R-4: **Window traversal unchanged.** `Ctrl+Tab` / `Ctrl+Shift+Tab` still raise + place DOM
      focus; `Ctrl+Space` still toggles the launcher; the native `Tab`/`Shift+Tab` window-boundary
      hand-off is untouched.
- [ ] R-5: **Wireframe pilot unaffected.** `wireframeSurface.test.ts` and the wireframe rails keep
      their outcomes; the DEV `?view=navigation-preview` route still mounts the bar + map + trail.
      Wireframe's keys are declaration data (`data-nav-keycap` / `data-nav-verb-id`), not element
      attributes.
- [ ] R-6: **Legacy platform code deleted (P8 supersession).** After #3122 the legacy keyboard
      runtime directory, the legacy bar/provider/announcer, the legacy `Keycap`, the command-surface
      runtime and the legacy root exports are GONE; the navigation barrels and `NavigationProvider`
      are the ONE surface. This row now asserts their absence, not their presence.
- [ ] R-7: **No new `document` keydown listener, no poll, no persistence** for place cursor / map /
      selection; no new runtime dependency. The pre-existing Mission Monitor detail `Escape` window
      listeners stay (behaviour preservation); `globalKeys.ts` is the only navigation chord listener.
- [ ] R-8: **Forbidden files untouched:** the pre-existing dirty
      `apps/tauri/src-tauri/Cargo.toml` stays byte-unchanged; `AGENTS.md`/`opencode.json` are
      human-owned and byte-unchanged; the eight retired application trees are deleted (not
      frozen). The sanctioned P8 edits are the deletion/re-pointing set in the #3122 plan.
- [ ] R-9: **Every existing outcome assertion survives** (tests may be re-pointed at the new
      dispatch path; no assertion is deleted). P8 relocates the surviving primitives
      (`keys`, `focusContext`, `terminalPassthrough`, `traversal`) into
      `shared/navigation/**` / `shared/window-system/`, named in
      `.opencode/tests/navigation/coverage-map.md`; the absence guard is additive.
- [ ] R-10: **Build + full suite green** — `pnpm --filter @fredo/ui build` and
      `pnpm --filter @fredo/ui test:run` exit 0.
- [ ] R-11: **SQL Studio outcomes unchanged.** Connection connect/edit/delete/disconnect/retry,
      schema-node actions (`viewColumns`/`openData`/`newQuery`), query run/run-all, tab new/close,
      result-set select/sort/load-more/export, history clear/re-run and saved-query open/save/rename/
      delete keep their shipped handlers and outcomes; the `db-*` testids are unchanged;
      `Ctrl/Cmd+Enter` remains the only run chord and `db-grid-row` gains no click/`aria-selected`
      selection.

## Overlapping suites to run as regression

- `.opencode/tests/navigation/` — P3 core + P4 surfaces + P5 contract changes (pure functions,
  host epoch, rail/map/trail models, validation V-01…V-12).
- `.opencode/tests/hotkeys/` — legacy element-declared hotkeys; the #3009 section documents what is
  obsolete, the `regression.md` invariants still apply to the frozen apps.
- `.opencode/tests/wireframe-navigation/` — the P5 pilot's live rails/keys/journal; must stay green.
- `.opencode/tests/mission-monitor/` — Mission Monitor behaviour (rows, drawer, detail) that the new
  surface must not change.
- `.opencode/tests/sql-studio/` — SQL Studio connection/schema/query/results/history behaviour; the
  migration must not change any handler or `db-*` testid.
- `.opencode/tests/db-client-builtin/` — the built-in connection + settings path.
- `.opencode/tests/terminal/` and `.opencode/tests/terminal-presentation-mode/` — terminal session
  lifecycle + passthrough hooks.
- `.opencode/tests/window-manager/` and `.opencode/tests/workspace-layout/` — window raising, focus
  placement and zone layout (the traversal surface must not change them).
- `.opencode/tests/launcher/` — launcher shell DOM must stay byte-identical (D-1: no palette is
  re-added).

## Regression risks to probe explicitly

- The terminal provider's focus subscription firing on every keydown (latency, extra journal rows).
- The window-system provider mounted once but re-registering per window (duplicate hosts →
  `last registration wins` silently dropping one).
- The window-system dock intercepting pointer events outside its own rows (wrapper must stay
  `pointer-events: none`).
- Selection-scoped availability leaking through a component-local boolean instead of `available(ctx)`.
- Legacy element-key strings surviving in a comment/test under one of the FIVE in-scope paths (the
  committed `legacyAbsence.test.ts` owns the literal search; a comment counts).
- SQL Studio's adapter swallowing `Ctrl/Cmd+Enter` before `SqlEditor` sees it (the chord must stay
  local and produce `runSingle`).
- A SQL selection change (connection/table/result set) remounting the workspace or moving the place
  cursor instead of only flipping map availability via `refreshContext()`.
