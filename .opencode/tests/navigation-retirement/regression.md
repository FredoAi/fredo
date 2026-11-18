# navigation-retirement — Regression

The "must NOT change" baseline for Issue #3151 (retire the navigation/keyboard engine, slice 1 of
3). Every entry is a behaviour the slice's deletion could plausibly take with it — the spec's NAMED
failure mode is **"deletion target assumed dead by location" (G-432)**. A regression FAIL here is
as serious as an AC FAIL: the ACs say "no lost capability".

Verification policy: **MIXED, per row** (see `functional.md`). `static` rows are proved from the
committed source + gate wrappers; `live` rows from a running webview.

## The four surviving features with engine dependencies (must be RE-HOMED, never deleted)

- [ ] **R-1 (G-432, live).** `shared/window-system/zoneLayout.ts` — the modifier-only chord DRAG
  (zone activation) still works. With ≥2 windows, hold the platform primary modifier and drag a
  window over a zone target; the zone overlay (`[data-testid="zone-overlay"]`,
  `[data-testid^="zone-target-"]`) appears and releasing assigns the layout.
  **Expected:** the drag-to-zone gesture still activates on `primary`, `primary+alt`,
  `primary+shift`, `alt`, `alt+shift` per the `ZONE_ACTIVATION_CHORDS` set — behaviour identical,
  now importing `resolvePrimaryModifier`/`PrimaryPlatform` from `./platformModifier`
  (Contracts §3). Owning artifact: ST-1's `zoneLayoutChord.test.ts` (new — the modifier-parity pin).
  **Edge:** a non-primary ctrl press must NOT match; `primary+alt` must not match `primary`.
- [ ] **R-2 (live + unit).** `applications/settings-app/components/LayoutSettings.tsx` — the
  activation-chord labels still render `Ctrl`/`⌘` correctly on the current platform, and the
  `layout-delete-dialog` still opens/dismisses. The inline status text still renders (the
  `announceNavigation` call is dropped, the visible text is kept — E2 disposition).
  **Expected:** the existing `LayoutSettings.test.tsx` (`'Ctrl+Alt'` label assertion) stays green;
  live: the chord options read `Ctrl`, `Ctrl+Alt`, `Ctrl+Shift`, `Alt`, `Alt+Shift` with the same
  accessible names as before.
- [ ] **R-3 (live + unit).** `shared/window-system/traversal.ts` — the plain-`Tab`
  window-boundary hand-off still works and modified Tab is still ignored there.
  **Expected:** `Tab` at the last focusable of a window's content hands off to the next window;
  `Shift+Tab` at the first hands off to the previous; a `primary+Tab` is NOT intercepted by
  traversal (it belongs to `platformChords.ts`). Owning artifact: ST-4's re-pointed
  `WindowTraversal.test.tsx`.
- [ ] **R-4 (live + unit).** `shared/window-system/launcherToggleSeam.ts` + `LauncherShell`'s
  shell-lifetime registration (`LauncherShell.tsx:1560-1565`).
  **Expected:** `runWindowLauncherToggle()` raises the launcher while the shell is mounted and
  reports `false` with no shell; the registration is cleared on unmount. Q-9 proves the chord path.

## The surviving `shared/companion` modules (must NOT be deleted)

- [ ] **R-5 (unit).** `composerBridge.ts`, `composerTarget.ts` (de-enveloped, SURVIVES — the
  architect's correction #1), `appOpenReply.ts`, `skillBridge.ts`, `companionDispatch.ts`.
  **Expected:** all five still exist at their paths and export their existing symbols; the
  composer's target-resolution ORDER is unchanged (`requestedAppId` → topmost frame containing the
  point → `windowAppId` → `focusedAppId` → `null`, `composerTarget.ts:78-101`); the absent-key rule
  for an ungrounded send is unchanged (never an explicit `null`/`undefined`).
  **FAIL** = deleting `composerTarget.ts` (the backlog listed it; the architect corrected it).
  Owning artifacts: ST-2's re-pointed `composerTarget.test.ts` + `companionDispatch.test.ts`.
