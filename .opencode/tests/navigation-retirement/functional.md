# navigation-retirement — Functional

Durable functional suite for the **retirement of the navigation/keyboard engine** (Issue #3151,
slice 1 of 3 — a REMOVAL programme). Rows map 1:1 to the QA Plan in
`.opencode/tmp/3151/triage.md` `## QA Expert` (`Q-1` … `Q-47`), keyed to the Software Architect's
EARS ids `R-1.1` … `R-5.5` and NFR-1 … NFR-7. Names bind verbatim to the Architect's
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

> **Recorded deferrals are legitimate; silent drops are not.** Three sub-legs are deferred with a
> stated reason because the sanctioned drivers or the isolated env cannot produce them: Q-13/Q-20's
> terminal *character-echo* leg (ghostty's canvas never emits `onData` from synthesised driver
> input), Q-20's *paste* leg (no app-level paste handler exists), and Q-24's SQL-Studio live
> destructive-confirm leg (only the read-only built-in connection is seeded; no read-write
> connection can be created). Each is reported as `DEFERRED — <reason>` with its unit pin cited —
> neither a PASS nor a silent skip. **No row is deleted.**

## Harness

- **Env:** `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3151 -EnvId qa3151-a -EnvSlot 1 -RequireIsolation`.
  `Restart` is forbidden (G-328) — recover with `Down` then `Up`. Driver:
  `tauri_driver_session start appIdentifier="16001"` (slot-1 MCP port as a decimal string).
- **Env split (binding — Q-24 and Q-34 are mutually exclusive in ONE env).** **Env A** = Wireframe
  file seams **UNSET** → runs **Q-24** (native-dialog path). **Env B** = seams **SET**
  (`-EnvVar "FREDO_WIREFRAME_SAVE_PATH=…"`, `-EnvVar "FREDO_WIREFRAME_OPEN_PATH=…"`,
  `-EnvVar "FREDO_WIREFRAME_EXPORT_PATH=…"`, `applications/wireframe/files.rs:29-33`) → runs
  **Q-34**. Rationale: the seam precedence `CANCEL > FAIL_FILE > path seams > shared fallback >
  native dialog` (`files.rs:74-84`) is precedence-ordered, so the two legs cannot both hold at once.
