# navigation-prose-retirement — Functional

Durable functional suite for the **retirement of the navigation ENGINE's prose** (Issue #3153,
slice 3 of 3 — documentation, ADR status, engineering rules and test-suite prose only). Rows map
1:1 to the QA Plan's `## QA Expert` section, keyed to the Software Architect's EARS ids. Names bind
verbatim to the plan's `### API Contracts & Data Models` block — do not invent alternative script
names, line shapes or paths.

- **`P-1` … `P-12`** — round 1, AC1–AC4 + the first AC5 sweep, keyed `R-1.1` … `R-5.3` and
  NFR-1 … NFR-6.
- **`P-13` … `P-18`** — round 2 (audit restart, root cause `scope`), the **AC5 remainder**, keyed
  `R-5.4` … `R-5.9`. AC1–AC4 are merged (PR #3164) and their rows are not re-planned.

> **Verification policy: `static` — every row.** Every one of AC1–AC5 is a predicate over
> **committed prose and committed scripts**, so there is no runtime behaviour to observe and a live
> receipt could not discriminate: the subject of the ACs is precisely what is *not* running (G-408).
> Each row is proved by `Read`/`Grep` plus the committed gate wrapper
> `.opencode/scripts/run-exitcode.ps1`, plus the two regression build receipts. **No `tauri_*` call
> belongs anywhere in this suite** (NFR-5): a tester that boots the app to "check the docs" has left
> the plan, and a screenshot cannot discriminate an absence.

> **Gate wrapper.** Every command exit code is asserted through
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"` (the sandbox forbids
> chaining, so `$LASTEXITCODE` is otherwise unreachable). The printed `EXITCODE=<n>` line is the
> receipt.

> **Forward-binding rows (P-1, P-2, P-3).** These rows test the guard
> `.opencode/scripts/check-navigation-prose-retired.ps1`, which **ST-1 has not authored yet** at
> suite-seeding time. They are therefore **forward-binding**: they name the exact printed lines the
> ST-1 author must produce, so the artifact is measured against a written contract instead of being
> graded after the fact. A tester reaching these rows before ST-1 lands records `NOT RUN — guard
> absent (ST-1)`, never a PASS.
>
> **Evidence durability (G-415).** Every evidence artifact named in this suite is a **NON-DRAFT,
> durable record** — the POSTED `## Tests Runs` comment on the feature issue, or a committed /
> non-consumed path. **Never** a `.opencode/tmp/3153/` timeline draft (dev summary, tests-runs
> draft, triage plan, fix plan): the transition posts and consumes those, so the record is gone
> when the tester looks.

> **This suite spells the banned tokens by construction.** It asserts their absence, so it names
> them. It is therefore allowlist entry #7 of the guard (G-431) and P-3 asserts that entry exists by
> name. Do **not** obfuscate a token here to "be safe" — an obfuscated token is a weaker assertion.

## AC1 — the scoped absence proof (the guard)

- [ ] **P-1 — the guard's plain run over its two roots.** `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-prose-retired.ps1"`
  from the repo root.
  **Expected:** printed `EXITCODE=0`; a `Scanned files: N` line with **N > 0**; an
  `Ignore filter: N path(s) excluded (git check-ignore)` line present; a
  `HITS: 0 (0 not covered by the evidence allowlist)` line; and a **per-class count line for each of
  the five classes A–E**. PASS = all six observations. The five printed line shapes are re-derived
  from the corrected precedent `check-companion-commands-retired.ps1:1240-1248,1262`;
  `check-navigation-retired.ps1:736,741,763` proves `Scanned files:`/`HITS:` are the in-repo
  convention.
  **Edge:** (a) `Scanned files: 0` is a **FAIL**, not a pass — the guard's own exit 2 covers it, so
  exit 0 + 0 scanned is a guard defect. (b) A missing `Ignore filter:` line is a FAIL (that count is
  the R-1.5 universe receipt). (c) A per-class count line absent for any class = FAIL even at
  `HITS: 0` (a class with no printed count cannot be shown non-vacuous). (d) Run twice consecutively
  — both runs byte-identical on the six lines (determinism, NFR-4).
- [ ] **P-2 — the guard's seven self-test controls.** `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-prose-retired.ps1 -SelfTest"`.
  **Expected:** `EXITCODE=0` **and** the transcript records **seven** control lines verbatim, one per
  control, in the architect's order: **1 POSITIVE** (one leg per token, iterated **from** the token
  data — printed leg count must equal the declared token count), **2 NEGATIVE** (allowlisted hit
  reported but not failing; the same hit moved outside fails), **3 SEEDED ROOT**
  (`docs/__nav_prose_absence_probe__.md`, untracked non-ignored, caught at that exact `path:line`,
  removed in `try/finally`), **4 OUT-OF-ROOT** (`spikes/__nav_prose_probe_outside__.md` not
  scanned), **5 IGNORED NON-SCAN** (`.opencode/tmp/__nav_prose_probe_ignored__.md` not scanned
  **after asking git for its own precondition**), **6 SELF-REFERENCE** (plain run clean while the
  script spells every token), **7 ALLOWLIST AUDIT** (exactly 8 entries; none matching a forbidden
  prefix except the named exception; no `apps/` entry).
  **Edge:** (a) Exit 0 with **fewer than seven** control lines = FAIL (G-430: record the lines, never
  only the exit code). (b) Post-conditions: `Test-Path docs/__nav_prose_absence_probe__.md` is
  `False`, `Test-Path spikes/__nav_prose_probe_outside__.md` is `False`, `Test-Path
  .opencode/tmp/__nav_prose_probe_ignored__.md` is `False` — a leftover probe is a FAIL **even at
  exit 0**. (c) Control 5 must fail **loudly** if its ignore rule has gone, not silently pass.
  (d) Control 1's leg count ≠ declared token count is a FAIL by construction.
