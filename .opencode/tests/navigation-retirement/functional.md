# navigation-retirement — Functional

Durable functional suite for the **retirement of the navigation/keyboard engine** (Issue #3151,
slice 1 of 3 — a REMOVAL programme). Rows map 1:1 to the QA Plan in
`.opencode/tmp/3151/triage.md` `## QA Expert` (`Q-1` … `Q-47`), keyed to the Software Architect's
EARS ids `R-1.1` … `R-5.4` and NFR-1 … NFR-7. Names bind verbatim to the Architect's
`### API Contracts & Data Models` block — do not invent alternative testids or ids.

> **Verification policy: MIXED, declared per row.** `static` rows (the committed absence guard,
> the build receipts, source-structure assertions, unit pins) are proved from the committed
> source + the committed gate wrappers. `live` rows are proved from a running webview. **Never**
> substitute a live screenshot for the guard, or the guard for a live chord check. The testing
> exit gate and the audit fail closed unless the `## Tests Runs` comment carries at least one
> live receipt the gate recognises (`tauri_webview_*` result, a `user-attachments` URL, or a
> `telemetry_spans` query). A static-only PASS is a FALSE PASS.

> **Gate wrappers:** every command exit code is asserted through
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"` (the sandbox forbids
> chaining, so `$LASTEXITCODE` is otherwise unreachable). The printed `EXITCODE=<n>` line is the
> receipt.

## Harness

- **Env:** `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3151 -EnvId qa3151-a -EnvSlot 1 -RequireIsolation`.
  `Restart` is forbidden (G-328) — recover with `Down` then `Up`. Driver:
  `tauri_driver_session start appIdentifier="16001"` (slot-1 MCP port as a decimal string).
- **Wireframe file seams (set when a file leg runs):** `-EnvVar "FREDO_WIREFRAME_SAVE_PATH=…"`,
  `-EnvVar "FREDO_WIREFRAME_OPEN_PATH=…"`, `-EnvVar "FREDO_WIREFRAME_EXPORT_PATH=…"`
  (`applications/wireframe/files.rs:29-33`). Leave UNSET for the native-dialog leg (Q-24).
- **Captures:** `.opencode/tmp/3151/e2e/<row>-<state>.jpeg`, uploaded with
  `pipeline-state.rs --issue 3151 --agent tester --action upload-evidence --image <path>`; the
  evidence is the resulting `user-attachments` URL in the posted comment — never the scratch file.

## AC1 / R-1 — the keyboard model is gone

- [ ] **Q-1 (R-1.1, live).** With all **8 retained applications** open — `wireframe`, `terminal`,
  `mission-monitor`, `database-client`, `settings`, `setup`, `theming`, `dev-mode` (the set
  pinned by `applications/__tests__/retainedApplicationSet.test.ts:22-31`; Dev Mode via the
  ten-stroke Konami sequence, `shared/hooks/useKonamiCode.ts:3-14`) — run ONE
  `tauri_webview_execute_js` returning the counts for the selector set, plus
  `tauri_webview_dom_snapshot` scoped to `[data-testid="wireframe-root"]`.
  **Expected:** `[data-nav-surface]`=0, `[data-testid^="navigation-"]`=0, `[data-nav-keycap]`=0,
  `[data-nav-verb-id]`=0, `[data-testid="wireframe-command-bar"]`=0, and 0 controls whose
  accessible name is exactly `Ask`. **Non-vacuity in the same pass:**
  `[data-testid="wireframe-root"]`=1 and `[data-testid="wireframe-status"]`=1.
  **Edge:** the launcher's own hint row (`LauncherChrome.tsx:355-360`) is NOT an engine keycap —
  this row is scoped to `data-nav-*` / `navigation-*` inside application roots, never a global
  `kbd` count (G-424). A second webview (`?view=terminal`).
