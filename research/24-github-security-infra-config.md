# GitHub Security & Infra Configuration for a Solo Maintainer Going Public

> Sources: docs.github.com (fetched live) + verified .github/ folders of tauri-apps/tauri and
> microsoft/vscode. Goal: only the owner merges to main; users can download and use the app.

## 1. Branch Protection vs Rulesets (2024+)

| | Branch protection rules | Rulesets |
|---|---|---|
| How many per branch | Only one can apply | Multiple; rules aggregate, most restrictive wins |
| Enforcement | Always on | Active / Disabled (toggle without deleting) |
| Visibility | Admin-only | Anyone with read access can view active rulesets |
| Bypass list | Admins implicitly bypass | Explicit bypass actors (roles/teams/Apps) — orgs only |
| Tags protection | No | Yes (tag rulesets: restrict creations/updates/deletions) |

Docs:
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

### Recommended ruleset config — "solo maintainer, only I merge to main"

On a user-owned repo the owner is admin, so GitHub never blocks *them*; the rules block everyone
else. Contributors can open PRs but cannot merge.

`Settings → Rules → Rulesets → New branch ruleset`:
- Name: `protect-main`, Enforcement status: **Active**, Bypass list: none
- Target branches: **Include default branch**
- Rules:
  - ✅ Restrict deletions (default)
  - ✅ **Block force pushes** (default)
  - ✅ **Require a pull request before merging** — **Required approvals: 0** (solo maintainer
    can't self-approve; 0 still forces all outside changes through a PR). Leave "require approval
    of most recent reviewable push" OFF (would block your own merge). Note: Copilot-only PRs
    automatically get +1 approval requirement.
  - ✅ **Require status checks to pass** — add CI job names (keep job names unique across workflows)
  - ✅ Require linear history (optional; enables squash/rebase merge for easy reverts)
  - ✅ Require signed commits (optional)
  - ❌ Skip merge queue (overkill for solo traffic)

**Tag ruleset** (protect release tags):
- Target: fnmatch `v*`
- ✅ Restrict creations, ✅ Restrict deletions, ✅ Block force pushes

Note: "Restrict who can push to matching branches" exists in public repos on Free *organizations*;
user-owned repos rely on the ruleset above. Branch protection rules by default don't apply to
admins — that is the intended solo setup.

## 2. The `.github/` Folder Inventory

Verified from tauri-apps/tauri and microsoft/vscode.

### `.github/CODEOWNERS`
Auto-assigns reviewers; with rulesets can *require* code-owner approval. Tauri's real file:
```
* @tauri-apps/wg-tauri
.github @tauri-apps/wg-devops
```
**Solo version:** `* @yourusername`.

### `.github/dependabot.yml`
VS Code's real file (trimmed):
```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
```
For Fredo add `cargo` (directory `/apps/tauri/src-tauri`).

### `.github/SECURITY.md`
Security policy — how to report, supported versions, response SLA. Displayed in the repo's
Security tab. Private vulnerability reporting is a SEPARATE Settings toggle (§3).

### `.github/FUNDING.yml`
Tauri's real file:
```yaml
github: tauri-apps
open_collective: tauri
```
Valid keys: github, patreon, open_collective, ko_fi, custom, etc.

### `.github/ISSUE_TEMPLATE/` + config.yml
Form templates (`bug_report.yml`, `feature_request.yml` with input/textarea/dropdown fields) +
config.yml with contact_links (Tauri links Discord here).

### `.github/PULL_REQUEST_TEMPLATE.md`
Tauri's uses an HTML comment checklist: descriptive title, `closes #123`, change-file requirement,
"ensure `cargo test` and `cargo clippy` pass". OpenClaw adds "What Problem This Solves" + "Evidence
(screenshots before/after)".

### `.github/workflows/`
- **CI** — test/lint on push/pull_request. Tauri splits per-area (lint-rust.yml, lint-js.yml, fmt.yml).
- **Audit** — Tauri's real audit.yml: daily cron + on `**/Cargo.lock`/`**/Cargo.toml` changes →
  `rustsec/audit-check@v2` (fails on RustSec advisories) + `pnpm audit`.
- **Release** — tag push or workflow_dispatch; see §4.
- Optional: `supply-chain.yml` (`cargo vet` daily suggest) — good OpenSSF Scorecard signal.

Also seen: CODE_OF_CONDUCT.md / CONTRIBUTING.md inside .github/, copilot-instructions.md, RELEASING.md.

## 3. Repo Security Features to Toggle in Settings

**Secret scanning + push protection** — free and automatic for public repos; scans full git
history. Push protection blocks a push containing a detected secret. Toggle at
`Settings → Code security and analysis → Secret protection`.

**Dependabot** — `Settings → Code security and analysis`:
- ✅ Dependency graph (default on public), ✅ Dependabot alerts, ✅ security updates (auto-PRs),
  ✅ version updates (via dependabot.yml)

**CodeQL code scanning** — use **Default setup** (zero-config, push/PR/schedule, free on public;
also scans Actions workflows).

**Private vulnerability reporting** — `Settings → Code security → Private vulnerability reporting`.
Gives a "Report a vulnerability" button on the Security tab; reporter becomes advisory
collaborator; "Start a temporary private fork" to fix privately. **Strongly recommended** —
otherwise reporters must email you or open a public issue.

**Actions hardening** (https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions):
- `GITHUB_TOKEN` default permissions → **read-only** (`Settings → Actions → General → Workflow
  permissions`); elevate per-job via `permissions:` blocks (e.g. `contents: write` only in release job)
- Never classic PATs for CI. Use built-in GITHUB_TOKEN, fine-grained PATs (repo-scoped, minimal,
  expiring) for local/dev, GitHub App tokens or OIDC for cloud
- Disable "Allow GitHub Actions to create and approve pull requests"
- **Pin third-party actions to full-length commit SHA** — "the only way to use an action as an
  immutable release". GitHub offers repo/org policies to require SHA-pinning. Convention:
  `uses: actions/checkout@<sha> # v4`
- Avoid `pull_request_target` with untrusted checkouts (pwn requests:
  https://securitylab.github.com/research/github-actions-preventing-pwn-requests/)
- Optional: `step-security/harden-runner` (egress monitoring — especially release jobs holding
  signing keys); run OpenSSF Scorecard action to flag risky patterns

**2FA** — orgs: require 2FA in org settings; solo: enable 2FA + passkey on your account.

## 4. Release / Distribution Infrastructure (Tauri)

**tauri-apps/tauri-action** — https://github.com/tauri-apps/tauri-action. Canonical workflow:
```yaml
name: 'publish'
on:
  push:
    tags: ['v*']

jobs:
  publish-tauri:
    permissions:
      contents: write        # only this job gets write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: 'macos-latest'
            args: '--target aarch64-apple-darwin'
          - platform: 'macos-latest'
            args: '--target x86_64-apple-darwin'
          - platform: 'ubuntu-22.04'
            args: ''
          - platform: 'windows-latest'
            args: ''
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: pnpm install
      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: app-v__VERSION__
          releaseName: 'App v__VERSION__'
          releaseDraft: true       # review before publishing — recommended
          args: ${{ matrix.args }}
```
Key inputs: `releaseDraft`, `generateReleaseNotes`, `uploadUpdaterJson` (default true — emits
`latest.json` pointing at release assets). Guide: https://v2.tauri.app/distribute/pipelines/github/
(ubuntu needs libwebkit2gtk-4.1-dev, libappindicator3-dev, librsvg2-dev, patchelf).

**Signing / code-signing:**
- **Updater signing is mandatory and cannot be disabled.** `tauri signer generate -w ~/.tauri/myapp.key`;
  public key in `tauri.conf.json` (`plugins.updater.pubkey`); private key as CI secrets
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Env vars only — .env files do NOT work in CI.
- `bundle.createUpdaterArtifacts: true` → emits `.msi/.sig`, `setup.exe/.sig`, `.app.tar.gz/.sig`, `AppImage` + sig.
- OS code-signing is separate: macOS Apple Developer ID + notarization (`APPLE_CERTIFICATE`,
  `APPLE_ID`, `APPLE_PASSWORD` secrets); Windows optional Authenticode (avoids SmartScreen warnings);
  Linux generally unsigned. https://v2.tauri.app/distribute/sign/macos/ and /sign/windows/

**Auto-update config (`tauri.conf.json`):**
```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "CONTENT FROM PUBLICKEY.PEM",
      "endpoints": ["https://github.com/user/repo/releases/latest/download/latest.json"]
    }
  }
}
```
TLS enforced in production. Windows `installMode: "passive"` recommended.

## 5. Rust / Node Supply-Chain Hardening

**Rust:**
- `cargo audit` / `rustsec/audit-check@v2` daily cron + on lockfile changes (Tauri's audit.yml)
- `cargo-deny` (`cargo deny check`: advisories, bans, licenses, sources)
- `cargo vet` (Mozilla dependency audit tracking) — optional, good Scorecard signal
- Commit `Cargo.lock` (yes, for binaries)

**Node:**
- `pnpm audit` in CI; commit `pnpm-lock.yaml`; Dependabot version + security updates
- Optional: `actions/dependency-review-action` on PRs

## TL;DR checklist for going public

1. **Ruleset** on main: PR required (0 approvals), status checks required, block force
   pushes/deletions; **tag ruleset** on `v*`.
2. **Settings toggles:** secret scanning + push protection, Dependabot alerts + security updates,
   CodeQL default setup, **private vulnerability reporting**, 2FA, GITHUB_TOKEN read-only default.
3. **`.github/`:** CODEOWNERS (`* @you`), dependabot.yml (actions/npm/cargo), SECURITY.md,
   issue templates + config.yml, PULL_REQUEST_TEMPLATE.md, CI + audit workflows.
4. **Releases:** tauri-action matrix build → draft release with msi/nsis/dmg/AppImage +
   `latest.json`; updater keypair as secrets; OS code-signing as budget allows.
5. **Supply chain:** daily rustsec/audit-check + pnpm audit cron (Tauri pattern), cargo-deny,
   SHA-pinned actions, least-privilege job permissions.

## Citations

- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning
- https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts
- https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning
- https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- https://github.com/tauri-apps/tauri-action
- https://v2.tauri.app/distribute/pipelines/github/
- https://v2.tauri.app/plugin/updater/
- https://github.com/step-security/harden-runner
- https://securitylab.github.com/research/github-actions-preventing-pwn-requests/
