# navigation-prose-retirement — Regression

The "must NOT change" baseline for Issue #3153 (the navigation-engine **PROSE** retirement, slice 3
of 3). Every entry is a behaviour the slice's prose sweep could plausibly take with it. The slice
changes **no product behaviour** — so a regression FAIL here is as serious as an AC FAIL: a docs-only
landing that dirties `apps/**`, erases history or "tidies" already-correct prose has left its scope.

Verification policy: **`static`, every row** (see `functional.md`). Rows are proved from the
committed tree + `git diff` + the two build receipts. **No `tauri_*` call belongs in this suite**
(NFR-5).

> **Round keying.** `PR-1` … `PR-6` are round 1's rows (AC1–AC4 + the first AC5 sweep); `PR-7` and
> `PR-8` are round 2's (the AC5 remainder, audit restart, root cause `scope`). `PR-1` and `PR-4` were
> **scope-corrected** in round 2: round 1 legitimately changed the guard, its harness leg and the CI
> job, and appended its own ledger section, so round 2's intended set **excludes** those four paths
> and pins the ledger anchor at **391 lines**. The round-1 assertions are kept in shape; only the
> scope fact and the stale constant changed.

> **Gate wrapper.** Command exit codes are asserted through
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"`; the printed
> `EXITCODE=<n>` line is the receipt. **The bash tool denies command chaining** — one command per
> call.

> **Evidence durability (G-415).** Every evidence artifact named below is a **NON-DRAFT** record —
> the POSTED `## Tests Runs` comment on the feature issue, or a committed / non-consumed path.
> **Never** a `.opencode/tmp/3153/` timeline draft.