- [ ] **Q-2 (R-1.2, live).** With the empty Wireframe canvas clicked so `document.activeElement`
  is the app root, press one at a time: `1 2 3 4 5 6 7 8 9 p k l u y n 0 h w o t`, `?`, `/`, `m`
  (`tauri_webview_keyboard action=press`). Re-read the root hooks after each.
  **Expected:** the tuple `data-wireframe-element-count`, `-selection-id`, `-selection-count`,
  `-zoom`, `-page`, `-pan-mode`, `-dirty`, `-group-count` is BYTE-IDENTICAL after every press;
  `[data-testid="fredo-companion-composer"]`=0 after `k`; the launcher notch `aria-expanded`
  stays `false` after `m`/`?`.
  **Edge:** a key pressed twice; a key pressed with an element selected; positive control — one
  POINTER insert from `wireframe-insert` DOES change the count. Repeat the sweep in Mission
  Monitor (session list unchanged).
- [ ] **Q-3 (R-1.3, static).**
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-retired.ps1"`.
  **Expected:** `EXITCODE=0`; `Scanned files` > 0 (a zero-file scan is exit 2, not a pass); the
  three token classes match Contracts §9 exactly — class A module-path tokens
  (`shared/navigation`, plus the retired hotkey-runtime directory path, whose directory no longer
  exists) scanned comment-stripped raw; class B symbol tokens
  scanned CODE-ONLY (comments AND string-literal text stripped, interpolation expressions still
  scanned as code — G-419); class C deleted-file tokens (`wireframeSurface`, `terminalSurface`,
  `missionMonitorSurface`, `databaseClientSurface`, `devModeSurface`, `windowSystemSurface`,
  `navigationDemoSurface`) scanned comment-stripped raw. `$EvidenceAllowlist = @()` is EMPTY and
  contains no product source. Root is `apps/ui/src` and nothing else.
  **Edge:** a class-B token in a comment must NOT count; a token inside a template's `${…}`
  MUST count.
- [ ] **Q-4 (R-1.3, static).**
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-retired.ps1 -SelfTest"`.
  **Expected:** `EXITCODE=0` ONLY when all three controls pass — (1) POSITIVE (every class flags
  a synthetic hit); (2) NEGATIVE (comment/prose only flags nothing); (3) SEEDED ROOT (writes
  `apps/ui/src/__nav_absence_probe__.ts`, asserts a hit at that exact path, deletes the probe,
  asserts clean again). Post-conditions: `Test-Path apps/ui/src/__nav_absence_probe__.ts` is
  `False`; a following clean run (Q-3) still returns 0.
  **Edge:** a self-test that passes without writing the probe is a SUITE DEFECT, not evidence
  (G-430) — record the three per-control output lines, never only the exit code. A leftover probe
  file is a FAIL even at exit 0.