- [ ] **P-3 — the allowlist is 8, and none is a current-state doc or product source.** `Read` the
  `$EvidenceAllowlist` block in `.opencode/scripts/check-navigation-prose-retired.ps1` and compare
  entry-by-entry against §`API Contracts` entry #1; then `Read` the refusal predicate and its
  `$ForbiddenAllowlistPrefixes`/`$RequiredExceptions` tables.
  **Expected:** the 8 entries are exactly `docs/NAVIGATION_ENGINE.md`, `docs/adr/`,
  `docs/UX_FLUENCY_RESEARCH.md`,
  `docs/agentic-pipeline/evaluations/3120-pilot-exit-review-template.md`,
  `.opencode/tests/retired-navigation/`, `.opencode/tests/navigation-retirement/`,
  `.opencode/tests/navigation-prose-retirement/`, `.opencode/tests/companion-command-removal/`.
  `Test-Path` each → all `True`. Zero entries start with `apps/`. The predicate **implements** the
  header claim: `apps/` prefix → exit 2; a listed `$RequiredExceptions` entry → accepted; any other
  `$ForbiddenAllowlistPrefixes` prefix → exit 2 **before scanning**.
  **Edge:** (a) **G-430 — read the predicate, not the header**: a header that claims the refusal
  while the loop accepts a forbidden prefix is a FAIL even though the allowlist looks right.
  (b) `docs/agentic-pipeline/evaluations/3120-pilot-exit-review-template.md` must be accepted **and**
  a sibling `docs/agentic-pipeline/playbooks/software-architect.md` entry must be **refused with
  exit 2** — control 7 asserts both directions; reproduce the refusal leg in P-2's control-7
  transcript line. (c) An allowlist entry whose path does not resolve is a FAIL (a dead entry is
  noise that hides a narrowing).

## AC2 — every superseded decision record says so and points forward

- [ ] **P-4 — the decision-record status table.** `Read` the `- **Status:**` line at line 3 of each
  of `docs/adr/0001`, `0002`, `0003`, `0004`, `0005`, `0006`, `0007`, `0008`; `Read`
  `docs/NAVIGATION_ENGINE.md:1-8`; `Read` `docs/UX_FLUENCY_RESEARCH.md:1-6`.
  **Expected:** (a) `0001`, `0002`, `0004`, `0005`, `0006`, `0007` each carry
  `- **Status:** Superseded …` naming **both** halves — the reversal (the companion is the
  interaction surface, not the keyboard) **and** where the product went instead. (b) `0003` keeps
  `Superseded by [ADR-8]` (verified at `0003:3`) **and** names the second supersession (the
  `dispatch()`/`describeContext` vocabulary). (c) `0008:3` reads **exactly** `- **Status:** Accepted`
  — byte-identical to the pre-slice line — with `0008:4` `Supersedes: ADR-3` intact, plus an appended
  amendment note naming the surviving grounding seam
  (`registerCompanionGrounding`/`readCompanionGrounding`, `shared/companion/grounding.ts:80,101`).
  (d) `docs/NAVIGATION_ENGINE.md` line 1 is `# NavigationEngine — Normative Contract` (verified)
  followed within `:2-10` by a `SUPERSEDED` banner naming the reversal, the date/issue and where the
  product went instead. (e) `docs/UX_FLUENCY_RESEARCH.md` **still exists** (673 lines at planning)
  and its `:1-5` banner's forward pointer now describes the shipped model. (f) Reading `0001`→`0008`
  in order: eight status lines, none claiming the engine ships.
  **Edge:** (a) **ADR-8 must NOT be superseded** — a `Superseded` on `0008:3` fails the slice
  (over-superseding is a named risk). (b) A bulk-stamped identical reason on all seven ADRs is a
  FAIL: each names its own carrier-less decision (e.g. `0005`'s glossary lived in
  `NAVIGATION_ENGINE.md` §1; `0004`'s journal became Wireframe's app-local
  `WIREFRAME_HISTORY_LIMIT = 100`, `wireframeHistory.ts:27`). (c) Deleting `UX_FLUENCY_RESEARCH.md`
  or `NAVIGATION_ENGINE.md` to go green is a FAIL — `Test-Path` both. (d) A `Superseded` line that
  does not name where the product went violates AC2's second half.

## AC3 — the binding rules bind only on what exists

