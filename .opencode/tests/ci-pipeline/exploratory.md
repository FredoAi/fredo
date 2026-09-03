# ci-pipeline — Exploratory Tests

Unscripted probes for the CI pipeline. Confirmed findings promote to `functional.md`.
Verification policy is **static** (GitHub-REST evidence; no product runtime).

Probe ideas (record what you find):
- [ ] E-1: What happens on a PR that changes NO files matched by any path filter (empty run)? Is it an explicit pass/note, or a silent no-job? Record the triggered job set and outcome.
- [ ] E-2: Force a fast-tier pass but a thorough-tier failure (e.g. a deliberate `clippy -D warnings` break). Does merge stay blocked? Record the gate outcome. (This probes AC2's structural guarantee.)
- [ ] E-3: Re-run the same PR head concurrently (two runs in flight). Does a cold cache restore contend and slow the second run? Record both timings.
- [ ] E-4: Push a `.rs` file nested under a "docs" folder. Is it skipped by a greedy frontend-path filter? Record the triggered job set.
- [ ] E-5: A path-filter edge where both a `*.ts` and a `*.rs` change land in one PR — confirm both stacks run (union semantics), matching AC3's edge case.
