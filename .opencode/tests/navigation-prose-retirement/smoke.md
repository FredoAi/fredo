# navigation-prose-retirement — Smoke

The R-1.4 **equality receipt** for Issue #3153: the prose absence guard must produce the same scan
universe in a pristine tree and in a built tree at **one and the same commit**. Smoke runs first on
every testing phase that touches this feature's surface.

Verification policy: **`static`, both rows** (see `functional.md`). These rows drive the committed
script only. **No `tauri_*` call belongs in this suite** (NFR-5) — a screenshot cannot discriminate
an absence (G-408).

> **Tree condition is named in every row (G-443).** A claim of "clean in a pristine checkout" with
> no commit SHA is a claim no receipt can settle. Each row below names **which tree** it reads and
> **which commit**, and the recorder must write that condition into the posted `## Tests Runs`
> alongside the two counts.

> **Gate wrapper.** Exit codes are asserted through
> `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"`; the printed
> `EXITCODE=<n>` line is the receipt. **The bash tool denies command chaining** — one command per
> call.

> **Evidence durability (G-415).** The evidence artifact is the **POSTED** `## Tests Runs` comment on
> the feature issue, carrying the tree condition, the commit SHA and both counts. Never a
> `.opencode/tmp/3153/` draft.

## T2 — the pristine tree

- [ ] **PS-1 — the guard is clean in a PRISTINE detached checkout at the PR head commit (T2).**
  `git worktree add <tmp> <head-sha> --detach`; then in that worktree
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-prose-retired.ps1"`.
  **Tree condition (write it verbatim into the receipt):** `pristine detached checkout, no build
  run, commit <head-sha>`.
  **Expected:** printed `EXITCODE=0`; `HITS: 0 (0 not covered by the evidence allowlist)`; and the
  literal `Scanned files: A` and `Ignore filter: X path(s) excluded (git check-ignore)` values are
  recorded — **A** and **X** are the numbers PS-2 must reproduce.
  **Edge:** (a) The **commit SHA must be named** — "clean in a pristine checkout" without a commit is
  a claim no receipt can settle (G-443). (b) Running the guard in T1 (the built tree) does not
  substitute for this row. (c) A non-empty `HITS:` in T2 while `functional.md` P-1 is clean is a
  contradiction to investigate before recording either.

## T1 — the built tree, same commit

- [ ] **PS-2 — the guard is clean in the SAME commit AFTER a full build (tree T1), with matching
  counts.** In T1, at the same commit `<head-sha>` as PS-1:
  `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui build"`, then
  `run-exitcode.ps1 -Command "cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked"`,
  then the plain guard run again
  (`run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-prose-retired.ps1"`).
  **Tree condition (write it verbatim into the receipt):** `same commit <head-sha> as PS-1, after
  pnpm --filter @fredo/ui build + cargo check`.
  **Expected:** `EXITCODE=0`; `HITS: 0`; `Scanned files: A` **byte-identical to PS-1's A**;
  `Ignore filter:` count **≥** PS-1's X (a build may add ignored output — never scanned prose).
  **Edge:** (a) **The PS-1/PS-2 pair in the same commit is the equality receipt** — a count
  difference **IS** the defect (R-1.4, G-441's equality leg), not a build artifact. (b) Comparing
  PS-2 against a *different* commit yields a vacuous pass. (c) If the build dirties `apps/`
  (lockfile), record it under `regression.md` PR-1 rather than silently absorbing it. (d) A dropped
  `Scanned files:` count after the build (a build output directory pruned as prose) is exactly the
  failure the derived-universe filter exists to prevent — FAIL.
