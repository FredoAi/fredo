# navigation-prose-retirement — Regression

The "must NOT change" baseline for Issue #3153 (the navigation-engine **PROSE** retirement, slice 3
of 3). Every entry is a behaviour the slice's prose sweep could plausibly take with it. The slice
changes **no product behaviour** — so a regression FAIL here is as serious as an AC FAIL: a docs-only
landing that dirties `apps/**`, erases history or "tidies" already-correct prose has left its scope.

Verification policy: **`static`, every row** (see `functional.md`). Rows are proved from the
committed tree + `git diff` + the two build receipts. **No `tauri_*` call belongs in this suite**
(NFR-5).

> **Gate wrapper.** Command exit codes are asserted through
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"`; the printed
> `EXITCODE=<n>` line is the receipt. **The bash tool denies command chaining** — one command per
> call.

> **Evidence durability (G-415).** Every evidence artifact named below is a **NON-DRAFT** record —
> the POSTED `## Tests Runs` comment on the feature issue, or a committed / non-consumed path.
> **Never** a `.opencode/tmp/3153/` timeline draft.

- [ ] **PR-1 — no product code, no test code.** `git diff --stat main...HEAD -- apps/` and
  `git diff --name-only main...HEAD`.
  **Expected:** the `apps/` diff is **empty**; the changed-file list contains **zero**
  `*.test.*` / `*.spec.*` files; the intended change set is exactly `docs/**`, `.opencode/tests/**`,
  `.opencode/scripts/check-navigation-prose-retired.ps1`, `.opencode/scripts/test-scripts.ps1` and
  `.github/workflows/validate.yml` — enumerated against the architect's `Files owned` across
  ST-1…ST-7 plus this QA suite.
  **Edge:** (a) `Cargo.lock`/`pnpm-lock.yaml` churn from a build is **not** an intended change — a
  non-empty `apps/` diff is a FAIL even if "only" a lockfile (a build must not dirty the tree; if it
  does, the receipt names it). (b) An unowned file in the changed list is a FAIL even when harmless.
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
  a recorded **human follow-up**, never a pipeline edit.
- [ ] **PR-4 — history is not erased, and the ledger is append-only.** `Test-Path` each of
  `docs/NAVIGATION_ENGINE.md`, `docs/UX_FLUENCY_RESEARCH.md`,
  `docs/adr/0008-teleport-attached-companion-turn.md`, and the four retired suite dirs
  (`.opencode/tests/navigation/`, `navigation-fleet/`, `navigation-research/`,
  `wireframe-navigation/`); `git diff main...HEAD -- .opencode/tests/retired-navigation/RETIRED.md`.
  **Expected:** all three docs `True`; all four engine dirs **`False`** (verified absent at planning
  by directory listing — **not** by glob, G-024); `RETIRED.md`'s diff contains **additions only** —
  lines 1-236 are unchanged (17 four-suite rows at `:21-41` keep `retired in #3151`).
  **Edge:** (a) `NAVIGATION_ENGINE.md`'s **normative body is intact** — a banner added, nothing
  deleted (`git diff --numstat` shows near-zero deletions for that file). (b) `UX_FLUENCY_RESEARCH.md`'s
  673-line body is intact; only the banner moves. (c) A `RETIRED.md` **deletion** or a re-stamped
  `retired in` is a FAIL (the dirs are retired once, in #3151). (d) The four dirs must not be
  re-created to "re-retire" them — and no `hotkeys` retirement row may be manufactured
  (`functional.md` P-8(c)).
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
  roving — verified).
  **Edge:** (a) A "tidy-up" of any of these is a FAIL even when the new prose is nicer — scope creep
  against a docs-only slice. (b) `applications-rename/regression.md:18-22` **may** gain a
  `CORRECTED`-wording disposition note and nothing else (no banned token, so no rewrite). (c)
  `contrast-gate` must not be swept at all — it is the calibration case proving Class C matches exact
  phrases, not bare words.