- [ ] **P-5 — `docs/ENGINEERING_RULES.md` binds only on what exists.** `Read`
  `docs/ENGINEERING_RULES.md`; cross-check the guard's per-file zero for that file from P-1; then run
  the named-path census.
  **Expected:** (a) Zero hits in this file for **every** class A–E (the rule at `:66` — the falsified
  one, verified verbatim at planning — is gone). (b) The surviving keyboard facts appear as **≤ 4**
  bullet rules covering exactly: the three platform chords, the plain-`Tab`/`Shift+Tab` boundary
  hand-off, the suppression precedence `terminal > modal > text-entry > none`, and "a focused
  terminal receives keystrokes by focus; there is no keyboard-navigation model". (c) **Named-path
  census:** every path the file cites resolves — `Test-Path` each of `FredoApplicationClass.ts`,
  `StreamContext.tsx`, `rtdb/ingest.rs`, `rtdb/merge.rs`, `rtdb/store.rs`,
  `apps/ui/src/app/theme/system.ts`, `shared/utils/colorTint.ts`,
  `applications/settings-app/components/SettingsSurface.tsx`, `apps/tauri/src-tauri/src/lib.rs` →
  all `True`; the only expected casualty, `shared/navigation/ui/globalKeys.ts`, is named **nowhere**
  in the file.
  **Edge:** (a) `dispatch()` is **NOT** a Class-B token — the AC names it explicitly, so run the
  **Grep tool** for the escaped regex `dispatch\(` on this file and require **0 matches**, as an
  **additive** check the guard cannot make (this is not a widening of any guard class; it is a
  second, separate predicate). Same for `validateSurface`/`NavigationHost` (guard-covered,
  re-asserted). (b) A rule that cites a path which does not resolve is a FAIL even when its prose is
  correct (R-3.3). (c) Five or more keyboard bullets = FAIL (the AC says "small rules"; the
  architect binds ≤ 4). (d) The pre-existing text at `:62-65`/`:67-75`/etc. must be **byte-unchanged**
  — a rewrite that "tidies" unrelated rules is out of scope and a FAIL on PR-6.

## AC4 — `docs/ARCHITECTURE.md` describes the shipped model

- [ ] **P-6 — `docs/ARCHITECTURE.md` describes the shipped model.** `Read` the module map (`:560`,
  `:578-582`), the two replaced sections (formerly `:593-621` and `:623-629`), the five app rows
  (`:636,639,640,642,643`), the two installed-app rows (`:1057,1074`), and the companion paragraph
  (`:842`).
  **Expected:** (a) The `shared/` map has **no** `navigation/` entry and **no** `ui/`
  navigation-surfaces entry, and names the surviving seams: `window-system/` incl.
  `platformChords.ts`, `chordSuppression.ts`, `traversal.ts`, `PlatformChordHost.tsx`;
  `companion/grounding.ts`; `hooks/useReducedMotion.ts` — each confirmed present on disk. (b) Both
  deleted section **positions** now carry a shipped-model section describing the window-system chord
  listener + `Tab` hand-off, focus-derived terminal passthrough, and application-level companion
  grounding with the payload fields `version`/`appId`/`appName`/`selection{count,kinds,label,ids}`/
  `dirty` (matches `grounding.ts:31,43-60,80,101`). (c) The five app rows carry no "NavigationEngine
  consumer"/declared-surface claim and instead name the pointer surface. (d) The companion paragraph
  states S2's end state in its own words: exactly the three static skills
  `open_app`/`close_app`/`doom_mode` from the zero-argument `companion_skill_registry()`
  (`status.rs:691`; the three names pinned at `status.rs:1467`), handle-free, nothing generated, no
  per-application command path — and **no longer defers** the rewrite. (e) The two installed-app rows
  state isolation without `NavigationHost`, `dispatch()` or "declared navigation surface".
  **Edge:** (a) `docs/ARCHITECTURE.md:578`'s companion module-map line is **already correct** and
  `:917`'s companion-skills row is **already correct** (static-three-only since #3152) — touching
  either is out of scope (PR-6). (b) Deleting the two sections' *positions* rather than replacing
  their content in place is a FAIL: cross-references and reading order must survive (re-read the two
  adjacent headings). (c) A sentence that names a symbol outside the shipped-model facts block
  without citing a resolving path violates R-3.3's discipline.

## AC5 — no durable test suite has a deleted subject