- [ ] **Q-5 (R-1.3, static).** Read `.opencode/tests/retired-navigation/RETIRED.md`; `Test-Path`
  each of the four durable suite directories.
  **Expected:** `.opencode/tests/navigation/` (5 files incl. `coverage-map.md`),
  `.opencode/tests/navigation-fleet/` (4), `.opencode/tests/navigation-research/` (4),
  `.opencode/tests/wireframe-navigation/` (4) — 17 files — are GONE. `RETIRED.md` carries one row
  per retired path as `path | suite | retired in | reason`, covering those 17 plus ST-6's in-tree
  rows, and appends the guard invocation recipe.
  **Edge:** a path deleted but unlisted = FAIL; a listed row whose path still exists = FAIL; the
  record names `#3151` as `retired in`. Prose-only stale references in SURVIVING suites are S3's
  (#3153), explicitly out of this row's scope.
- [ ] **Q-6 (R-1.4, static).** `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui build"`.
  **Expected:** `EXITCODE=0`, zero `error TS` lines, an emitted `assets/index-*.js`.
  **Edge:** a stale `dist` is not the receipt — the run itself is; warnings alone do not fail.
- [ ] **Q-7 (R-1.4, static).** `run-exitcode.ps1 -Command "cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked"`.
  **Expected:** `EXITCODE=0`, `warning:` count = 0, `Finished` present.
- [ ] **Q-8 (R-1.4, static).** `run-exitcode.ps1 -Command "cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings"`.
  **Expected:** `EXITCODE=0`, zero `warning:`/`error:` lines. The invocation carries **no**
  `--all-targets` (RED at base — G-406).

## AC2 / R-2 — the three platform chords + their three suppression cases

- [ ] **Q-9 (R-2.1, live).** From a non-editing, non-terminal target with no modal open, press
  `primary+Space`. Read `[role="button"][aria-label="Fredo launcher"]` `aria-expanded` and the
  active element.
  **Expected:** `aria-expanded` `"false"` → `"true"`; `[role="searchbox"]` becomes active
  (`LauncherShell.tsx:778-802`). A second press while the bar has focus leaves it `"true"` (the
  shipped semantic is RAISE/SUMMON — `selectCtrlSpaceAction` has no close branch; ESC closes).
  Record the second press verbatim. **See the QA section's Discussion note on AC2's "toggles".**
  **Edge:** a maximized window covers the surface; a rapid double press; macOS reads `⌘`.
- [ ] **Q-10 (R-2.2, live).** With ≥3 windows open, note
  `[data-testid^="window-frame-"][data-focused-window="true"]`, press `primary+Tab`, re-read.
  **Expected:** focus moves exactly one step to the NEXT id in open order and that window is
  raised; exactly ONE frame is `data-focused="true"`.
  **Edge:** from the last window (wraps to first); one window only (no change, no throw); with
  the launcher overlay open (still fires — it is `role="dialog"` WITHOUT `aria-modal`).
- [ ] **Q-11 (R-2.3, live).** As Q-10 with `modifiers=["Control","Shift"]` from a non-first window.
  **Expected:** focus moves exactly one step BACKWARD (wrapping first → last), raised.
  **Edge:** alternate next/previous four times and return to the start id; two windows only.
- [ ] **Q-12 (R-2.4, live).** Focus `[data-testid="wireframe-text-content"]` (an INPUT/TEXTAREA);
  press each of the three chords.
  **Expected:** for EACH chord the launcher `aria-expanded` is unchanged, the focused-frame id is
  unchanged, and no window/launcher change occurs; the field keeps its value. Blur → press again
  → the chord fires (positive control).
  **Edge:** a `role="textbox"` control (`mm-session-search`, `SessionHistoryDrawer.tsx:292-295`);
  a `contenteditable` target. NOTE: the Wireframe panel's Escape-to-canvas branch is GONE (ST-1) —
  Escape in a panel field must NOT move focus to the canvas.
- [ ] **Q-13 (R-2.5, live).** Spawn a shell (`terminal-session-sidebar-add`), click inside the pane
  so focus is inside `[data-fredo-terminal-root="true"]` (`SessionTerminal.tsx:344`);
  `tauri_ipc_monitor action=start`; type `echo qa3151`; press each of the three chords;
  `tauri_ipc_get_captured filter=write_pty_input`.
  **Expected:** (a) a `write_pty_input` invoke with `data:"echo qa3151"` for the typed leg
  (`SessionTerminal.tsx:172-174`); (b) for EACH chord press ≥1 further `write_pty_input` invoke is
  captured AND launcher `aria-expanded` stays `false` AND the focused window id is unchanged.
  **Edge:** the terminal check is FIRST in the precedence (`focusContext.ts:73`, re-homed to
  `chordSuppression.ts`) so the hidden helper textarea cannot mask it; a second session tab.
- [ ] **Q-14 (R-2.5, live).** From Q-13's state, click the Wireframe empty canvas, then press
  `primary+Tab`.
  **Expected:** after focus leaves the terminal root the chord FIRES (focused window changes by
  one); before the click-away it did not. Click-away is the only release.
  **Edge:** click-away into a text field (still no fire); click back into the terminal
  (suppression returns immediately).
- [ ] **Q-15 (R-2.6, live).** Open a real `[role="dialog"][aria-modal="true"]` — primary:
  `[data-testid="db-destructive-confirm"]` (`DestructiveConfirm.tsx:62-65`) reached by typing a
  destructive statement into `db-query-editor` and clicking `db-query-run`; accepted alternative:
  `[data-testid="layout-delete-dialog"]` (`LayoutSettings.tsx:453-457`). Press each chord.
  **Expected:** the dialog is still present after all three (count = 1), the focused window id is
  unchanged, the launcher `aria-expanded` is unchanged, and nothing executed unbidden.
  **Edge:** the launcher overlay itself is `role="dialog"` with NO `aria-modal` — it must NOT
  suppress; `[data-testid="wireframe-new-document-dialog"]` — record whether it carries
  `aria-modal="true"`, do not FAIL on it.

## AC3 / R-3 — every application still works by pointer

- [ ] **Q-16 (R-3.1, live).** Pointer-only: click `wireframe-insert`, then each
  `wireframe-insert-item` by its visible label — Elements (7): `Text, Button, Input, Image, Icon,
  Card, Line`; Section presets (4): `Header, Nav bar, Sidebar, Footer`; Shape kinds (3):
  `Rectangle, Ellipse, Triangle`; Icons (12) — 26 items total, re-derived from
  `WireframeInsertMenu.tsx` + `model/icons.ts:18-80`.
  **Expected:** `data-wireframe-element-count` increments by exactly 1 per item (0→26) and
  `data-wireframe-selection-type` equals the inserted type after each.
  **Edge:** the same item twice (count +2, distinct ids); insert with a selection active (new
  element becomes the selection).
- [ ] **Q-17 (R-3.2, live).** Pointer-only on the canvas; read `-selection-id`, `-selection-ids`,
  `-selection-count`, `-selection-geometry`. Drags/resizes use the documented DOM `MouseEvent`
  sequence on `.konvajs-content` (a synthetic `interact` click does not deliver Konva's drag
  shape).
  **Expected:** click A then B → `-selection-id` is B exactly; shift-click C → `-selection-count`
  = 2 with the Transformer wrapping the union; drag → x/y change by ≈ (dx,dy)/scale ±2 px; handle
  swipe → `w`/`h` change per the dragged corner.
  **Edge:** empty-canvas click (selection cleared, page controls shown); overlapping pair
  (topmost wins); 1 px drag; 200 % zoom.
- [ ] **Q-18 (R-3.3, live).** Pointer-only property panel edits:
  `wireframe-text-content`, `wireframe-align-group`/`wireframe-align-*`, `wireframe-button-label`,
  `wireframe-input-placeholder`, `wireframe-card-label`, `wireframe-fill-*`,
  `wireframe-corner-radius`, `wireframe-visible-switch`, `wireframe-lock-switch`, width/height
  number fields. Document oracle = Save As through the seam.
  **Expected:** each edit observable in the SAME interaction; `visible=false` removes the ink
  while the element stays in the document (count unchanged) and the selection is not cleared.
  **Edge:** empty / 300-char text; all three appearances; max radius on a small element; a hidden
  element once deselected is not hit-testable (recovery is Undo); Escape in a panel field does NOT
  move focus to the canvas (the ST-1 deletion).
- [ ] **Q-19 (R-3.4, live).** The three new clusters (Contracts §11): `wireframe-arrange` →
  `wireframe-arrange-item`; `wireframe-file-menu` → `wireframe-file-item`;
  `wireframe-view-controls` → `wireframe-view-item`. (`wireframe-undo` / `wireframe-redo` are the
  separate history pair proved by Q-29/Q-30.)
  **Selector discipline (UI/UX §5, G-424):** all three `*-item` testids REPEAT and both menus are
  `lazyMount` (rows do not exist until opened) — assert each row by its **accessible name inside
  the opened popup** (`within(<popup>)`), and the five view rows
  `within(getByTestId('wireframe-view-controls'))`. Never a page-wide count of a repeating testid,
  never a count while a menu is closed.
  Click each row by its accessible name, verbatim from `WIREFRAME_ACTIONS`
  (`actions/wireframeActions.ts:355-603`): arrange **10** `Group, Ungroup, Lock group, Align left,
  Align centre, Align right, Distribute, Bring forward, Send backward, Snap to grid`; file **3**
  `Open, Save As, Export PNG` (UI/UX §3.4 order); view **5** `Zoom out, Zoom in, Fit page,
  Reset view, Pan tool`.
  **Expected:** all **18** rows exist, are enabled and pointer-activatable, each producing its
  declared effect — `Group` on a 2-element selection: `data-wireframe-group-count` 0→1;
  `Snap to grid` is a `role="menuitemcheckbox"` whose `aria-checked` AND `data-wireframe-snap`
  flip together on the same tick; `Zoom in` grows `-zoom` by 10 percentage points
  (`ZOOM_STEP = 0.1`, `model/geometry.ts:16`); `Reset view` → `-zoom`=`100`; `Pan tool` is a
  toggle — `aria-pressed` AND `-pan-mode` flip together; `Save As` writes at the seam and sets
  `-document-path`; `Export PNG` writes at `FREDO_WIREFRAME_EXPORT_PATH` and leaves `-dirty`
  untouched.
  **Edge:** the UI/UX §7 disabled matrix — empty selection → Group/Ungroup/Lock/Align×3/
  Distribute/Bring/Send disabled and `Snap` ENABLED; one element → Bring/Send enabled; exactly one
  whole group → Group disabled, Ungroup+Lock enabled; `Zoom out` disabled at ≤10 %, `Zoom in` at
  ≥400 % (`MIN_VIEW_SCALE`/`MAX_VIEW_SCALE`, `model/geometry.ts:13-14`); all three file rows
  disabled while `status !== 'idle'`; the triggers themselves are never disabled. Also: already
  aligned (`wireframeActions.ts:299-303`); both menu open/close paths. Owning artifact: ST-5's
  `wireframePointerControls.test.tsx` (new). **Row count is 18; the UI/UX §9 proposal to add
  `New`/`Delete`/`Duplicate` would make it 21 — see the QA section's Discussion (plan defect).**
- [ ] **Q-20 (R-3.5, live).** Terminal by pointer: `terminal-session-sidebar-add` (aria-label "Add
  session"), type, paste, then `terminal-session-kill-<id>` (aria-label `Close session <name>`).
  **Expected:** `terminal-session-row-<id>`=1, `terminal-canvas-host-<id>`=1, typing and paste
  each produce `write_pty_input` invokes, the kill removes the session. Owning artifact: ST-6's
  `terminalPrimaryControl.test.tsx` (new).
  **Edge:** spawn with a session already running; empty clipboard (no invoke, no error); close the
  last session.
- [ ] **Q-21 (R-3.5, live).** Mission Monitor: click a `[role="button"].mm-session-row`
  (`SessionHistoryDrawer.tsx:324-351`; `aria-label=<displayName>`).
  **Expected:** ≥1 `.mm-session-row` before; `[data-testid="detail-panel"]`=1 after and the row is
  selected. Owning artifact: ST-6's `missionMonitorPrimaryControl.test.tsx` (new).
  **Edge:** zero sessions (empty state, no crash); drawer collapsed then re-expanded; the
  already-selected row (no-op).
- [ ] **Q-22 (R-3.5, live).** SQL Studio: select the built-in connection
  (`db-connection-builtin-badge`), type a SELECT into `db-query-editor`, click `db-query-run`.
  **Expected:** `[data-testid="db-query-results"]` renders with `db-grid-rowcount` ≥ 0 and no
  `db-query-error`. Owning artifact: ST-6's `sqlStudioPrimaryControl.test.tsx` (new).
  **Edge:** a destructive statement → `db-destructive-confirm` (this is Q-15's modal); empty
  editor (no-op); `db-export-csv`.
- [ ] **Q-23 (R-3.5, live).** Dev Mode (Konami-only route): click `dev-mode-view-toggle`'s
  `Application Data` segment, then back to `Rows`.
  **Expected:** both segments pointer-activatable; `dev-mode-filter-input` present in `Rows`,
  absent in `Application Data` (`DevMode.tsx:518-520,677-689`); switching back restores it.
  Owning artifact: ST-6's `devModeViewSwitch.test.tsx` (new).
  **Edge:** re-select the active view (declared no-op, `DevMode.tsx:653`); a filter query active.
- [ ] **Q-24 (AC3 edge, live).** With NO seam env vars: `wireframe-file-menu` → `Save As`, then
  `Open`; then trigger `terminal-delete-session-dialog` (kill a running session) and
  `db-destructive-confirm` (a destructive statement).
  **Expected:** Save As / Open open the NATIVE OS picker (cancel → document/path/`-dirty`
  unchanged, no `wireframe-file-error`); `[data-testid="launcher-confirmation"]` count = 0 at all
  times (the seam is deleted with the engine, no requester); both app-owned dialogs reachable and
  dismissible.
  **Edge:** cancel every native dialog; a `CANCEL=1` seam run (document intact, no banner).

## AC4 / R-4 — Wireframe undo/redo is application-local

- [ ] **Q-29 (R-4.1, live).** Insert two elements and drag one; click `wireframe-undo`
  (accessible name `Undo`).
  **Expected:** one click reverts exactly the newest mutation (geometry string back to its exact
  pre-drag value, or count −1 for an insert); two mutations then one undo reverts only the LAST.
  **Edge:** undo with empty history (disabled, no-op); undo of a delete restores the same element
  id and geometry; undo → undo → redo.
- [ ] **Q-30 (R-4.2, live).** After Q-29's undo, click `wireframe-redo` (accessible name `Redo`).
  **Expected:** the re-applied state is byte-identical to the pre-undo post-state; a further click
  once the redo stack is empty is a no-op and the control is disabled.
  **Edge:** undo→redo→undo; redo after a NEW mutation (cleared); redo with an empty stack.
- [ ] **Q-31 (R-4.3, live).** 105 sequential single-step drags of one element (one `execute_js`
  `MouseEvent` loop on `.konvajs-content`, +1 page px at 100 %), then 100 clicks on
  `wireframe-undo`, then one more.
  **Expected:** after 105 edits the newest 100 are retained — the 100th undo lands on the
  POST-edit-#5 geometry (oldest 5 evicted; `WIREFRAME_HISTORY_LIMIT = 100`, re-derived from the
  shipped `UNDO_DEPTH = 100`, `wireframeDocumentStore.ts:93`); the 101st click changes NOTHING and
  the control is disabled; `wireframe-redo` is enabled after the 100th undo. Owning artifact:
  ST-3's `wireframeHistory.test.ts` (new — bounded depth beyond 100).
  **Edge:** 101 edits; exactly 100 edits; a mix of insert/drag/edit entries.
- [ ] **Q-32 (R-4.3, live).** Fresh document (or after Q-33) with zero edits.
  **Expected:** BOTH `wireframe-undo` and `wireframe-redo` report a disabled state and clicking
  either is a no-op. Owning artifacts: ST-3's `wireframeHistory.test.ts` ("empty-history flags") +
  ST-5's `WireframeHistoryControls` disabled wiring.
  **Edge:** history emptied by undoing everything; one edit re-enables only Undo.
- [ ] **Q-33 (R-4.4, live).** Build ≥3 edits; activate the control whose accessible name is
  exactly `New` (`wireframeActions.ts:586`); if the document is dirty click
  `wireframe-new-document-discard`.
  **Expected:** count=0, `-document-path`='', `-dirty`=`true`, BOTH history controls disabled. A
  second edit then undoes normally (the history instance identity never changed). Owning artifact:
  ST-3's `wireframeHistory.test.ts` ("New/Open reset").
  **Edge:** cancel the discard prompt (document AND its history intact, controls still enabled);
  New on a clean document (no prompt); New twice. **CONDITIONAL — see the QA section's Discussion
  note: Contracts §11 binds no `New` control and UI/UX §9 records that after the command bar dies
  `New` has no pointer home. If the PO/architect do not accept adding it to the File menu, this
  row is UNVERIFIED-with-a-plan-defect, never a PASS.**
- [ ] **Q-34 (R-4.4, live).** With the save seam: save a 3-element document (`Save As`); make 2
  edits; `wireframe-file-menu` → `Open` (open seam pointing at the saved file).
  **Expected:** count = 3, `-document-path` = the seam path, `-dirty`=`false`, BOTH history controls
  disabled; a later edit undoes normally. Owning artifact: ST-3's `wireframeHistory.test.ts`.
  **Edge:** Open while dirty (record the declared behaviour); a `phone`-dimension document; open
  then undo (no-op).
- [ ] **Q-35 (R-4.4 second clause, static).** (a) Q-3's guard class-A scan = 0; (b) exact-path scan of
  `apps/ui/src/applications/wireframe/**` for `createJournalStore`, `JournalStore`,
  `JournalEntry`, `JournalEntryDraft`, `appendJournalEntry`, `getNavigationJournal` (comments
  stripped) = 0 code occurrences; (c) review `undo()`/`redo()` bodies.
  **Expected:** zero code occurrences of the journal symbols in `applications/wireframe/**`;
  `undo()` consumes `history.undo()` and applies `entry.before`; `redo()` consumes
  `history.redo()` and applies `entry.after`; `getNavigationJournal` no longer exists.
  **Edge:** a `journal` mention inside a comment is not a hit.

## AC5 / R-5 — the companion still converses and grounds

- [ ] **Q-36 (R-5.1, live).** With Wireframe open and 2 elements selected
  (`data-wireframe-selection-count`=`2`), publish the composer open request from the page context
  via `tauri_webview_execute_js` calling
  `requestCompanionComposerOpen({ source: 'command-bar-ask', appId: 'wireframe', focus: true })`
  (the shipped public bridge, `shared/companion/composerBridge.ts:39` — the same call the deleted
  rail `Ask` button made); read `fredo-companion-composer` and
  `fredo-companion-composer-target`; type into `fredo-companion-composer-input`; click
  `fredo-companion-composer-submit`.
  **Expected:** composer mounts exactly once, only in the hosting window; the target chip reads
  exactly `for Wireframe` (`COMPANION_COMPOSER_TARGET_PREFIX = 'for '` + `WireframeFeature.name`);
  submitting yields a non-empty conversational reply with no error banner. No `ContextEnvelope`,
  no host registry (Q-3 class-B = 0).
  **Edge:** no app in front (chip reads `No app in front of Fredo`); empty submit (no-op, focus
  retained); a repeated open request (exactly ONE composer, `focusNonce` re-focus,
  `CompanionComposer.tsx:137-140`). **DISCLOSURE (G-410 style): the OPENER's pointer reachability
  is NOT established by this row — the rail's `Ask` was the only pointer opener and dies with the
  engine (UI/UX `## Discussion`). This row proves grounding + reply only; record that limitation
  verbatim, never as proof of pointer reachability.**
- [ ] **Q-37 (R-5.1, static).** ST-2's
  `apps/ui/src/shared/companion/__tests__/grounding.test.ts`.
  **Expected:** `readCompanionGrounding('wireframe')` returns a FRESH payload with `version`=`1`,
  `appId`=`'wireframe'`, `appName`=`'Wireframe'`, `selection.count`/`kinds`/`label`/`ids` matching
  a seeded selection with `kinds.length === ids.length === count`, and `dirty` from the store.
  Assert the fields ON the projection, never on the source store (G-418).
  `listCompanionGroundingAppIds()` returns exactly the five registered apps. Owning artifact:
  ST-2's `grounding.test.ts` (new).
  **Edge:** zero-element document; multi-select (index-aligned, document order); a disposed
  provider → `null`.
- [ ] **Q-38 (R-5.2, live).** With Wireframe in front, type `in SQL Studio, what is selected?`
  into the composer; read the target chip.
  **Expected:** the chip reads exactly `for SQL Studio` (`DatabaseClientFeature.tsx:709`) — the
  named app beats the app in front (`resolveNamedAppMention`, `composerTarget.ts:128-156`).
  **Edge:** a non-showable app (`Theming`) → not a candidate; two apps tying on the longest
  whole-word match → ambiguous → default kept; re-naming the app in front is not an override.
- [ ] **Q-39 (R-5.3, live + static).** Name an app with NO grounding source — `settings` (only
  the five apps in Contracts §5 register) — and submit; plus ST-2's `grounding.test.ts`
  `readCompanionGrounding('settings') === null` and the re-pointed `companionDispatch.test.ts`
  legacy-pair case.
  **Expected:** `null` grounding; the turn carries the ABSENT `context` key (never `null`/
  `undefined`), so `buildCompanionTurnMessages` returns the byte-identical legacy
  `[persona, user]` pair; the live reply is conversational, no error banner.
  **Edge:** an app whose source is disposed (no stale payload); an unregistered id → `null`; an
  over-cap payload (>16384 bytes) → `null` (never truncated JSON).
- [ ] **Q-40 (R-5.4, live).** Open a standalone window
  (`tauri_ipc_execute_command command=open_app_window args={"appId":"wireframe"}`,
  `infrastructure/app_window.rs:198`), publish a composer open request there, query the composer.
  **Expected:** `fredo-companion-composer` count = 0 there and no `data-composer-surface="overlay"`
  node; the overlay branch is gated on `isHosting` (`CompanionEntity.tsx:1655-1666`).
  **Edge:** two standalone windows; a request published BEFORE the window mounts; the main window
  as the positive control (Q-36: composer = 1).
- [ ] **Q-41 (R-5.4, live).** On the home desktop with the launcher engaged (home seat), publish a
  composer open request from the seat; query the composer.
  **Expected:** composer count = 0 on the home seat; only `overlay` can host it
  (`CompanionEntity.tsx:1809-1814`); the seat still renders its bubble/avatar (only the composer
  is gated).
  **Edge:** the seat→overlay teleport (after the settle exactly ONE composer opens —
  `CompanionComposer.test.tsx`'s StrictMode + non-StrictMode pair); dismiss then request again.

## Non-functional

- [ ] **Q-42 (NFR-1, static).** Exact-path read of `shared/window-system/platformChords.ts`.
  **Expected:** the dispatch body has NO `await`, `async`, `.then(`, `Promise`; `preventDefault()`
  and `stopPropagation()` precede the direct call; the dispatch calls exactly one of
  `runWindowLauncherToggle()` / `focusNextWindow()` / `focusPreviousWindow()` directly (no
  `getNavigationHost`, no verb id, no registry lookup); ONE capture-phase `document` listener
  installed by `installPlatformChords()` with a reference count. Owning artifact: ST-4's
  `platformChords.test.ts` (new).
  **Edge:** `PLATFORM_CHORDS` names the three ids with `primary:true`; `matchPlatformChord` is pure.
- [ ] **Q-43 (NFR-2, static).** ST-1's `shared/hooks/__tests__/useReducedMotion.test.ts` (new —
  re-points the retired `reducedMotion.test.tsx`) + an exact-path read of the hook.
  **Expected:** `shared/hooks/useReducedMotion.ts` exports `useReducedMotion()` +
  `REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'`; with `matchMedia` absent it returns
  `false` (fail-safe); it re-reads the CURRENT `matchMedia` per render and re-subscribes to
  `change`; the snapshot is a primitive boolean (no render loop, the #523 rule); no
  `shared/navigation` import (Q-3).
  **Edge:** a `matchMedia` replaced after mount is honoured on the next render.
- [ ] **Q-44 (NFR-2, static).** Run the three existing companion pins unmodified —
  `companion.cursorReducedMotion.test.ts`, `SpeechBubble.reducedMotion.test.tsx`,
  `ReplyScrollArea.test.tsx` (its `prefers-reduced-motion` case).
  **Expected:** all three green AND unmodified (empty diff against `main`); `companion.css:128+`
  still gates the streaming cursor; the bubble is fade-only; the scroll area is instant.
  **Edge:** `LauncherConfirmation.test.tsx` legitimately retires with the seam — its removal is
  not a loss of this NFR.
- [ ] **Q-45 (NFR-3, static).** Diff both `package.json` dependency blocks and
  `apps/tauri/src-tauri/src/runtime/command_manifest.rs` against `main`.
  **Expected:** all three diffs EMPTY (no new dependency, no new IPC; the Rust half is S2/#3152).
  **Edge:** a dependency moved between `dependencies`/`devDependencies` still shows as a change.
- [ ] **Q-46 (NFR-5, static).** Exact-path reads of `store/wireframeHistory.ts` and
  `shared/companion/grounding.ts`.
  **Expected:** `WIREFRAME_HISTORY_LIMIT = 100` (equal to the shipped `UNDO_DEPTH = 100`) and
  `COMPANION_CAPABILITY_LIMITS.maxContextBytes = 16384` (re-homed unchanged from
  `navigation/types.ts:87`); `createWireframeHistory(limit?)` drops the OLDEST past the limit.
  Owning artifacts: ST-3's `wireframeHistory.test.ts` + ST-2's `grounding.test.ts`.
  **Edge:** `createWireframeHistory(5)` honoured; the byte guard still reads 16384.
- [ ] **Q-47 (NFR-6, static).** Grep `apps/ui/src` for `shared/navigation` (Q-3) + verify
  `shared/window-system/{platformChords,chordSuppression,platformModifier}.ts` hold no companion
  import and `shared/companion/grounding.ts` holds no window-system import; diff
  `apps/tauri/src-tauri/src/infrastructure/`.
  **Expected:** no product import of `shared/navigation`; the ownership split holds; the
  RTDB/`comm` tree diff is empty.
  **Edge:** a type-only import still counts for this row.
