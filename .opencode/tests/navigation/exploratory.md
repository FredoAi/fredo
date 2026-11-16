# navigation — Exploratory

Feature: the headless NavigationEngine P3 core (issue #3117). Edge probes the functional suite
does not drive directly — unvalidated surfaces, coalescing groups, partial undo, root Escape and
key-glyph redaction.

Verification policy: **static** — each probe is a pure-function result read through the committed
vitest suites or a short ad-hoc test in the same `__tests__/` folder. No app, webview or
telemetry surface; none applies.

> **Precondition.** `spec/3117` checked out; run from the repo root. Test paths are relative to
> `apps/ui/src/shared/navigation/__tests__/`. An ad-hoc probe may be added to the relevant suite
> **only** if the named probe below does not already exist — an ad-hoc test is a finding, not a
> substitute for the committed assertion.

## Cases

- [ ] **E-1 (REQ-02.9 + REQ-02.11 / AC2, AC10) — a dispatch on an unvalidated surface never picks a winner.**
  Build `duplicateStrokeSurface()` (two distinct verbs on the same normalized stroke in one place)
  and call `resolveStroke` **without** running `validateSurface` first.
  **Expected:** `{status:'rejected', code:'ambiguous-key'}` — never the declaration-order or
  last-wins winner. Separately, `validateSurface(duplicateStrokeSurface())` reports exactly
  `NAV-E007` (`V-07`). For `aliasShadowsPlaceKeySurface()` the surface is `valid === false` with
  `NAV-E008`, and no intent is produced.
  **Edge:** three bindings on one stroke; declaration order reversed; the same-verb collision
  (`r→place.rect` twice) must resolve at tier 1 and NOT be flagged ambiguous.

- [ ] **E-2 (REQ-05.8 / AC5) — coalescing groups undo as one unit, and never across the gaps.**
  Append three mutation drafts sharing `coalesceKey` and `actor`, with `seq` gaps of 1 and `ts`
  gaps of 400 ms; then a fourth with a `ts` gap of 401 ms; then a `navigation` draft with the same
  key.
  **Expected:** the first three merge into ONE entry (kept later `seq`/`ts`, `groupId ===
  String(firstEntry.seq)`, merged `before` = first entry's `before`, merged `after` = later
  entry's `after`); the fourth starts a new entry; the navigation draft never coalesces. One undo
  of the coalesced entry restores the group's `before` exactly.
  **Edge:** gap 1 vs 2; `ts` 400 vs 401; differing actor but same `coalesceKey` (no merge); an
  undo of the group followed by redo.

- [ ] **E-3 (REQ-04.10 + REQ-05.6 + REQ-05.11 / AC5) — partial undo stops at the first failure and keeps applied inverses.**
  Journal three undoable mutations, make the second inverse application throw (the stub
  `applyPatch` throws on that patch), then run `journal.undo` with `{count:3}`.
  **Expected:** `{status:'partial', code:'undo-failed', applied:1, failedSeq:<second entry seq>}`;
  the one applied inverse is preserved as a separate `mutation` entry with `actor:'system'`; the
  remaining inverses are untouched; the journal is still append-only.
  **Edge:** failure on the newest entry (`applied:0`); `count:101` (clamped to 100); a query that
  matches fewer entries than `count`; a redo after a partial undo.

- [ ] **E-4 (REQ-02.13 / AC2) — root Escape closes the overlay, child Escape pops.**
  Resolve `Escape` at `wireframe.canvas` with `overlayOpen()` true, then with it false; resolve
  `Escape` inside `wireframe.edit`.
  **Expected:** at the root, no intent and no journal entry — the outcome reports `overlayClose`
  so the host closes the innermost overlay. Inside `wireframe.edit`, `place.exit` is dispatched,
  exactly one level pops, the entry carries `exitedBy:'escape'`. A sticky place is never an
  Escape exemption.
  **Edge:** root with no overlay (still no dispatch); three-level nested Escape; Escape while a
  prefix is armed (prefix cancels, no pop).

- [ ] **E-5 (REQ-07.5 + REQ-02.15 / AC7, AC2) — `?` and `/` never appear as tooltip keys or as bindings.**
  Call `formatTooltip` on verbs with 0, 1 and 2 bound keys; probe `isBindableStroke('?')`,
  `isBindableStroke('/')`, and resolve a `'?'` / `'/'` stroke.
  **Expected:** tooltips are `"<title>"`, `"<title> (<key>)"` or `"<title> (<k1>, <k2>)"` with
  `" — <risk>"` only when risk is not `safe`; neither `?` nor `/` appears in any tooltip; both
  tokens are non-bindable and resolve as a tier-4 no-match (hint at most) — never a throw and
  never a dispatch. Glyphs remain legal in rail/map/onboarding prose only.
  **Edge:** a verb whose title contains `?`; the map and ask affordances (`m`, `k`); a tooltip for
  a destructive verb with no keys; a two-character token.

- [ ] **E-6 (REQ-06.4–06.7 / AC6) — caps bind before serialization, not after.**
  Build an envelope from a surface with 65 verbs, an 11-entry journal, 33 selection ids, 9 kinds
  and one 1,000-character label.
  **Expected:** `verbs.length === 64`, `journal.last.length === 10`, `selection.ids.length === 32`,
  `selection.kinds.length === 8`, every string ≤ 120 chars, and `envelopeByteLength(envelope) <=
  16384`; the truncated values are the declared-order prefixes, not re-sorted.
  **Edge:** a `CAPABILITY_LIMITS` mutation attempt on a frozen object; exactly 64/10/32 (no
  truncation); a serialized envelope just over 16,384 bytes.

## Suite-level pass/fail

PASS = E-1..E-6 green with the observed outcome quoted. A probe that requires a new public API
is a plan defect — report it, do not invent the API. The receipt is the POSTED `## Tests Runs`
comment plus the committed suite.

---

# P4 — UI surfaces (issue #3118)

Feature: the rail / map / trail / keycap / announcement surfaces on the DEV prototype route. These
are **unscripted prompts**: each names a state the functional suite does not drive. A confirmed
finding is promoted to `functional.md` as a new `F-` row with an origin note.

Verification policy: **live** where noted; otherwise a short component probe in the same
`ui/__tests__/` folder. A probe may be added **only** if the named case does not already exist — an
ad-hoc probe is a finding, never a substitute for the committed assertion.

> **Precondition.** `spec/3118` checked out; the dev route reachable as in S-9.

## Cases — P4

- [ ] **E-7 (R-1.5 / AC1) — the rail at its narrow floor with the worst content.**
  Resize the window until the rail is at its `NAV_RAIL_MIN_WIDTH_PX` (180) floor; enter the 9-verb place with a 60-char
  verb title on the 8th row and one `Destructive` row.
  **Expected:** `rail.scrollWidth <= rail.clientWidth`; no row wraps to two lines; the title
  ellipsizes while the keycap and the risk word keep their size; the breadcrumb wraps instead of
  scrolling; `more…` stays reachable. Probe: what happens at 160 px (below the declared floor)?
  Record the observation, do not assert a new floor.

- [ ] **E-8 (R-2.1–R-2.5 / AC2) — the map's focus integrity under hostile sequencing.**
  Open the map from `more…`, arrow to the last row, press `Tab` three times, then `Escape` during the
  Tab walk; reopen and close by backdrop; reopen via `?` while a trail undo button holds focus.
  **Expected:** focus never lands on `body`; each close restores the **most recent** invoker (not the
  first one); no double restore leaves focus outside the document order; the trap is released after
  each close. Probe: a verb that mutates the model while the map is open (does the row set change
  under the focused element?).

- [ ] **E-9 (R-4.1–R-4.5 / AC4) — announcement ordering under bursts.**
  Rapidly enter and exit two places with a 300 ms settle between each, arm a prefix and let it
  time out (250 ms), then undo immediately.
  **Expected:** at most one announcement per event; the region's final text is the LAST event's
  message; no message is a concatenation; a timeout announces nothing even when a prefix was armed;
  the dedupe never swallows a genuinely different consecutive message.

- [ ] **E-10 (R-3.2, R-3.5 / AC3) — the trail's degenerate entries.**
  Produce an entry whose verb is undoable in general but whose result had `inverse === null`; then a
  companion entry older than the cap; then compact the trail with the journal full (10 entries).
  **Expected:** no undo affordance on the non-invertible entry and no empty tooltip; the companion
  entry falls off the cap in age order (not by actor); compact renders 10 entries with no path/time
  nodes and still offers undo where the entry is undoable.

- [ ] **E-11 (R-6.1 / AC6) — mutate the declaration twice and re-project.**
  Apply `renamePlace` and then `addDirectAlias` to the same clone without rebuilding between edits.
  **Expected:** the second mutation sees the first (no stale projection), `epoch` advances once per
  mutation (twice total), and every projection reflects both edits — no double-count of the alias
  row, no duplicated breadcrumb segment.

- [ ] **E-12 (AC8 / AC9) — the dev route's blast radius.**
  With the dev route open, check the console and the window for leaked state: a `NavigationAnnouncer`
  region from a previous mount, a stale `document` keydown listener (count listeners before/after
  navigate away and back), and any settings write attributable to the route.
  **Expected:** navigating away and back leaves exactly one live region and one element-scoped
  handler; no `settingsService`/`localStorage` write is attributable to the route; no app is affected
  (`Home` still renders on the plain URL).

## Suite-level pass/fail — P4

PASS = E-7..E-12 probed with the observation quoted. A probe that needs a new public API or a new
dependency is a plan defect — report it, never invent it. The receipt is the POSTED
`## Tests Runs` comment plus the committed suite.

---

# P5 — engine contract changes (issue #3119)

Probes for the four contract changes. Static (pure functions + source reads) unless noted.

- [ ] **E-13 (grammar collisions) — does the extended reserved set create a new ambiguity class?**
  Declare a surface binding both `'-'` and a hypothetical display glyph, then `'+'` and `'ArrowUp'`
  in the same place, and one place binding `'+'` while a child binds `+` as a first step of a
  longer sequence.
  **Expected:** duplicate strokes on one place ⇒ `ambiguous-key` (never a winner);
  `'+'` as a single stroke and as a prefix of a longer sequence resolve without throwing (the
  hint/armed path accepts a non-letter token); `?`/`/` remain non-bindable. **Probe:** does the
  which-key hint render an arrow or `+` sensibly, or as a bare token?
- [ ] **E-14 (V-08 root scoping — the residual risk) — a legitimate alias that a FUTURE root binding would shadow.**
  Take the pilot's declaration and add `r` to the ROOT keys (bound to any other verb) without
  removing the alias `r→wireframe.create.rect`.
  **Expected:** exactly one `NAV-E008` at the root; the resolver never dispatches both (tier 1
  wins). Probe: does the diagnostic name BOTH verbs and the root place id (it must, so a future
  author can act on it)?
- [ ] **E-15 (transient auto-exit — double-pop and no-pop paths)** *(live, in
  `.opencode/tests/wireframe-navigation/`)* — see E-N5/E-N6 there; the engine-side probe is: a
  mutation whose effect is `patch:null` in a transient place must NOT pop and must write no
  entry, while a mutation with a patch pops exactly once. Record cursor + entry count for both.
- [ ] **E-16 (`placeRows` — never a second list) — mutate the declaration and re-project.**
  Add a seventh child place to a clone of the pilot surface (key `z`), rebuild the rail model,
  and confirm the place rows gain it while `rows`/`overflow`/`actionCount` are unchanged.
  **Expected:** one declaration, two projections, no second list; removing the place restores the
  six. Probe: does `CommandRail` render an empty place-rows group when the current place is a
  leaf (it must not)?

## Suite-level pass/fail — P5

PASS = E-13..E-16 probed with the observation quoted. A probe needing a new public API is a plan
defect — report it, never invent it.

---

# P8 — decommission (issue #3122)

Probes for the post-deletion surface: the states the scripted P8 rows do not drive. A confirmed
finding PROMOTES to `functional.md` as a new `F-` row with an origin note. Live probes name their
receipt; a probe that needs a new public API or a new dependency is a plan defect.

- [ ] **E-17 (double mount) — can a second `NavigationProvider`/announcer appear?**
  Mount a second provider in a harness (or open the terminal window and the main window, then the standalone app window) and read every `[data-testid="navigation-announcer"]` + `[aria-live]`.
  **Expected:** each webview has exactly ONE announcer and ONE chord listener, idempotent install; a second mount in the same webview is a defect (two regions) — record it as a finding, never a PASS. Probe: is the chord listener re-added on an HMR remount?

- [ ] **E-18 (retired id via every entry point) — does a deleted app fail closed?**
  Ask the launcher, `fredo open-app <retired-id>`, the companion `open_app` skill and `open_app_window` for a deleted id (e.g. an old saved session or a hand-crafted call). **Expected:** zero windows open, a typed not-found/unknown outcome, no throw/console error; no static list can resolve it. Probe: a stale persisted open-app request from a previous version.

- [ ] **E-19 (old companion client) — a call to a deleted command id is rejected, not silently run.**
  Invoke `app_command_intent` with a deleted app id and with a deleted command id on a retained app. **Expected:** `app_command_intent_result` reports `Invalid`/`Failed` (never `Performed`), no journal entry, no window; the manifest has no such id. Probe: a command id that exists on another surface.

- [ ] **E-20 (two webviews) — the chord/announcement layer is per-webview.**
  With the terminal window and the main window open, fire `primary+space` in each. **Expected:** the hosting webview toggles the launcher once per press; the other webview does not double-toggle; each has its own one region; no cross-webview duplicate announcement. Probe: teleporting the companion between windows.

- [ ] **E-21 (host absent) — a stroke with no navigation host mounted.**
  On a bare harness/frame with no app host, fire a declared app stroke and one global chord. **Expected:** the app stroke does nothing (no throw); the global chord falls back to the shipped `focusNextWindow`/`focusPreviousWindow`/`runWindowLauncherToggle` so the frame stays usable. Probe: a host registered then unregistered mid-sequence.

- [ ] **E-22 (reintroduction attempt) — can a second path quietly come back?**
  Try to re-add a `data-hotkey` attribute, a legacy element-key module import, or a manual `feature.commandSurface` in a throwaway local edit, then build/test. **Expected:** the `legacyAbsence.test.ts` guard and `pnpm --filter @fredo/ui build` FAIL (a deleted symbol cannot be imported); the reintroduction is rejected before merge. Probe: a name-obfuscated shim (does the ADR-7 table catch it?).

## Suite-level pass/fail — P8

PASS = E-17…E-22 probed with the observation quoted. A probe that needs a new public API/new dependency is a plan defect — report it, never invent it. A confirmed finding is promoted to `functional.md` with an origin note.
