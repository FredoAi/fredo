# oss-launch — Smoke Tests

Adapted from the standardized app-boots boilerplate: this spec is **docs/config-only** (zero running-system observables), so the webview/DOM/telemetry cases do not apply. Smoke = repo-state sanity + the CI-parity quick gate. Run on the spec-branch tip before deep testing.

- [ ] S-1: Required-file inventory — `Test-Path` (or `git ls-files`) confirms every file the spec must add exists: `README.md` (reworked), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE-2.0`, `.github/SECURITY.md`, `docs/GITHUB_SETUP.md`, `.github/CODEOWNERS`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, re-enabled `.github/workflows/validate.yml`, updated `.github/workflows/audit.yml`.
- [ ] S-2: Working tree clean — `git status --porcelain` shows no uncommitted/unexpected changes for the spec's paths (in particular `docs/SECURITY.md` untouched).
- [ ] S-3: Diff scope sane — `git diff <fork-sha>..HEAD --stat` lists only docs/ + .github/ + LICENSE*/README/CONTRIBUTING/CoC paths; zero app-code files.
- [ ] S-4: YAML parses — all new/changed YAML files load without parse errors (quick `npx --yes yaml-lint` or node + js-yaml pass).
- [ ] S-5: CI-parity quick gate — `pnpm --filter @fredo/ui typecheck` exits 0 (fastest signal); full command set runs as functional case F-14.