- [ ] **PR-1 — no product code, no test code, and no re-tuned instrument.** `git diff --stat main...HEAD -- apps/` and `git diff --name-only main...HEAD`.
  **Expected:** the `apps/` diff is **empty**; the changed-file list contains **zero**
  `*.test.*` / `*.spec.*` files; and the intended change set is **exactly** `.opencode/tests/**` —
  the round-2 P-set's 15 files, this suite's own rows, and
  `.opencode/tests/retired-navigation/RETIRED.md` — enumerated against ST-8/ST-9/ST-10's `Files
  owned`. **`.opencode/scripts/check-navigation-prose-retired.ps1`, `.opencode/scripts/test-scripts.ps1`,
  `.github/workflows/validate.yml` and all of `docs/**` must be ABSENT** from the changed list —
  round 1 legitimately changed those four (it landed the guard, its harness leg and the CI job);
  **round 2 must change none of them** (that is PR-7's assertion, restated here as a scope fact).
  **Edge:** (a) `Cargo.lock`/`pnpm-lock.yaml` churn from a build is **not** an intended change — a
  non-empty `apps/` diff is a FAIL even if "only" a lockfile (a build must not dirty the tree; if it
  does, the receipt names it). (b) An unowned file in the changed list is a FAIL even when harmless.
  (c) `AGENTS.md`/`opencode.json` are PR-3's subject.
- [ ] **PR-2 — the build receipts stay green.** `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui build"`;
  `run-exitcode.ps1 -Command "cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked"`.
  **Expected:** `EXITCODE=0` for both; the UI build emits an `assets/index-*.js` and reports
  **zero** `error TS` lines; `cargo check` prints `Finished` with a `warning:` count of **0**.
  **Edge:** (a) **G-199: do NOT demand `cargo nextest run` / `cargo nextest run --no-run`** — no Rust
  test target is touched, so it is the wrong receipt and the audit must not require one. (b) A stale
  `dist` is not the receipt — the run itself is (G-425). (c) These are regression-only: a red build
  with an empty `apps/` diff is an environment/lockfile problem to report, not a product defect.
- [ ] **PR-3 — the human-owned negative control.** `git diff --name-only main...HEAD -- AGENTS.md opencode.json`.
  **Expected:** the command prints **nothing** (empty output) and exits 0.
  **Edge:** (a) Either file appearing in the diff **fails the slice** — not a warning, a FAIL, per the
  AC's explicit negative case and `docs/ENGINEERING_RULES.md`'s "Human-owned touchpoints" section.
  (b) **References** to them (e.g. `docs/README.md:43-46`, which already documents the rule) **may**
  change — that is not an edit to the files. (c) The `AGENTS.md` bullet mirroring the deleted rule is
  a recorded **human follow-up**, never a pipeline edit. (d) The round-2 two-vocabulary record belongs
  in `RETIRED.md` §ST-10, **never** in `AGENTS.md` — a mirror bullet there is that same human
  follow-up.
- [ ] **PR-4 — history is not erased, and the ledger is append-only.** `Test-Path` each of
  `docs/NAVIGATION_ENGINE.md`, `docs/UX_FLUENCY_RESEARCH.md`,
  `docs/adr/0008-teleport-attached-companion-turn.md`, and the four retired suite dirs
  (`.opencode/tests/navigation/`, `navigation-fleet/`, `navigation-research/`,
  `wireframe-navigation/`); `git diff main...HEAD -- .opencode/tests/retired-navigation/RETIRED.md`.
  **Expected:** all three docs `True`; all four engine dirs **`False`** (verified absent at planning
  by directory listing — **not** by glob, G-024); `RETIRED.md`'s diff contains **additions only** —
  **`:1-391` is byte-unchanged** (the 17 four-suite rows at `:21-41` keep `retired in #3151`). The
  pre-round length is **391 lines**, not 236: round 1 appended its own
  `### #3153 — prose dispositions (slice 3 of 3)` section at `:237` (with `#### ST-7` at `:328`), so
  a row pinning 236 is stale.
  **Edge:** (a) `NAVIGATION_ENGINE.md`'s **normative body is intact** — a banner added, nothing
  deleted (`git diff --numstat` shows near-zero deletions for that file). (b) `UX_FLUENCY_RESEARCH.md`'s
  673-line body is intact; only the banner moves. (c) A `RETIRED.md` **deletion**, a **rewritten**
  existing row, or a re-stamped `retired in` is a FAIL (the dirs are retired once, in #3151; the
  ledger is append-only). (d) The four dirs must not be re-created to "re-retire" them — and no
  `hotkeys` retirement row may be manufactured (`functional.md` P-8(c)). (e) **Confirm the anchor
  before asserting it** — `Read` the file's last line and state the observed length; if it differs
  from 391, the ledger changed outside this round and that is a finding to report, not a row to
  re-pin.
- [ ] **PR-5 — the #3145 authoring path is absent, and the product copy is a recorded no-op.** Use the
  **Grep tool** for `3145` over the repo (the tester's bash is deny-by-default,
  `opencode.json:380-381`); `Test-Path` any `docs/**/*install*`; `Read`
  `apps/ui/src/applications/settings-app/components/InstalledAppsSettings.tsx:70-71` and
  `.opencode/tests/installable-apps/functional.md:329`; `git diff --name-only main...HEAD --
  apps/ui/src/applications/settings-app/components/InstalledAppsSettings.tsx
  .opencode/tests/installable-apps/functional.md`.
  **Expected:** (a) No `docs/`-level authoring document exists — the only `3145` matches are
  `Cargo.lock` checksum false positives (architect-verified); no `docs/**/*install*` path resolves.
  (b) The copy string at `:70-71` (`LIMITATIONS_SENTENCE`) and the quote at
  `installable-apps/functional.md:329` are **byte-unchanged**; both paths are **absent** from the
  diff. (c) The no-op is **recorded** — the posted `## Tests Runs` comment (the NON-DRAFT record)
  states it with evidence and names the human as owner.
  **Edge:** (a) **This row asserts the recorded no-op — it does NOT require the product-source
  edit.** Requiring the edit would break the docs-only constraint *and* the installable-apps suite in
  the same landing. (b) A pipeline edit to either file is a **FAIL** for this slice (PR-1). (c) The
  three doc touch-points that *are* in scope — `docs/FAQ.md:38`, `docs/ARCHITECTURE.md:1057`,
  `docs/ARCHITECTURE.md:1074` — are corrected by ST-5/ST-3 and verified in `functional.md`
  P-9(c)/P-6(e); do not fail PR-5 because the *product* string still exists.
