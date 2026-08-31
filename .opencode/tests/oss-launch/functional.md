# oss-launch — Functional Tests

Per-requirement cases for the OSS launch readiness spec (#2773, docs/config-only — zero running-system observables). All cases are static: file inspection, git diff, YAML structure checks. REQ ids map 1:1 to the QA Plan table in the Implementation Plan.

**Test data:**
- CoC canonical reference: `.opencode/tmp/2773/coc-v2.1-reference.md` (Contributor Covenant v2.1 markdown).
- Fork-point SHA: `git merge-base main HEAD` on the spec branch.

## README (AC1)

- [ ] F-1 (AC1): README visitor path — `README.md` contains, in order: one-line tagline under the title; a single badge row including license + CI badges; screenshot placeholder (image/link to `docs/assets/…` or explicit placeholder); Features section; end-user install section; dev setup / build-from-source section. **Expected:** all 6 elements present in order; badge URLs reference this repo (workflow file + `main`); install/dev commands match real repo commands (`pnpm dev:tauri`, `pnpm install`, `cargo build`). **Edge:** badge URL must point at a workflow file that actually exists in `.github/workflows/`; placeholder image path resolves; no dead `#anchor` links.

## Contributing / CoC / Security (AC2)

- [ ] F-2 (AC2a): CONTRIBUTING self-sufficiency — `CONTRIBUTING.md` has: build-from-source steps, PR checklist, wanted-contributions list, rejected-contributions list, AI-assisted PR disclosure section. **Expected:** all present; build steps match AGENTS.md key commands (`pnpm install`, `pnpm --filter @fredo/ui build`, `cargo build`); checklist covers build/test hygiene. **Edge:** no drifted/typo'd pnpm filter names; checklist not empty boilerplate.
- [ ] F-3 (AC2b): CoC verbatim — diff `CODE_OF_CONDUCT.md` against `.opencode/tmp/2773/coc-v2.1-reference.md` and inspect EVERY hunk. **Expected:** identical except the single `[INSERT CONTACT METHOD]` placeholder filled with the maintainer contact (@pktron route). ZERO other diffs. **Edge:** BOM or CRLF differences = FAIL; any second modified spot or edited Covenant paragraph = automatic FAIL (revert, don't re-review).
- [ ] F-4 (AC2c): Security routing + docs/SECURITY.md byte-identity — (1) `.github/SECURITY.md` routes vulnerability reports to a private channel (private vulnerability reporting / Security Advisories), never "open a public issue". (2) `git diff <fork-sha>..HEAD -- docs/SECURITY.md` produces empty output AND `git status --porcelain -- docs/SECURITY.md` is clean. **Edge:** ambiguous fork point → use merge-base; `Get-FileHash` fallback ONLY if git form unavailable in sandbox.

## Licensing (AC3)

- [ ] F-5 (AC3a): Dual license files — root `LICENSE` carries the dual "MIT OR Apache-2.0" notice (Tauri pattern); `LICENSE-MIT` is the MIT text with a copyright line; `LICENSE-APACHE-2.0` is the FULL canonical Apache-2.0 text (version header + appendix present). **Edge:** summarized/truncated Apache text = FAIL; copyright holder line sane and consistent.
- [ ] F-6 (AC3b): Trademark/attribution — README states the logo license (CC-BY-NC-ND) AND a "not affiliated" clause for derivatives/naming. **Edge:** present in License/footer section; not contradicted elsewhere in README.

## GitHub infra (AC4)

- [ ] F-7 (AC4a): validate.yml frozen diff — compare `.github/workflows/validate.yml` content against the pre-spec `.disabled` copy minus lines 1–4 (deactivation comment); job keys are exactly `ui-validate`, `rust-validate`, `validate` (YAML keys, not `name:` strings); trigger still `on: pull_request: branches: ['main']`; no deactivation comment remains. **Expected:** content equality with only the 4 comment lines removed. **Edge:** any extra reformatting/renaming = FAIL.
- [ ] F-8 (AC4b): audit.yml triggers — audit.yml is a NEW file in the spec diff (amended during #2773 round 1: there is no pre-spec copy, so "unchanged vs fork" does not apply). Verify: weekly `schedule:` cron present AND a path filter covering `**/Cargo.lock` on pull_request and push-to-main. **Edge:** cron must be genuinely weekly; path pattern must match `apps/tauri/src-tauri/Cargo.lock`; every `uses:` line SHA-pinned (F-10).
- [ ] F-9 (AC4c): Community files — `.github/CODEOWNERS`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, `config.yml`, `.github/PULL_REQUEST_TEMPLATE.md` all exist. dependabot has exactly 3 ecosystems (github-actions `/`, npm `/`, cargo `apps/tauri/src-tauri`), all `weekly`; `config.yml` has NO `contact_links` key; PR template has Problem / Evidence / checklist. **Edge:** exact `directory` values; issue templates use form-schema structure (`name`, `fields`); CODEOWNERS `* @pktron` eval format.
- [ ] F-10 (AC4d): SHA-pinning — in every workflow file touched by this spec, every `uses:` line referencing a third-party action is pinned to a full 40-char commit SHA with a version comment (`owner/action@<40-hex sha> # vX(.Y)`). **Edge:** `actions/checkout` & co. count as third-party; a tag ref (`@v4`) alone = FAIL; first-party/local actions exempt.
- [ ] F-11 (AC4e): Workflow diff scope — `git diff <fork-sha>..HEAD --stat -- .github/workflows/` shows ONLY validate.yml (re-enable) and audit.yml (trigger) changed. **Edge:** drive-by rename or undeclared added workflow = FAIL.

## GITHUB_SETUP (AC5)

- [ ] F-12 (AC5): GITHUB_SETUP.md self-sufficiency — `docs/GITHUB_SETUP.md` covers all 10 items, each with exact click-path AND gh CLI command: protect-main ruleset (3 required checks + 0 approvals), `v*` tag ruleset, secret scanning + push protection, Dependabot alerts + security updates, CodeQL default setup, private vulnerability reporting, read-only workflow permissions, disable Actions PR create/approve, 2FA, repo topics. **Expected:** click-path page names match current GitHub Settings UI (cross-check `research/24` §3); doc self-contained — no "ask an agent" steps. **Edge:** the 3 required check names must exactly equal the CI job keys (`ui-validate`, `rust-validate`, `validate`); `gh api` ruleset payloads syntactically valid; verification is doc-only — agents never touch repo settings.

## Negative case

- [ ] F-13 (NEG): Out-of-scope absence — (1) `.github/FUNDING.yml` does not exist; (2) no `contact_links` key in `config.yml`; (3) no `release.yml` in `.github/workflows/`; (4) `git diff <fork-sha>..HEAD --stat` touches ONLY docs/, .github/, LICENSE*, README/CONTRIBUTING/CoC files — ZERO files under apps/, packages/, src/ or any app code. **Edge:** a "harmless" app-code tweak is a spec-scope violation = FAIL.

## CI-parity

- [ ] F-14 (CI): Local CI-parity — on the spec-branch tip, run validate.yml's exact command set (read the exact flags from the re-enabled validate.yml): `pnpm install --filter @fredo/ui...`; `pnpm --filter @fredo/ui typecheck`; `pnpm --filter @fredo/ui build`; `pnpm --filter @fredo/ui test:run`; `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`; `cargo test … --locked`; `cargo clippy … --locked -- -D warnings`. **Expected:** every step exits 0. **Edge:** gates this spec's own PR merge (pr_merge_guard); a local failure predicts a red PR check; doubles as build-hygiene evidence. **#2773 amendment (SI round 1):** for docs-only spec branches the cargo steps are REMOVED from verification (build-environment limitation, not a regression — build hygiene gates on code changes only) and `pnpm --filter @fredo/ui typecheck` is OPTIONAL; restore the full set whenever the diff touches apps/ or src-tauri.

## Non-functional

- [ ] F-15 (NFR): YAML validity + link validity — (1) parse all new/changed YAML files (dependabot.yml, 3 issue templates, changed workflows) with a YAML parser (e.g. `npx --yes yaml-lint <files>` or node + js-yaml): zero parse errors. (2) extract every relative link `](…)` from `README.md`, `CONTRIBUTING.md`, `.github/SECURITY.md`, `docs/GITHUB_SETUP.md` and `Test-Path` each: all resolve to real repo paths. **Edge:** external https links format-checked only (no network fetch); `#anchor` links checked against headings in the same file.
