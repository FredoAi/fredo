# ci-pipeline — Functional Tests

Reusable functional suite for the Fredo GitHub Actions CI pipeline (`.github/workflows/`).
This is a CONFIG-ONLY domain (workflow YAML + docs); the observable "system" under test is
the real GitHub Actions run state, read via GitHub REST. No product runtime is required —
verification policy is **static** (G-089 docs/config-only discipline).

Prerequisite (all cases): an authenticated `gh` CLI and a branch where the fast/thorough
split is applied. Timings come from `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`
(job `started_at` → `completed_at` = wall-clock duration). Baseline for comparison:
#2798 ~13m21s, #2797 ~13m49s.

## AC1 — Median PR wall time materially below ~13.5-min baseline
- [ ] F-1: On a clean code-change push (full matrix), query the workflow run's jobs and record each job's `started_at`/`completed_at`. Compute the median feedback time across ≥3 full-matrix code-change runs. EXPECT: the median is materially below ~13.5 min (proposed ≥25% faster, i.e. ≤ ~10 min); record the observed number + margin vs baseline in evidence with the run + job IDs.

## AC2 — Full thorough checks still gate merge (no coverage loss)
- [ ] F-2: Inspect the merge-gate / required-checks config and the workflow's concluding job. EXPECT: the thorough validate job set (rust-validate: cargo build + test + clippy `--locked -D warnings`; ui-validate: TS build + test) is still a required check, is independent of the fast tier, and has no `continue-on-error`. On a normal green code-change PR, the thorough validate job also passes (no coverage loss).

## AC3 — Docs-only / single-stack PRs skip irrelevant expensive jobs
- [ ] F-3: Trigger a docs-only, a UI-only, and a Rust-only PR. Query each run's triggered job set. EXPECT: docs-only → no Rust job and no UI job (only a cheap docs/lint check); UI-only → no `rust-validate`; Rust-only → no `ui-validate`. The job set equals exactly the jobs matching the changed path set.

## AC4 — Warm cache repeat runs are materially faster
- [ ] F-4: Re-run the same code-change PR head (same commit + lockfile set). Compare the warm run's Rust build/clippy step durations and cache-hit log lines against the cold run. EXPECT: the warm run shows a GitHub-S3 cache HIT and the compile/clippy step durations drop by ≥ the proposed margin (≥30%); record cold + warm durations.

## AC5 — Workflow files small and readable
- [ ] F-5: Static readability review: read `validate.yml` + any fast/thorough split; confirm `audit.yml` is unchanged. EXPECT: small file (line budget), no duplicated job/step bodies (DRY via reusable workflows / YAML anchors), clear job naming, path-filter/trigger conditions visible at the top; a maintainer can read it in ~2 minutes and state what runs when.

_Evidence convention: pass cases keep `- [x]` + append run/job IDs + durations; fail cases leave `- [ ]` and mark `FAIL` with expected-vs-actual + repro._
