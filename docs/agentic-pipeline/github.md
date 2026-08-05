# GitHub Conventions

GitHub is the communication backbone and the log ([principles.md](principles.md#5-github-is-the-communication-backbone-and-the-log)). This file defines the mechanics: issue types, labels, branch naming, PR checklist, comment prefixes, and the single-writer rule.

> **Single-writer rule (principle 2 point 8):** the **state machine** owns all pipeline GitHub writes — creating issues, setting/transitioning labels, posting comments, creating branches/worktrees, merging PRs, closing issues. Agents draft content and request an action through the state machine ([state-machine.md](state-machine.md#the-action-request-api)); they never call `gh`/`git` to write. They read GitHub directly.

---

## Issue Model

Each feature/epic produces **one feature (backlog) issue — the single source of truth — plus one Implementation Plan issue**. Sub-issues and a separate tester issue were **removed** (PO decision): all comments land on the feature issue, and the tester posts its `## Evidence` verdict on the plan issue. Issue templates live in [artifacts.md](artifacts.md) and `templates/PO-issue-template.md`; the state machine validates drafted **backlog** bodies against the PO template (backlog type, incl. bug-variant bodies) — other bodies are drafted to their templates without machine re-validation.

| Issue type | Created by (drafted by) | References | Labels |
|------------|-----------|------------|--------|
| Backlog Issue | State machine (Product Owner drafts) | — | `triage` |
| Implementation Plan | State machine (transition side-effect: seeds from [templates/triage-plan-template.md](templates/triage-plan-template.md) and assembles every section from the A2A file) | Backlog issue | `triage` |

The **feature** (backlog issue) is the **single source of truth** — it carries `ready-for-test` during implementation and all `Decision`/`Status`/`Question` comments land on it. The **plan issue** carries the assembled plan and is where the tester posts its `## Evidence` verdict.

---

## Labels

The label set models the workflow state. An issue's label is its pipeline state; comments carry the detail. **The state machine sets and transitions every label** — agents request the transition, and the state machine validates it against the phase model before applying it.

| Label | Meaning | Requested by | → next |
|-------|---------|--------------|--------|
| `triage` | Backlog awaiting triage (intake) | Product Owner | `triage-plan` |
| `triage-plan` | Implementation Plan being produced (triage phase — deliberation until the convergence marker is posted) | Self-Improver | `ready-for-test` |
| `ready-for-dev` | Legacy dev-work label (accepted for `create-worktree`) | Self-Improver | `in-progress-dev` |
| `in-progress-dev` | Legacy dev-work label | — (reserved; no action sets it today) | — |
| `ready-for-test` | **Feature** — implementation phase; the developer works directly on the feature's `spec/<N>` branch (sub-issues removed) | Self-Improver | `testing` |
| `testing` | **Feature** — testing phase; the tester posts its `## Evidence` verdict on the **plan issue** | Self-Improver | `audit` or back to `implementation` |
| `audit` | Self-Improver is auditing the issue | Self-Improver | `done` or restart |
| `blocked` | Work is stalled on a dependency | Self-Improver or Developer (with `Status` comment) | `ready-for-dev` after unblock |
| `done` | Work passed testing | Self-Improver (auto via `audit-record`) | — |

**Label transitions** are executed by the state machine via the `transition` action — never by an agent calling `gh issue edit` directly. The state machine rejects transitions that skip phases or whose guards aren't met.

---

## Branch Naming

- `spec/<spec-issue>` — the **spec integration branch**, one per spec. Auto-created by the state machine when the feature enters `implementation`. All developer work, testing, and evidence accumulates here. It is **never deleted** (it carries the visual evidence trail), so `prune` leaves `spec/*` alone.
- There are **no per-developer branches.** The developer works in a **worktree detached at the tip of `spec/<N>`** (`create-worktree` adds `--detach`) and pushes with `git push origin HEAD:spec/<N>`. Detached worktrees allow many developers in parallel (git forbids two *attached* worktrees on one branch, but allows unlimited detached ones).
- The base branch (`main`) stays stable; the spec integration branch is the working base for a spec's whole lifecycle.
- **Worktrees are created by the state machine** via the `create-worktree` action once the feature is in the implementation phase (labeled `ready-for-test`); the base is the feature's own `spec/<N>` branch. `remove-worktree` cleans up; `prune` removes orphaned worktrees.

**PRs:** the only PR in the pipeline is the **spec PR** (`spec/<N>` → `main`), auto-created by the state machine when the feature enters `testing`. It stays open during testing; once the tester passes and the feature moves to `audit`, the state machine auto-merges it (the branch always survives so evidence URLs keep rendering). These are deterministic side-effects of the `transition` action — no separate actions exist.

---

## Spec PR Checklist

The only PR in the pipeline is the **spec PR** (`spec/<N>` → `main`), auto-created by the state machine when the feature transitions to testing. It must complete this checklist before merge; the Self-Improver verifies it.

```markdown
- [ ] References the parent Implementation Plan issue (spec #<N>)
- [ ] CI green
- [ ] Developer pushed to `spec/<N>` (implementation gate: commits ahead of main)
- [ ] Tester verdict passed on the plan issue (`## Evidence`)
- [ ] Docs updated (if the change affects documented surface)
- [ ] Scope: only files belonging to the spec
```

---

## Comment Conventions

Prefix every agent comment to keep issue timelines scannable and filterable. **Comments are posted by the state machine** via the `comment` action — the agent drafts the body to a temp file and requests the post.

| Prefix | Purpose | Requested by |
|--------|---------|--------------|
| `Decision` | A decision was made (design, scope, tradeoff) | Self-Improver (gated — `Decision` comments carry exit-guard markers) |
| `Question` | An open question requiring an answer | Any |
| `Status` | A state change or progress update | Self-Improver, Developer, Tester |
| `Evidence` | Test results, screenshots, logs, proof | Tester, Developer |

**Rules:**
- One topic per comment. Never bury a question inside a status update.
- Every `Question` eventually gets a `Decision` in reply — no orphan questions.
- Evidence comments carry the receipts: links, screenshots, log excerpts — not "it worked."
- Every agent-authored comment ends with `*Authored by <Agent Name>*`.
- The state machine validates the prefix is one of `Decision`/`Question`/`Status`/`Evidence` (and `Decision` is Self-Improver only) and the required fields are present before posting.

**Triage deliberation usage:** during Phase 2, the detailed back-and-forth happens in the A2A working file `.opencode/tmp/<issue>/triage.md` (ephemeral, gitignored) — **not** in comments. Each planner writes its section draft under its own `## <Agent>` heading and appends agent-tagged points to `## Discussion`; the planners reply to each other's points there. GitHub comments carry only:
- the **convergence marker** — the Self-Improver posts a `Decision` comment: `Triage converged — all planner questions resolved.` The state machine's triage gate (**agreement gate**) requires this marker before `triage → implementation`.
- the final **Implementation Plan** — auto-assembled by the `triage → implementation` transition: the state machine seeds it from the template and fills each agreed section (read from the A2A file).

---

## GitHub Write Model (replaces a separate automation roadmap)

Because the state machine is the **single writer**, mechanical label/project bookkeeping is not a separate automation layer — it is the state machine's job, executed at write time. The Action Request API ([state-machine.md](state-machine.md#the-action-request-api)) covers:

| Capability | State machine action |
|-----------|----------------------|
| Create tester issue from QA Plan | `generate-work` (from the QA Expert's `### QA Plan` section) — run automatically by the `triage → implementation` transition |
| Auto-assemble the Implementation Plan from the A2A file | `transition` side-effect (`triage → implementation`); `update-plan` (self-improver-gated, idempotent per-section replacement) remains for edge/repair only |
| Append spec PR link to tester issue | `comment` on the tester issue |
| Auto label transition on phase change | `transition` (labels + side-effects are state-machine-driven) |
| Auto A2A seed + spec branch + spec PR + merge | `transition` side-effects: `→ triage` seeds the A2A file; `triage → implementation` assembles the plan + generates work + persists test suites (`tests-commit`) + creates `spec/<N>`; `→ testing` opens the spec PR; `testing → audit` merges it |
| Sub-issue actionable labels | state-machine-driven (`generate-work` sets `ready-for-dev`; no action sets `in-progress-dev` today) |
| SLA escalation on `blocked` | surfaced via the `health` report's **overdue-blocker list** (issues blocked past the default 4h SLA) — not a `blockedDuration` metric |
| Worktree lifecycle | `create-worktree` / `remove-worktree` (developer); `prune` removes orphaned worktrees; `spec/*` branches are never pruned |

**The two deliberate exceptions to single-writer — the developer pushes to the spec integration branch, and the self-improver pushes product docs to `main`.**

1. **The developer pushes to the spec integration branch.** The developer commits in a detached worktree and pushes `git push origin HEAD:spec/<N>` (allowed in the developer permission set; `main`/`master` and `HEAD:main` denied). Rationale: `spec/<N>` is the developer's shared *work product* — the worktree sits at its tip, and pushing is how sub-issue work lands. It is not a pipeline-state mutation (issues, labels, comments, merges, closes). Everything *around* the push is still the state machine's: worktree creation/removal (`create-worktree`/`remove-worktree`) and cleanup (`prune`). The **spec PR** (`spec/<N>` → `main`) is created and merged automatically by `transition` — the only PR in the pipeline.

2. **The self-improver fast-forward pushes synced product docs to `main`** (the doc-sync gate, [principle 6](principles.md#6-a-self-improver-gate-audits-every-issue)). The SI is the product-doc owner and commits the synced product docs (ARCHITECTURE.md, CLI_GUIDE.md, SETUP.md, SECURITY.md, FAQ.md) at the audit gate. Its one direct write is `git push origin main` — fast-forward only (allowed in the self-improver permission set). Everything force-ish or indirect stays denied: `--all`, `--mirror`, `--delete`, `--force`/`--force-with-lease` to `main`, `HEAD`-based pushes, `-u`/`--set-upstream origin main`, any `upstream` push to `main`, and **any push to `master`** remain denied.

Agents never call `gh`/`git` to write GitHub state — the state machine does. Reads stay direct. **Exceptions:** the developer pushes `HEAD:spec/<N>` only, and the self-improver fast-forward pushes `main` for synced product docs only (see above).
