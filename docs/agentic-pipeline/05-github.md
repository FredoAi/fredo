# GitHub Conventions

GitHub is the communication backbone and the log ([01-principles.md](01-principles.md#5-github-is-the-communication-backbone-and-the-log)). This file defines the mechanics: issue types, labels, branch naming, PR checklist, comment prefixes, and the single-writer rule.

> **Single-writer rule (principle 2 point 8):** the **state machine** owns all pipeline GitHub writes — creating issues, setting/transitioning labels, posting comments, creating branches/worktrees, merging PRs, closing issues. Agents draft content and request an action through the state machine ([07-state-machine.md](07-state-machine.md#the-action-request-api)); they never call `gh`/`git` to write. They read GitHub directly.

---

## Issue Model

Each feature/epic produces **one Implementation Plan issue** plus **sub-issues**. Issue templates live in [04-artifacts.md](04-artifacts.md) and `templates/PO-issue-template.md`; the state machine validates drafted bodies against them.

| Issue type | Created by (drafted by) | References | Labels |
|------------|-----------|------------|--------|
| Backlog Issue | State machine (Product Owner drafts) | — | `triage` |
| Implementation Plan | State machine (Scrum Master drafts) | Backlog issue | `triage` |
| Dev Sub-issue | State machine (Scrum Master drafts) | Implementation Plan (parent) | `ready-for-dev` → `in-progress-dev` → `ready-for-test` |
| Tester Issue | State machine (Scrum Master drafts) | Implementation Plan (parent), PRs | `ready-for-test` → `testing` → `done` |

---

## Labels

The label set models the workflow state. An issue's label is its pipeline state; comments carry the detail. **The state machine sets and transitions every label** — agents request the transition, and the state machine validates it against the phase model before applying it.

| Label | Meaning | Requested by | → next |
|-------|---------|--------------|--------|
| `triage` | Work is being planned | Product Owner, Scrum Master | `ready-for-dev` / `ready-for-test` |
| `ready-for-dev` | Dev sub-issue is actionable | Scrum Master | `in-progress-dev` |
| `in-progress-dev` | Developer is working it | Developer | `ready-for-test` |
| `ready-for-test` | Work merged, waiting for tester | Scrum Master | `testing` |
| `testing` | Tester is executing the QA Plan | Tester | `audit` or reopen |
| `audit` | Self-Improver is auditing the issue | Scrum Master | `done` or restart |
| `blocked` | Work is stalled on a dependency | Any (with `Status` comment) | `ready-for-dev` after unblock |
| `done` | Work passed testing | Scrum Master | — |

**Label transitions** are executed by the state machine via the `transition` action — never by an agent calling `gh issue edit` directly. The state machine rejects transitions that skip phases or whose guards aren't met.

---

## Branch Naming

- `feat/<issue-number>-short-desc` — feature work (dev sub-issues).
- Branches are short-lived: created at sub-issue start, merged and deleted at sub-issue end.
- All dev work happens on the feature branch; the base branch stays stable.
- **Branches/worktrees are created by the state machine** via the `create-branch`/`create-worktree` action once the sub-issue is actionable. Local cleanup of merged `feat/` branches and orphaned worktrees is the `prune` action.

---

## PR Checklist

Every feature PR must complete this checklist. The developer fills it in; the Scrum Master verifies before merging.

```markdown
- [ ] References the sub-issue (closes #<N>)
- [ ] CI green
- [ ] Unit tests pass
- [ ] Docs updated (if the change affects documented surface)
- [ ] Reviewers assigned
- [ ] Scope: only sub-issue files touched
```

---

## Comment Conventions

Prefix every agent comment to keep issue timelines scannable and filterable. **Comments are posted by the state machine** via the `comment` action — the agent drafts the body to a temp file and requests the post.

| Prefix | Purpose | Requested by |
|--------|---------|--------------|
| `Decision` | A decision was made (design, scope, tradeoff) | Triage cluster, Scrum Master |
| `Question` | An open question requiring an answer | Any |
| `Status` | A state change or progress update | Scrum Master, Developer, Tester |
| `Evidence` | Test results, screenshots, logs, proof | Tester, Developer |

**Rules:**
- One topic per comment. Never bury a question inside a status update.
- Every `Question` eventually gets a `Decision` in reply — no orphan questions.
- Evidence comments carry the receipts: links, screenshots, log excerpts — not "it worked."
- Every agent-authored comment ends with `*Authored by <Agent Name>*`.
- The state machine validates the prefix is legal for the phase and the required fields are present before posting.

---

## GitHub Write Model (replaces a separate automation roadmap)

Because the state machine is the **single writer**, mechanical label/project bookkeeping is not a separate automation layer — it is the state machine's job, executed at write time. The Action Request API ([07-state-machine.md](07-state-machine.md#the-action-request-api)) covers:

| Capability | State machine action |
|-----------|----------------------|
| Create tester issue from QA Plan | `create-issue` (validated against template) |
| Append PR link to tester issue | `comment` on the tester issue |
| Auto label transition on merge/close | `transition` + `merge-pr` / `close-issue` |
| Set a sub-issue lifecycle label (`in-progress-dev`) | `set-label` (developer marks pickup; scrum-master too) |
| SLA escalation on `blocked` | surfaced via `blockedDuration` metric (see [Metrics](07-state-machine.md#metrics-the-pipelines-memory)) |
| Branch cleanup after merge | `merge-pr` (deletes the merged `feat/` branch) + `prune` (removes stale local branches/worktrees) |

**The one deliberate exception to single-writer — PR creation.** The developer opens feature PRs directly (`gh pr create`, allowed in the developer permission set). Rationale: a PR is the developer's *work product* — it references the sub-issue, carries the diff, and is the object the Scrum Master reviews. It is not a pipeline-state mutation (issues, labels, comments, branches, merges, closes). Everything *around* the PR is still the state machine's: branch creation (`create-branch`/`create-worktree`), merge (`merge-pr`), and branch cleanup (`prune`). If PR creation ever needs validation (e.g., scope/checklist gates), promote it to a state-machine action — it is the only write that currently bypasses the machine.

Agents never call `gh`/`git` to write — the state machine does. Reads stay direct. **Exception:** the developer opens feature PRs directly (see above).
