# navigation-fleet — Regression

Feature: NavigationEngine P7 fleet migration (Spec #3121). The "must not change" baseline. Run on
every testing phase that touches `shared/navigation/`, `shared/hotkeys/`, `shared/window-system/` or
any of the FIVE in-scope application folders (`terminal`, `mission-monitor`, `database-client`,
`dev-mode`). The removed apps (diagram, optimizely, my-workitems, create-workitem) are frozen and
are not regression targets of this phase.

## Must-not-change baseline (from the Architect's non-goals)

- [ ] R-1: **No key re-tuning and no new key.** Every legacy binding keeps its exact stroke:
      mission-monitor `s`; dev-mode `x`/`v`/`i`/`b`; terminal `F2`; SQL Studio `Ctrl/Cmd+Enter`;
      Mission Monitor detail `Escape`; globals `Ctrl+Space`, `Ctrl+Tab`, `Ctrl+Shift+Tab`. No new key
      is introduced in any of the five surfaces (`app.map` stays keyless), and each migrated surface
      ends with zero `data-hotkey` attributes.
- [ ] R-2: **No capability added.** No terminal `split`/`new-tab`/`new-window`/`clear`/`kill` verb;
      `terminal.session.copyAuthCommand` is the only copy action. No mission-monitor `n`/`p` session
      navigation (a stale comment only). No new SQL chord and no row-selection behaviour; no new
      dev-mode probe feed or view.
- [ ] R-3: **Terminal passthrough unchanged.** Every keystroke reaches the PTY; no
      `preventDefault`/`stopPropagation`; no exit chord (focus change exits); `Escape` reaches the
      PTY; `data-fredo-passthrough` body hook still driven by `terminalMode.ts`.
- [ ] R-4: **Window traversal unchanged.** `Ctrl+Tab` / `Ctrl+Shift+Tab` still raise + place DOM
      focus; `Ctrl+Space` still toggles the launcher; the native `Tab`/`Shift+Tab` window-boundary
      hand-off is untouched.
- [ ] R-5: **Wireframe pilot unaffected.** `wireframeSurface.test.ts` and the wireframe rails keep
      their outcomes; the DEV `?view=navigation-preview` route still mounts rail + map + trail.
      Wireframe's tests are not relocated and its `data-hotkey` literals are out of scope.
- [ ] R-6: **Legacy platform code NOT deleted.** `shared/hotkeys/**` (observer, scan, activation),
      `HotkeyBar.tsx`, `Keycap`, `commandSurfaceStore.ts`, the `apps/ui/src/index.ts` exports and
      `docs/ARCHITECTURE.md`'s P8-bound internals stay (P8 owns removal).
- [ ] R-7: **No new `document` keydown listener, no poll, no persistence** for place cursor / map /
      selection; no new runtime dependency. The pre-existing Mission Monitor detail `Escape` window
      listeners stay (behaviour preservation).
- [ ] R-8: **Forbidden files untouched:** `apps/ui/src/index.ts`, `main.tsx`,
      `StandaloneAppWindow.tsx`, `apps/tauri/src-tauri/Cargo.toml` (pre-existing dirty),
      `Home.tsx` (application registration stays as shipped), and the frozen app folders
      (`applications/diagram/**`, `applications/optimizely/**`, `applications/my-workitems/**`,
      `applications/create-workitem/**`). The one additive shared edit allowed is
      `StrokeOptions.keyboardOwner` in `shared/navigation/ui/host.ts`.
- [ ] R-9: **Every existing outcome assertion survives** (tests may be re-pointed at the new
      dispatch path; no assertion is deleted). No test is relocated; the new retirement scan is
      additive.
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
- `data-hotkey` strings surviving in a comment/test under one of the FIVE in-scope paths (AC7 is a
  per-surface literal search; a comment counts).
- SQL Studio's adapter swallowing `Ctrl/Cmd+Enter` before `SqlEditor` sees it (the chord must stay
  local and produce `runSingle`).
- A SQL selection change (connection/table/result set) remounting the workspace or moving the place
  cursor instead of only flipping map availability via `refreshContext()`.
