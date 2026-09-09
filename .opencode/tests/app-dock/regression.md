# app-dock — Regression

The "must not change" baseline for the positionable dock surface. #2848 adds position choice (Sidebar / Bottom bar) — the **Sidebar orientation is the unchanged #2838/#2841 baseline and must be byte-identical** until a user opts into Bottom bar; the window engine stays READ-ONLY; existing `AppDock.test.tsx` cases stay green. Map 1:1 to `.opencode/tmp/2848/triage.md` `## QA Expert` (Regression risks). Seeded from issue #2848.

> Run the app-dock suite's own regression alongside the overlapping prior suites listed at the bottom — desktop-chrome F-14..F-23 / R-15..R-20 and window-manager F-20..F-35 / R-11/R-12 — per `.opencode/tests/README.md` "regression runs".

## Must NOT change

- [ ] R-1 (default Sidebar for existing installs): An existing install (no persisted `Fredo_dock_position`) opens with the dock on the **Sidebar** — the pre-#2848 default. There is NO migration on upgrade: existing persisted settings never flip a Sidebar-user to Bottom bar, and a persisted choice is honored over the default.
  - **Expected:** after a full restart with NO `Fredo_dock_position` key written, the dock renders at the left edge (resting-visible on a clean desktop, exactly the #2838/#2841 rail); the first-run default is NOT Bottom bar; no store key is auto-written on upgrade.
- [ ] R-2 (Sidebar geometry constants unchanged): The left-edge reveal-zone / keep-zone / hide-delay constants for the Sidebar leg are UNCHANGED — `EDGE_ZONE_PX = 6`, keep-zone ≈ 76px (`DOCK_WIDTH_PX + DOCK_KEEP_MARGIN_PX`), `HIDE_DELAY_MS = 350` baselines. The Bottom bar orientation introduces bottom-edge equivalents (`clientY ≥ viewport.height − 6` semantics) WITHOUT altering the left-edge values.
  - **Expected:** a Sidebar edge-summon probe behaves identically to the #2841 baseline (reveal at `clientX ≤ 6`, keep-zone ≈76px, hide-delay ≈350ms); the `DOCK_BOTTOM_*` constants are additive, not renames of the Sidebar values.
- [ ] R-3 (existing `AppDock.test.tsx` default-sidebar cases stay green): The pre-existing component-test suite (`dock/__tests__/AppDock.test.tsx`, #2838/#2841) passes UNCHANGED — its default-orientation (Sidebar) assertions (resting-visible, roving, close-✕, empty gate) must not need edits for the new orientation work.
  - **Expected:** `pnpm --filter @fredo/ui test:run` green including the unmodified default-sidebar `AppDock.test.tsx` cases.
- [ ] R-4 (window-engine kernel READ-ONLY): The dock stays a PURE READ-ONLY consumer of the shared window-system read surface — zero edits to `windowStore.ts` / `windowTypes.ts` / `window-system/*` (useWindows/useWindowActions/WindowManager/WindowFrame/WindowChrome) and ZERO Rust diff. The dock dispatches only `focusWindow`/`closeWindow`.
  - **Expected:** `git diff main spec/2848` shows no kernel file edits and no Rust change; the dock consumes `useWindows()` store-order entries keyed `win.id` and never writes lifecycle state.
- [ ] R-5 (entry set == window-store set): In BOTH orientations the dock entry set equals the `useWindows()` store set — every open window listed exactly once in store order, no stale/ghost entries, no duplicate after an orientation flip or a same-feature double-open.
  - **Expected:** per-orientation DOM snapshots list the same entries as the store; after open/minimize/close/restore settles, dock entries and store entries agree.
- [ ] R-6 (empty gate both orientations): With 0 windows open, NO dock renders at EITHER edge — `dockPresent:false`, no mounted listener, no empty rail/pill, no ghost — and the setting still persists when chosen at 0 windows.
  - **Expected:** close the last window per orientation → dock unmounts entirely; reopening a window restores the dock at the chosen edge.
- [ ] R-7 (hover/focus ✕ semantics + `canClose` gate retained): The #2838/#2841 close-✕ behavior is retained in BOTH orientations: ✕ reveals on row `:hover` / `:focus-within` (`opacity 0→1`, `pointer-events none→auto`, opacity-hidden NOT `display:none`), `aria-label="Close <title>"`, `stopPropagation` prevents the row's activate from firing on a ✕ click, and the ✕ NEVER renders (and is out of the tab order) when `win.canClose` is false.
  - **Expected:** the Sidebar ✕ behaves exactly as the #2841 F-16/F-21 baseline; the Bottom bar ✕ matches the same semantics on the horizontal layout.
- [ ] R-8 (no re-render loops on orientation flips): The orientation flip must NOT add a re-render-loop dep (#523 class) — reveal/visibility stay transition-only booleans; no effect depends on array `.length` or freshly-created object refs. `tauri_read_logs(source="console")` after EVERY leg (orientation flips, reveal/hide cycles, hover-✕ toggles, keyboard roving) shows ZERO `Maximum update depth exceeded` / `Error:` / `Uncaught`.
  - **Expected:** rapid Sidebar↔Bottom bar flips, reveal/hide cycles and hover-✕ toggles settle with a clean console; a console error invalidates that leg's evidence.

## Overlapping prior suites (run alongside)

- `.opencode/tests/desktop-chrome/` — functional **F-14..F-23** (dock vs desktop chrome: single top-right LED, band z sink/cover, rail disjoint from clock/LED, settings button chrome-tier, live `telemetry_spans` gate) + regression **R-15..R-20** (left-edge dock invariants + #2841 polish non-goals) must hold unchanged with the positionable dock.
- `.opencode/tests/window-manager/` — functional **F-20..F-35** (window lifecycle + left-edge rail interactions from #2838) + regression **R-11/R-12** (dock passive read-only consumer; dock at rest changes nothing about stacking/pointer reach/chrome) must hold unchanged.
