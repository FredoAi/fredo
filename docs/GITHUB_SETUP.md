# GitHub Settings Runbook — Protecting the Repo for the Open-Source Launch

**Who runs this:** the human maintainer (the repo owner) — this is the only person who
should ever touch repository settings. AI agents never modify repo settings; their only
deliverable was this document and the workflow files it references.

**When to run this:** after the open-source launch PR (Spec #2773) has merged to `main`,
**before** flipping the repository from private to public
(`Settings → General → Danger Zone → Change visibility`). Steps 1–8 and 10 should be in
place while the repo is still private; step 3 (secret scanning) becomes fully automatic
on public repos, but verify it anyway; step 9 is account-level and can be done any time.

**Prerequisites:**
- You are the repo owner (admin) of `FredoAi/fredo`.
- `gh` (GitHub CLI) is installed and authenticated as you: `gh auth status`.
- CI is live: `.github/workflows/validate.yml` runs the jobs `ui-validate`, `rust-validate`,
  and `validate` on pull requests to `main` (re-enabled by Spec #2773).

**Conventions used below:** every setting has a **Click-path** (through the GitHub web UI
as of 2026) and a **CLI** form. Where no real `gh` command exists for a setting, the CLI
entry says **web UI only** — no invented commands. `gh api` calls use real GitHub REST
endpoints and are safe to run as given. Replace `FredoAi/fredo` if the repo slug changes.

Suggested execution order: 1 → 2 → 7 → 8 → 3 → 4 → 5 → 6 → 10 → 9 (branch/tag protection
and Actions hardening first, security toggles next, cosmetics last, account 2FA anytime).

---

## 1. Branch ruleset `protect-main` (require PR + status checks, block force pushes)

**What it does:** nobody but you can merge or push directly to `main`. Outside
contributors open pull requests; CI must pass before merging. On a user-owned repo the
owner is admin and is not blocked by the ruleset — that is the intended solo-maintainer
setup.

**Click-path:** `Settings → Rules → Rulesets → New ruleset → New branch ruleset`
- Ruleset name: `protect-main`
- Enforcement status: **Active**
- Bypass list: leave **empty** (nobody bypasses — not even yourself)
- Target branches: **Add target → Include default branch**
- Rules — enable:
  - ✅ **Restrict deletions**
  - ✅ **Block force pushes**
  - ✅ **Require a pull request before merging** — Required approvals: **0** (you cannot
    self-approve; 0 still forces all outside changes through a PR). Leave
    **"Require approval of the most recent reviewable push"** **OFF** — enabling it would
    block your own merges. (Note: Copilot-only PRs automatically get a +1 approval
    requirement regardless of this value.)
  - ✅ **Require status checks to pass** — add exactly these check names:
    **`ui-validate`**, **`rust-validate`**, **`validate`** (search by name; the checks
    appear in "Recent quick picks" after the workflow's first run on a PR — you can also
    type the exact names manually).
- Click **Create**.

**CLI:** `gh` has **no** `gh ruleset` subcommand (verify: `gh ruleset --help` →
"unknown command"; if a future gh version adds one, prefer it). Use the REST endpoint
`POST /repos/{owner}/{repo}/rulesets`. Save this payload as `protect-main.json`:

```json
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_status_check_policy": false,
        "required_status_checks": [
          { "context": "ui-validate", "integration_id": null },
          { "context": "rust-validate", "integration_id": null },
          { "context": "validate", "integration_id": null }
        ]
      }
    }
  ]
}
```

Then create it:

```
gh api --method POST repos/FredoAi/fredo/rulesets --input protect-main.json
```

Verify:

```
gh api repos/FredoAi/fredo/rulesets
```

## 2. Tag ruleset on `v*` (protect release tags)

**What it does:** prevents accidental creation/deletion/rewriting of release tags
(`v1.2.3` style). Relevant from the first release on (release pipeline is a planned
follow-up).

**Click-path:** `Settings → Rules → Rulesets → New ruleset → New tag ruleset`
- Ruleset name: `protect-release-tags`
- Enforcement status: **Active**, Bypass list: empty
- Target tags: **Add target → Add pattern** → `v*`
- Rules — enable:
  - ✅ **Restrict creations**
  - ✅ **Restrict deletions**
  - ✅ **Block force pushes**
- Click **Create**.

**CLI:** same endpoint as step 1. Save as `protect-tags.json`:

```json
{
  "name": "protect-release-tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "creation" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

```
gh api --method POST repos/FredoAi/fredo/rulesets --input protect-tags.json
```

## 3. Secret scanning + push protection

**What it does:** scans the full git history for known secret formats and blocks pushes
that introduce a detected secret (push protection).

**Click-path:** `Settings → Code security and analysis → Secret protection`
- Enable **Secret scanning**
- Enable **Push protection**

**CLI:** **web UI only** — there is no dedicated `gh` command for these toggles.
(On public repositories secret scanning and push protection are enabled automatically
and free of charge; after the visibility flip, use this click-path to confirm both are
on rather than assuming.)

## 4. Dependabot alerts + Dependabot security updates

**What it does:** alerts on known vulnerabilities in dependencies; opens automatic
upgrade PRs for them. (The dependency graph is enabled by default on public repos.
Weekly version updates for npm/cargo/github-actions are already configured in
`.github/dependabot.yml` — that file needs no settings change.)

**Click-path:** `Settings → Code security and analysis → Dependabot`
- Enable **Dependabot alerts**
- Enable **Dependabot security updates**

**CLI:**

```
gh api --method PUT repos/FredoAi/fredo/vulnerability-alerts
gh api --method PUT repos/FredoAi/fredo/automated-security-fixes
```

## 5. CodeQL code scanning — Default setup

**What it does:** zero-config CodeQL analysis on pushes, PRs, and a weekly schedule
(free on public repos; also scans GitHub Actions workflow files).

**Click-path:** `Settings → Code security → Code scanning` → **Default setup** →
**Enable** → keep **Default** query suite → **Save**.

**CLI:** real REST endpoint — `PATCH /repos/{owner}/{repo}/code-scanning/default-setup`:

```
gh api --method PATCH repos/FredoAi/fredo/code-scanning/default-setup -F state=configured -F query_suite=default
```

This is asynchronous (the API answers `202 Accepted`); watch progress on the
**Code scanning** page. If the endpoint is unavailable for your repo state, use the
click-path above — it is the same operation in the UI.

## 6. Private vulnerability reporting

**What it does:** adds a **"Report a vulnerability"** button to the repo's Security tab
so researchers can file privately (they become advisory collaborators; you can spin up a
temporary private fork to fix). This is the private reporting channel that
[.github/SECURITY.md](../.github/SECURITY.md) points to. **Strongly recommended** —
without it, reporters must fall back to email or public issues.

**Click-path:** `Settings → Code security → Private vulnerability reporting` → **Enable**.

**CLI:** **web UI only**.

## 7. Actions workflow permissions → read-only default

**What it does:** the implicit `GITHUB_TOKEN` gets read-only permissions by default;
jobs that need write must opt in via an explicit `permissions:` block (audit.yml already
declares `contents: read`; the future release workflow will declare `contents: write`
in its own job).

**Click-path:** `Settings → Actions → General` → **Workflow permissions** →
select **"Read repository contents and packages permissions"** → **Save**.

**CLI:** the `PUT /repos/{owner}/{repo}/actions/permissions/workflow` endpoint requires
**both** fields in one call, so this one command sets steps 7 and 8 together:

```
gh api --method PUT repos/FredoAi/fredo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_requests=false
```

## 8. Disable "Allow GitHub Actions to create and approve pull requests"

**What it does:** workflows can never create or approve PRs — closes an entire class of
token-abuse attacks.

**Click-path:** same page as step 7 (`Settings → Actions → General` → **Workflow
permissions**) → untick **"Allow GitHub Actions to create and approve pull requests"** →
**Save**.

**CLI:** covered by the same command as step 7 (the
`-F can_approve_pull_request_requests=false` flag). Idempotent — if you want to
(re-)apply it standalone:

```
gh api --method PUT repos/FredoAi/fredo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_requests=false
```

## 9. Two-factor authentication + passkey on your account

**What it does:** account-level 2FA and a passkey protect the single account that can
merge to `main`.

**Click-path:** on github.com (account settings, not repo settings):
your profile picture → `Settings → Password and authentication` →
**Enable two-factor authentication** → then **Add a passkey** on the same page.

**CLI:** **web UI only**.

## 10. Repo topics

**What it does:** discoverability — topics surface the repo in GitHub topic searches and
on the repo home under "About".

**Click-path:** repo home → **About** ⚙ (next to the description) → **Topics** field →
add: `tauri`, `rust`, `react`, `typescript`, `ai-agents`, `ai-coding-agents`,
`desktop-app`, `llm`, `cross-platform`, `developer-tools` → **Save changes**.

**CLI:**

```
gh repo edit FredoAi/fredo --add-topic tauri --add-topic rust --add-topic react --add-topic typescript --add-topic ai-agents --add-topic ai-coding-agents --add-topic desktop-app --add-topic llm --add-topic cross-platform --add-topic developer-tools
```

Verify:

```
gh repo view FredoAi/fredo --json repositoryTopics
```

---

## Post-launch hardening (PO-approved follow-up)

### SHA-pin `validate.yml`'s tag-pinned actions

Spec #2773 deliberately left `validate.yml`'s four `uses:` lines tag-pinned — its content
was frozen (only the rename + deactivation-comment removal were permitted, Resolution 1).
Pin them to full-length commit SHAs as the first post-launch hardening commit. The
convention is `uses: owner/action@<40-char-sha> # vX.Y.Z`.

Values resolved at Spec #2773 implementation time (August 2026) — **re-resolve against
the latest release of each action before committing the pin**, then edit
`.github/workflows/validate.yml`:

| Action | Current pin | SHA to pin (at resolution time) |
|---|---|---|
| `actions/checkout@v4` | v4.2.2 | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| `pnpm/action-setup@v4` | v4.4.0 | `fc06bc1257f339d1d5d8b3a19a8cae5388b55320` |
| `actions/setup-node@v4` | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions-rust-lang/setup-rust-toolchain@v1` | v1.17.0 | `166cdcfd11aee3cb47222f9ddb555ce30ddb9659` |

To resolve a fresh SHA for a release tag `vX.Y.Z` of an action:

```
git ls-remote https://github.com/<owner>/<action>.git refs/tags/vX.Y.Z^{ }
```

Note: for actions whose release tags are **annotated** (e.g. `pnpm/action-setup`), the
`refs/tags/vX.Y.Z` entry points at a tag *object* — pin the **peeled commit** SHA
(the `^{}`-suffixed query above, or the commit shown on the release page), not the tag
object SHA.

### Optional follow-ups (from the launch research)

- Add **Require linear history** and/or **Require signed commits** to the `protect-main`
  ruleset (both optional; linear history enables squash/rebase merges for easy reverts).
- When the release pipeline lands (roadmap Phase 4): pin every release-workflow action to
  SHAs and consider `step-security/harden-runner` on release jobs (they hold signing
  keys).
- Run the OpenSSF Scorecard action to flag remaining risky patterns.

---

## Quick verification checklist

```
gh api repos/FredoAi/fredo/rulesets
gh api repos/FredoAi/fredo --jq .security_and_analysis
gh api repos/FredoAi/fredo/actions/permissions/workflow
gh api repos/FredoAi/fredo/vulnerability-alerts
gh repo view FredoAi/fredo --json repositoryTopics
```

Expected: two rulesets (`protect-main`, `protect-release-tags`) with `enforcement:
active`; `security_and_analysis` shows secret scanning + push protection + Dependabot
settings; workflow permissions show `default_workflow_permissions: read` and
`can_approve_pull_request_requests: false`; vulnerability-alerts returns `204`/enabled;
topics list the ten values from step 10.
