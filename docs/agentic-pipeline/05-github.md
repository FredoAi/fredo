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
| Dev Sub-issue | State machine (Scrum Master drafts) | Implementation Plan (parent) | `ready-for-dev` → `in-progress-dev` |
| Tester Issue | State machine (Scrum Master drafts) | Implementation Plan (parent), PRs | `testing` → `audit` → `done` |

The **feature** (backlog issue) carries `ready-for-test` during implementation and is transitioned to `testing` by the state machine; the **tester issue** is created with the `testing` label (it reads as the testing phase).

---

## Labels

The label set models the workflow state. An issue's label is its pipeline state; comments carry the detail. **The state machine sets and transitions every label** — agents request the transition, and the state machine validates it against the phase model before applying it.

| Label | Meaning | Requested by | → next |
|-------|---------|--------------|--------|
| `triage` | Backlog awaiting triage (intake) | Product Owner | `triage-plan` |
| `triage-plan` | Implementation Plan being produced (triage phase) | Scrum Master | `ready-for-test` |
| `ready-for-dev` | Dev sub-issue is actionable | Scrum Master | `in-progress-dev` |
| `in-progress-dev` | Developer is working it | Developer | — (sub-issue; the feature aggregates to `ready-for-test`) |
| `ready-for-test` | **Feature** — implementation done, all work merged, waiting for the tester | Scrum Master | `testing` |
| `testing` | **Tester issue** — created with this label (reads as the testing phase); the feature is transitioned to it on `ready-for-test → testing` | Scrum Master | `audit` or reopen |
| `audit` | Self-Improver is auditing the issue | Scrum Master | `done` or restart |
| `blocked` | Work is stalled on a dependency | Any (with `Status` comment) | `ready-for-dev` after unblock |
| `done` | Work passed testing | Self-Improver (auto via `audit-record`) | — |

**Label transitions** are executed by the state machine via the `transition` action — never by an agent calling `gh issue edit` directly. The state machine rejects transitions that skip phases or whose guards aren't met.

---

## Branch Naming

- `spec/<spec-issue>` — the **spec integration branch**, one per spec. Auto-created by the state machine when the feature enters `implementation`. All sub-issue work, testing, and evidence accumulates here. It is **never deleted** (it carries the visual evidence trail), so `prune` leaves `spec/*` alone.
- There are **no per-developer or per-sub-issue branches.** Developers work in **worktrees detached at the tip of `spec/<N>`** (`create-worktree` adds `--detach`) and push with `git push origin HEAD:spec/<N>`. Detached worktrees allow many developers in parallel (git forbids two *attached* worktrees on one branch, but allows unlimited detached ones).
- The base branch (`main`) stays stable; the spec integration branch is the working base for a spec's whole lifecycle.
- **Worktrees are created by the state machine** via the `create-worktree` action once the sub-issue is actionable; the base is auto-resolved from the sub-issue's `Parent: Implementation Plan #N` (falling back to `main`). `remove-worktree` cleans up; `prune` removes orphaned worktrees.

**PRs:** the only PR in the pipeline is the **spec PR** (`spec/<N>` → `main`), auto-created by the state machine when the feature enters `testing`. It stays open during testing; once the tester passes and the feature moves to `audit`, the state machine auto-merges it (the branch always survives so evidence URLs keep rendering). These are deterministic side-effects of the `transition` action — no separate actions exist.

---

## Spec PR Checklist

The only PR in the pipeline is the **spec PR** (`spec/<N>` → `main`), auto-created by the state machine when the feature transitions to testing. It must complete this checklist before merge; the Scrum Master verifies it.

```markdown
- [ ] References the parent Implementation Plan issue (spec #<N>)
- [ ] CI green
- [ ] All sub-issues pushed and verified (Status comments present)
- [ ] Tester verdict passed on the consolidated tester issue
- [ ] Docs updated (if the change affects documented surface)
- [ ] Scope: only files belonging to the spec
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
| Create tester issue from QA Plan | `generate-work` (from the `## QA Plan` section) |
| Append spec PR link to tester issue | `comment` on the tester issue |
| Auto label transition on phase change | `transition` (labels + side-effects are state-machine-driven) |
| Auto spec branch + spec PR + merge | `transition` side-effects: `→ implementation` creates `spec/<N>`; `→ testing` opens the spec PR; `testing → audit` merges it |
| Sub-issue actionable labels | state-machine-driven (`generate-work` sets `ready-for-dev`; no action sets `in-progress-dev` today) |
| SLA escalation on `blocked` | surfaced via `blockedDuration` metric (see [Metrics](07-state-machine.md#metrics-the-pipelines-memory)) |
| Worktree lifecycle | `create-worktree` / `remove-worktree` (developer); `prune` removes orphaned worktrees; `spec/*` branches are never pruned |

**The one deliberate exception to single-writer — the developer pushes to the spec integration branch.** The developer commits in a detached worktree and pushes `git push origin HEAD:spec/<N>` (allowed in the developer permission set; `main`/`master` and `HEAD:main` denied). Rationale: `spec/<N>` is the developer's shared *work product* — the worktree sits at its tip, and pushing is how sub-issue work lands. It is not a pipeline-state mutation (issues, labels, comments, merges, closes). Everything *around* the push is still the state machine's: worktree creation/removal (`create-worktree`/`remove-worktree`) and cleanup (`prune`). The **spec PR** (`spec/<N>` → `main`) is created and merged automatically by `transition` — the only PR in the pipeline.

Agents never call `gh`/`git` to write GitHub state — the state machine does. Reads stay direct. **Exception:** the developer pushes `HEAD:spec/<N>` only (see above).
