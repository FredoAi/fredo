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
  **Expected:** green titles `envelope v1 carries every field from its arguments` (`version === 1`),
  `place path lists root to current and truncates to eight`, `selection dedupes kinds and
  truncates ids`, `verbs follow declaration order and truncate to 64`, `journal last is newest
  first and capped at ten`, `dirty and frozen capability limits`, `strings truncate at 120 and
  envelope is at most 16384 bytes`, `envelope build does not mutate its inputs`.
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
  `V-03 dangling parent`, `V-04 cyclic parent chain`, `V-05 unknown key target`, `V-06 verb does
  not apply to place`, `V-07 duplicate normalized stroke`, `V-08 alias shadows a different-verb
  place key`, `V-09 verb declares no risk`, `V-10 destructive or external without undo or
  consequence`, `V-11 complete binding shadows a longer sequence`, `V-12 incomplete verb`) are
  green; each failing fixture yields exactly ONE diagnostic with the stated `rule` + `code`; the
  passing fixture `validWireframeSurface()` yields zero for all twelve. `orderedViolationSurface()`
  yields exactly `['V-01','V-02','V-09','V-12']`. `validateSurface never throws on a malformed
  surface` and `validateSurface does not mutate its input` are green.
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
  aliases`. The golden file path is
  `apps/ui/src/shared/navigation/__tests__/fixtures/wireframe.navigation.golden.json` and is read
  from disk with `readFileSync` + `JSON.parse`. `commands` ids equal every `publish===true` verb
  id; `actionIds` ends with exactly one `listActions`.
  **Edge:** an unpublished verb appearing in the projection; input reordered (projection
  unchanged); a verb with no aliases (`[]` is valid); a regenerated-at-test-time expectation
  (FAIL — the file must be committed).

- [ ] **F-15 (REQ-10.4, REQ-10.5 / AC1–AC10 build gate) — commands green, no new dependency.**
  Run `pnpm --filter @fredo/ui test:run`, `pnpm --filter @fredo/ui typecheck` and
  `pnpm --filter @fredo/ui build`.
  **Expected:** all three exit 0; `typecheck` reports zero diagnostics; `build` reports zero
  warnings; the whole `test:run` suite has no new failures versus `main`. `apps/ui/package.json`
  `dependencies`/`devDependencies` are unchanged; `pnpm-lock.yaml` shows no `apps/ui` importer
  delta; Grep `fast-check` in `apps/ui` returns nothing.
  **Edge:** a warning-only build (FAIL); a `.skip`ped navigation suite (FAIL); a lockfile-only
  change; a devDependency added "for the property test".

## Suite-level pass/fail

PASS = F-1..F-15 green, all ten ACs covered, every cited `it()` title observed in the reporter,
and all four commands exit 0. Any non-zero exit, any missing named title, or any assertion drift
is a FAIL of that case. A skipped or `todo` navigation test counts as missing. The receipt is the
POSTED `## Tests Runs` comment plus the committed suites — never a `.opencode/tmp/3117/` draft.
