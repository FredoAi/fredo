# ci-pipeline — Regression Tests

"Must not change" baselines and overlapping surfaces for the CI pipeline. Verification
policy is **static** (GitHub-REST evidence; no product runtime).

## Fidelity to merge-gate semantics
- [ ] R-1: The full thorough validate job set remains the merge gate — a PR whose thorough job fails is blocked even when the fast tier passes (the fast tier is additive-only and never replaces the thorough gate).
- [ ] R-2: `.github/workflows/audit.yml` (path-gated, lightweight) is unmodified and still triggers on its original paths.

## Coverage / job-set fidelity on existing PR shapes
- [ ] R-3: A combined frontend+Rust PR still triggers BOTH stacks (path-filter UNION, not intersection).
- [ ] R-4: A `.github/workflows/` change still triggers validation (the workflows are part of the testable surface).

## Cache / build determinism
- [ ] R-5: A lockfile change invalidates the cache and the run is expected to rebuild (NOT a regression — assert the cache key includes the Rust toolchain + `Cargo.lock` hash + pnpm lockfile for UI).
- [ ] R-6: No introduced nightly/unstable toolchain in the fast tier — CI must remain deterministic (the fast tier must not flake on toolchain drift).

_Overlapping surface suites that must also run when this feature is touched: none yet — this is the first spec to seed `ci-pipeline`._
