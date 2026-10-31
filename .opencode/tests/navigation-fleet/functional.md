# navigation-fleet — Functional

Feature: **NavigationEngine P7 fleet migration (Spec #3121)** — the FIVE in-scope surfaces
(terminal, window traversal, mission-monitor, SQL Studio `database-client`, dev-mode) re-homed onto
declared `Surface` trees resolved by the shared engine. Behaviour-preserving: no key is re-tuned, no
capability added, no layout redesigned. Diagram, Optimizely, My Work Items and Create Work Item are
REMOVED from this phase (frozen until #3122) and have no cases here.

This file is the executable checklist for the QA Plan in `.opencode/tmp/3121/triage.md`
`## QA Expert`. Case ids `F-1..F-30` map 1:1 to EARS clauses R-01…R-24 + N-1…N-5. The plan is the
source of truth for expected values; this file is how the Tester works it.

> **Verification policy: live.** Rows tagged `[live]` require a receipt from the running desktop
> app (`pnpm dev:tauri` + shipped `tauri_driver_session`): `tauri_webview_dom_snapshot`,
> `tauri_webview_find_element`, `tauri_webview_screenshot`, `tauri_webview_keyboard`,
> `tauri_read_logs`, `tauri_ipc_monitor`, or a PTY echo. Rows tagged `[static]` require a committed
> test exit (`pnpm --filter @fredo/ui test:run …`) or a source read on the spec branch. No
> `telemetry_spans` receipt applies (the navigation layer emits no telemetry).
>
> **Premise resolutions are binding.** D-1 (launcher context = `describeContext(appId)` registry /
> composer seam — acknowledged, no palette), D-2/D-2a (NO exit chord — focus change exits; `Escape`
> reaches the PTY), D-3(a) (the three window chords stay kept globals delegating to declared verbs),
> D-3(b)/(c) (SQL `Ctrl/Cmd+Enter` and terminal `F2` stay on their controls and map to declared
> verbs), D-4 (AC7 is a per-surface scan with a frozen-path allowlist — no test is relocated), D-8
> (SQL "result rows" = the active result set), corrected terminal inventory (`copyAuthCommand` is
> the only copy verb).
>
> **Rail root attribute:** the emitted value is `data-nav-surface="bar"` (`CommandRail.tsx:309`),
> never `"rail"` (the constant's header comment is stale; the code is binding). The map is
> `data-nav-surface="map"`, the trail `data-nav-surface="trail"`.

## Preconditions

- The `spec/3121` tree is checked out; `pnpm --filter @fredo/ui test:run` and
  `pnpm --filter @fredo/ui build` are runnable.
- Commands, from the repo root:
  ```text
  pnpm --filter @fredo/ui test:run
  pnpm --filter @fredo/ui test:run src/applications/__tests__/navigationParityMatrix
  pnpm --filter @fredo/ui test:run src/applications/__tests__/navigationBindingsCompleteness
  pnpm --filter @fredo/ui test:run src/shared/hotkeys/__tests__/featureHotkeyKeys
  pnpm --filter @fredo/ui test:run src/applications/terminal
  pnpm --filter @fredo/ui test:run src/applications/mission-monitor
  pnpm --filter @fredo/ui test:run src/applications/database-client
  pnpm --filter @fredo/ui test:run src/applications/dev-mode
  pnpm --filter @fredo/ui test:run src/shared/window-system
  pnpm --filter @fredo/ui test:run src/shared/hotkeys
  pnpm --filter @fredo/ui build
  ```
- Key gate (live): press keys only when `document.activeElement` is `document.body`/the app root or
  a rail row focused on purpose. A focused text control suppresses every stroke — correct, not a
  failure.
- Rail/map testids are the shipped P4/P6 bindings (`navigation-bar*`, `navigation-map*`,
  `navigation-trail*`, `data-nav-*`), never a new name.

## Surface reachability (read this before any live leg)

| Surface | `appId` | Live lever (traced on this branch) | Class |
|---|---|---|---|
| Terminal | `terminal` | `?view=terminal` webview route (`Router.tsx:21-23`) or the launcher tile; `spawn_terminal_session{cli:"shell"}` | live |
| Window traversal | `window-system` | main Home window with ≥2 windows | live |
| Mission Monitor | `mission-monitor` | launcher tile (`Home.tsx:34` `SHOWABLE_FEATURES`) | live |
| SQL Studio | `database-client` | launcher tile (`DatabaseClientFeature.tsx:582` `showable=true`) or `?view=app&id=database-client` (`Router.tsx:32-34` → `StandaloneAppWindow.tsx:60-67`) | live |
| Dev Mode | `dev-mode` | Konami **10 keys**: `ArrowUp ArrowUp ArrowDown ArrowDown ArrowLeft ArrowRight ArrowLeft ArrowRight b a` (lowercase `b`/`a`, no modifier — `shared/hooks/useKonamiCode.ts:3-14`) on Home (`Home.tsx:69-77`) | live |

**No named blocker in this phase.** Every in-scope surface has a shipped live lever. The three
removed apps (diagram / optimizely / my-workitems) are not tested at all — their `data-hotkey`
bindings stay frozen until #3122 deletes them.

## Cases

- [ ] **F-1 (R-01) `[static]` — five-surface `validateSurface()` gate.**
  Run the parity suite. **Expected:** each of the five declarations returns
  `toStrictEqual({valid:true, diagnostics:[]})`; appIds exactly `terminal, window-system,
  mission-monitor, database-client, dev-mode`; roots exactly `terminal.window`,
  `window-system.root`, `mission-monitor.sessions`, `sql-studio.workspace`, `dev-mode.events`;
  every non-root place sets exactly one of `transient`/`sticky`; `app.map` is `publish:false` with
  no key in all five; verb-id sets equal B.5 (12/4/6/20/7, including the D-9 place verbs).
  **Edge:** negative control with a duplicated stroke → `valid:false`, exactly one `V-07`/`NAV-E007`;
  removed root → `V-02`/`NAV-E002`; five distinct object identities (a gate validating one object
  five times is vacuous); a sixth (removed-app) id in the registry → FAIL.
  **Files:** `applications/__tests__/navigationParityMatrix.test.ts` (ST-6).

- [ ] **F-2 (R-02) `[live]`+`[static]` — strokes resolve through the shared engine.**
  Live per app: press the declared key at the app root. **Expected:** the B.6 outcome occurs and the
  newest journal entry carries the declared `verbId` + `channel:"keyboard"`. Static: the five
  providers/adapters reference no `data-hotkey`, `hotkeyElements`, `detectDuplicateHotkeys`,
  `commandSurfaceStore` or `executeCommand`; `host.handleStroke` is the only resolution call.
  **Edge:** child-place key pressed at the root (no fall-through); text-entry focused (`null`, no
  `preventDefault`); uppercase `D` normalises to `d`; unbound stroke does nothing and journals
  nothing.

- [ ] **F-3 (R-03) `[live]`+`[static]` — every legacy binding keeps its outcome (B.6; 5 element keys
  + `F2` + detail `Escape` + SQL chord; the 3 globals are F-20).**
  **Expected:** mission-monitor `s` → focus `[data-testid="mm-session-search"]` (drawer expanded by
  default); dev-mode `x` → buffer clears in BOTH views, `v` → Application Data + cursor enters
  `dev-mode.applicationData`, `i` → focus `[data-testid="dev-mode-filter-input"]` (rows view), `b` →
  all states active (`dev-mode-show-all-states` unmounts); terminal `F2` on a focused renamable row
  → inline rename editor (same `canRename` guard; `noop` when the selected session has no persisted
  record); SQL `Ctrl/Cmd+Enter` → the F-30 outcome; Mission Monitor `Escape` with the detail panel
  open → the panel closes (or an in-progress drag cancels first).
  **Edge:** key pressed twice; `x` in the app-data view (still clears); collapsed drawer (`s`
  inert); no persisted record (`F2` noop); autocomplete open (`Enter` accepts, never runs).

- [ ] **F-4 (R-04) `[static]` — an absent control yields no observable change.**
  **Expected:** dispatch is `noop` at most — journal length unchanged, no announcement, no new state,
  no toast, no dialog. Cases: dev-mode `b` when already all active; dev-mode `x` with zero events;
  mission-monitor `s` with the drawer collapsed; dev-mode `i`/`b` in the Application Data view; SQL
  `results.loadMore` with `!hasMore`; SQL `history.clear` with empty history.
  **Edge:** render the control afterwards → it acts; `x` in the app-data view is NOT inert; a `noop`
  never appears in the ActivityTrail. Availability absence is F-11, not a noop row.

- [ ] **F-5 (R-05) `[live]` — terminal passthrough swallows nothing.**
  Spawn a PTY (`spawn_terminal_session{cli:"shell"}`) and focus `[data-fredo-terminal-root="true"]`.
  **Expected:** `document.body[data-fredo-passthrough="true"]`; `echo P7-PASSTHROUGH` echoes; every
  bare key bound in the migrated fleet (`s x v i b`) and the map glyph stroke `m` reaches the PTY and
  fires NO app verb (no map, no dialog, no journal entry); `handleStroke` returns `null`; committed
  jsdom pin asserts the keydown's `defaultPrevented === false` (no `preventDefault`/`stopPropagation`).
  **Edge:** `Ctrl+C` reaches the shell; arrow keys move history; `Tab` completes; IME composition;
  kept globals record their pre-change behaviour; no `await`/IPC/state write before the PTY write.

- [ ] **F-6 (R-06) `[live]` — focus change is the exit, exactly one pop.**
  Click `[data-testid="terminal-session-sidebar"]` (or another window), then return. **Expected:**
  `data-fredo-passthrough` clears;
  `describeContext('terminal').placePath.map((p) => p.id)` equals `["terminal.window"]` (each ref's
  `label`/`transient`/`sticky` matches the declaration — `placePath` is a `PlaceRef[]`);
  exactly ONE `place.exit` journal entry; `terminal.session.new` opens the dialog with accessible
  name `New session` (the same dialog `terminal-session-sidebar-add` opens).
  **Edge:** window blur then return = one pop + one enter; focus-out then immediate focus-in; a rail
  verb click ends passthrough first.

- [ ] **F-7 (R-07) `[live]`+`[static]` — the place projection tells the truth about key ownership.**
  **Expected:** at `terminal.session`, breadcrumb `data-nav-place-id` sequence
  `terminal.window,terminal.session` (last segment = `navigation-bar-place`), `navigation-bar-row`
  count **0**, empty copy `No actions in this place`. At `terminal.window`, `navigation-bar-row` count
  **0** while the map (`navigation-bar-map`) lists every declared terminal action verb that
  `appliesTo` `terminal.window` — at minimum `terminal.session.new`, `.close`, `.rename`, `.resume`,
  `.startFresh`, `.retry`, `.chooseDirectory`, `.deleteRecord`, `.copyAuthCommand` — each with
  `data-nav-availability` from `selection.count`; `.copyAuthCommand` copies the auth command (the
  ONLY copy action).
  **Edge:** map activation ends passthrough first; a rail row appearing at `terminal.session` is a
  FAIL; `terminal.session.enter` is the place entry and `app.map` the map affordance (both
  `publish:false`, never companion rows); the map is `appliesTo`-driven without a `publish` filter,
  so assert presence, not a raw map row count.

- [ ] **F-8 (R-08) `[static]`+`[live]` — every app mounts the three surfaces over its own
  declaration.**
  **Expected:** `[data-nav-surface="bar"]` and `[data-nav-surface="trail"]` present at mount;
  `[data-nav-surface="map"]` present when the map is open; breadcrumb `data-nav-place-id` sequence
  equals `describeContext(appId).placePath.map((p) => p.id)`; map blocks equal the declared tree in tree order (4 for
  SQL Studio); trail is newest-first. Root **verb-row** counts (`navigation-bar-row`, excluding the
  separate `navigation-rail-place-row` group): mission-monitor 1 (`s`), dev-mode 4 (`x i b v`),
  terminal 0, window-system 0, SQL Studio 0 at all four places; `dev-mode.applicationData` **2**
  (`x` and `v`, both bound there by B.3); `app.map` is a footer affordance, never a row.
  **Edge:** unmounted app → no nodes, `describeContext` null; window-system mounts ONCE (3 windows →
  1 rail); a 0-bound place renders 0 rows and is not padded; a 1-row `dev-mode.applicationData`
  means the declared `v` binding was dropped (FAIL).

- [ ] **F-9 (R-09) `[static]` — `describeContext(appId)` per app; `null` when unmounted.**
  **Expected:** `appId` matches; `placePath` is a `PlaceRef[]` root→current whose `id`s equal the
  snapshot path and whose `label`/`transient`/`sticky` equal the declaration (unknown ids dropped);
  `verbs.length ≤ 64` and its ids equal EVERY declared verb id of that surface in declaration order
  (`buildVerbSummaries` does not filter `publish`), each with `keys`/`risk`/`available` from the
  shipped predicate; `selection` (`count/kinds/label/ids`) and `dirty` match the app's injected
  context; unknown/unmounted app → `describeContext === null`, `getRegisteredSurface === null`.
  **Edge:** register then dispose; two apps registered → two disjoint envelopes; a pure selection
  change yields a fresh envelope (never cached); none of the five hits the 64-verb cap; SQL Studio's
  envelope carries its 20 ids including the 3 D-9 place verbs.

- [ ] **F-10 (R-10) `[static]`+`[live]` — per-app context, never a global list (D-1 acknowledged).**
  **Expected:** `getRegisteredSurface(appId)` returns exactly that app's declaration;
  `describeContext(appId).verbs` contains only that app's ids (all 25 app/verb-id pairs checked);
  `listRegisteredSurfaces()` = five distinct appIds; composer grounding relays through the target
  app's `runIntent` (`channel:"agent"`, `actor:"companion"`). No launcher palette is reintroduced.
  **Edge:** no app mounted → null + unchanged launcher DOM; explicit app mention overrides
  foreground; two apps sharing a verb title still expose disjoint id sets.

- [ ] **F-11 (R-11) `[static]` — selection-scoped verb unavailable with no selection.**
  **Expected:** the verb's rendered **NavigationMap** row is `data-nav-availability="disabled"` with
  reason `Not available for the current selection`; dispatch `{status:'rejected',
  code:'unavailable'}`; journal unchanged; `available(ctx)` reads only `ctx`. The phase's
  selection-scoped verbs are unbound, so the map is the AC5 surface (D-UI-2 / G-UIUX-2). Covered:
  terminal session verbs (`count ≥ 1`); mission-monitor `session.delete` + `detail.close`
  (`count ≥ 1`); SQL `connection.edit`/`.delete`/`.disconnect` + `history.clear` (`kinds` ∋
  `connection`), `schema.viewColumns`/`.openData`/`.newQuery` (`kinds` ∋ `table`),
  `results.loadMore`/`.exportCsv`/`.exportJson` (`kinds` ∋ `resultSet`); dev-mode `events.clear`
  (`kinds` ∋ `panel`), `search.focus`/`states.all` (`panel ids` ∋ `rows`), `view.rows` (`panel ids` ∋
  `application-data`).
  **Edge:** wrong selection kind does not enable; `count>0` enables; disabled map-row activation is a
  no-op and the row is NOT omitted; **C-4 caveat:** `sql-studio.tab.close` is gated on `kinds` ∋
  `query`, which §D.4 never projects — record the contradiction, do not fail the tester on it.

- [ ] **F-12 (R-12) `[static]`+`[live]` — availability flips without a dispatch.**
  **Expected:** seeding a selection through the real UI (mission row, SQL connection/table/result
  set, dev-mode view) advances `epoch` by exactly 1 via `host.refreshContext()` and the SAME map rows
  (plus any bound rail rows) flip `disabled → available` (and back) with no remount, no journal
  entry, no announcement; the cursor does not move into a child place (D-UI-1).
  **Edge:** value-equal context → silent no-op; flip during an armed prefix; rapid flips settle on
  the final state; no poll; SQL connection select flips only the connection verbs.

- [ ] **F-13 (R-13) `[static]` — parameterised parity matrix (B.8).**
  Run `pnpm --filter @fredo/ui test:run src/applications/__tests__/navigationParityMatrix`.
  **Expected:** five app rows only; every `ParityRow` produces the SAME `observe()` on keyboard /
  pointer / launcher, journals the SAME `verbId`, and the three entries differ ONLY in `channel` (and
  `actor` for the companion relay). One `runIntent`/`dispatch` per run, exactly one journal entry per
  non-noop run. Terminal rows use `runIntent({channel:'keyboard'})` because terminal declares ZERO
  strokes by design (B.6/§B.7) — stated in the row, not a weakened assertion. SQL rows use
  `dbQueryExecute`/`dbResultPage` mocks, never a live database.
  **Edge:** args-bearing verb; destructive verb with a deterministic `confirm`; noop verbs excluded
  and asserted to journal nothing on all channels; companion supplementary leg; three runs → +3
  entries.
  **Files:** `applications/__tests__/navigationParityMatrix.test.ts` (ST-6).

- [ ] **F-14 (R-14) `[static]` — zero `data-hotkey` in the five in-scope paths.**
  **Expected:** a literal search over `apps/ui/src/applications/terminal`,
  `.../mission-monitor`, `.../database-client`, `.../dev-mode`,
  `apps/ui/src/shared/hotkeys/traversal.ts` and `apps/ui/src/shared/window-system` returns **0
  matches** (source, comments and tests — comments count, so the scan does NOT strip them).
  Non-vacuity: every root exists with ≥1 file; `data-testid` returns >0 in the four app roots; a
  constructed-attribute control matches. Remaining repo hits are the explicit allowlist, not
  failures: the deprecated apps (7 sites / 9 keys — `ArchitectureDiagram.tsx:680`;
  `OptimizelyFlagsPanel.tsx:461,491,506,533`; `MyWorkItemsContainer.tsx:133,155`) plus non-migrated
  literals in wireframe tests/comments, `shared/hotkeys/**` machinery/tests and comment-only mentions
  (`shared/navigation/context.ts:6`, `FredoApplicationClass.ts:126`, `index.ts:49`).
  **Edge:** a comment hit in a five path (FAIL — ST-3 rewrites `MissionMonitorFeature.tsx:15-20`); a
  test hit in a five path (FAIL); a hit only in a frozen app (allowlisted); `data-Hotkey` is outside
  the literal AC and is stated, not assumed.
  **File:** `shared/hotkeys/__tests__/featureHotkeyKeys.test.ts`, rewritten by ST-6 to the five-surface
  truth (AC7-authorized, test-only; no runtime deletion).

- [ ] **F-15 (R-15) `[live]`+`[static]` — no mounted `[data-hotkey]`, no app-owned `g+*`.**
  **Expected:** each of the five mounted apps → `document.querySelectorAll('[data-hotkey]').length
  === 0`; `data-fredo-pending-sequence` never set by the app's dispatch; static: no `g`-prefixed
  sequence in any of the five trees.
  **Edge:** the legacy `HotkeyBar` may still list frozen apps (not a FAIL — P8 owns removal);
  wireframe's sibling `g+i`/`g+o` bindings are out of scope and are NOT asserted absent repo-wide;
  two migrated apps mounted at once still zero.

- [ ] **F-16 (R-16) `[static]` — existing suites keep every outcome assertion.**
  **Expected:** `pnpm --filter @fredo/ui test:run` exit 0; diff review of the FIVE apps' pre-existing
  test files shows **0 removed `it(` titles**, EXCEPT the AC7-authorized rewrite of
  `shared/hotkeys/__tests__/featureHotkeyKeys.test.ts` — **E-1 RESOLVED**: ST-6 rewrites the old
  app-specific discovery pin to the five-surface truth (the five migrated surfaces declare no
  `data-hotkey`; the frozen apps' 7 sites / 9 keys are enumerated; a non-vacuous five-surface
  assertion is retained; no runtime deletion) — the rewrite re-points the pin and deletes no
  coverage; dispatch-path edits allowed, outcome observations otherwise unchanged.
  **Edge:** a `.skip`/`.todo`; a renamed title (must be justified); a dropped assertion; a new
  failure elsewhere; the E-1 rewrite may touch only the inventory pin (five-surface truth + frozen
  7-site / 9-key enumeration).

- [ ] **F-17 (R-17) `[static]` — build green.**
  **Expected:** `pnpm --filter @fredo/ui build` exit 0, zero TS errors, zero warnings;
  `package.json` + lockfile importer unchanged (no new dependency).
  **Edge:** warning-only build (FAIL); lockfile-only delta; static `@tauri-apps/api` import.

- [ ] **F-18 (R-18) `[static]` — docs describe the declared-surface model and list the FIVE apps.**
  **Expected:** `docs/ARCHITECTURE.md` *Keyboard & Hotkeys* describes the declared-surface model and
  lists exactly the five migrated apps with their declared keys — terminal (`F2`), window traversal
  (`Ctrl+Space`, `Ctrl+Tab`, `Ctrl+Shift+Tab`), Mission Monitor (`s`, detail `Escape`), SQL Studio
  (`Ctrl/Cmd+Enter`), Dev Mode (`x`, `v`, `i`, `b`); the old per-app element list (`:598`) is gone;
  the P8-bound `shared/hotkeys/` internals may remain (marked legacy); each app name is positively
  present with keys; the three removed apps are not documented as migrated.
  **Edge:** a listed key disagreeing with B.3 (FAIL); a measured-UX-gain claim (forbidden); removing
  P8-bound internals (out of scope).

- [ ] **F-19 (R-19) `[live]` — focus-out exits; Escape reaches the PTY.**
  **Expected:** run `cat -v` in the PTY and send `Escape` → `^[` echoed;
  `describeContext('terminal').placePath.map((p) => p.id)` still
  `["terminal.window","terminal.session"]`; `data-fredo-passthrough` still `true`; no journal entry,
  no announcement. Focus-out = one pop (F-6).
  **Edge:** `Escape` with a rail row focused (engine-owned); an arrow escape sequence arrives as one
  PTY sequence; no invented chord (`Ctrl+Shift+F10` must not reappear).

- [ ] **F-20 (R-20) `[live]`+`[static]` — window chords through declared verbs (D-3(a)).**
  **Expected:** ≥2 windows: `Ctrl+Tab` raises + focuses next; `Ctrl+Shift+Tab` previous;
  `Ctrl+Space` toggles the launcher. Journal `window.focus.next` / `window.focus.previous` /
  `window.launcher.toggle`, `channel:"keyboard"`. Static: the three kept-global runs delegate into
  the window host's `runIntent({channel:'keyboard'})`.
  **Edge:** one window; rapid double-press = one toggle; terminal focused (record + assert
  unchanged); native `Tab` boundary hand-off untouched.

- [ ] **F-21 (R-21) `[static]` — mapping completeness (11 bindings).**
  **Expected:** the committed table has exactly **11** rows — mission `s`; dev `x`, `v`, `i`, `b`;
  `primary+space` → `window.launcher.toggle`; `primary+tab` → `window.focus.next`;
  `primary+shift+tab` → `window.focus.previous`; terminal `F2` → `terminal.session.rename`; SQL
  `Ctrl/Cmd+Enter` → `sql-studio.query.run`; Mission detail `Escape` →
  `mission-monitor.detail.close`. Each resolves to the B.6 verb id; every declared `keys` entry maps
  back to a row (dev `x/v` in both places = one row each); `app.map` has no key and is excluded.
  **Edge:** a declaration key with no row (FAIL — invented); a row with no declaration (FAIL —
  omitted); the count drifting from 11 (FAIL); a frozen-app key appearing as a row (FAIL — out of
  phase); `app.map`/`app.ask` never counted.
  **File:** `applications/__tests__/navigationBindingsCompleteness.test.ts` (ST-6).

- [ ] **F-22 (R-22) `[static]` — one funnel, one journal entry.**
  **Expected:** `runIntent → dispatch` exactly once per run, ≤1 journal entry; no component calls
  `dispatch(`/`runVerb(`/verb `.run(` directly (source scan); the only call sites are the host and
  the adapter.
  **Edge:** rejected intent journals nothing; `noop` journals nothing; undo journals one system
  entry; two channels → two entries / two dispatch calls.

- [ ] **F-23 (N-1) `[static]`+`[live]` — terminal latency does not regress.**
  **Expected:** static — no `await`/IPC/storage/React state write before `handleStroke`/PTY write;
  `tauri_ipc_monitor` during a 10-key type shows no navigation-journal IPC. Live — 20 keystrokes
  produce 20 echoed characters, no drop/reorder.
  **Edge:** heavy agent stream; rapid repeats; IME/multi-byte; a passthrough stroke schedules no
  timer.

- [ ] **F-24 (N-2) `[static]` — one document keydown listener, element-scoped adapters.**
  **Expected:** no provider/adapter calls `document.addEventListener('keydown'` or
  `window.addEventListener('keydown'`; each attaches ONE `onKeyDown` to its app root (P5 pattern);
  `engine.ts` remains the only capture-phase `document` listener.
  **Edge:** a document-scoped adapter (FAIL); a second adapter per app root; a listener attached in
  render; the pre-existing Mission Monitor detail `Escape` listeners are allowed.

- [ ] **F-25 (N-3) `[static]`+`[live]` — a11y + theme of the new mounts.**
  **Expected:** bound names present (`Command bar`, `Navigation map`, `Activity trail`, `more…` →
  `More actions in this place — opens the map`, `?` → `Question mark`, `/` → `Slash`); no second
  live region per app provider; zero raw hex/rgba and zero `var(--x)NN` alpha-appends in new
  provider/shell code; `contrast:gate` unchanged; focus does not move on mount; the window dock
  wrapper stays `pointer-events: none` with only its own controls interactive.
  **Edge:** a second live region (FAIL); a hardcoded colour; focus moved on mount.

- [ ] **F-26 (N-4) `[static]` — no persistence, no poll, no new dependency.**
  **Expected:** no `localStorage`/`sessionStorage`/settings write for place cursor, map state or
  selection; no `setInterval` in new providers; `package.json` + lockfile importer unchanged.
  **Edge:** a settings key for the place cursor; polling availability; a dependency added "for the
  parity test".

- [ ] **F-27 (N-5) `[live]` — evidence pack per app (ST-8).**
  **Expected:** for each of the FIVE apps a screenshot + DOM snapshot of the rail (breadcrumb + rows),
  the map open and the trail, via the levers above (terminal route/launcher; launcher windows; SQL
  Studio launcher tile; Dev Mode via the 10-key Konami). Files are authored under
  `.opencode/tmp/3121/e2e/` but the record is the ONE POSTED `## Tests Runs` comment (uploaded URLs),
  never a `.opencode/tmp` draft (G-415).
  **Edge:** an unreadable dark capture (FAIL); a screenshot of the wrong app id; a missing breadcrumb
  segment; a Dev Mode capture taken without all 10 keys.

- [ ] **F-28 (R-23) `[live]`+`[static]` — SQL Studio actions reproduce their outcomes; no
  capability added.**
  **Expected (per §B.5 verb):** `connection.new` → `db-connection-form`; `connection.edit` →
  prefilled form (`db-conn-name`); `connection.delete` → the host's deterministic `confirm` seam,
  then `dbConnectionDelete` + `clearConnectionData` and removal; `connection.disconnect` →
  `dbDisconnect` called and the session marked disconnected (`Disconnected`); `connection.retry` →
  `dbConnectionList` called again; `schema.viewColumns` → columns render; `schema.openData` → a tab
  whose `dbQueryExecute` carries the bounded read-only SELECT; `schema.newQuery` → a tab with the
  object name; `query.run` → `dbQueryExecute` once with the selection or the statement at the caret;
  `query.runAll` → `dbQueryExecute` with all statements; `tab.new` → a new `db-query-tab`;
  `tab.close` → the active tab closes (C-4 caveat); `results.loadMore` → `dbResultPage` next offset
  (`db-result-load-more`); `results.exportCsv`/`.exportJson` → the export path
  (`db-export-csv`/`db-export-json`); `history.clear` → stored history removed. No new capability:
  `Ctrl/Cmd+Enter` is the only run chord, no `db-grid-row` click/`aria-selected` row selection, every
  pointer flow unchanged.
  **Edge:** a verb dispatching `invalid-args` when its target is in `ContextSnapshot` (FAIL); a new
  row-selection affordance (FAIL — D-8); a changed `db-*` testid (FAIL); a second run chord.

- [ ] **F-29 (R-24) `[live]`+`[static]` — Dev Mode retained; its Konami opener still works.**
  **Expected:** from Home, complete `ArrowUp ArrowUp ArrowDown ArrowDown ArrowLeft ArrowRight
  ArrowLeft ArrowRight b a` (lowercase `b`/`a`, no modifier — `useKonamiCode.ts:3-14`; the listener
  is document-level, mounted by `Home.tsx:77`): the Dev Mode window opens, `dev-mode-view-toggle`
  renders, `x`/`v`/`i`/`b` keep their B.6 outcomes, and the window carries ZERO `[data-hotkey]`.
  **Edge:** the old "8 arrows, no B/A" text is WRONG — do not use it; a wrong key resets the
  sequence; `b` uppercase does not complete; opening twice does not stack two windows; the app still
  reports `showable=false` (only Konami/`openFeatureWindow` opens it).

- [ ] **F-30 (R-23) `[live]`+`[static]` — SQL `Ctrl/Cmd+Enter` keeps its outcome and stays local
  (B.6 / D-3(b)).**
  **Expected:** focus `db-query-editor`, select a statement (or place the caret in one), press
  `Ctrl+Enter` (`Meta+Enter` on macOS): `dbQueryExecute` is called exactly once with the selection,
  or the statement at the caret — byte-identical args to clicking `db-query-run`
  (`SqlEditor.tsx:345-348`). The navigation adapter does not handle the chord (text-entry owner →
  `null`; no adapter `preventDefault`, no engine journal entry for the chord itself). Invoking the
  declared `sql-studio.query.run` verb via `runIntent` produces the SAME `dbQueryExecute` call and
  journals one entry.
  **Edge:** autocomplete open → `ArrowUp`/`ArrowDown`/`Enter`/`Escape` keep widget behaviour (Enter
  accepts the option); no editor focus → the chord does nothing; a selected fragment runs only that
  fragment; `query.runAll` remains a distinct verb/outcome.

## Suite-level pass/fail

PASS = F-1…F-30 green, every required title/assertion observed verbatim, `test:run` + `build` exit 0,
the F-14 per-surface search returns zero with its non-vacuity controls firing, all five app evidence
packs exist (F-27), and every `[live]` row carries its own running-app receipt in the POSTED
`## Tests Runs` comment. FAIL-closed on: a vacuous scan, a `.skip`/`.todo`/`.only`, a static-only
PASS on a `[live]` row, a `data-hotkey` hit in any of the five in-scope paths, two parity channels
journaling different verb ids, an evidence pointer to a consumed `.opencode/tmp/3121/` draft (G-415),
or a row treating a removed app as migrated.

UNVERIFIED: none. **E-1 RESOLVED** — ST-6 rewrites `shared/hotkeys/__tests__/featureHotkeyKeys.test.ts`
to the five-surface truth (AC7-authorized test-only rewrite; frozen 7 sites / 9 keys enumerated; no
runtime deletion). **C-4 RESOLVED** — B.4 marks `query` selectable, §D.4 projects it, and B.5's
`tab.close` predicate is satisfiable.