- [ ] **PR-6 — the already-correct and deliberately-unswept prose is byte-unchanged.** `git diff
  main...HEAD --` on each named region, then `Read` each.
  **Expected:** byte-unchanged: (a) `docs/ARCHITECTURE.md:578` (the surviving companion module-map
  line, which already says `shared/navigation/` does not exist) and `:917` (the companion-skills row,
  static-three-only since #3152); (b) `docs/ENGINEERING_RULES.md` bullets outside the keyboard rule
  (`:62-65`, `:67-75`, and the settings/Chakra sections); (c) `.opencode/tests/contrast-gate/functional.md:26,28`
  ("declared surfaces × states" = theme `SurfaceId`s — verified); (d)
  `.opencode/tests/applications-rename/regression.md:18` ("tile keyboard navigation" = launcher grid
  roving — verified); (e) the wireframe **historical / PASS-record** statements at
  `wireframe/smoke.md:200`, `wireframe/regression.md:318,387`, `wireframe/exploratory.md:266`.
  **Edge:** (a) A "tidy-up" of any of these is a FAIL even when the new prose is nicer — scope creep
  against a docs/suite-only slice. (b) `applications-rename/regression.md:18-22` **may** gain a
  `CORRECTED`-wording disposition note and nothing else (no banned token, so no rewrite). (c)
  `contrast-gate` must not be swept at all — it is the calibration case proving Class C matches exact
  phrases, not bare words. (d) **Round 2 does edit
  `wireframe/{functional,regression,exploratory}.md` (ST-10)**, so (e) is the live risk: correct only
  the rows that assert the subject is **CURRENT** (G-125) — rewriting a PASS record is a FAIL.
- [ ] **PR-7 — the frozen-scope negative control: the round-1 instrument is byte-unchanged.** `git diff
  --name-only main...HEAD` and `git diff --stat main...HEAD --` on each of
  `.opencode/scripts/check-navigation-prose-retired.ps1`, `.opencode/scripts/test-scripts.ps1`,
  `.github/workflows/validate.yml`, `docs/`; then `Read` the guard's token tables and
  `$EvidenceAllowlist`; then
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-prose-retired.ps1 -SelfTest"`.
  **Expected:** (a) **all four paths print NOTHING in the diff** — the guard, the harness and the CI
  workflow are **absent** from the changed set, and `docs/**` carries no change from merged `main`.
  (b) `Read` confirms the guard still declares **45 tokens** across classes A–E with the split
  `A=3 B=19 C=8 D=8 E=7`, an **8-entry** `$EvidenceAllowlist`, and the **seven** `CONTROL 1..7`
  lines; the plain run's printed receipt line is exactly
  `Tokens declared: 45 in 5 classes (A=3 B=19 C=8 D=8 E=7)` — **that printed line is the receipt**,
  and **a change to any number in it IS the defect**. (c) The `-SelfTest` leg prints `EXITCODE=0` with
  **seven** control lines (unchanged behaviour: POSITIVE, NEGATIVE, SEEDED ROOT, OUT-OF-ROOT,
  IGNORED NON-SCAN, SELF-REFERENCE, ALLOWLIST AUDIT).
  **Edge:** (a) **ANY diff touching the guard, `test-scripts.ps1`, `validate.yml` or `docs/**` is a
  FAIL** — no exceptions, including "just a comment" or "just a token". The AC5 remainder is proved by
  `functional.md` P-13's predicate alone; widening the instrument is a rejected route (a widening
  would redden the guard on 41 correct absence-asserting line hits). (b) **A guard that still passes
  after a token was removed is the failure mode** — read the printed `Tokens declared:` line; do not
  infer "unchanged" from exit 0. (c) A `docs/**` change is a FAIL even though docs are prose: this
  round is suite prose + ledger only, so a docs edit means the sweep escaped its scope. (d)
  `gh pr checks` is not a substitute for the diff — the frozen-scope claim is a diff fact. (e) Round 1
  legitimately changed these files; this row asserts **round 2 differs from the merged `main`**, so
  read the diff against the post-merge baseline, not against round-1's pre-change state.
- [ ] **PR-8 — the soundness row: the ABSENCE-asserting rows are NOT swept (G-444 regression risk).**
  `git diff -U0 main...HEAD --` on the hot files, then `Read` each named line and confirm its text is
  the **pre-sweep** text.
  **Expected:** **byte-unchanged, asserted line-by-line** — `.opencode/tests/launcher/functional.md`:
  `:2124`, `:2134`, `:2148-2149`, `:2161`, `:2205-2213` (F-132), `:2262`, `:2264`, `:2305`,
  `:2378-2379`, `:2567-2568`, `:2636-2637`; `.opencode/tests/launcher/regression.md`:
  `:885-886`, `:937-938`, `:961`, `:1006`; `.opencode/tests/launcher/smoke.md:370-374` (S-45,
  evidence + liveness — its subject survives); `.opencode/tests/companion/functional.md`:
  `:3211` (`:2888`, `:2901` also); `.opencode/tests/companion/regression.md`: `:997`, `:1001`;
  `.opencode/tests/navigation-retirement/functional.md`: `:326`, `:420`; plus the correctness
  statements at `.opencode/tests/contrast-gate/functional.md:26,28` and
  `.opencode/tests/applications-rename/regression.md:18`.
  PASS = **every** listed line carries its pre-sweep text.
  **Edge:** (a) **This is a real regression risk, not a formality** — a blind token-substitution over
  the P-set would corrupt these into present-asserting rows and *break AC5 while looking green*,
  because the same token appears on both sides: `launcher/smoke.md:350` asserts `launcher-context`
  **renders** (P) while `launcher/functional.md:2124` asserts count **0** (A). The discriminator is
  the row's **expected observable**, never the token. (b) **`launcher/functional.md:2596-2612` is
  deliberately EXCLUDED** from the protected list — it is F-165, which **must** change (P-15); a
  reviewer must not fail the correct F-165 edit. (c) `:2633-2645` (F-167) **is** protected and must
  not be touched — the F-165 edit must not spread into its sibling. (d) A "tidy-up" of a protected
  line is a FAIL even when the new prose is true. (e) `contrast-gate/functional.md:26,28` must not be
  swept at all — it is the calibration case proving Class C matches exact phrases, not bare words.
  (f) F-132's recipe literally says `rg` `apps/` — the tester has no bash `rg`; drive the same
  predicate with the **Grep tool** (`pattern` + `path`) and do **not** edit the row (editing it would
  break this PR-8 assertion).
