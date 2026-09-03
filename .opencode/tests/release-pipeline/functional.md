# release-pipeline — Functional Tests

Reusable functional suite for the Fredo release line (protected `release/stable` branch +
one-trigger Tauri release-build/publish path). This is a **CONFIG-ONLY** domain (workflow YAML +
`.github/CODEOWNERS` + docs); the observable "system" under test is the declared in-repo release
contract. No product runtime is required — verification policy is **static** (G-089 docs/config-only
discipline, mirroring `ci-pipeline`).

> **Honest reach split (G-102 / G-033 / G-053):** the ACs below are the **in-repo/declarative**
> facets that an in-sandbox tester can PASS/FAIL by reading the repo files at the spec-branch tip.
> The **admin-enforced / publish** legs (AC1/AC2/AC3 enforcement and AC4 real publish) require a
> repo ADMIN/owner to apply a ruleset, merge into a protected branch, and cut a real Release; the
> pipeline's GitHub principal is NOT a repo ADMIN, so those are **UNVERIFIED-with-named-blocker**
> (G-053) and routed to the PO as documented-partials — never asserted as PASS.

Prerequisite (all cases): working tree at the `spec/<N>` tip (`git checkout -B spec/<N> origin/spec/<N>`,
G-032 form), and the ability to read `.github/workflows/release.yml`, `.github/workflows/validate.yml`,
`.github/CODEOWNERS`, `apps/tauri/src-tauri/tauri.conf.json`, and `docs/release-process.md`.

## AC1 — Protected release branch requires owner/CODEOWNERS approval, no direct push, no bypass (declarative facet)
- [ ] F-1: Read `.github/CODEOWNERS` and `docs/release-process.md`. EXPECT: `.github/CODEOWNERS` still carries `* @pktron` (the owner — NOT a bot/collaborator, per NFR-1); `docs/release-process.md` documents the `release/stable` repository ruleset with `require_code_owner_review: true`, `required_approving_review_count ≥ 1`, "require a PR before merging" (no direct push), and an EMPTY `allow_bypass` list ("no admin bypass").
- [ ] F-1a: **UNVERIFIED-with-named-blocker (admin-enforced).** The actual ENFORCEMENT (ruleset applied, admin bypass off, direct push rejected at the branch) is a GitHub repo setting a non-admin cannot apply/observe. Requires a repo ADMIN/owner to create `release/stable` and apply/enable the ruleset in Settings → Rules. Denied verb: `gh api repos/FredoAi/fredo/rulesets` (apply). Route to PO as documented-partial. Do NOT report as PASS.

## AC2 — Unapproved release PR blocked even when CI green (declarative facet)
- [ ] F-2: Read `docs/release-process.md` + `.github/workflows/release.yml`. EXPECT: the doc states a `release/stable` PR must carry the owner's (`@pktron`) approval (via `require_code_owner_review` / `required_approving_review_count`) before merge, and that a green gate alone is insufficient without that approval (the negative gate is explicit).
- [ ] F-2a: **UNVERIFIED-with-named-blocker (admin-enforced).** Cannot open a PR to a protected release branch from the sandbox principal; `gh pr create` is NOT allowlisted. Requires a repo ADMIN to enable the protection (require owner review) and observe/confirm the block. Denied verb: `gh pr create`. Route to PO as documented-partial. Do NOT report as PASS.

## AC3 — Approved green release PR can merge (declarative facet)
- [ ] F-3: Read `docs/release-process.md` and `validate.yml`. EXPECT: `docs/release-process.md` names `validate` as the required status check for `release/stable`; `validate.yml` `on.pull_request.branches` includes BOTH `main` (unchanged main behavior) AND `release/stable` (ADDITIVE, per ST-1) so a release PR triggers the thorough gate; `validate-fast` and per-stack `ui-validate`/`rust-validate` are NOT required checks (matching `docs/CI_GATE_CONTRACT.md`); the doc states approved + green → mergeable. (This row is PASS/FAIL-able — the Architect resolved the `validate.yml` trigger gap via ST-1's additive trigger.)
- [ ] F-3a: **UNVERIFIED-with-named-blocker (admin-enforced).** Cannot merge into a protected release branch; `gh pr merge` is NOT allowlisted. Requires an owner/admin to approve and merge once protection + required checks are configured. Route to PO as documented-partial. Do NOT report as PASS.

## AC4 — Merge/tag publishes GitHub Release with platform artifacts (declarative facet)
- [ ] F-4: Read `.github/workflows/release.yml` + `apps/tauri/src-tauri/tauri.conf.json`. EXPECT: workflow presents as syntactically valid YAML; `on.push.branches` is exactly `['release/stable']` (+ optional `workflow_dispatch`), NO `main`/tag trigger; uses `tauri-apps/tauri-action@v1` with `projectPath: apps/tauri/src-tauri`, `tagName: app-v__VERSION__`, `releaseName`/`releaseBody` set, `releaseDraft: true`; job-level `permissions: contents: write`; `pnpm install --frozen-lockfile`; every `uses:` SHA-pinned; `tauri.conf.json` `bundle.active` is `true` and `bundle.targets` non-empty.
- [ ] F-4a: **UNVERIFIED-with-named-blocker (admin-enforced publish).** Cannot trigger/await a real protected-branch Release from the sandbox principal. `releaseDraft: true` means artifacts land on a DRAFT the owner must review + publish. Requires an owner/admin to merge an approved PR into `release/stable`, review the draft, and confirm downloadable assets. Denied verbs: `gh release create`, `gh run rerun`. Route to PO as documented-partial. Do NOT report as PASS.

## AC5 — Main-based spec flow unaffected (regression)
- [ ] F-5: Read `validate.yml`, `release.yml`, `.github/CODEOWNERS`, `apps/tauri/src-tauri/tauri.conf.json`, and `docs/CI_GATE_CONTRACT.md` (SEMANTIC-EQUIVALENCE). EXPECT: `validate.yml` main-PR behavior byte-identical to the `main` tip (a `main` PR still triggers all of `ui-validate`/`rust-validate`/`validate`, `validate` remains the single required check, and the only change is the ADDITIVE `release/stable` entry that does not affect main PRs); `release.yml` has no `pull_request`/`push` trigger on `main`; CODEOWNERS still `* @pktron`; `tauri.conf.json` unchanged (NFR-5); `docs/CI_GATE_CONTRACT.md` still names `validate` as main's sole required check. The additive `release/stable` trigger is EXPECTED and must NOT be flagged as an AC5 failure.

_Evidence convention: pass cases keep `- [x]` + append the file/line observed; fail cases leave `- [ ]` and mark `FAIL` with expected-vs-actual + repro. UNVERIFIED rows must name the blocker (the owner/admin action + the denied verb)._
