# navigation — Functional

Feature: the headless NavigationEngine P3 core (issue #3117) — one pure TypeScript module at
`apps/ui/src/shared/navigation/` that resolves key sequences, dispatches verbs, journals and
undoes changes, builds the context envelope, derives every discovery surface and validates a
surface declaration, implementing §4–§10 of `docs/NAVIGATION_ENGINE.md`.

Verification policy: **static** — every expected value is a pure-function result, a source-text
property or a committed build/test exit. The module has no consumer, no webview mount and no
telemetry emission, so no app launch, DOM drive, screenshot or `telemetry_spans` query applies
and none is planned.

> **Precondition.** The `spec/3117` branch tree is checked out. All test paths are relative to
> `apps/ui/src/shared/navigation/__tests__/`. Commands, run from the repo root:
>
> ```text
> pnpm --filter @fredo/ui test:run src/shared/navigation   # scoped module suite
> pnpm --filter @fredo/ui test:run                          # whole suite
> pnpm --filter @fredo/ui typecheck                         # tsc --noEmit
> pnpm --filter @fredo/ui build                             # tsc && vite build
> ```
>
> There is no eslint script in `apps/ui`. Test titles quoted below are binding: the `test:run`
> reporter must show each one verbatim.

## Cases

- [ ] **F-1 (REQ-01.1 / AC1) — eleven modules plus a colocated test directory.**
  Run `pnpm --filter @fredo/ui test:run src/shared/navigation`.
  **Expected:** exit 0 and the reporter shows `declares exactly eleven modules and a __tests__ directory`;
  the scanned list is exactly `types.ts`, `registry.ts`, `resolver.ts`, `keyResolver.ts`,
  `dispatch.ts`, `journal.ts`, `context.ts`, `discover.ts`, `manifest.ts`, `validation.ts`,
  `index.ts`, every file non-empty, and `__tests__/` exists.
  **Files:** `apps/ui/src/shared/navigation/` (11 `.ts`), `__tests__/purity.test.ts`.
  **Edge:** a renamed or extra module; an empty stub (the non-vacuity guard must fail); a module
  outside the eleven that the scan silently skips.

- [ ] **F-2 (REQ-01.2, REQ-01.3, REQ-01.4 / AC1) — pure, synchronous, clock-free, zero `any`.**
  Same command, plus `pnpm --filter @fredo/ui typecheck`.
  **Expected:** the titles `imports only sibling ./ modules`, `reads no clock, global, timer, I/O
  or network` and `declares no any in module sources` are green. After comment stripping, zero
  hits for `react`, `react-dom`, `@tauri-apps`, `node:`, `@/`, `../`, `applications/`, `Date.now(`,
  `new Date(`, `performance.now(`, `setTimeout(`, `setInterval(`, `document.`, `window.`,
  `globalThis.`, `localStorage`, `fetch(`. `typecheck` exits 0 with zero diagnostics.
  **Edge:** a comment naming `Date.now()` (stripped — still passes); a dynamic `import('react')`;
  a generic default `= any`; a `type` import from `../hotkeys`.

- [ ] **F-3 (REQ-02.1–02.7 / AC2) — tier precedence, arming and the 250 ms timeout.**
  **Expected:** green titles `tier 1 place key beats direct alias`, `direct alias resolves only
  when tier 1 is empty`, `unbound stroke returns a quiet hint`, `armed prefix consults tier 3
  only`, `invalid continuation cancels and re-resolves at tier 1`, `first stroke with
  continuations arms and dispatches nothing`, `stroke without continuations falls through to tier
  2`, `prefix times out at 250 ms with no fallback`. At `armedAtMs + 249` the prefix is still
  armed; at `+250` the outcome is `status:'timeout'` with no journal entry, no hint and no
  single-stroke dispatch. Every `dispatch` outcome carries exactly one intent.
  **Edge:** the `w` prefix (`w n`, `w p`) with `w` unbound; a stroke bound at all three tiers; a
  continuation that is also a complete binding in another place.

- [ ] **F-4 (REQ-02.8–02.11, REQ-02.14–02.16 / AC2, AC10) — passthrough, ambiguity, locality, no fifth tier.**
  **Expected:** green titles `text-entry terminal and modal owners pass every stroke through`
  (`'text-entry'`, `'terminal'`, `'modal'` → `status:'passthrough'`, no place key, no alias),
  `two intents on one stroke reject ambiguous-key` (`{status:'rejected', code:'ambiguous-key'}`),
  `same verb place key and alias dispatch at tier 1` (tier 1, no ambiguity), `place keys are
  place-local`, `no fifth tier is consulted`. `validation.test.ts` › `V-08 alias shadows a
  different-verb place key` returns exactly one `NAV-E008` with `valid === false` for
  `aliasShadowsPlaceKeySurface()`; the harness asserts validation fails before any intent.
  **Edge:** declaration order reversed (same ambiguity outcome); a global-registry-only stroke
  (must not dispatch); same stroke in two sibling places.

- [ ] **F-5 (REQ-02.12, REQ-02.13 / AC2) — transient auto-exit and Escape.**
  **Expected:** `transient place pops exactly one level on verb completion` green — cursor
  `['wireframe.canvas']`, entry `exitedBy:'verb'`, exactly one mutation entry, no second
  navigation entry. `Escape pops one level in a child place` green — dispatches `place.exit`,
  `exitedBy:'escape'`, cursor one level up. `Escape at root dispatches nothing and reports
  overlayClose` green — no intent, no journal entry.
  **Edge:** a sticky place — Escape still pops exactly one level; root with and without an open
  overlay; Escape while a prefix is armed.

- [ ] **F-6 (REQ-03.1–03.4 / AC2) — published key map and the three §4.3 traces.**
  **Expected:** `traces.test.ts` titles `fixture declares the published key map`, `c trace matches
  every published column`, `c r trace matches every published column`, `r trace matches every
  published column`, `c r and r differ only in journal placePath`, and `c r journals navigation
  then mutation and never a second navigation` all green. Read the matrix as: `c` → tier `[1]`,
  intents `['place.create']`, effects `['navigation']`, placePath `['wireframe.canvas']`, cursor
  `['wireframe.canvas','wireframe.create']`, `exitedBy 'none'`; `c r` → tiers `[1,1]`, intents
  `['place.create','place.rect']`, effects `['navigation','mutation']`, placePath
  `['wireframe.canvas','wireframe.create']`, cursor `['wireframe.canvas']`, `exitedBy
  ['none','verb']`; `r` → tier `[2]`, intents `['place.rect']`, effects `['mutation']`, placePath
  `['wireframe.canvas']`, cursor `['wireframe.canvas']`, `exitedBy 'none'`.
  **Files:** `__tests__/traces.test.ts`, `__tests__/fixtures.ts`.
  **Edge:** one-column drift; reading the dispatch-time `placePath` as the post-dispatch cursor
  (Reading #3); `w` bound (must fail REQ-03.1).

- [ ] **F-7 (REQ-04.1–04.10 / AC4) — the dispatch funnel.**
  **Expected:** green titles `all six channels reach the verb through dispatch`, `companion channel
  with non-companion actor rejects actor-spoof first`, `validation order is existence then
  availability then args then risk`, `unknown verb rejects unknown-verb`, `unavailable verb rejects
  unavailable`, `invalid args rejects invalid-args`, `successful run applies and journals exactly
  one effect`, `did-nothing returns noop and journals nothing`, `throwing run returns failed
  failed-run and journals nothing`, `multi-entry undo stops after applied inverses returns partial`.
  Each rejection leaves the journal length unchanged and calls neither `run` nor `applyPatch`.
  `purity.test.ts` › `run is referenced only by dispatch.ts` is green.
  **Edge:** unavailable + invalid args in one intent → `unavailable`; an engine-reserved id passed
  as `verbId`; async `run`; `run` throwing after mutating the document.

- [ ] **F-8 (REQ-05.1–05.12 / AC5) — the append-only journal, undo and redo.**
  **Expected:** green titles `every state-changing dispatch appends exactly one entry`,
  `navigation entry has null patch and inverse`, `undoable iff inverse is non-null`,
  `non-undoable entry carries a consequence sentence`, `exitedBy records verb escape and none`,
  `undo applies inverses newest first`, `redo re-applies after in ascending seq`, `new mutation
  clears the redo stack`, `applied inverse is journaled as a system mutation`, `entries coalesce
  only within key actor seq and ts gaps`, `coalesced undo reverts the whole group`, `navigation
  entries never coalesce`, `non-undoable verbs carry distinct consequences and not-undoable
  reason`, `empty query returns noop no-matches with Nothing to undo. once`, `query defaults clamp
  and AND semantics`, `canonical companion query undoes the companion's last change`, `canonical
  count and actor query undoes newest N`. `groupId` is a STRING (`String(firstEntry.seq)`).
  **Edge:** `count:0` and `count:101`; `since` exactly equal to an entry `ts` (inclusive); seq gap
  2 and ts gap 401 (must not coalesce); companion entries interleaved with human ones.

- [ ] **F-9 (REQ-06.1–06.8 / AC6) — the context envelope v1.**
  **Expected:** all eight `context.test.ts` titles green — `envelope v1 carries every field from
  its arguments` (`version === 1`), `envelope is JSON-serialisable with no functions or cycles`,
  `place path lists root to current and truncates to eight`, `selection dedupes kinds and
  truncates ids`, `verbs follow declaration order and truncate to 64`, `journal last is newest
  first and capped at ten`, `dirty and frozen capability limits`, `strings truncate at 120 and
  envelope is at most 16384 bytes`. REQ-06.8's "every value comes from its arguments" rides on the
  first title (the empty selection and empty journal cases are asserted explicitly); there is no
  separate envelope non-mutation title — the envelope's plain-value shape is the JSON-serialisable
  title, and frozen-input non-mutation is asserted for the derivations by `derivations do not
  mutate a deep-frozen surface` (F-10).
  `Object.isFrozen(CAPABILITY_LIMITS)` is true and its values are `64/10/32/120/8/16384`.
  **Edge:** a 9-deep place path; 33 selected ids; 9 distinct kinds; 65 verbs; 11 journal entries;
  a 1,000-character label.

- [ ] **F-10 (REQ-07.1–07.6 / AC7) — every discovery surface derived from one declaration.**
  **Expected:** green titles `rail is current-place rows capped at eight with overflow`, `map
  returns the whole tree in tree order`, `palette puts recents first then place groups`, `hint
  returns prefix rows with 250 ms and next three verbs`, `tooltip renders title keys and risk and
  never ? or /`, `derivations do not mutate a deep-frozen surface`, `declaration mutation changes
  all four projections`. `formatTooltip` renders `"Map (m)"`, appends `" — <risk>"` only when risk
  is not `safe`, omits the parenthetical with no keys, and never emits `?` or `/`.
  **Edge:** a place with zero bound verbs (no padding); 9 rail rows → 8 + `overflow:1`; 6 recents;
  a recent verb id absent from the surface; every hint candidate already shown in the rail (zero
  rows).

- [ ] **F-11 (REQ-08.1–08.5 / AC8) — twelve validation rules over twelve failing fixtures.**
  **Expected:** the twelve per-rule titles (`V-01 duplicate verb id`, `V-02 exactly one root`,
  `V-03 parent resolves`, `V-04 chain terminates at root`, `V-05 key target declared`, `V-06 bound
  verb applies to that place`, `V-07 no duplicate stroke within a place`, `V-08 alias shadows a
  different-verb place key`, `V-09 every verb declares a risk`, `V-10 destructive or external has
  undo or consequence`, `V-11 complete binding shadows a longer sequence`, `V-12 incomplete
  verb`) are green; each failing fixture yields exactly ONE diagnostic with the stated `rule` +
  `code`; the passing fixture `validWireframeSurface()` yields zero for all twelve.
  `orderedViolationSurface()` yields exactly `['V-01','V-02','V-09','V-12']`. `validateSurface
  never throws on a malformed surface` and `validateSurface does not mutate its input` are green.
  **Files:** `__tests__/validation.test.ts`, `__tests__/fixtures.ts`.
  **Edge:** two diagnostics from one fixture; `null`/`undefined` surface; a frozen surface; a
  "nine rules" implementation missing V-11/V-12 (FAIL — AC8 covers all twelve).

- [ ] **F-12 (REQ-09.1–09.4 / AC4) — risk policy and confirmation.**
  **Expected:** green titles `safe and mutating apply without confirmation and journal once`,
  `destructive verb does not run until confirmation is accepted`, `destructive confirmation
  carries verb target consequence and undo availability`, `external confirmation carries the party
  and is always not-undoable`, `dismissed confirmation rejects canceled-confirmation and journals
  nothing`. `targetLabels` ≤ 5 with `targetOverflow` carrying `+N more`; `externalParty` non-null
  for `external`; `undoAvailability` is `{undoable:false, reason:'not-undoable'}` for `external`.
  **Edge:** 6 targets → 5 + `+1 more`; dismissal for both destructive and external; an external
  verb declaring an `inverse` (still not undoable); `confirm` never called for safe/mutating.

- [ ] **F-13 (REQ-10.1, REQ-10.2 / AC3, AC5) — seeded property run and `undo(run(x)) ≡ before`.**
  **Expected:** green titles `seeded resolution never throws and yields one typed outcome`,
  `property run generates 3000 cases`, `undo run x equals before`. The property test reads
  `PROPERTY_SEEDS = [1, 42, 2026]` and `PROPERTY_CASES_PER_SEED = 1000` from `fixtures.ts` and
  asserts the generated count ≥ 1,000 (actual 3,000). Every generated case asserts: no throw; one
  typed outcome from `dispatch | armed | pending | passthrough | hint | rejected | timeout`; a
  `dispatch` carries exactly one intent whose `verbId` exists in the generated surface; the same
  sequence never resolves to two different verbs in one context. `undo run x equals before` deep-
  equals `doc` to `before`, asserts the undo entry has `actor:'system'` and restores `after` on
  redo.
  **Edge:** the 1,000-case floor; two identical runs produce identical results; a generated
  surface with duplicate strokes; a verb with `inverse:null` (undo must refuse, not corrupt).

- [ ] **F-14 (REQ-10.3 / AC9) — golden manifest projection.**
  **Expected:** green titles `manifest equals the committed golden file`, `manifest projection is
  byte-identical across runs`, `every published verb carries id title description risk args and
  aliases`, `golden command rows carry all six projection keys`. The golden file path is
  `apps/ui/src/shared/navigation/__tests__/fixtures/wireframe.navigation.golden.json` and is read
  from disk with `readFileSync` + `JSON.parse` — never regenerated at test time. The six fields are
  asserted **on the projected `CompanionCommand`**, per published verb: `command.id === verb.id`,
  `command.label === verb.title`, `command.description === verb.description`,
  `command.risk === verb.risk`, `command.args` name/required per declared arg (an authored
  `VerbArg.description` preserved, omitted when the source declares none),
  `command.aliases === verb.aliases` (a non-empty authored array projected verbatim, and an
  authored `[]` preserved as `[]`). An assertion on the source `VerbDescriptor` alone does NOT
  satisfy this case (G-418). `commands` ids equal every `publish===true` verb id in declaration
  order; `actionIds` ends with exactly one `listActions`; and every row of the committed golden's
  `manifest.commands` has `Object.keys()` exactly `['id','label','description','risk','args',
  'aliases']` in that order — a shape gate independent of the projection code, with a non-empty
  `commands` array asserted first.
  **Edge:** an unpublished verb appearing in the projection; input reordered (projection
  unchanged); a verb with no aliases (`[]` is valid); a golden row missing `risk` or `aliases`
  (FAIL — the AC9 narrowing this round fixes); `risk`/`aliases` asserted only on the source
  descriptor (FAIL, G-418); a projection hard-coding `aliases: []`; a regenerated-at-test-time
  expectation (FAIL — the file must be committed).

- [ ] **F-15 (REQ-10.4, REQ-10.5 / AC1–AC10 build gate) — commands green, no new dependency.**
  Run `pnpm --filter @fredo/ui test:run`, `pnpm --filter @fredo/ui typecheck` and
  `pnpm --filter @fredo/ui build`.
  **Expected:** all three exit 0; `typecheck` reports zero diagnostics; `build` reports zero
  warnings; the whole `test:run` suite has no new failures versus `main`. `apps/ui/package.json`
  `dependencies`/`devDependencies` are unchanged; `pnpm-lock.yaml` shows no `apps/ui` importer
  delta; `fast-check` has no import, no `package.json` entry and no lockfile importer delta — its
  only two occurrences in `apps/ui` are comment-only mentions in
  `__tests__/property.test.ts` and `__tests__/fixtures.ts`, prose rather than a dependency.
  **Edge:** a warning-only build (FAIL); a `.skip`ped navigation suite (FAIL); a lockfile-only
  change; a devDependency added "for the property test".

## Suite-level pass/fail

PASS = F-1..F-15 green, all ten ACs covered, every cited `it()` title observed in the reporter,
and all four commands exit 0. Any non-zero exit, any missing named title, or any assertion drift
is a FAIL of that case. A skipped or `todo` navigation test counts as missing. The receipt is the
POSTED `## Tests Runs` comment plus the committed suites — never a `.opencode/tmp/3117/` draft.

---

# P4 — UI surfaces (issue #3118)

Feature: the three navigation surfaces (`CommandRail`, `NavigationMap`, `ActivityTrail`) plus the
navigation `NavKeycap` and the announcement layer, all driven by the P3 headless projections —
never by a prop that carries a key table.

Verification policy: **live** (the surfaces are rendered UI). Live receipt lever: the dev route
`/?view=navigation-preview` in the running desktop app — `pnpm dev:tauri`, then
`tauri_webview_execute_js` → `window.location.replace('/?view=navigation-preview')`; evidence via
`tauri_webview_screenshot`, `tauri_webview_dom_snapshot`, `tauri_webview_find_element`
(`properties` for computed styles), `tauri_webview_keyboard`, `tauri_manage_window` (resize) and
`tauri_read_logs`. P4 emits no telemetry, so no `telemetry_spans` leg applies; `pnpm dev:ui` in a
browser is **not** a sanctioned receipt (no committed browser driver).

> **Precondition.** The `spec/3118` tree is checked out. Suite paths are relative to
> `apps/ui/src/shared/navigation/`. Commands, from the repo root:
>
> ```text
> pnpm --filter @fredo/ui test:run src/shared/navigation   # scoped module + UI suites
> pnpm --filter @fredo/ui typecheck
> pnpm --filter @fredo/ui build
> pnpm --filter @fredo/ui test:run                          # whole suite
> pnpm --filter @fredo/ui contrast:gate
> ```
>
> **Fixtures.** `ui/__tests__/fixtures.ts` (authored by ST-1) exports the unit surface
> `navTestSurface()` (root `test.canvas` = Canvas, binding c/i/a/s/v/f → the six children and
> m→`app.map`, k→`app.ask`; `test.arrange` binds 9 verbs; `test.create` is transient), the four
> clone-mutators `addPlace()/renameVerbTitle()/addDirectAlias()/renamePlace()`, and the journal
> builders `seedEntries(n)/seedCompanionEntry()/seedNonUndoableEntry()`. The product demo
> declaration is `NAVIGATION_DEMO_SURFACE` at `apps/ui/src/app/dev/navigationDemoSurface.ts` (ST-6).
> Constants are cited from the plan's binding block, not paraphrased.

## Cases — P4

- [ ] **F-16 (R-1.1–R-1.7 / AC1) — `CommandRail` renders the rail projection and nothing else.**
  Run `pnpm --filter @fredo/ui test:run src/shared/navigation` (or the scoped
  `... src/shared/navigation/ui`).
  **Expected:** `models.test.ts` + `commandRail.test.tsx` are green and the following are observed:
  (a) breadcrumb one segment per place with `data-nav-place-id`, current place label in
  `navigation-rail-place`, transient chip `"Create · one action"` present **iff** transient;
  (b) rows in declaration order, each with a non-empty title, a `NavKeycap` hint and — for a
  non-`safe` risk — a `navigation-rail-risk` word from `NAV_RISK_LABELS` (`Changes` /
  `Destructive` / `External`); (c) an unavailable verb is **present** with
  `data-nav-availability="disabled"` and the reason `Not available for the current selection` in
  its tooltip; (d) `/ Ask` is disabled with `Ask arrives with the launcher in the next phase`,
  `? Map` is enabled, and no tooltip contains `?` or `/`; (e) at most 8 rows in every state and a
  place with 0 verbs renders 0 rows (never padded to 4) with exactly `NAV_RAIL_EMPTY_COPY`
  (`No actions in this place`) as its empty copy; (f) 9 bound verbs → 8 rows + one
  `navigation-rail-more` whose label is `more…` and whose click opens the map filtered to that
  place; (g) `rows` carries neither `app.map` nor `app.ask` (they are the footer affordances);
  (h) the component's props carry no key table / `VerbDescriptor[]`, the root has no `aria-live`
  and no positive `tabindex`, and mounting it does not move focus.
  **Files:** `ui/__tests__/models.test.ts`, `ui/__tests__/commandRail.test.tsx`,
  `ui/__tests__/fixtures.ts`.
  **Edge:** 0 / 1 / 3 / 8 / 9 / 12 bound verbs; every verb unavailable; a 60-char verb title; a
  sticky place (no transient chip); the two globals also bound in a child place.

- [ ] **F-17 (R-1.5 / AC1) — the rail never scrolls horizontally (measured, not asserted by style).**
  Live: resize the window to **520 px** (`tauri_manage_window action="resize"`), then to **900 px**.
  **Expected:** at both widths `rail.scrollWidth <= rail.clientWidth` **and**
  `list.scrollWidth <= list.clientWidth` (read with `tauri_webview_execute_js` or
  `find_element(properties)`); the row title is the only ellipsizing child (`textOverflow` computed
  `ellipsis`, `minWidth: 48px`) and the breadcrumb wraps rather than overflowing. Source: no
  `overflowX` with `auto`/`scroll` anywhere in `CommandRail.tsx`; the root declares
  `overflow: hidden`; every flex ancestor of a row carries `minWidth: 0`.
  **Edge:** all-unavailable place at 520 px; a 60-char title; the rail at the
  `NAV_RAIL_MIN_WIDTH_PX` (180) floor — design intent, not a jsdom px assertion (the measured
  proof is this live row).

- [ ] **F-18 (R-2.1–R-2.6 / AC2) — `NavigationMap` is the whole tree, keyboard-operated, focus-safe.**
  **Expected:** `navigationMap.test.tsx` green with: closed → `null` (no node, no live region, no
  focus move); open → `role="dialog"`, `aria-modal="true"`, `aria-label="Navigation map"`; the
  whole tree in tree order with per-place `pathLabel` (`Canvas › Arrange`), verbs (title, keys,
  availability, risk word) and keys; exactly ONE `[data-nav-current]`; three distinct sections
  (`navigation-map-key` inside blocks, `navigation-map-alias` after all blocks with 4 rows,
  `navigation-map-global` with `Map (m)` + glyph `?` and `Ask (k)` + glyph `/`); `ArrowDown`/
  `ArrowUp` move focus across interactive verb rows and wrap; `Enter` runs the active enabled verb
  exactly once; `Escape` closes; `Tab`/`Shift+Tab` stay inside the dialog and the trap is released
  on close; closing by Escape, backdrop and a ran verb each restore focus to the pre-open invoker
  (`toHaveFocus()`), never `body`; the search filters from the same model and shows
  `navigation-map-empty` on no match with focus kept and its text exactly `NAV_MAP_EMPTY_COPY`
  (`No matching places, actions or keys`); the search field's `aria-label` is
  `NAV_MAP_SEARCH_LABEL` (`Search places, actions and keys`); the visible current chip reads
  `NAV_MAP_CURRENT_LABEL` (`Current place`); the alias and globals headings read
  `NAV_MAP_ALIASES_HEADING` (`Direct aliases`) / `NAV_MAP_GLOBALS_HEADING` (`Global keys`); the
  keyboard-hint footer reads `NAV_MAP_HINT_COPY`; the map adds no `document`-level keydown
  listener. All six are `[root]`-exported bound constants (Architect C8).
  **Edge:** `filteredTo` naming an unknown place; open/close/open; exactly one focusable; a place
  with 0 verbs; Enter on a disabled row (no run, no close); a whitespace-only query.

- [ ] **F-19 (R-3.1–R-3.5 / AC3) — `ActivityTrail` is the journal receipt with honest undo.**
  **Expected:** `activityTrail.test.tsx` green with: newest-first (`seq` DESC), 11 entries → 10
  rendered; actor / label / path (` Canvas › Create ` with the ` › ` separator) / time
  (`/^\d{2}:\d{2}$/`) present per entry; an undo control **only** when `entry.undoable` is true —
  including the negative case of an entry with `inverse === null` on a verb that is NOT one of the
  five built-in non-undoable ids (proves entry-keyed gating, not `undoAffordance(verbId).disabled`);
  the empty state text is exactly `Nothing yet — your actions will appear here` with zero entries;
  a companion entry carries actor text `Companion` **and** `data-nav-actor="companion"` (text, not
  colour); compact mode sets `data-nav-compact="true"` and renders no path and no time node while
  keeping actor, label and undo.
  **Per-entry undo (binding):** with three undoable entries, activating the undo control on the
  **oldest** one applies THAT entry's inverse — the newest entry is untouched, exactly one new
  `system` mutation entry is appended and exactly one announcement is emitted. The control is
  wired to `host.undoEntry(seq)` (implemented in `host.ts` from the exported journal primitives —
  the P3 `JournalQuery` carries no `seq`); a per-entry button wired to `undoLast()` (newest-entry
  semantics) fails this row.
  **Edge:** equal `ts` with different `seq`; 10 vs 11 entries; `undoReason === ''` (nothing
  rendered, no empty tooltip); compact + empty; a system entry; undo twice in a row.

- [ ] **F-20 (R-4.1–R-4.6 / AC4) — exactly one polite announcement per event, and exactly one region.**
  **Expected:** `announce.test.tsx` + `host.test.ts` green with the bound strings verbatim:
  `Editing — 5 actions` / `Editing — 1 action` / `Editing — 0 actions`,
  `Left Canvas — Editing — 5 actions`, `w… Focus next, Focus previous` (and `w…` for no
  continuations), `z isn't available here`, `x matches more than one action`,
  `Undid Rectangle`, `Nothing to undo.`, `Couldn't undo Rectangle`; a subscription counter fires
  **exactly once** per event (never twice for one stroke); a `timeout` and a `passthrough` announce
  nothing; with a text-entry control focused `handleStroke` returns `null`, journals nothing and
  announces nothing. `singleLiveRegion.test.tsx`: `<HotkeyAnnouncer />` + `<NavigationAnnouncer
  channel="legacy" />` + all three surfaces → `countActiveLiveRegions() === 1`, the surviving region
  is `hotkeys-announcer`, and a forwarded message appears in **that** region's text; the
  non-vacuity control (default channel + `HotkeyAnnouncer`) yields `2`.
  **Edge:** identical consecutive messages deduplicate (assert one update, not two); partial undo;
  re-arming the same prefix; enter immediately followed by exit.

- [ ] **F-21 (R-5.1 / AC5) — motion is opacity/transform only and honours reduced motion.**
  **Expected:** `reducedMotion.test.tsx` green: `useNavReducedMotion()` returns `true` under
  `vi.stubGlobal('matchMedia', … matches:true)`, `false` under `matches:false`, and fails safe to
  `false` when `matchMedia` is absent. `navTheme.test.ts` green: every `transition*`/`animation*`
  declaration under `src/shared/navigation/ui/**` names only `opacity`/`transform` (zero
  `width|height|left|top|right|bottom|margin|padding|filter|box-shadow`), and each animated file
  references the `reducedMotion` prop branch.
  **Named limitation (disclosed, not a silent pass):** the *rendered* suppression under the OS
  preference is not observable in jsdom (no media engine) and no sanctioned webview tool exposes
  media emulation — the shipped precedent documents the same gap
  (`shared/components/companion/__tests__/companion.cursorReducedMotion.test.ts:5-15`). Passing
  `reducedMotion={true}` in a component test is admissible corroboration, never the AC's proof.
  **Edge:** an inherited transition from a Chakra parent; a layout-shifting animation.

- [ ] **F-22 (R-5.2 / AC5) — no raw colour, no alpha-append, no new token, gate green.**
  **Expected:** `navTheme.test.ts` first asserts it scanned something (the glob over
  `src/shared/navigation/ui/**/*.{ts,tsx}` is non-empty and includes `CommandRail.tsx`,
  `NavigationMap.tsx`, `ActivityTrail.tsx`, `Keycap.tsx`), then
  `scanRawColors(targets) === []`, zero `/var\(--[a-z0-9-]+\)[0-9]/` alpha-appends, and zero bare
  non-keyword named-colour JSX props. `pnpm --filter @fredo/ui contrast:gate` exits 0 with the
  **pre-change** pair count and `app/theme/contract/tokens.ts` is unchanged. Note: the shipped gate
  does **not** scan `shared/` (`app/theme/contrast/rawColorScan.ts:110-131` globs
  `/src/applications/**` + `/src/app/theme/system.ts`), which is why this scoped sweep is the
  **binding** proof; widening `defaultScanTargets()` was **declined for this slice** (a named
  follow-up needing its own first-green run, G-406), not a missing receipt.
  **Edge:** a hex in a comment (stripped → pass); a colour word inside a `title` string (stripped →
  pass, documented); a new theme token appearing (breaks the no-new-token gate).

- [ ] **F-23 (R-6.1 / AC6) — the declaration is the single source of truth (per-cell matrix).**
  Supplementary per-cell coverage — **THE AC6 proof is F-27's aggregate case.** The two cells below
  that a projection cannot see are asserted as invariants, never as proof.
  **Expected:** `projectionMutation.test.ts` green: with **one** clone-mutator applied and nothing
  else edited — (a) **add place** `test.archive` under `test.canvas` with key `z` → the map gains a
  block `Canvas › Archive`; the rail is unchanged (a place-target key is not a verb row); (b)
  **rename verb title** `test.rect` Rectangle→Box → the rail row title and the map verb title read
  `Box`; (c) **add direct alias** `q→test.rect` → the map `aliases` gains that row and the rail is
  unchanged (aliases are tier 2, never place bindings); (d) **rename place** Create→Compose → rail
  breadcrumb + current label, map `pathLabel`, and the trail `pathLabel` all read `Compose`.
  The residual is asserted as an invariant: a verb-title rename does **not** rewrite an existing
  journal entry's `label`, and an alias adds no rail row/`keyHint` (so no implementation can "pass"
  by re-deriving history). **AC1 note:** "unless the place declares them hidden" is **inert** in
  P4 — `PlaceNode` has no `hidden` field; nothing is hidden and every bound verb renders (disabled
  when unavailable).
  **Edge:** a mutator applied twice; a new place that also binds a verb at the current place; a
  mutation that would break validation.

- [ ] **F-24 (R-7.1–R-7.3 / AC7) — accessibility, automated assertion, recorded manual pass.**
  **Expected:** `a11y.test.tsx` green (role/name reachability for every interactive element, a
  `tab` walk where every stop receives `toHaveFocus()`, no stop is `body`, the map trap holds, every
  `NavKeycap` exposes a non-empty accessible name — `C`, `W then N`, `Question mark`, `Slash` — with
  `aria-hidden` chips, and every non-`safe` risk carries its word as text); the suite is collected
  by plain `test:run` (no `.skip`/`.todo`/`.only`) and adds no dependency
  (`apps/ui/package.json` unchanged). The recorded pass exists **on `spec/3118`** at
  `docs/NAVIGATION_ENGINE.md` §11.4 "Recorded manual screen-reader pass (P4)" with reader + version,
  OS, the route `/?view=navigation-preview`, the ordered eight-class announcement log captured from
  the screen reader's accessibility tree / the live-region text, an attester line (role + date),
  and an explicit instrument disclosure (accessibility-tree text, not captured audio). The tester's
  leg is mechanical: every field present, every logged string equal to the bound `nav*Message`
  output verbatim, and `a11y.test.tsx` green in the same round. Live: `Tab` to a rail verb and read
  `find_element(properties:['outline-style','outline-width','box-shadow'])` → at least one non-none
  outline/shadow; screenshot with the ring visible.
  **Edge:** all-unavailable place; the map close trigger; the disabled Ask; a missing/incomplete
  §11.4 record (a **FAIL** of AC7 — never BLOCKED, never a PO-amendment branch, G-411/G-414).

- [ ] **F-25 (R-8.1, R-8.2 / AC8) — the dev route exists in DEV and is absent from the production bundle.**
  **Expected:** live — `/?view=navigation-preview` mounts rail + map + trail + undo from
  `NAVIGATION_DEMO_SURFACE`, whose places are exactly `Canvas, Create, Edit, Arrange, Style, View,
  File`, and `validateSurface(NAVIGATION_DEMO_SURFACE) === []`; two screenshots (light and dark) of
  rail + open map + trail, each with a textual description, plus a DOM snapshot.
  Static — `app/routes/__tests__/navigationPreviewExclusion.test.ts` green (DEV guard, dynamic
  import only, no other static importer, `src/index.ts` exports nothing from `app/dev/`), and after
  a REAL `pnpm --filter @fredo/ui build` a scan of **every** file under `apps/ui/dist/assets/**`
  finds zero hits for **all five** dev-route-only markers — `NavigationPreview`,
  `navigationDemoSurface`, `demo.canvas`, `demo.arrange`, **and the literal `navigation-preview`**
  (the query literals are inlined in the `Router.tsx` DEV branch and stripped with it — Architect
  C2). Artifact = the built bundle, never "the app"; the scan is a plain file read over emitted
  files, an independent receipt that works whether or not the claim holds (G-408). The marker set,
  the test file and the artifact path are identical to §7 / the plan's C13.
  **Edge:** `dist` stale or absent (rebuild first, then scan); a lazily-split chunk; the map closed
  vs open; a dark screenshot taken before the preset applied.

- [ ] **F-26 (NFR: epoch, bounds, no polling, no persistence, no dependency) — the runtime contract
  that keeps the surfaces cheap.** **Expected:** `host.test.ts` shows `getSnapshot()` returns the
  same object reference between mutations and one dispatch advances `epoch` by exactly 1 (five
  re-renders advance it 0); source scans find no `useEffect`/`useMemo` dependency containing
  `.length` or a fresh array/object literal, zero `setInterval` in `ui/**` (only the one-shot
  250 ms `PENDING_TIMEOUT_MS` clear), no `localStorage`/`sessionStorage`/settings write for map
  open/filter/search or the pending prefix; rail rows ≤ 8 and trail entries ≤ 10
  (`CAPABILITY_LIMITS.maxJournalEntries`). `apps/ui/package.json` and the lockfile importer are
  unchanged key-for-key.
  **Edge:** an effect that `setState`s on a `.length`; two epoch advances for one mutation; an
  unbounded trail; a settings key added for map state.

- [ ] **F-27 (R-6.1 / AC6 — THE aggregate proof) — one declaration drives rail + map + trail.**
  **Expected:** `projectionMutation.test.ts` green: on a **single** clone of `navTestSurface()` with
  **no other edit**, apply (a) add place `test.archive` under `test.canvas` (key `z`; the same
  add-place mutator binds `x→test.rect` inside `test.archive`), (b) rename verb title `test.rect`
  `Rectangle`→`Box`, (c) add direct alias `q→test.rect`. Navigate to the mutated place and dispatch
  `test.rect` (stroke `x`) through the host; assert in that one snapshot: **(i) rail** —
  breadcrumb/`currentPlace` include `Archive` and the `test.rect` row `title === 'Box'`; **(ii) map**
  — the `Canvas › Archive` block is present, the `test.rect` verb `title === 'Box'`, and the
  `q→test.rect` alias row is present in `aliases`; **(iii) trail** — the new entry's `label === 'Box'`
  and its `placePath`/`pathLabel` includes `Archive`. Q6-02's two invariants still hold (a
  verb-title rename never rewrites a historical entry's label; an alias adds no rail row/`keyHint`),
  so the aggregate cannot be passed by re-deriving history.
  **Edge:** a projection rebuilt from a stale declaration (one surface misses the edit); the alias
  rendered inside a place block; a dispatch not starting from the mutated place.

## Suite-level pass/fail — P4

PASS = F-16…F-27 green, AC1–AC9 each covered by at least one live row, every named literal identical
to the binding block, and every static claim cited to its artifact. A row that cannot be found in
the reporter is a FAIL of that row. A vacuous pass (a scan that scanned nothing, a live-region count
observed only at 1) is a FAIL. The receipt is the POSTED `## Tests Runs` comment plus the committed
suites and the committed §11.4 record.
