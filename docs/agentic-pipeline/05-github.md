# GitHub Conventions

GitHub is the communication backbone and the log ([01-principles.md](01-principles.md#5-github-is-the-communication-backbone-and-the-log)). This file defines the mechanics: issue types, labels, branch naming, PR checklist, comment prefixes, and automation roadmap.

---

## Issue Model

Each feature/epic produces **one Implementation Plan issue** plus **sub-issues**. Issue templates in `.opencode/templates/issues/` (implemented later) mirror the templates in [04-artifacts.md](04-artifacts.md).

| Issue type | Created by | References | Labels |
|------------|-----------|------------|--------|
| Backlog Issue | Product Owner | — | `triage` |
| Implementation Plan | Scrum Master | Backlog issue | `triage` |
| Dev Sub-issue | Scrum Master | Implementation Plan (parent) | `ready-for-dev` → `in-progress-dev` → `ready-for-test` |
| Tester Issue | Scrum Master | Implementation Plan (parent), PRs | `ready-for-test` → `testing` → `done` |

---

## Labels

The label set models the workflow state. An issue's label is its pipeline state; comments carry the detail.

| Label | Meaning | Set by | → next |
|-------|---------|--------|--------|
| `triage` | Work is being planned | Product Owner, Scrum Master | `ready-for-dev` / `ready-for-test` |
| `ready-for-dev` | Dev sub-issue is actionable | Scrum Master | `in-progress-dev` |
| `in-progress-dev` | Developer is working it | Developer | `ready-for-test` |
| `ready-for-test` | Work merged, waiting for tester | Scrum Master | `testing` |
| `testing` | Tester is executing the QA Plan | Tester | `done` or reopen |
| `blocked` | Work is stalled on a dependency | Any (with `Status` comment) | `ready-for-dev` after unblock |
| `done` | Work passed testing | Tester / Scrum Master | — |

**Label transitions** are the Scrum Master's responsibility to enforce (see automation below for the future automatic path).

---

## Branch Naming

- `feat/<issue-number>-short-desc` — feature work (dev sub-issues).
- Branches are short-lived: created at sub-issue start, merged and deleted at sub-issue end.
- All dev work happens on the feature branch; the base branch stays stable.

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

Prefix every agent comment to keep issue timelines scannable and filterable.

| Prefix | Purpose | Used by |
|--------|---------|---------|
| `Decision` | A decision was made (design, scope, tradeoff) | Triage cluster, Scrum Master |
| `Question` | An open question requiring an answer | Any |
| `Status` | A state change or progress update | Scrum Master, Developer, Tester |
| `Evidence` | Test results, screenshots, logs, proof | Tester, Developer |

**Rules:**
- One topic per comment. Never bury a question inside a status update.
- Every `Question` eventually gets a `Decision` in reply — no orphan questions.
- Evidence comments carry the receipts: links, screenshots, log excerpts — not "it worked."
- Every agent-authored comment ends with `*Authored by <Agent Name>*`.

---

## Automation Roadmap

Planned (not yet implemented). The goal is to remove mechanical label/project bookkeeping from agents.

| Automation | Trigger | Effect |
|-----------|---------|--------|
| Tester issue creation | Implementation Plan posted | Auto-create consolidated tester issue from QA Plan section |
| Tester issue update | Feature PR merged | Append PR link to the open tester issue |
| Auto label transition | PR merged / issue closed | `in-progress-dev` → `ready-for-test`; `testing` → `done` |
| Assignee notification | Label changes | Notify assigned developer / tester |
| SLA escalation | `blocked` label + 4h timeout | Remind Scrum Master |
| Branch cleanup | PR merged | Delete merged `feat/` branches |

Until these exist, agents perform the transitions manually via the git-operations workflow.