- [ ] **R-6 (live).** The composer never renders in a non-hosting window and never on the home
  seat — see `functional.md` Q-40/Q-41. This is an AC (R-5.4) AND a regression invariant: the
  gate must not loosen when the grounding source changes.

## Wireframe capability parity (the command bar was the ONLY pointer entry)

No component rendered `WIREFRAME_ACTIONS` before this slice (architect correction #2), so for file,
arrange, view and undo/redo the command bar was the only pointer entry. **Losing one of those rows
is a capability loss, not a cosmetic change.**

- [ ] **R-7 (live).** Every one of the 21 re-homed rows exists and works by pointer — see
  `functional.md` Q-19. A row that is present but disabled, or whose accessible name differs from
  the verbatim `WIREFRAME_ACTIONS` title, is a FAIL.
- [ ] **R-8 (live).** The insert menu keeps its FOUR groups and its `wireframe-insert` /
  `wireframe-insert-item` testids, and drops ONLY the engine-only `data-nav-verb-id` /
  `data-nav-args` attributes. A preserved `data-nav-*` attribute is a Q-1 FAIL; a
  **dropped testid** is an R-8 FAIL.
- [ ] **R-9 (live).** Canvas geometry, snap, guides and the Transformer behave unchanged; a
  property-panel field edit still commits exactly ONE history entry; `dispatch()` remains the
  regression-suite funnel; selection/view/pan/snap stay non-undoable editor state.
- [ ] **R-10 (live).** The document remains module-scoped and survives close→open (the AGENTS.md
  persistence rule) — closing and reopening the Wireframe window keeps elements, path and history.

## Durable suites that must NOT be silently deleted

- [ ] **R-11 (static).** The suites whose SUBJECT survives are re-pointed, not retired:
  `wireframeActions.test.ts` (the `wireframe.edit.undo`/`redo` rows and undo-after-group rows),
  `wireframeFileActions.test.ts`, `wireframeDraft.test.ts`, `store.dirty.test.ts`,
  `WireframeCanvas.test.tsx`, `canvasStageRegistration.test.tsx`, `pageControls.test.tsx`,
  `WireframePropertyPanel.test.tsx`, `WireframeInsertMenu.test.tsx`, `WindowTraversal.test.tsx`.
  **Expected:** each still exists and is green; a diff shows re-pointing (import swaps) not
  assertions removed. The only legitimate deletions are the surface/provider/golden-subject suites
  enumerated by ST-6 Work 4 and recorded in `RETIRED.md` (Q-5).
- [ ] **R-12 (static).** The three companion reduced-motion pins remain green AND unmodified —
  see `functional.md` Q-44.
- [ ] **R-13 (static).** `apps/ui/src/index.ts` keeps every export except the two additive
  navigation barrel lines (`:91`, `:94`). Any other export lost from the app barrel is a FAIL.

## Rust / IPC (not a party to this slice)

- [ ] **R-14 (static).** The S2 Rust command path is **gone**, not preserved: #3152 deleted
  `apps/tauri/src-tauri/src/applications/companion/` entirely (`Test-Path` → `False`; the shipped
  `applications/` listing is `db_client, doom, installed_apps, llm_server, mod.rs, pg_supervisor,
  screenshot, settings, setup, telemetry, terminal, wireframe`), so `register_app_command_surfaces`,
  `app_command_intent`, `app_command_intent_take`, `app_command_surfaces`, `app-command-intent` /
  `app-command-intent-result` and the per-application relay no longer exist and have no successor.
  **Expected:** a source scan over `apps/tauri/src-tauri/src/` returns zero occurrences of any of
  those symbols, and the companion offer is exactly the three static skills from the ZERO-argument
  `companion_skill_registry()` (`open_app`, `close_app`, `doom_mode`). A resurrected command surface
  is a FAIL. Q-7/Q-8 still prove the shipped tree compiles and lints clean. Cross-ref R-15 below:
  the row-pipeline is still not a party to this slice.
  *(Supersedes this row's earlier "is untouched and still compiles — the Rust/IPC half is S2/#3152",
  which was true only until that slice landed.)*
- [ ] **R-15 (static).** `infrastructure/comm/` and `infrastructure/rtdb/` are untouched (NFR-6,
  Q-47) — the row-pipeline is not a party to this slice.