- [ ] **P-7 — the surviving-suite sweep, read ROW BY ROW.** For every file in the Domain Model §4
  stale set (`launcher/functional.md`, `launcher/regression.md`, `wireframe/functional.md`,
  `wireframe/regression.md`, `wireframe/smoke.md`, `wireframe/exploratory.md`,
  `terminal/functional.md`, `terminal/regression.md`, `companion/functional.md`,
  `applications-rename/regression.md`), open the named line ranges; then open
  `.opencode/tests/retired-navigation/RETIRED.md` §`#3153 — prose dispositions (slice 3 of 3)`
  (heading verbatim).
  **Expected:** (a) **No stale sentence survives** in any of those ten files — and **none carries an
  in-place `SUPERSEDED` marker** (R-5.2 forbids it in a non-allowlisted suite). (b) Every replaced
  row's behavioural expected outcome is still present in its replaced form and **not weakened**.
  (c) Each replaced/removed site has **one** ledger row
  `| path:line-range | suite | disposition | replacement | reason |` with disposition ∈
  `CORRECTED`/`REMOVED`/`SUPERSEDED`, `SUPERSEDED` appearing **only** for `docs/adr/**` +
  `docs/NAVIGATION_ENGINE.md`; each row names its successor row in
  `navigation-retirement/functional.md` (`Q-16..Q-32`, verified present) and its S1/S2 evidence.
  (d) The guard (P-1) reports **zero** non-allowlisted hits under `.opencode/tests/**`.
  **Edge:** (a) A ledger row whose `path:line-range` no longer matches the file's content is a FAIL
  (the row must quote the deleted claim). (b) `SUPERSEDED` on any non-allowlisted suite = FAIL.
  (c) A stale row silently deleted without a `REMOVED` ledger row = FAIL ("no row's outcome is
  weakened **or deleted**"). (d) The two deliberate non-targets are **not** swept:
  `contrast-gate/functional.md:26,28` ("declared surfaces × states" = theme `SurfaceId`s — verified)
  and `applications-rename/regression.md:18` ("tile keyboard navigation" = launcher grid roving) — a
  rewrite of either is a FAIL, the latter gets a `CORRECTED`-wording disposition note only.
  (e) `RETIRED.md:1-236` is **byte-unchanged** (append-only).
- [ ] **P-8 — `.opencode/tests/hotkeys/` is absent and is not cited as work.** `Test-Path
  .opencode/tests/hotkeys` → `False`; then use the **Grep tool** (not a bash `grep` — the tester's
  bash is deny-by-default, `opencode.json:380-381`) with the escaped regex
  `\.opencode/tests/hotkeys/` over `.opencode/tests/**`, and again over `RETIRED.md` §`#3153`.
  **Expected:** (a) `Test-Path` returns `False` (the 73-entry `.opencode/tests` listing at planning
  has no `hotkeys/`). (b) **Zero** matches for the escaped regex in any `.opencode/tests/**` file —
  the six pre-existing citations re-derived by QA must all be gone, at exactly these six sites in
  five files: `.opencode/tests/doom-mode/regression.md:213`,
  `.opencode/tests/workspace-layout/regression.md:29` and `:49`,
  `.opencode/tests/doom-autoplay-fluency/regression.md:59`,
  `.opencode/tests/applications-rename/regression.md:65`,
  `.opencode/tests/wireframe/functional.md:1236`. (c) `RETIRED.md` §`#3153` carries **no row**
  claiming a `hotkeys` suite was retired — a manufactured retirement row is the failure AC5 names.
  **Edge:** (a) **The architect's "cited nowhere" was FALSE — six citations in five files.** P-8
  binds the AC5 clause to *those six*, not to a vacuous zero. (b) **Scope the ban to the suite set,
  deliberately:** `docs/agentic-pipeline/playbooks/references.md:1499` also contains the literal
  string, inside a historical `tests-commit` re-validation log (G-287-class record). It is
  **excluded by design** — it is a past-incident record, not a work cite, it is under the
  architect's forbidden `docs/agentic-pipeline/` prefix (so it can never be allowlisted), and
  `.opencode/tests/hotkeys/` is in **no** token class A–E, so the guard never sees it. A row
  demanding a repo-wide zero here would be **undrivable by construction** (G-440). (c) The word
  "hotkeys" appearing in unrelated shipped copy (e.g. a `settings-nav-hotkeys` id) is **not** a hit
  — the ban is on the exact path string, which is why the pattern is the escaped **path**, never the
  bare word.

## AC1 FAQ clause + AC2 index half

- [ ] **P-9 — the FAQ keeps its keyboard answer, and the index points forward.** `Read`
  `docs/FAQ.md:26-33` and `docs/README.md:28-29`.
  **Expected:** (a) The question **still exists** — the heading at `:26` (verified:
  `### Can I use Fredo entirely with the keyboard?`) is not deleted, merged or re-titled; ST-5 may
  re-word the answer, never the question's existence. (b) The replacement answer names the
  **companion** as the interaction surface, the **three chords**, the **`Tab`** boundary hand-off,
  and **terminal focus-pass-through**. (c) `docs/README.md:28` (UX research row) points at
  historical/superseded status; `:29` (NAVIGATION_ENGINE row) points at superseded status — neither
  advertises a shipped model nor a contract "P3 builds against".
  **Edge:** (a) A deleted FAQ section is a FAIL (the slice's own named edge case). (b) A
  "Yes — entirely!" that still names all four tokens passes P-9 and is **false** — covered by P-12.
  (c) The surviving sentence "`>` is ordinary search text in the launcher command bar" **stays true**
  and may stay (the launcher's own query field survives; only the deleted three-surface bar goes).
  (d) `docs/README.md:72`'s `spikes/3115-…` row is **outside** the scanned roots — not a row target,
  not a failure.

## NFR — the guard is actually run

- [ ] **P-10 — the guard is actually run: harness leg + CI job.** Use the **Grep tool** over
  `.opencode/scripts/test-scripts.ps1` for the guard; `Read` the `filters:` block and `outputs:` of
  `.github/workflows/validate.yml:19-60` and the aggregator `:496-528`; `Read`
  `docs/CI_GATE_CONTRACT.md:40`. Then take the CI receipt on the spec PR's final head SHA
  (`gh pr checks <PR> --watch` — permitted for the tester, `opencode.json:387`).
  **Expected:** (a) `test-scripts.ps1` carries the syntax entry
  `Test-Script-Syntax "check-navigation-prose-retired.ps1"` inside the existing `Other scripts:`
  block (`:4698-4716`, which today lists six scripts + a conditional `verify-env-isolation.ps1`)
  **and** the `-SelfTest` leg `& powershell -File <guard> -SelfTest` asserting exit 0. (b)
  `validate.yml` gains a `docs:` key in `filters:` (`:34-60` today has only `ui:`/`rust:`), a
  matching `docs:` entry in the `paths` job `outputs:` (`:23-25` today has only `ui`/`rust` —
  **without it `needs.paths.outputs.docs` is empty and the job never runs**), a `docs-validate` job
  with `needs: paths` + `if: needs.paths.outputs.docs == 'true'` running the plain guard **and**
  `-SelfTest`. (c) The `validate` aggregator's `needs:` (`:497`) gains `docs-validate`, and its
  `success|skipped` loop (`:514-524`) is **unchanged** — `validate` stays the only required check.
  (d) `docs/CI_GATE_CONTRACT.md:40`'s "Docs-only / no-stack PR" bullet no longer says a docs-only PR
  runs **nothing**. (e) CI receipt: on the spec PR head SHA the `docs-validate` job **ran** (not
  `skipped`) and both its steps are green; the `validate` check is green.
  **Edge:** (a) **G-410 disclosure — `logic-verified, no discriminating run`** for the *skipped*
  leg: proving `docs-validate` skips on a UI-only diff needs a diff matching neither path filter,
  which this spec's PR cannot produce (its diff is `docs/**` + `.opencode/**` + `.github/**`, so
  `docs` matches every time). That leg is quoted-logic only and the row says so — it must never be
  presented as a run. (b) A `docs:` filter **without** the matching `outputs:` entry is a FAIL: the
  job exists on paper and never runs (the exact silent failure this row exists to pin). (c) A new
  required check beyond `validate` is a FAIL (scope).
- [ ] **P-11 — the plain-run harness leg lands at ST-7; the harness is green.** Use the **Grep tool**
  over `.opencode/scripts/test-scripts.ps1` for the plain-run guard leg; then
  `run-exitcode.ps1 -Command "powershell -File .opencode/scripts/test-scripts.ps1"`.
  **Expected:** (a) The plain-run leg (`& powershell -File <guard>` asserting exit 0, no
  `-SelfTest`) is present **in the final tree** — and its git-arrival commit is **ST-7's**, verified
  with `git log -1 --format=%s -- .opencode/scripts/test-scripts.ps1`. (b) The full harness prints a
  results block ending `All pipeline scripts validated.` with `EXITCODE=0` and **`Failed:` absent**
  from the `=== Results ===` block (`:4845-4863`).
  **Edge:** (a) **Ordering is load-bearing:** the guard is deliberately RED between ST-1 and the last
  sweep, so a plain-run leg landing before **ST-7** would red the harness for every developer in the
  slice. **A P-11 PASS on a mid-slice tree is not evidence** — the receipt must name **the final
  tree at the spec PR head**. (b) A harness run whose `Total:`/`Passed:` counts are absent is not a
  receipt. (c) `Skipped:` > 0 warrants recording **which** legs skipped — a skipped leg is not a
  passed leg (G-279's discipline).

## AC1 FAQ clause (negative half) — the copy contract

- [ ] **P-12 — the FAQ answer makes no false promise.** `Read` `docs/FAQ.md:26-33` and assert each
  forbidden claim's absence.
  **Expected:** All absent from the answer: (a) an unqualified affirmative ("entirely / fully /
  completely with the keyboard" as the answer); (b) any per-application key binding, named key,
  verb, or "place" to step into; (c) the deleted bottom navigation command bar that showed your
  current place and its verbs, the navigation map via `?`, or the activity trail; (d) that
  navigation chrome is announced to screen readers / any navigation-announcement channel; (e) a
  Settings → Hotkeys pane, saved hotkey overrides or recorded key sequences; (f) that the companion
  is a typed slash-command line (it is the conversation surface).
  **Edge:** (a) The launcher's own query/ask field survives (`LauncherCommandBar.tsx`) — forbidding
  "command bar" outright would over-reach; the ban is on the **place-and-verbs bar**. (b) Once
  (c)/(d)/(e) are gone, the deleted vocabulary is also gone, so P-1's guard independently
  corroborates this row — a P-12 PASS with a P-1 red is a contradiction to re-read. (c)
  `docs/FAQ.md:38`'s installed-app sentence becomes a **plain isolation statement** (own window, own
  origin, no backend commands, cannot declare commands) — it must not mention a keyboard/navigation
  surface at all.

## AC5 remainder — the round-2 residual sweep (audit restart, root cause `scope`)

> **Scope.** AC1–AC4 passed the audit and are merged (PR #3164); P-1…P-12 stand and are **not**
> re-planned. These six rows are the AC5 **remainder**: the executed enumeration (round-1 plan's
> Domain Model §2) found **15 files** still carrying PRESENT-asserting rows about deleted subjects —
> the 8 the auditor named plus 7 more, including a whole surviving suite
> (`companion-audio-skill-parity/`, 4 files) and a false row **inside the guard's own allowlist**
> (`navigation-retirement/regression.md:88-92`, R-14). The round-1 sweep set was enumerated from an
> illustrative list rather than executed (G-444); P-13 is the executed instrument and its post-sweep
> re-run is the acceptance receipt.

- [ ] **P-13 (R-5.4 / R-5.5 / R-5.7 + R-5.6's offer-set half) — the 28-search predicate, re-run POST-sweep (the second instrument).**
  Run **all 28** searches of the plan's Domain Model §2 (the `## Triage Plan` comment carries the
  table) with the **Grep tool** — `pattern` = that row's regex **verbatim**, `path` =
  `.opencode/tests` (recursive; add `include: *.md` only on rows 13/14, which declare it). The Grep
  tool's `pattern` + `path` **are** the command; re-running the pair reproduces the count. Run them
  in §2's numbered order, one line each.
  **Expected:** for **each** search record exactly four things — (a) the `pattern` string, (b) `path`,
  (c) the tool's reported **hit count**, (d) the **COMPLETE `file:line` list** of returned hits
  (every hit, never a sample). Then **classify every returned hit**: **A** = ABSENCE-asserting (the
  sentence asserts the subject does NOT exist / is gone / count 0 — correct, AC5 wants it);
  **L** = the hit's file is inside the guard's 8-entry evidence allowlist **and** the line must spell
  the tokens (ledger / S1 / S2 / seeded suite; G-431); **X** = the ONE named substring false positive
  (Edge (d)); **P** = PRESENT-asserting (asserts the subject renders / drives / lists / is current).
  **PASS = zero remaining P hits across all 28 searches AND every returned hit carries one of
  A / L / X.** An **unclassified hit is a FAIL** (G-444: every line of the result is either owned or
  dispositioned). The receipt is the counts + the complete lists + the classification in the POSTED
  `## Tests Runs` (G-415).
  **Edge:** (a) **The pre-sweep counts in §2 are the BASELINE, not the target** — the sweep
  *corrects* most sites rather than deleting them, so a corrected row still contains the token (e.g.
  `launcher/functional.md:2305` must still read "`launcher-confirmation` does not exist"). A
  post-sweep count is therefore **expected to differ** from §2's: **do not pin any post-sweep count**
  (G-444 — re-run, don't predict). (b) **`L` is a path fact, `A` is a content fact — do not conflate
  them.** `navigation-retirement/regression.md` is allowlisted, so a hit there is *path-L*; after
  P-18 corrects R-14 its content is absence-asserting, so record it **A** with the allowlist noted.
  Recording it as "L, no further check" is exactly the blind spot this row closes. (c) **`X` is
  mandatory, not a loophole** — the only admissible X is the literal substring false positive below;
  any other X is a FAIL. (d) **The known X:** the row-22 pattern contains `55 rows`, which matches
  `llama-setup/functional.md:6` — the text `#2855 rows` — a substring coincidence in an unrelated
  suite that no sub-task owns and which must **NOT** be swept; record it
  `X — "#2855 rows" substring, out of subject` with the line quoted. (e) **Text mode (G-419):** the
  Grep tool regex is a raw, **case-sensitive** match over committed Markdown — a token inside a fenced
  code block, a quoted example or a comment **counts**; a hit is a literal occurrence, never a
  semantic claim. (f) **The QA suite itself is an L hit** — the row-11/13 alternatives
  (`describeContext`, `NavigationHost`, `NavigationEngine`, `validateSurface`) are spelled by
  `.opencode/tests/navigation-prose-retirement/functional.md:102,106,138,157,163` and
  `exploratory.md:18`; classify **L** (allowlist entry #7), never P — a tester who classifies them P
  fails the round on its own suite. (g) A hit outside the 15-file P-set that is neither A, L nor the
  named X is a FAIL: a missed P site or a false positive to adjudicate in the verdict — never
  silently dropped. (h) Run each search **twice** in the same tree: identical counts both times
  (NFR-3 determinism); a count that moves is a FAIL.
  **Receipt:** the per-search table (pattern / path / count / `file:line` list / dispositions) in the
  POSTED `## Tests Runs`.

- [ ] **P-14 (R-5.9) — the internal-consistency read of `launcher/functional.md` (the row that would have caught the round-1 defect).**
  `Read` **F-165** at `launcher/functional.md:2596-2612` in full (including its `- **Edge:**` lines at
  `:2609-2611` and its `Receipt` at `:2612`), then `Read` the siblings **F-141** (`:2302-2310`),
  **F-132** (`:2203-2213`), **F-163** (`:2564-2578`), **F-167** (`:2633-2645`) and `Read` **R-86** at
  `.opencode/tests/launcher/regression.md:1000-1008`. Compare their **expected observables**, not
  their vocabulary.
  **Expected:** all six rows mutually consistent, asserted one clause at a time — (a) **F-165 says the
  confirmation host does NOT exist**: `[data-testid="launcher-confirmation"]` count **0**, matching
  F-141 (`:2305`, "NO confirmation dialog … does not exist") and R-86 (`:1006-1007`,
  "`requestLauncherConfirmation` does not exist … was its only host"); (b) **F-165 does NOT drive
  `app_command_intent`** and asserts no relay / no result event, matching F-132 (`:2207-2210`, zero
  matches in `apps/`); (c) **F-165 names no palette and no action list**, matching F-163
  (`:2567-2569`) and F-167 (`:2636-2637`, all three counts **0**); (d) **F-165's surviving clauses are
  preserved verbatim** — `Ctrl+Space` opens once and closes once per press with focus restored, the
  voice/dictation path is unchanged (a listening indicator renders; the transcript is a message to
  Fredo), and no handler is registered for `fredo.palette.openActions`; (e) F-165's `Edge` no longer
  asserts a "request resolves `false`" path (that presupposes a requester). PASS = (a)–(e) all hold
  simultaneously in the same file.
  **Edge:** (a) **A newly authored row contradicting a sibling reconciled row is a defect in the NEW
  row until the reverse is proven** (G-444) — if F-165 and F-141 disagree, F-165 is wrong by
  construction, not "the file has a conflict". (b) **This is an assertion comparison, not a token
  scan** — F-132's scan target is `apps/`, so F-165 merely *mentioning* `app_command_intent` inside a
  sentence that says it does not exist is **not** a violation; the FAIL is F-165 asserting the
  command **works** or the confirmation host **mounts**. Stated so a literal tester does not fail a
  correct absence sentence. (c) **Deleting F-165 is a FAIL** — its surviving half is true and its
  coverage must remain (successor `Q-19`); the row is corrected, not removed. (d) A PASS here with
  P-13 still reporting a P hit on `:2596-2612` is a contradiction to re-read before recording either.
  **Receipt:** the six quoted rows + the clause-by-clause comparison in the POSTED `## Tests Runs`.

- [ ] **P-15 (R-5.8) — F-165's post-correction assertions.**
  Read/drive `launcher/functional.md:2596-2612` as written.
  **Expected:** **text (static, `Read`)** — the row asserts the confirmation host is **absent** (count
  **0**; no `role="alertdialog"` for the destructive companion intent) and that **no**
  `app_command_intent` / `app-command-intent` / `app-command-intent-result` drive remains in its Steps
  or `Edge`; it **keeps** the three surviving clauses of P-14(d) verbatim; its title states the
  shipped reality rather than claiming the confirmation host survives. **Behaviour (only if the row
  keeps a driver)** — `Ctrl+Space` twice toggles once per press; holding Space in the focused
  searchbox starts dictation and the transcript lands as a message, never a palette; typing `>`
  produces no palette node. PASS = the absence clause present **and** the three preserved clauses
  byte-identical to their pre-sweep wording **and** no present-asserting relay clause.
  **Edge:** (a) **`R-5.8` says "preserved verbatim"** (G-411) — a reworded surviving clause is a FAIL
  even if the prose is nicer. (b) A purely static rewrite of F-165 is admissible (the row's subject is
  absence) **provided** it is executable by `Read` alone with no dangling live-receipt requirement.
  (c) A `launcher-confirmation` count asserted for a *different* intent than the destructive companion
  intent is a FAIL — that intent is the subject. (d) If the dictation leg is dropped, the row must say
  so rather than leaving an orphan receipt.
  **Receipt:** the quoted row + the four observations in the POSTED `## Tests Runs`.

- [ ] **P-16 (R-5.6) — the offer set is the three static skills, and parity survives (the audio-parity suite is CORRECTED, not retired).**
  `Read` the corrected `companion-audio-skill-parity/{functional,smoke,regression,exploratory}.md`
  rows (`functional.md:5-13,16,26-28,40,41,43,45,49,50,52`; `smoke.md:20-23`;
  `regression.md:9-20`; `exploratory.md:13,20`); `Test-Path` all four files.
  **Expected:** (a) every sentence stating the offered skill set names **exactly** `open_app`,
  `close_app`, `doom_mode` **in that order** — no `wireframe`, no fourth name, no generated or
  application-named skill; (b) the accessor is named **zero-argument**: `companion_skill_registry()`
  (`status.rs:691`) — a `companion_skill_registry(app)` arity is a FAIL; (c) the deleted pins are
  replaced by the **surviving** pin `the_turn_offer_is_exactly_the_three_static_skills`
  (`status.rs:1462`) — citing
  `the_live_offer_carries_the_wireframe_skill_with_its_directive_description` (`status.rs:1346`) or
  `companion_manifest.rs` is a FAIL; (d) **the parity requirement is preserved unweakened** — a row
  still asserts that the typed turn and the audio turn obtain the SAME offer from the ONE accessor
  (byte-equal `tools`), and the CI-parity rows (F-8 / F-9 / F-12) are unchanged; (e) `Test-Path` the
  suite's four files → **all `True`** (the suite is **not** retired).
  **Edge:** (a) **Retiring the suite to go green is a FAIL** — `R-5.6` forbids weakening it; only the
  content assertion moves (four skills → three), the invariant does not. (b) A row that drops the
  audio leg and keeps only the typed leg is a FAIL (parity is the subject). (c) A three-skill claim
  that **reorders** the names is a FAIL. (d) The 4-skill **negative** assertion at
  `companion-command-removal/functional.md:172` ("A 4th skill … = FAIL") is CORRECT and must stay — do
  not "harmonise" it.
  **Receipt:** the quoted rows + the four `Test-Path` booleans in the POSTED `## Tests Runs`.

- [ ] **P-17 (R-5.4 / R-5.5 / R-5.7 + the AC5 ledger clause) — the ledger: one row per corrected/removed site, append-only.**
  `Read` `.opencode/tests/retired-navigation/RETIRED.md` from `:237` (the
  `### #3153 — prose dispositions (slice 3 of 3)` parent heading) to EOF, plus the round-2
  `#### ST-8..ST-10 — the round-2 residual sweep …` sub-heading; cross-check against each sub-task's
  corrected sites; then `git diff main...HEAD -- .opencode/tests/retired-navigation/RETIRED.md`.
  **Expected:** (a) **one row per corrected/removed site**, schema
  `| path:line-range | suite | disposition | replacement | reason |`, `path:line-range` = the
  **pre-sweep** location; (b) `disposition` ∈ **`CORRECTED`** or **`REMOVED`** only — **no
  `SUPERSEDED` for any non-allowlisted suite** (`R-5.2`; `SUPERSEDED` is docs-only); (c) every site
  this round corrected or removed has **exactly one** row, and each row's quoted claim matches the
  pre-sweep text at that range; (d) **`RETIRED.md:1-391` is byte-unchanged** — the diff is **additions
  only**, no deletion and no re-stamped existing row (`PR-4`); the file's pre-round length is **391
  lines**; (e) the ledger row for the allowlisted-but-false `navigation-retirement/regression.md` site
  is present too (a false row inside an allowlist is still a dispositioned site).
  **Edge:** (a) A row whose `path:line-range` no longer matches the file's content is a FAIL (the row
  must quote the deleted claim). (b) `SUPERSEDED` anywhere outside `docs/adr/**` /
  `docs/NAVIGATION_ENGINE.md` = FAIL. (c) A site **silently deleted** without a `REMOVED` row = FAIL —
  "no row's outcome is weakened *or deleted*". (d) A **rewritten** existing row (not appended) is a
  FAIL even if the new text is better: the ledger is the record and `1-391` is frozen. (e) An
  in-place `SUPERSEDED` marker left inside a non-allowlisted suite file instead of a ledger row is a
  FAIL.
  **Receipt:** the `git diff` output + the new sub-heading's rows in the POSTED `## Tests Runs`.

- [ ] **P-18 (R-5.4 / R-5.7) — `navigation-retirement/regression.md` R-14 is corrected (the allowlisted-but-false row).**
  `Read` `.opencode/tests/navigation-retirement/regression.md:88-92` and the section heading at `:88`;
  `Test-Path apps/tauri/src-tauri/src/applications/companion`; `Read` the directory listing of
  `apps/tauri/src-tauri/src/applications/`.
  **Expected:** (a) `Test-Path` → **`False`** (the directory was deleted in #3152; the shipped listing
  is `db_client, doom, installed_apps, llm_server, mod.rs, pg_supervisor, screenshot, settings, setup,
  telemetry, terminal, wireframe`); (b) R-14 **no longer asserts** that
  `register_app_command_surfaces` / `app_command_intent*` "is untouched and still compiles" — it
  asserts the shipped truth: the commands and the relay are **gone**, and the three static skills are
  the whole offer; (c) R-14's **surviving intent is kept** — the row-pipeline is still not a party to
  that slice (cross-ref R-15 at `:93-94`); (d) a ledger row exists for the site (P-17); (e) the
  heading at `:88` either survives as a corrected scope statement or is reworded — it must not still
  read as a promise that a deleted directory is intact.
  **Edge:** (a) **This row sits inside the guard's allowlist, so the guard is blind to it by design** —
  a green P-1 / P-13-clean result is **NOT** evidence about R-14; recording "the guard is green
  therefore R-14 is fine" is the G-445 error restated. (b) Deleting R-14 outright is a FAIL unless its
  surviving intent (R-15's row-pipeline scope) is demonstrably still carried — prefer CORRECT over
  REMOVE. (c) `Test-Path` on the directory, **never** `Glob` (G-024 — a glob false negative proves
  nothing). (d) The row must not be re-aimed at `infrastructure/rtdb/` — that is R-15's subject.
  **Receipt:** the quoted row + the `Test-Path` boolean + the directory listing in the POSTED
  `## Tests Runs`.

## Test data

- **T1 — the spec PR head tree** (the built tree; `spec/3153` tip == the PR head SHA). Every row
  except `smoke.md`'s PS-1 reads T1.
- **T2 — a pristine detached checkout at the SAME commit** (`git worktree add <tmp> <head-sha>
  --detach`). Used only by `smoke.md` PS-1/PS-2 for the R-1.4 equality receipt; **the commit identity
  is the discriminator** — two different commits cannot produce an equality receipt (G-443).
- **The guard itself** — `.opencode/scripts/check-navigation-prose-retired.ps1` (ST-1) plus
  `.opencode/scripts/run-exitcode.ps1` (exists, `:1-39`).
- **The ledger** — `.opencode/tests/retired-navigation/RETIRED.md` (**391 lines** at round-2 start;
  append-only). Round 1's "236 lines at planning" was the pre-round-1 length — round 1 appended its
  own `### #3153` section at `:237`. **The binding anchor is 391** (P-17(d), `regression.md` PR-4).
- No fixtures, no mocks, no telemetry lease, no live environment. **G-172 satisfied**: every
  artifact above is in-repo and committed.

## Pass/fail criteria

PASS = **every** stated observation holds, read from the printed line / the read line, **and** the
row's evidence record is a durable non-draft artifact (G-415). FAIL = any observation absent,
contradictory, or sourced from a consumed draft. A row may not be marked PASS on a "looks right"
reading: each expected value names the literal line it is read from (`EXITCODE=`, `Scanned files:`,
`Ignore filter:`, `HITS:`, a `- **Status:**` line, a `git diff --name-only` output, a `Test-Path`
boolean). A row that cannot be driven as written is a **plan defect** returned in this same pass —
never a tester FAIL and never a live substitution (G-316/G-440).
