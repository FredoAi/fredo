# GitHub Conventions

GitHub is the communication backbone and the log ([principles.md](principles.md#5-github-is-the-communication-backbone-and-the-log)). This file defines the mechanics: issue types, labels, branch naming, PR checklist, comment prefixes, and the single-writer rule.

> **Single-writer rule (principle 2 point 8):** the **state machine** owns all pipeline GitHub writes — creating issues, setting/transitioning labels, posting comments, creating branches/worktrees, merging PRs, closing issues. Agents draft content and request an action through the state machine ([state-machine.md](state-machine.md#the-action-request-api)); they never call `gh`/`git` to write. They read GitHub directly.

---

## Issue Model

Each feature/epic produces **one feature (backlog) issue — the single source of truth**. There is **no separate Implementation Plan issue** and no sub-issues or tester issue: the plan is posted as a `## Triage Plan` timeline comment **on the feature issue**, and the tester posts its `## Tests Runs` verdict on the feature issue. Issue templates live in [artifacts.md](artifacts.md) and `templates/PO-issue-template.md`; the state machine validates drafted **backlog** bodies against the PO template (backlog type, incl. bug-variant bodies) — other bodies are drafted to their templates without machine re-validation.

| Issue type | Created by (drafted by) | References | Labels |
|------------|-----------|------------|--------|
| Backlog Issue | State machine (Product Owner drafts) | — | `backlog` |

The **feature** (backlog issue) is the **single source of truth** — it carries `ready-for-dev` during implementation, all `Status` comments, the `## Triage Plan` plan comment, and the tester's `## Tests Runs` verdict.

> **Closed `temp:` issues are test-harness artifacts, not pipeline issues.** The validation harness `.opencode/scripts/test-scripts.ps1` creates scratch issues titled `temp: <test>` to exercise the state machine (transitions, comment gates, close/cancel, etc.), then closes them in each run's `finally` block. They accumulate with test runs and are closed + harmless. The pipeline itself never creates `temp:` issues. **The public-repo hardening NEVER locks a `temp:` issue** (they must stay commentable + closable during a test run) — both `hardening-lock-open-issues` and the `create-issue` lock-on-create side-effect skip any title starting with `temp:`.

---

## Pipeline issue comment protection (public-repo hardening)

`FredoAi/fredo` is now **PUBLIC**, so untrusted third-party issue comments are a prompt-injection / context-poisoning risk for the agentic pipeline, which reads issue comments as trusted context. The mitigation is **machine side-effects** (principle 9: mechanics are machine actions, never an agent playbook step) — three controls, all issued through the state machine's `run_gh` seam (`gh api`), never by an agent calling `gh`:

| Control | Type | Mechanism | Re-apply |
|---------|------|-----------|----------|
| **Per-conversation lock** | durable | `PUT /repos/{owner}/{repo}/issues/{n}/lock` with `lock_reason: off-topic` — a locked issue is commentable only by users with write access | permanent (until unlocked); the one-shot `hardening-lock-open-issues` locks every currently-OPEN pipeline issue; `create-issue` locks a new issue at birth |
| **Repo interaction limit** | **temporal** | `PUT /repos/{owner}/{repo}/interaction-limits` with `{ limit: "collaborators_only", expiry: "six_months" }` — a repo-wide belt-and-suspenders | **GitHub `expiry` enum max is `six_months`; must be re-applied** after the window lapses. The durable guard is the per-conversation lock-on-create — never mistake this for a permanent control (the literal `6_months` is rejected with HTTP 422) |
| **Trusted-author comment filter** | durable (code) | the state machine reads comment `authorAssociation` and excludes non-write-role comments from every context/verdict read path; each exclusion emits a `guard.fired` metric event + a surfaced note (never silent) | permanent (in `pipeline-state.rs`) |

**Lock reason:** `active_lock_reason` is one of GitHub's four enum values — the triage-chosen value is **`off-topic`** (least-misleading for "public commentary on a maintainer-controlled pipeline thread"; `too heated`/`spam` imply conflict/abuse, `resolved` misrepresents an in-flight issue). It is **informational metadata only** — it does not change who may comment; the lock itself does. GitHub's enum set uses a HYPHEN: `off-topic | too heated | resolved | spam` (the underscore variant `off_topic` is rejected with HTTP 422).

**Trusted (write-capable) comment-author roles** the filter allows: `OWNER`, `MEMBER`, `COLLABORATOR`, PLUS the pipeline's own posting principal `BOT`/`MANNEQUIN` — the state machine posts `Status`/`Triage Plan`/`Tests Runs` as a bot/mannequin, so excluding those would break verdict parsing and AC3. **Flagged (untrusted)** roles (excluded from every read): `NONE`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`. Bots/dependabot that are NOT the pipeline's own principal are external and flagged.

**Non-goals of the hardening:** does NOT disable GitHub Issues; does NOT redact/delete any comment body; does NOT close/cancel/unlabel an issue; does NOT use `contributors_only`/`existing_users` (both admit non-collaborators). The interaction limit is repo-wide and affects ALL issues (a collaborator on a non-pipeline issue is unaffected — only non-collaborators are stopped).

---

## Labels

The label set models the workflow state. An issue's label is its pipeline state; comments carry the detail. **The state machine sets and transitions every label** — agents request the transition, and the state machine validates it against the phase model before applying it.

| Label | Meaning | Requested by | → next |
|-------|---------|--------------|--------|
| `backlog` | Backlog issue created (backlog phase) | Product Owner | `planning` |
| `planning` | Implementation Plan being produced (planning phase — the plan deliverable in `.opencode/tmp/<issue>/triage.md` must converge before leaving) | Self-Improver | `ready-for-dev` |
| `ready-for-dev` | **Feature** — implementation phase; the developer works directly on the feature's `spec/<N>` branch | Self-Improver | `testing`, or back to `planning` (backward rescope — the "loop back to Phase 2 (Architect)" scope-redesign leg; the forward commit gate does not apply) |
| `in-progress-dev` | Legacy dev-work label (accepted for `create-worktree`) | — (reserved; no action sets it today) | — |
| `ready-for-test` | Legacy implementation-phase label (accepted for `create-worktree`) | — (legacy) | — |
| `testing` | **Feature** — testing phase; the tester posts its `## Tests Runs` verdict on the **feature issue** | Self-Improver | `audit` or back to `implementation` |
| `audit` | Self-Improver is auditing the issue | Self-Improver | `cleanup` (success) or restart |
| `cleanup` | Teardown-only phase — SI removes worktrees, prunes stale branches (spec/* kept), cleans scratch, retains evidence | Self-Improver (auto via `audit-record --verdict success`) | `done` (via `close-issue`) |
| `blocked` | Work is stalled on a dependency | Self-Improver or Developer (with `Status` comment) | `ready-for-dev` after unblock |
| `done` | Work passed testing + cleanup | Self-Improver (auto via cleanup close) | `planning` (reopen leg — post-merge defect reported while the issue is still OPEN); otherwise the human closes it manually |

**Label transitions** are executed by the state machine via the `transition` action — never by an agent calling `gh issue edit` directly. The state machine rejects transitions that skip phases or whose guards aren't met.

---

## Branch Naming

- `spec/<spec-issue>` — the **spec integration branch**, one per spec. Auto-created by the state machine when the feature enters `implementation`. All developer work, testing, and evidence accumulates here. It is **never deleted** (it carries the visual evidence trail), so `prune` leaves `spec/*` alone.
- There are **no per-developer branches.** The developer works in a **worktree detached at the tip of `spec/<N>`** (`create-worktree` adds `--detach`) and pushes with `git push origin HEAD:spec/<N>`. Detached worktrees allow many developers in parallel (git forbids two *attached* worktrees on one branch, but allows unlimited detached ones).
- The base branch (`main`) stays stable; the spec integration branch is the working base for a spec's whole lifecycle.
- **Worktrees are created by the state machine** via the `create-worktree` action once the feature is in the implementation phase (labeled `ready-for-dev`); the base is the feature's own `spec/<N>` branch. `remove-worktree` cleans up; `prune` removes orphaned worktrees.

**Keep the spec branch synced with `main`'s pipeline config.** Agents' sandbox/tool permissions are read from the `opencode.json` in the working tree they are launched from. When a spec branch forks before pipeline-config changes land on `main` (agent permission allowlists, script paths, skill wiring, docs), agents launched from that stale branch run with the **old** permissions — silent failures (blocked `powershell -File` scripts, missing tool patterns). Before dispatching any agent to a spec branch (especially the **tester**), sync the spec branch with `main`: `git fetch origin main && git merge origin/main` (or rebase) and push. The spec PR then carries the current pipeline config alongside the feature's product code. Developers must also `git fetch origin spec/<N>` + reset their worktree to the new tip before starting.

**PRs:** the only PR in the pipeline is the **spec PR** (`spec/<N>` → `main`), auto-created by the state machine when the feature enters `testing`. It stays open during testing; once the tester passes and the feature moves to `audit`, the state machine auto-merges it (the branch always survives so evidence URLs keep rendering). These are deterministic side-effects of the `transition` action — no separate actions exist.

---

## Spec PR Checklist

The only PR in the pipeline is the **spec PR** (`spec/<N>` → `main`), auto-created by the state machine when the feature transitions to testing. It must complete this checklist before merge; the Self-Improver verifies it.

```markdown
- [ ] References the feature issue (spec #<N>)
- [ ] CI green
- [ ] Developer pushed to `spec/<N>` (implementation gate: commits ahead of main)
- [ ] Tester verdict passed on the feature issue (`## Tests Runs`, PASS with live evidence per the plan's Verification policy)
- [ ] Docs updated (if the change affects documented surface)
- [ ] Scope: only files belonging to the spec
```

---

## Comment Conventions

Prefix every agent comment to keep issue timelines scannable and filterable. **Comments are posted by the state machine** via the `comment` action. **Agents never write to GitHub directly** — they draft the comment as a `.md` file in `.opencode/tmp/<issue>/<prefix>.md` using the comment templates in [templates/](templates/), and the state machine reads that file and posts it (`--body-file` is optional and overrides the conventional `.opencode/tmp/<issue>/<prefix>.md` path).

| Prefix | Purpose | Requested by | Template |
|--------|---------|--------------|----------|
| `Status` | The ONLY agent-facing prefix: blockers, escalations, and state changes — never routine progress (a push is visible via commits/CI) | Any pipeline agent | `Status-comment-template.md` |

**Removed prefixes** (PO decision, #2756 data — 1 Question + 1 Decision across a 2,826-comment spec):
- `Evidence` — the canonical verdict is the `## Tests Runs` timeline draft (machine round-stamped); screenshots go through `upload-evidence` (upload-only). Caused the G-006/G-020/G-029 bug class.
- `Question` — genuine ambiguity IS a blocker until answered: use the `block` action (`--reason`, label + SLA); the orchestrator resolves and re-dispatches with the answer inlined in the brief. A parallel Q/A channel nobody reads (workers get answers via briefs, never by scanning threads).
- `Decision` (free-form) — MACHINE-ONLY: posted by the `audit-record` verdict. Decisions reach the record via `audit-record --reason` or a PO amendment through `Status`.

**Rules:**
- One topic per comment; blockers get the label too (`block` action posts the Status + sets it).
- Evidence lives in the `## Tests Runs` draft: links, screenshots, log excerpts — not "it worked."
- Every agent-authored comment ends with `*Authored by <Agent Name>*`.
- The state machine validates the prefix is `Status` before posting; anything else is refused with a pointer to the correct channel.

**Timeline comments (the issue narrative):** the transition / `audit-record` auto-post five titled comments from `.opencode/tmp/<issue>/` drafts (templates in [templates/](templates/)): `## Triage Plan` (triage→implementation), `## Fix Plan (round N)` (rework re-entry — Architect-authored), `## Development Summary` (implementation→testing), `## Tests Runs` (testing — carries the verdict, read by the gate), `## SI Summary` (audit→done). **The issue BODY is the single PO Backlog** — no `## PO Backlog` comment is posted (it duplicated the body; PO feedback #2688).

**Retry rounds are machine-stamped on the timeline.** The state machine derives the current round from the event log (the count of `phase.started` entries for `testing` — every rework advances the round, never stuck at "round 1") and stamps it on retry-relevant comments — never the drafting agent:
- the restart `## Decision` comment reads `Audit verdict: **restart → <phase> (round N)**` and lists the missed ACs for round N;
- `## Development Summary`, `## Tests Runs`, `## Fix Plan`, and `## SI Summary` post as `## <title> (round N)`.

`## Triage Plan` is posted once (round-1 only) and stays untagged; the full plan is never re-posted on retry — a compact `## Fix Plan (round N)` carries the deltas. **The Fix Plan is authored by the Software Architect** (draft `.opencode/tmp/<issue>/fix-plan.md` from the tester's FAIL verdict; footer `*Authored by Software Architect*`) — the SI dispatches the architect before re-entering implementation, and the machine round-stamps and posts it; when no authored draft exists the machine falls back to deriving a compact plan from the Triage Plan draft. The **round-aware verification guard** enforces the round: a retry round is only satisfied by evidence carrying the current round, so a stale round-1 PASS can never clear a round-2 audit (`latest_evidence_comment` parses `(round N)` from the `## Tests Runs` header; untagged evidence counts as round 1).

**The Product Owner's GitHub output is deterministic:** `create-issue` creates the issue whose BODY is the backlog (the single PO Backlog), and after #2734 the PO may post `Status` comments (PO amendments) — but never gate-critical artifacts (verdicts are `## Tests Runs`; decisions are machine-only). The `post-comments` action remains gated to reject `product-owner`.

**Triage deliberation usage:** during Phase 2, the detailed back-and-forth happens in the A2A working file `.opencode/tmp/<issue>/triage.md` (ephemeral, gitignored) — **not** in comments. Each planner writes its section draft under its own `## <Agent>` heading and appends agent-tagged points to `## Discussion`; the planners reply to each other's points there. **The triage deliverable IS the implementation plan (the A2A file)** — no convergence `Decision` comment is posted; the triage exit gate checks the file itself (all required sections + `## Convergence: agreed`). If an agent looks for a GitHub comment and finds none, it reads the `.md` files under `.opencode/tmp/<issue>/`. GitHub carries only:
- the final **Implementation Plan** — auto-assembled by the `triage → implementation` transition into the `## Triage Plan` timeline comment **on the feature issue** (single-issue model — no separate plan issue).

---

## GitHub Write Model (replaces a separate automation roadmap)

Because the state machine is the **single writer**, mechanical label/project bookkeeping is not a separate automation layer — it is the state machine's job, executed at write time. The Action Request API ([state-machine.md](state-machine.md#the-action-request-api)) covers:

| Capability | State machine action |
|-----------|----------------------|
| Auto-assemble the plan into the `## Triage Plan` feature-issue comment | `transition` side-effect (`triage → implementation`); `update-plan` (self-improver-gated, idempotent per-section replacement of the `triage-plan.md` draft) remains for edge/repair only |
| Persist feature test suites to `main` | `tests-commit` (auto side-effect of `triage → implementation`; shared with the Tester) |
| Auto label transition on phase change | `transition` (labels + side-effects are state-machine-driven) |
| Auto A2A seed + spec branch + spec PR + merge | `transition` side-effects: `→ triage` seeds the A2A file; `triage → implementation` assembles the `## Triage Plan` comment + persists test suites (`tests-commit`) + creates `spec/<N>`; `→ testing` opens the spec PR; `testing → audit` merges it |
| Timeline comments (the issue narrative) | auto-posted from `.opencode/tmp/<issue>/*.md` drafts (`triage-plan.md` / `fix-plan.md` / `dev-summary.md` / `tests-runs.md` / `si-summary.md`) on every transition and `audit-record`; `post-comments` flushes pending drafts; a `## Tests Runs` draft is refused unless it carries a literal `Verdict:` line AND every image reference is an `https://` URL (bare filenames/local paths are unviewable evidence — refused, draft kept) |
| Project Status sync (labels + Status) | every transition mirrors the phase onto the GitHub project Status field (Backlog → Planning → Coding → E2E → Reviewing → Done); `create-issue` adds the issue to the project; `done`/`canceled` set `Done` while the issue stays OPEN for manual close — best-effort, never fatal |
| SLA escalation on `blocked` | surfaced via the `health` report's **overdue-blocker list** (issues blocked past the default 4h SLA) — not a `blockedDuration` metric |
| Worktree lifecycle | `create-worktree` / `remove-worktree` (developer); `prune` removes orphaned worktrees; `spec/*` branches are never pruned |
| Hardening: lock all OPEN pipeline issues | `hardening-lock-open-issues` (Self-Improver) — enumerate OPEN pipeline issues (pipeline label) and `PUT .../issues/<n>/lock` with `lock_reason: off-topic`; skips `temp:` harness issues; one-shot |
| Hardening: repo interaction limit | `interaction-limit` (Self-Improver) — `PUT .../interaction-limits` `{ limit: "collaborators_only", expiry: "six_months" }`; temporal |
| Hardening: lock-on-create | `create-issue` side-effect — a newly created non-`temp:` pipeline issue is locked immediately (best-effort) so it is comment-safe at birth |

**The two deliberate exceptions to single-writer — the developer pushes to the spec integration branch, and the self-improver pushes product docs to `main`.**

1. **The developer pushes to the spec integration branch.** The developer commits in a detached worktree and pushes `git push origin HEAD:spec/<N>` (allowed in the developer permission set; `main`/`master` and `HEAD:main` denied). Rationale: `spec/<N>` is the developer's shared *work product* — the worktree sits at its tip, and pushing is how the plan's checklist work lands. It is not a pipeline-state mutation (issues, labels, comments, merges, closes). Everything *around* the push is still the state machine's: worktree creation/removal (`create-worktree`/`remove-worktree`) and cleanup (`prune`). The **spec PR** (`spec/<N>` → `main`) is created and merged automatically by `transition` — the only PR in the pipeline.

2. **The self-improver fast-forward pushes synced product docs to `main`** (the doc-sync gate, [principle 6](principles.md#6-a-self-improver-gate-audits-every-issue)). The SI is the product-doc owner and commits the synced product docs (ARCHITECTURE.md, CLI_GUIDE.md, SETUP.md, SECURITY.md, FAQ.md) at the audit gate. Its one direct write is `git push origin main` — fast-forward only (allowed in the self-improver permission set). Everything force-ish or indirect stays denied: `--all`, `--mirror`, `--delete`, `--force`/`--force-with-lease` to `main`, `HEAD`-based pushes, `-u`/`--set-upstream origin main`, any `upstream` push to `main`, and **any push to `master`** remain denied.

Agents never call `gh`/`git` to write GitHub state — the state machine does. Reads stay direct. **Exceptions:** the developer pushes `HEAD:spec/<N>` only, and the self-improver fast-forward pushes `main` for synced product docs only (see above).