- **Mission Monitor session lever (Q-21):** `fredo emit`
  (`.opencode/skills/fredo-cli-events/SKILL.md:10,23`; recipe `:117-123`; dev-environment
  `SKILL.md:435` MANDATES it for mission-monitor specs). Target the isolated env's pipe via
  `FREDO_CLI_PIPE` / `FREDO_ENV_ID` (`SKILL.md:35-44`). Seed two **chat-init** events with distinct
  session ids and distinct providers (`--provider open_code --session-id qa3151-mm-a
  --correlation-id qa3151-mm-a_1`; `--provider copilot_cli --session-id qa3151-mm-b`).
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
- [ ] **Q-13 (R-2.5, live).** Spawn a shell (`terminal-session-sidebar-add` → confirm the New-session
  dialog), pointer-click inside the pane so focus is inside `[data-fredo-terminal-root="true"]`
  (`SessionTerminal.tsx:340-344`); `tauri_ipc_monitor action=start`; then run ONE
  `tauri_webview_execute_js` that (1) asserts
  `document.activeElement?.closest('[data-fredo-terminal-root="true"]') !== null`; (2) for EACH
  of the three chords dispatches a chord-shaped keydown AT that focused element —
  `new KeyboardEvent('keydown',{key:'Tab',ctrlKey:true,bubbles:true,cancelable:true})` plus the
  `Space` and `shift+Tab` variants — reads `defaultPrevented`, and checks a bubbling listener
  attached INSIDE the root RECEIVED the event; (3) re-reads the launcher notch `aria-expanded`
  and the focused-window id after all three. Then
  `tauri_ipc_get_captured filter=write_pty_input`.
  **Expected:** (1) focus is inside the root; (2) for EACH chord `defaultPrevented` is **`false`**
  (SUPPRESSED — not intercepted) AND the in-root bubbling listener **received** the event (the
  keystroke still reaches the terminal's own consumer); (3) after all three the launcher
  `aria-expanded` and the focused-window id are UNCHANGED; (4) **PTY reachability receipt —
  corroboration ONLY:** one `write_pty_input` invoke issued through the sanctioned
  `__TAURI__.core.invoke` path is captured; the input chain is `SessionTerminal.tsx:172-174`
  (`term.onData → write_pty_input`).
  **Edge:** **the character-echo leg is NOT drivable** — ghostty's canvas never emits `onData`
  from synthesised driver input (`tauri_webview_keyboard action=type` updates the DOM `value` and
  produces zero `write_pty_input`), a documented limitation; the suppression and non-interception
  obligations are proven directly, PTY deliverability by the invoke receipt plus the cited input
  chain. `terminal` is FIRST in the precedence (`chordSuppression.ts:91-100`) so the hidden helper
  textarea cannot mask it; a second session tab.
- [ ] **Q-14 (R-2.5, live).** From Q-13's guided state: (1) pointer-click a control OUTSIDE the
  terminal root but inside the same webview — a session row in
  `[data-testid="terminal-session-sidebar"]` (**avoid `terminal-session-sidebar-add`** — it opens
  a dialog); (2) read `document.activeElement?.closest('[data-fredo-terminal-root="true"]')`;
  (3) press `primary+Tab`, re-read the focused-window id; (4) pointer-click back into the pane,
  confirm focus inside the root, press `primary+Tab`, re-read.
  **Expected:** after the out-of-root pointer click the `closest(...)` is **`null`** and
  `primary+Tab` **fires** (the focused-window id changes by exactly one); after clicking back into
  the pane focus is inside the root again and `primary+Tab` leaves the id **unchanged** —
  suppression returns immediately, no reload needed.
  **Edge:** AC2's release is *"click-away / focus-change"* — a pointer-driven focus change is
  within the AC and is drivable; a pointer click landing physically OUTSIDE the focused window is
  not (all windows render maximized at identical rects with z-index 1). Click-away into a text
  field → still no fire.
- [ ] **Q-15 (R-2.6, live).** Primary lever, by pointer: Settings → Layout
  (`[data-testid="settings-nav-layout"]`) → `[data-testid="layout-new-button"]` → a template preset
  `[data-testid="layout-template-columns"]` (**required**: `layout-editor-confirm` is `disabled`
  while `zones.length === 0`, `ZoneLayoutEditor.tsx:455`) → `[data-testid="layout-editor-confirm"]`
  (save a layout) → `[data-testid="layout-delete-<id>"]` (`LayoutSettings.tsx:425`; dialog
  `:451-463`, `role="alertdialog" aria-modal="true"`). Press each chord.
  **Expected (after the predicate widening — `chordSuppression.ts:29` also matches
  `[role="alertdialog"][aria-modal="true"]`):** after EACH of the three presses the dialog is still
  present (`layout-delete-dialog` count = 1), the focused-window id is unchanged, the launcher
  `aria-expanded` is unchanged, and nothing was deleted (the layout is still in
  `[data-testid="layout-list-item-<id>"]`).
  **Edge:** `[data-testid="db-destructive-confirm"]` is DROPPED as the primary lever — the only
  seeded connection is the built-in **read-only** `Fredo` connection
  (`db_client/query.rs:112-127` refuses a destructive statement before any confirmation) and a
  read-write connection cannot be created (the embedded-cluster password is OS-keychain-only), so
  its live leg is not drivable; it remains a corroborating STATIC citation of the other
  `aria-modal="true"` surface (`DestructiveConfirm.tsx:62-65`). The launcher overlay itself is
  `role="dialog"` with NO `aria-modal` — it must NOT suppress (positive control, Q-10's third
  edge).

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
  (`actions/wireframeActions.ts:355-603`): arrange **12**, in five `Menu.ItemGroup` sections —
  **Element** `Delete, Duplicate` (FIRST group; both disabled on an empty selection), **Group**
  `Group, Ungroup, Lock group`; **Align** `Align left, Align centre, Align right, Distribute`;
  **Order** `Bring forward, Send backward`; **Snap** `Snap to grid`; file **4** — `New` (the
  FIRST row, never disabled), then `Open, Save As, Export PNG` (UI/UX §3.4 order); view **5**
  `Zoom out, Zoom in, Fit page, Reset view, Pan tool`.
  **Expected:** all **21** rows exist, are enabled and pointer-activatable, each producing its
  declared effect — `Group` on a 2-element selection: `data-wireframe-group-count` 0→1;
  `Snap to grid` is a `role="menuitemcheckbox"` whose `aria-checked` AND `data-wireframe-snap`
  flip together on the same tick; `Zoom in` grows `-zoom` by 10 percentage points
  (`ZOOM_STEP = 0.1`, `model/geometry.ts:16`); `Reset view` → `-zoom`=`100`; `Pan tool` is a
  toggle — `aria-pressed` AND `-pan-mode` flip together; `Save As` writes at the seam and sets
  `-document-path`; `Export PNG` writes at `FREDO_WIREFRAME_EXPORT_PATH` and leaves `-dirty`
  untouched. `Delete` on a selected element decrements the element count by 1; `Duplicate`
  increments it by 1 with a NEW element id; `New` exists, is enabled (never disabled) and on a
  dirty document opens `wireframe-new-document-dialog` (the reset itself is Q-33's).
  **Edge:** the UI/UX §7 disabled matrix — empty selection → `Delete`/`Duplicate`/Group/Ungroup/
  Lock/Align×3/Distribute/Bring/Send disabled and `Snap` ENABLED; one element → Bring/Send
  enabled; exactly one whole group → Group disabled, Ungroup+Lock enabled; `Zoom out` disabled at
  ≤10 %, `Zoom in` at ≥400 % (`MIN_VIEW_SCALE`/`MAX_VIEW_SCALE`, `model/geometry.ts:13-14`);
  Open/Save As/Export PNG disabled while `status !== 'idle'` (New is NEVER disabled); the
  triggers themselves are never disabled. Also: already aligned (`wireframeActions.ts:299-303`);
  both menu open/close paths. Owning artifact: ST-5's `wireframePointerControls.test.tsx` (new).
  **The row count is 21 in the three clusters (12 arrange + 4 file + 5 view), totalling 23
  pointer-reachable controls with the two separately-testid'd history controls
  (`wireframe-undo`, `wireframe-redo`).**
- [ ] **Q-20 (R-3.5, live).** Terminal by pointer — spawn and close are LIVE; type is Q-13's
  limbs; paste is DEFERRED. Spawn: `terminal-session-sidebar-add` (aria-label "Add session") →
  confirm the New-session dialog. Close: `terminal-session-kill-<id>` (aria-label
  `Close session <name>`). Type: Q-13's limbs 1, 2 and 4. Paste: see the edge.
  **Expected:** `terminal-session-row-<id>`=1 AND `terminal-canvas-host-<id>`=1 after spawn; the
  kill removes the session (row count returns to the prior value) and `close_terminal_session` is
  invoked; typing obligations are Q-13's. No keyboard navigation is needed anywhere. Owning
  artifact: ST-6's `terminalPrimaryControl.test.tsx` (`:118-157` spawn → `write_pty_input` →
  close; `:148` pins the `write_pty_input` call).
  **Edge:** **paste is DEFERRED, not dropped** — there is no app-level paste handler (the only
  clipboard write in the app is `TerminalWindow.tsx:425`, a *copy* of the copilot auth command), so
  paste is ghostty's own and cannot be driven by the sanctioned driver; recorded with that reason.
  Also: spawn with a session already running; close the last session.
- [ ] **Q-21 (R-3.5, live).** Seed the list with the sanctioned `fredo emit` lever — two **chat-init**
  events with distinct session ids and distinct providers into the target env's pipe
  (`FREDO_CLI_PIPE` / `FREDO_ENV_ID`, `fredo-cli-events/SKILL.md:35-44`: `--provider open_code
  --session-id qa3151-mm-a --correlation-id qa3151-mm-a_1` and `--provider copilot_cli
  --session-id qa3151-mm-b`). Then, with Mission Monitor open: **leg 1** locate ≥2 `.mm-session-row`
  by `aria-label` matching the seeded user text (`SessionHistoryDrawer.tsx:324-351`); **leg 2**
  pointer-click the row whose `aria-label` matches session **B**, compare
  `[data-testid="mm-selected-cli-label"]`'s `data-provider` with the `data-provider` of THAT ROW's
  own `[data-testid="mm-session-cli-label"]` (scoped `within(rowB)` — that testid REPEATS per row,
  never a page-wide read; `CliLabel.tsx:112-122`); **leg 3** double-click a
  chat node on the canvas → `[data-testid="detail-panel"]`.
  **Expected:** leg 1 — ≥2 rows, each identified by its own `aria-label` (the list source is the
  declared `sessions` rollup table, `lib/dataDeclaration.ts:40-68`, `kind: 'sessionRollup'`,
  materialised from canonical chat rows). Leg 2 — the two `data-provider` attributes are EQUAL
  (compare them to each other, never a hard-coded token) AND the chip's value CHANGED from the
  pre-click value (auto-select picks the newest, so start on the other row); this proves the drawer
  row is the session-selection control. Leg 3 — `detail-panel`=1; this proves the detail control.
  **A single click on a row does NOT open `detail-panel`** — it calls `selectSession`;
  `detail-panel` is opened only by a canvas node double-click, which is shipped behaviour, not a
  defect. If leg 3 cannot be reached, record the row as *half proven* naming
  `missionMonitorPrimaryControl.test.tsx:134-167` and the reason — never delete the row.
  Corroborating green unit pin: `missionMonitorPrimaryControl.test.tsx:134-167`.
  **Edge:** zero sessions (empty state, no crash); the drawer collapsed then re-expanded; the
  already-selected row (no-op); a sibling env's emit must not appear (env-scoped pipe).
- [ ] **Q-22 (R-3.5, live).** SQL Studio: select the built-in connection
  (`db-connection-builtin-badge`), type a SELECT into `db-query-editor`, click `db-query-run`.
  **Expected:** `[data-testid="db-query-results"]` renders with `db-grid-rowcount` ≥ 0 and no
  `db-query-error`. Owning artifact: ST-6's `sqlStudioPrimaryControl.test.tsx` (new).
  **Edge:** a destructive statement is REFUSED before any confirmation on the read-only built-in
  connection (`db_client/query.rs:112-127`) — record the refusal and do NOT treat it as a missing
  confirm (that surface is Q-15's corroborating static citation); empty editor (no-op);
  `db-export-csv`.
- [ ] **Q-23 (R-3.5, live).** Dev Mode (Konami-only route): click `dev-mode-view-toggle`'s
  `Application Data` segment, then back to `Rows`.
  **Expected:** both segments pointer-activatable; `dev-mode-filter-input` present in `Rows`,
  absent in `Application Data` (`DevMode.tsx:518-520,677-689`); switching back restores it.
  Owning artifact: ST-6's `devModeViewSwitch.test.tsx` (new).
  **Edge:** re-select the active view (declared no-op, `DevMode.tsx:653`); a filter query active.
- [ ] **Q-24 (AC3 edge, live + static — Env A: file seams UNSET).** (1) With the File menu open,
  pointer-click `wireframe-file-menu` rows `Save As` then `Open`, asserting at every step. (2) Spawn
  a shell and close it so a persisted record exists, select it, pointer-click **Delete** on the
  record surface (`TerminalPane.tsx:253,260` → `handleDeleteRequest`); assert
  `[data-testid="terminal-delete-session-dialog"]`=1, then Cancel. (3) Static: read
  `applications/wireframe/commands.rs:29-35,42-81` + `files.rs:75-96`.
  **Expected:** (1) `[data-testid="launcher-confirmation"]` count = **0** at every step, no
  `wireframe-file-error` appears, and `data-wireframe-document-path` / `data-wireframe-dirty` are
  UNCHANGED (the cancel path leaves the document intact) — the AC's actual clause *"confirmations
  have no requester"*. (2) `terminal-delete-session-dialog`=1 then gone after Cancel (this also
  REMOVES the "fresh env has no record" blocker by creating the record first). (3) With no seam
  set, `seam_short_circuit()` → `files::env_path()` returns `None` → the native
  `save_dialog`/`open_dialog` is called (`commands.rs:91-95` + `:42-64`): the native OS picker is
  the only fallback; a file command's fallback branch is SOURCE, not runtime, so this sub-leg is
  `static`.
  **Edge:** **SQL Studio's destructive-confirm live leg is a RECORDED DEFERRAL, not drivable** —
  the only seeded connection is the built-in **read-only** `Fredo` connection
  (`db_client/query.rs:112-127` refuses a destructive statement before any confirmation) and a
  read-write connection cannot be created (the embedded-cluster password is OS-keychain-only); cite
  `DestructiveConfirm.test.tsx:32-44` + `sqlStudioPrimaryControl.test.tsx` as the unit pins —
  never PASS, never silently dropped. **(Env split, binding: Q-24 runs in Env A with the Wireframe
  file seams UNSET; Q-34 runs in Env B with them SET — the precedence `CANCEL > FAIL_FILE > path
  seams > shared fallback > native dialog` (`files.rs:74-84`) makes the two legs mutually
  exclusive in ONE env.)**

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
- [ ] **Q-33 (R-4.4, live).** Build ≥3 edits; open `wireframe-file-menu` and click the row INSIDE
  the opened popup whose accessible name is exactly `New` — the FIRST `wireframe-file-item` row,
  the `WIREFRAME_ACTIONS` title verbatim (`wireframeActions.ts:584-592`, verb
  `wireframe.document.new`; `WireframeFileMenu.tsx:100-107`); if the document is dirty click
  `wireframe-new-document-discard`.
  **Expected:** count=0, `-document-path`='', `-dirty`=`true`, BOTH history controls disabled. A
  second edit then undoes normally (the history instance identity never changed). Owning artifact:
  ST-3's `wireframeHistory.test.ts` ("New/Open reset").
  **Edge:** cancel the discard prompt (document AND its history intact, controls still enabled);
  New on a clean document (no prompt); New twice. **not conditional** — the File menu's first
  `wireframe-file-item` row is `New` (never disabled) and is the pointer home for the reset
  (`WireframeFileMenu.tsx:100-107`; `runWireframeAction('wireframe.document.new')` →
  `resetForNewDocument`).
- [ ] **Q-34 (R-4.4, live — Env B: the save/open/export seams SET).** Save a 3-element document
  (`Save As`, writing at `FREDO_WIREFRAME_SAVE_PATH`); make 2 edits; `wireframe-file-menu` → `Open`
  (`FREDO_WIREFRAME_OPEN_PATH` pointing at the saved file).
  **Expected:** count = 3, `-document-path` = the seam path, `-dirty`=`false`, BOTH history controls
  disabled; a later edit undoes normally. Owning artifact: ST-3's `wireframeHistory.test.ts`.
  **Edge:** Open while dirty (record the declared behaviour); a `phone`-dimension document; open
  then undo (no-op). **Env split (binding): the seams belong to Env B alone — Q-24 runs in Env A
  with them UNSET.**
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

- [ ] **Q-36 (R-5.1, R-5.5, live).** With Wireframe open, 2 elements selected
  (`data-wireframe-selection-count`=`2`) and the TicTacToe bubble CLOSED (shipped default):
  **click the companion avatar ONCE** — locator `.fredo-companion-avatar`
  (`CompanionEntity.tsx:1833-1853`) disambiguated by its `aria-label` (**no testid exists on the
  avatar and none was invented**). The click runs `handleSpriteClick`'s single-click branch →
  `openComposer()` in addition to `askForJoke()`. Then read `fredo-companion-composer`,
  `fredo-companion-composer-target`; type into `fredo-companion-composer-input`; click
  `fredo-companion-composer-submit`.
  **Expected:** composer mounts EXACTLY once, only in the hosting window; the target chip reads
  exactly `for Wireframe` (`COMPANION_COMPOSER_TARGET_PREFIX = 'for '` + `WireframeFeature.name`);
  the pre-existing joke observable is still produced (asserted as present, never as absent);
  submitting yields a non-empty conversational reply with no error banner. No `ContextEnvelope`,
  no host registry (Q-3 class-B = 0).
  **Edge:** no app in front (chip reads `No app in front of Fredo`); empty submit (no-op, focus
  retained); a repeated open request (exactly ONE composer, `focusNonce` re-focus,
  `CompanionComposer.tsx:137-140`); a DOUBLE click still only toggles the TicTacToe bubble and opens
  no composer. **TIMER DISCIPLINE:** the single-click path is armed by a ~250 ms `setTimeout`, so
  an immediate re-read finds 0 composers and is a FALSE FAIL — wait for the node or advance timers.
  **SURFACE DISCIPLINE:** assert `data-composer-surface="overlay"`; the home seat can never render
  it (Q-41). The `requestCompanionComposerOpen` bridge (`composerBridge.ts:39`) is a
  **corroborating/diagnostic** lever only (if the pointer click fails to open the box, publish the
  request to prove the gate works) — never the row's mechanism.
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
  `infrastructure/app_window.rs:198`). **Leg A:** publish NOTHING; query the composer in that
  window. **Leg B:** publish a composer open request there (`tauri_webview_execute_js` calling the
  bridge), query again, then dismiss and re-query.
  **Expected:** **Leg A (at rest — the AC's requirement):** `fredo-companion-composer` count = **0**
  AND `data-composer-surface` count = **0**. **Leg B (summon — documented shipped semantics, NOT a
  violation):** the count becomes **1** with `data-composer-surface="overlay"` (Fredo teleported
  into that webview), then after dismissing it re-asserts **0**. Overlay gate
  `CompanionEntity.tsx:1681-1683`; composer render gate `:1833`.
  **Edge:** two standalone windows; a request published BEFORE the window mounts; the main window
  as the positive control (Q-36: composer = 1). **A published request in a standalone window
  correctly produces 1, NOT 0** — a teleport makes that webview the host; treating 1 as a FAIL
  would contradict the shipped summon semantics.
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
