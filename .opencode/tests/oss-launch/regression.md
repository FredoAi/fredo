# oss-launch — Regression Tests

"Did we break existing behavior?" baseline for the OSS launch readiness spec (#2773). This spec is docs/config-only: the strongest regression risk is scope bleed — edits landing outside the declared doc set, or protected files being modified "in passing".

## Invariants (what must NOT change)

- [ ] R-1: `docs/SECURITY.md` byte-identity — `git diff <fork-sha>..HEAD -- docs/SECURITY.md` empty AND `git status --porcelain -- docs/SECURITY.md` clean. This file is referenced, never edited. (Primary invariant; sandbox-safe git form, `Get-FileHash` fallback only.)
- [ ] R-2: `validate.yml` frozen content — content equals the pre-spec `.disabled` copy minus exactly lines 1–4 (deactivation comment); job keys `ui-validate` / `rust-validate` / `validate` unchanged; `on: pull_request: branches: ['main']` unchanged. Any other diff = regression.
- [ ] R-3: Workflow set untouched beyond the declared two — `git diff <fork-sha>..HEAD --stat -- .github/workflows/` shows only validate.yml + audit.yml changes; no other workflow modified/renamed/deleted.
- [ ] R-4: Zero app-code changes — `git diff <fork-sha>..HEAD --stat` contains no files under apps/, packages/, src/ or any Rust/TS source. Docs/config/LICENSE/README/CONTRIBUTING/CoC only.
- [ ] R-5: Pre-existing docs/ content intact — files under docs/ other than new additions (e.g. docs/ARCHITECTURE.md, docs/SETUP.md, docs/CLI.md, docs/FAQ.md) are not modified or deleted; only genuinely new files may appear.
- [ ] R-6: CI-parity green — the local validate.yml command set (F-14) all green on the spec-branch tip. This is the no-change baseline for build hygiene: a docs-only spec must not be able to break the build; if it does, something out of scope changed.

## Overlapping prior suites

- No prior feature-suite folders overlap this docs/config surface (first spec in the `oss-launch` domain). Later specs touching README/.github/workflows/licensing must run this suite.
