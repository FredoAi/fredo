# release-pipeline — Regression Tests

Reusable regression suite for the Fredo release line. The "must not change" baseline for the
release-workflow work is the existing main-based spec flow and the CI validate gate — a release
workflow change must NOT disturb the #2801 validate merge gate. Verification policy is **static**
(config/CI domain; G-089 discipline).

> **Cross-suite link:** this domain overlaps `ci-pipeline` because both touch `.github/workflows/`.
> Every run of this suite MUST also run `ci-pipeline/regression.md`, and vice versa when a change
> touches `.github/workflows/`. The release-workflow/validate-trigger change must not disturb the
> #2801 validate merge gate (`validate` as main's sole required check).

## R-1 — Main dev-trunk validate gate unchanged (AC5)
- [ ] R-1: `validate.yml` main-PR behavior is byte-identical to the `main` tip. EXPECT: for a `main` PR, `ui-validate` + `rust-validate` + `validate` all still run exactly as before; `validate` remains the single required status check on `main`; no new second gating check is introduced; the ONLY change to the file is an ADDITIVE `release/stable` entry in `on.pull_request.branches` (required for AC3) plus dropping the hardcoded `base: main` on the `dorny/paths-filter` (behavior-preserving for main).
- [ ] R-2: `validate-fast.yml` is unchanged (still the non-gating early signal).

## R-2 — Release workflow does not gate or trigger on main (AC5)
- [ ] R-3: `release.yml` has NO `pull_request` trigger and NO `push` trigger on `main`. EXPECT: `on.push.branches` is exactly `['release/stable']` (+ optional `workflow_dispatch`); the workflow can never be a required check on `main`.
- [ ] R-4: `.github/CODEOWNERS` still carries `* @pktron` and is not re-scoped to gate or alter `main` PR ownership semantics.

## R-3 — Tauri bundle config used by the release workflow is unchanged (NFR-5)
- [ ] R-5: `apps/tauri/src-tauri/tauri.conf.json` is unchanged (productName, version, identifier, `bundle.active`, `bundle.targets`); `release.yml` reads the existing values rather than introducing a duplicate.

## R-4 — Reproducibility invariants (NFR-2)
- [ ] R-6: `release.yml` SHA-pins every `uses:` action (matching the `validate.yml`/`validate-fast.yml` convention) and uses `pnpm install --frozen-lockfile`.

_Evidence convention: pass cases keep `- [x]` + append the file/line observed; fail cases leave `- [ ]` and mark `FAIL` with expected-vs-actual + repro._
