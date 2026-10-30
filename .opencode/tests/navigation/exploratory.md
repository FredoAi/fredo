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
