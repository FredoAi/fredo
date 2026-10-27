# Pipeline Phases

Eight phases + an independent audit gate. Sequential handoffs between phases; parallel work within a phase wherever dependencies allow. Every handoff happens through GitHub issues and comments ([github.md](github.md)) — the exceptions are the ephemeral working files `.opencode/tmp/<issue>/triage.md` (where the planning deliberation itself takes place) and the Orchestrator's observations log `.opencode/tmp/<issue>/observations.md` (improvement candidates captured while orchestrating).

```
Business → Backlog → Planning → Implementation → Testing → Audit → Post-audit → Cleanup → Done
   (You)      PO    Orchestrator   Dev pool        Tester  Auditor  Orchestrator  Orchestrator Orchestrator
```

The **Orchestrator** runs the pipeline: it dispatches the planning cluster, the developer pool, and the tester, drives the transitions, and runs the teardown-only Cleanup phase. The independent **Auditor** records the audit verdict (the gate between Testing and Cleanup). The Orchestrator's former mechanical orchestration steps (A2A seed, plan assembly, test-suite persistence) are now **state-machine transition side-effects** — the Orchestrator runs the transitions and the machine does the mechanics.

---

## Full Pipeline Flow

```mermaid
flowchart TD
    B([Business - You]) --> P1

    subgraph P1[Phase 1: Backlog]
        PO[Product Owner]
        PO --> |structured dialogue| SUM[Design Summary]
        SUM --> |backlog issue| BL[Backlog Issue - label: backlog]
    end

    BL --> ORCH[Orchestrator]
    ORCH --> |backlog → planning: A2A auto-seeded| PLAN
    subgraph P2[Phase 2: Planning]
        PLAN[Software Architect / UI-UX / QA Expert]
        PLAN --> |sections + discussion<br/>in triage.md| CONV[Converged plan deliverable<br/>## Convergence: agreed]
        CONV --> |planning → implementation:<br/>auto-assembles ## Triage Plan comment<br/>+ tests + spec branch| IMPL[## Triage Plan comment<br/>on the feature issue]
        IMPL -. retry (testing → implementation) .-> |the Orchestrator dispatches the Architect<br/>to author the Fix Plan; the machine posts it<br/>round-stamped, not the full plan| FIX[## Fix Plan (round N)<br/>on the feature issue]
    end

    IMPL --> P3
    subgraph P3[Phase 3: Implementation]
        DEV[Developer pool xN]
        DEV --> |work the plan's checklist on<br/>worktrees detached at spec/N, push| SPEC[spec/N integration branch]
        SPEC --> |commits beyond main| READY[ready-for-dev]
    end

    READY --> |spec PR auto-created on →testing| P4
    subgraph P4[Phase 4: Testing]
        T[Single Tester]
        T --> |execute QA Plan| TR[Tests Runs verdict<br/>## Tests Runs]
        TR --> |FAIL - re-dispatch| SPEC
        TR --> |PASS under Verification policy| AUDIT
    end

    subgraph GATE[Audit Gate]
        AUDIT[Phase 5: Audit<br/>Auditor]
        AUDIT --> |success| CLEAN
        AUDIT --> |failure: restart from phase N| RESTART
        RESTART --> P1
        RESTART --> P2
        RESTART --> P3
        RESTART --> P4
    end

    subgraph P6[Phase 6: Cleanup - teardown only]
        CLEAN[Orchestrator<br/>remove worktrees, prune stale branches + closed-spec branches, clean scratch]
        CLEAN --> |teardown complete| DONE2
    end

    DONE2[Phase 7: Done<br/>Orchestrator status + human review]
```

---

## Phase 1: Backlog

**Owner:** Product Owner
**Input:** Business goals from the human
**Output:** Backlog issue (label: `backlog`)
**Goals:** A backlog issue with the required intake sections (## Title, ## Problem / Why now, ## Intended users, ## Proposed behavior / Scope, ## Success metrics, ## Acceptance criteria, ## Out of scope, ## Priority), Gherkin ACs, priority, and label `backlog` — agreed by the human before dispatch. The `backlog → planning` exit gate **enforces the required sections** (a backlog missing them is blocked).

1. **Explore context** — understand scope, constraints, priority. Is this a trivial task (typo, label, single-file tweak) or a complex feature (new architecture, data flow, multiple surfaces)? Adjust dialogue depth accordingly.
2. **Split check (INVEST-S)** — is the request ONE story-sized slice? If it bundles independent value streams or otherwise fails **S (~half a sprint)**, propose an **N-way SPIDR split**, get the human's approval, and create **one backlog issue per slice** (each INVEST-clean, each with its own revision linkage). The pipeline is single-issue — the Architect can only decompose a spec into capsules on ONE issue, so an oversized backlog is unsplittable downstream. A declined split records the accepted risk in `## Out of scope / constraints`.
3. **Structured dialogue** — one question at a time. Never ask about implementation details — flag them `[Technical: defer to planning]`.
4. **Design summary** — What, Wireframe (ASCII, UI only), Behavioral (Gherkin), Non-Behavioral, Risks/Unknowns.
5. **User confirmation** — the human approves the summary. No dispatch until this happens.
6. **Create backlog issue** — draft the body per the [backlog template](artifacts.md#backlog-issue), then request the state machine's `create-issue` action (labeled `backlog`). The state machine is the single GitHub writer.
7. **Handoff to the Orchestrator** — the Product Owner dispatches the Orchestrator with the backlog issue number (after a split, only the slice(s) the human chose to start).

**Simplicity heuristic:** trivial tasks get a one-line summary and a single dialogue round — but the summary + confirmation step is never skipped.

---

## Phase 2: Planning

**Owner:** Planning cluster (Software Architect + UI/UX Expert + QA Expert), orchestrated by the Orchestrator
**Input:** Backlog issue
**Output:** The `## Triage Plan` timeline comment on the feature issue (single-issue model — no separate plan issue). On a retry re-entry (`testing → implementation`) the full plan is not re-posted — the **Software Architect authors a Fix Plan** (`.opencode/tmp/<issue>/fix-plan.md`: failed ACs, root cause at file:line, this round's fix scope) from the tester's FAIL verdict, and the machine posts it as the compact, round-stamped `## Fix Plan (round N)` (falling back to compacting the plan draft only if no authored draft exists).
**Goals:** A converged planning deliberation on the feature issue, then the plan auto-assembled into the `## Triage Plan` comment from [templates/triage-plan-template.md](templates/triage-plan-template.md) with all required sections (Summary, Software Architect, UI/UX Expert, QA Expert, Staffing Plan, Deployment Notes, Risks) — every backlog requirement covered by a plan checklist item (the `- [ ]` lines under `### Sub-issue Decomposition`).

### Orchestrator responsibilities
1. Read the backlog issue.
2. **Run `transition backlog → planning`** — request the state machine's `transition` action (applies the `planning` label) *before* dispatching the planning cluster, so the planning subagents (software-architect / ui-ux-expert / qa-expert) read the planning phase in their context block. **Auto side-effect:** the machine seeds the A2A working file `.opencode/tmp/<issue>/triage.md` (idempotent). You do NOT run `triage-init` — the transition owns it.
3. **Dispatch the three planners in parallel** with the same brief (backlog + any Product Owner notes) and the A2A file path. Each planner works in the shared file. **Dispatch briefs are LEAN** (loop hardening, #2694): inline the full backlog/requirement text in the brief so a planner never needs to probe the issue, and tell each planner its only deliverable is **one Edit to its own `## <Agent>` A2A section** — no git, no gh probing, no repeated context reads (their sandbox denies git; `doom_loop` recovery + the state-machine `context` streak guard stop the loops). Read your context once, edit once, return.
4. **Coordinate the deliberation** — see [the planning deliberation protocol](#the-planning-deliberation-protocol). Track open `## Discussion` items in the A2A file and route each to its owning section.
5. **Write the orchestrator sections + convergence** — when no `## Discussion` item remains open, write the orchestrator-owned plan sections (`## Summary`, `## Staffing Plan`, `## Deployment Notes`, `## Risks & Mitigations`) into the A2A file and append `## Convergence: agreed`. **The plan deliverable is the planning artifact — no GitHub `Decision` convergence comment is posted.**
6. **Handoff** — request the `transition` action `planning → implementation`. **Auto side-effects:** the machine (a) **assembles the plan into the `## Triage Plan` timeline draft** `.opencode/tmp/<issue>/triage-plan.md` from `templates/triage-plan-template.md`, filling every section (`software-architect`, `ui-ux`, `qa`, `summary`, `staffing`, `deployment`, `risks`) from the converged A2A file, and auto-posts it on the feature issue (single-issue model — **no plan issue is created**); (b) **persists the QA-seeded test suites** to `main` via `tests-commit` (feature names parsed from the QA Expert's `**Feature tests:**` line in the A2A file); (c) creates the spec branch `spec/<N>`. No sub-issues or tester issue are generated — the plan's `- [ ]` checklist is the work list. You do NOT run `tests-commit` manually — the transition owns it (`generate-work` is removed).

### The planning deliberation protocol (file-based A2A)
The three planners deliberate in a shared A2A working file, `.opencode/tmp/<issue>/triage.md` (ephemeral and gitignored) — not in GitHub comment threads. GitHub keeps only the final plan (auto-assembled into the `## Triage Plan` comment). **The plan file is the deliverable** — if an agent looks for a GitHub comment and finds none, it reads the `.md` files under `.opencode/tmp/<issue>/`.
1. **A2A auto-seeded.** The `backlog → planning` transition creates the A2A working file `.opencode/tmp/<issue>/triage.md`, seeded from the triage template's per-agent `## <Agent>` sections plus a `## Discussion` section (idempotent).
2. **Parallel drafts.** The Orchestrator dispatches the three planners in parallel with the same brief. Each planner reads the file, writes its section draft under its own `## <Agent>` heading, and appends agent-tagged points to `## Discussion` (e.g. `**QA:** REQ-3 has no observable target — can you scope it?`).
3. **Cross-review.** Each planner reads the other two planners' drafts in the file (the Architect's Domain Model anchors UI/UX and QA) and replies to their `## Discussion` points — it never edits another planner's section heading.
4. **Convergence.** When no unresolved `## Discussion` items remain, the Orchestrator reviews the file, writes the orchestrator-owned sections (`## Summary`, `## Staffing Plan`, `## Deployment Notes`, `## Risks & Mitigations`), and appends `## Convergence: agreed`. The state machine's planning exit guard checks the file itself (all required sections + `## Convergence: agreed`) before `planning → implementation` — **no `Decision` comment is involved**.
5. **Plan assembly (automatic).** The `planning → implementation` transition reads each agreed section from the A2A file and assembles the plan into the `## Triage Plan` comment (auto-assembled, no manual `update-plan` on the happy path). The detailed back-and-forth stays in the ephemeral file; the plan captures the agreed decisions.

### Planners
- **Software Architect** — research, domain model (file:line citations), EARS-style requirements for observable behavior (constraints/NFRs in prose), API contracts, data models, scope decomposition into independent sub-tasks, **effort estimates** per sub-task (these feed the Staffing Plan).
- **UI/UX Expert** — design assets (mockups, component specs, interaction flows, states, accessibility). Returns "N/A" for backend-only work. Bases the draft on the Software Architect's Domain Model section (read from the A2A file).
- **QA Expert** — QA Plan (test cases per requirement, pass/fail criteria, test data, non-functional checks), edge cases, regression risks; the **sole test author**: seeds/extends the feature test suites under `.opencode/tests/<feature>/` (functional / smoke / regression / exploratory — conventions in `.opencode/tests/README.md`) AND declares the seeded folder names as a `**Feature tests:** <name1, name2>` line in its `## QA Expert` A2A section so the transition can auto-persist them via `tests-commit`. Bases the draft on the Software Architect's Domain Model section (read from the A2A file).

### The Implementation Plan must contain
| Section | Content |
|---------|---------|
| **Title** | Concise feature name + parent issue number |
| **Summary** | Goal + acceptance criteria |
| **Software Architect** | Domain model (file:line), EARS requirements (behavioral) + prose constraints, API contracts & data models, sub-task decomposition + effort estimates |
| **UI/UX Expert** | Design assets (or "N/A") |
| **QA Expert** | QA Plan (test cases, pass/fail criteria, required test data, non-functional checks) |
| **Staffing Plan** | Number of developers required, suggested roles, estimated effort — and the heuristic used (see [staffing.md](staffing.md)) |
| **Deployment notes** | Branch strategy, CI checks, infrastructure needs |
| **Risks & mitigations** | Blockers and fallback options |

The `planning → implementation` transition **assembles the plan into the `## Triage Plan` comment on the feature issue** (single-issue model): it writes the seeded plan from [templates/triage-plan-template.md](templates/triage-plan-template.md) to `.opencode/tmp/<issue>/triage-plan.md` and fills every section from the converged A2A file (no manual `update-plan` on the happy path), then auto-posts it. **No separate plan issue is created.** The same transition persists the QA-seeded test suites and creates the spec branch. No sub-issues or tester issue are generated — the plan's `### Sub-issue Decomposition` checklist is the work list developers execute on `spec/<N>`.

---

## Phase 3: Implementation

**Owner:** Orchestrator (setup/review) + Developer pool (execution)
**Input:** The `## Triage Plan` comment on the feature issue (single-issue model)
**Output:** Spec branch `spec/<N>` has commits beyond main (the developer pushed); the feature is labeled `ready-for-dev`
**Goals:** All plan checklist items implemented, verified, and pushed to `spec/<N>`. The `implementation → testing` exit gate is **spec branch `spec/<N>` has commits beyond main** — the machine blocks the transition until the developer pushes. **Backward rescope:** a human-authorized scope redesign loops `implementation → planning` (the "loop back to Phase 2 (Architect)" rule) — the forward commit gate does NOT apply to the backward leg, the A2A is re-seeded fresh, and the planning cluster re-converges the new scope.

### 3a. Staffing (Orchestrator)

1. **Read the Staffing Plan** — extract total effort and the planner's suggested headcount.
2. **Apply the staffing heuristic** — convert effort to developer headcount (default: 1 full-stack dev ≈ 5 story points per delivery window). See [staffing.md](staffing.md#staffing-heuristic).
3. **Check pool availability** — every developer has a max of 2 active workstreams on the spec branch. Reduce headcount if the pool is saturated.
4. **Work list (the plan's checklist)** — there are no sub-issues: the `planning → implementation` transition created only the `## Triage Plan` comment and the spec branch. The plan's `### Sub-issue Decomposition` `- [ ]` lines are the checklist the developer pool works through directly on the feature's `spec/<N>` branch. `generate-work` is removed — no manual work-generation step exists.
5. **Spec integration branch** — auto-created by the state machine as a side-effect of the `planning → implementation` transition (`spec/<spec-issue>` from `main`). This is the working base for every developer's worktree, testing, and the evidence trail (see [github.md](github.md#branch-naming)).
6. **Transitions** — the feature issue carries `ready-for-dev` during implementation; no sub-issue, tester-issue, or plan-issue transitions exist.

### 3b. Development (Developer pool)

Each developer works a slice of the plan's task decomposition directly on the feature issue / `spec/<N>`:

1. **Read the plan** — the `## Triage Plan` comment on the feature issue: task decomposition, acceptance criteria, effort, scope. Read the API contracts and design assets.
2. **Create a worktree detached at the tip of `spec/<N>`** — request the state machine's `create-worktree` action (`--worktree-path <path>`; base auto-resolved to the feature's `spec/<N>`). Detached worktrees let many developers run in parallel.
3. **Implement** — strictly within the plan's scope. Never touch files outside the task; never redesign architecture.
4. **Verify locally** — lint, typecheck, build, tests.
5. **Push with `git push origin HEAD:spec/<N>`** — the developer's one allowed direct write (never `main`/`master`). Pull/merge `spec/<N>` first if the push is rejected.
6. **Remove the worktree** (`remove-worktree`) and **Report** — a `Status` comment on the FEATURE issue: what shipped, verification results, any scope notes.

> **Round isolation (Spec #3066).** Every dev/test/pipeline round runs against its OWN isolated env slot — `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec <N> -EnvId <id> -EnvSlot <n> -RequireIsolation` — never the legacy shared path. A round that resolves to the shared `%APPDATA%\com.fredo.app` PostgreSQL cluster dir **fails closed** (`ISOLATION REFUSED`, exit `3`) BEFORE PostgreSQL starts, and the credential sentinel seams (`FREDO_PG_PASSWORD_FILE` / `FREDO_PG_KEYCHAIN_DISABLED`) are refused there too. The legacy shared path is **FORBIDDEN for rounds**. **`Restart` is forbidden for isolated envs** — it drops `-EnvSlot` (G-328) and falls back to the legacy ports; recover with an explicit `-Action Down -EnvId <id>` then `-Action Up -EnvId <id> -EnvSlot <n>`. Every isolation/refusal is recorded append-only in `.opencode/state/env-isolation.jsonl`; `dev-env.ps1 -Action Status` surfaces the read-only isolation check (`verify-env-isolation.ps1`, which flags an active env whose data root IS the shared cluster dir).

### Dependency handling
- **Declared dependencies are ordered, not discovered.** The plan's sub-task lines may carry `requires: ST-<n>` edges (Architect-declared, deterministic data). The Orchestrator dispatches ready sub-tasks (all listed predecessors already pushed to `spec/<N>`) first; a `block` on an undeclared dependency is a plan-defect signal for the retrospective. The default is file-independent sub-tasks (no edges); `requires:` is the rare exception for ordering dependencies that survive file-independence.
- If work blocks on a dependency: request the state machine's `block` action (label `blocked` + `Status` comment) and notify the Orchestrator. Never stall silently.
- If the plan is ambiguous: request the state machine's `block` action with `--reason` (ambiguity blocks work until the orchestrator resolves it and re-dispatches with the answer). Never improvise scope.

### Retry path
When the Orchestrator requests changes:
1. Re-enter the worktree, fetch + rebase (`git rebase origin/spec/<N>`, or `git -c core.editor=true rebase origin/spec/<N>`; git is configured with `core.editor=true`, so a rebase/merge NEVER opens an interactive editor — if you ever see vim open, abort and redo with the `-c core.editor=true` form).
2. Fix exactly what was requested.
3. Push to the same branch — the PR updates.
4. Post `Status: PR #N updated`.

### Merge
The Orchestrator reviews each developer's pushes on the spec integration branch against the plan's checklist, requests changes when needed, and returns failed work to the same developer. Once the spec branch has commits beyond main, the Orchestrator transitions the feature to `testing` — which **auto-creates the spec PR** (`spec/<N>` → `main`) and applies the `testing` label — making the feature testable. Once testing passes, the Orchestrator transitions to `audit`, which **auto-merges the spec PR**; the `spec/<N>` branch is kept so evidence URLs keep rendering.

---

## Phase 4: Testing

**Owner:** Tester (single)
**Input:** Feature issue (label: `testing`) + the plan's `### QA Plan` (from the `## Triage Plan` comment)
**Output:** Verdict on the feature issue (a `## Tests Runs` timeline comment); the Orchestrator transitions the feature to `audit` (auto-merging the spec PR), the Auditor's `audit-record --verdict success` auto-transitions `audit → cleanup`, and the Orchestrator's `close-issue --to-phase done` from cleanup labels the issue `done` (left OPEN for the human to close), or the Orchestrator returns the feature to implementation for the failing work
**Goals:** Tester verdict posted with per-case evidence; all failures re-dispatched to the plan's checklist items with expected-vs-actual and repro steps. The testing exit gate is a **verification guardrail**: the verdict must substantiate a PASS under the plan's `> Verification policy` — for `live` policies the evidence must reference `telemetry_spans` (a live-query result); a static-only PASS or a FAIL blocks the exit.

1. **Read the plan's `### QA Plan`** — QA Plan checklist, the spec integration branch to test (`spec/<N>`), and required test data. Identify the feature domain(s) and read the matching durable suites under `.opencode/tests/<feature>/` (persisted to `main` via `tests-commit`; conventions in `.opencode/tests/README.md`).
2. **Ensure the dev instance is running on the spec integration branch** (see the dev-environment workflow). Before starting, the tester (or the Orchestrator) must ensure `spec/<N>` is synced with `main`'s pipeline config and the dev build's checkout has `node_modules` installed — a stale `opencode.json` re-blocks the tester's sandbox (telemetry-query, `fredo emit`, opencode prerequisites), and a bare worktree cannot build the app. **A testing round is a round — run it in its OWN isolated env slot with `-RequireIsolation` (see the Phase 3 round-isolation rule); never the legacy shared path.**
3. **Execute each test case** in order — functional + smoke, then regression + exploratory (unscripted probes; a confirmed finding promotes to `functional.md`):
   - Attach evidence per case: screenshots, logs, DOM snapshots, test output. Screenshots are uploaded to GitHub as `user-attachments` assets via `upload-evidence` (the `gh-image` extension) and embedded as their URLs in the `## Tests Runs` draft, so they open for repo members without committing binaries to the repo.
   - Classify PASS / FAIL.
   - Persist suite updates to `main` via the `tests-commit` action.
4. **Verdict:**
   - **All pass** → post the test report as a `## Tests Runs` timeline comment (draft `.opencode/tmp/<issue>/tests-runs.md` per the Tests-runs template — the machine auto-posts pending timeline drafts on transitions / `audit-record`, or via `post-comments`) and notify the Orchestrator — who transitions the feature to `audit` (auto-merging the spec PR). The Auditor's `audit-record --verdict success` then auto-transitions `audit → cleanup`, and the Orchestrator's `close-issue --to-phase done` from cleanup labels the issue `done` (left OPEN — the human closes it manually).
   - **Any fail** → post the partial test report (`## Tests Runs`) with a precise failure description per failing case (expected vs actual, evidence, repro steps) and notify the Orchestrator — who dispatches the **Software Architect** to diagnose the root cause and author the round's Fix Plan (`.opencode/tmp/<issue>/fix-plan.md`), then returns the feature to implementation (the transition posts the authored `## Fix Plan (round N)`) and re-dispatches the failing plan checklist work. There is no reopen action.

### Re-dispatched work
Failing work goes back through Implementation (Phase 3) and, once pushed again, returns to the Tester on the same feature issue — the feature stays in `testing` until the whole feature passes.

---

## Phase 5: Audit

**Owner:** Auditor — independent of the work (a fresh context; it neither orchestrated nor built it)
**Input:** Tester verdict + the issue's full record
**Output:** the `post-audit` phase (self-improvement + gate merge), then `cleanup` (success) or a restart instruction (phase + root cause + reason)

1. **Audit from the record** — the Auditor runs the integrity gate (`verify`) and the audit bundle (`audit`), reads the Tester's verdict and the issue's recorded history (events, rework, blocked, evidence), and independently re-derives each acceptance criterion's verdict against the evidence. Decide: was the issue completed successfully? A case with no evidence is UNVERIFIED/FAIL; a PASS with no supporting evidence is a false PASS.
2. **Doc-sync (the Orchestrator's gate step)** — the Orchestrator is the product-doc owner. Classify the merged spec diff into doc categories (`ARCHITECTURE.md`, `CLI_GUIDE.md`, `SETUP.md`, `SECURITY.md`, `FAQ.md`), patch the affected product docs, and commit (fast-forward `main`). Product docs are only coherent against the full merged diff, which the gate — running last — is uniquely positioned to see. If the product state doesn't match the docs, that is a failure the Auditor can flag.
3. **Success** → the Auditor records `audit-record --verdict success` — the state machine **transitions `audit → post-audit`**. In `post-audit` the Orchestrator dispatches the **Curator** (distil + curate) and any specialists, runs the **gate doc-sync**, and stages the pipeline's own edits in the gate commit; then `transition post-audit → cleanup` (the teardown-only phase), where the issue stays OPEN. The Orchestrator runs the cleanup teardown and closes as done via `close-issue --to-phase done` (label → `done`, OPEN for the human to close).
4. **Failure** → the Auditor chooses the phase to restart from (Backlog, Planning, Implementation, or Testing), classifies the root cause (`defect`|`technique`|`environment`|`scope`), and records `audit-record --verdict restart --phase <p> --root-cause <c> --reason "<missed-AC list>"`, which **transitions `audit → post-audit`**. In `post-audit` the **Curator** distills the durable lesson (playbooks, skills, `references.md`, pipeline docs) and the Orchestrator runs the gate; then `transition post-audit → <p>` re-enters the chosen phase. The **Machinist** owns the state machine, permissions, and measurement; the **Toolsmith** owns skills/scripts. Agent identity is proposed to the human, never edited by an agent. Stale product docs are a valid failure reason → restart to Implementation with "sync docs" in scope. **No agent researches product code to improve the pipeline** — code/observability improvements are routed through the Software Architect (a planning → implementation cycle).
5. **Return** — the restart instruction re-dispatching the pipeline from the chosen phase is executed by the Orchestrator (it owns the whole flow, including restarts).

**Status: implemented.** The audit gate is the **Auditor** (`.opencode/agents/auditor.md`), its steps in `playbooks/auditor.md`; orchestration is the **Orchestrator** (`playbooks/orchestrator.md`). The verdict is recorded via the state machine's `audit-record` action, which also drives the next phase automatically.

---

## Phase 6: Cleanup

**Owner:** Orchestrator — teardown only (the audit verdict was already recorded by the Auditor at the audit gate)
**Input:** Auditor audit verdict = success (issue in `cleanup`, label `cleanup`)
**Output:** Feature labeled `done` (left OPEN), human review
**Goals:** Teardown complete — no leftover worktrees, stale branches, or scratch — then the feature is labeled `done` (the human closes it manually after review).

1. **Remove worktrees** — any leftover developer worktrees are removed (`git worktree remove` / `prune`).
2. **Prune stale branches** — the state machine's `prune` action deletes local `spec/*`/`feat/*` branches whose remote counterpart is gone, and `prune --remote` deletes `origin/spec/<N>` for every **closed** spec (open-issue list read once; fail-safe). Merged spec PRs also auto-delete their head branch (`delete_branch_on_merge`); `spec/*` is no longer kept as an evidence record — evidence is uploaded as GitHub `user-attachments`.
3. **Clean scratch** — leftover gitignored scratch under `.opencode/tmp/` is removed; evidence now lives on GitHub as `user-attachments` (no repo copy to retain).
4. **Verify no dirty state** — confirm the working tree is clean (no leftover modified/untracked files from the run).
5. **Label done (leave open)** — `close-issue --to-phase done` (cleanup → done): the machine swaps the label to `done`, records the phase transition, and posts the final-metrics summary. **The issue is NOT closed by the machine** — it stays OPEN so the human closes it manually after review.
6. **Human review + close** — the human validates the finished feature manually, then closes the issue. If the human finds an issue, they report back and the Product Owner opens a follow-up backlog item (labeled `backlog`, with the bug variant of the PO template).

---

## Phase 7: Done

**Owner:** Orchestrator
**Input:** Cleanup complete (teardown done, issue labeled `done` and left OPEN)
**Output:** Feature closed by the human, human review
**Goals:** Feature labeled `done`, branches cleaned, final `Status` summary posted, human review + close initiated.

1. Confirm the spec PR was merged and the tester verdict passed.
2. The feature is already labeled `done` and left OPEN — `close-issue --to-phase done` from cleanup labeled it; **the human closes it manually** after review.
3. Post a final `Status` summary: what shipped, test results, remaining risks (if any).
4. **Human review + close** — the human validates the finished feature manually, then closes the issue. `done` is **terminal**: a defect in the merged work is **not reopened** — it becomes a **follow-up backlog issue** (the PO links it with `revises: #N`; the `feature.revised` metric tracks it), which runs the pipeline normally.

---

## Escalation

| Situation | Trigger | Action |
|-----------|---------|--------|
| Blocked work / issue | label `blocked` | Orchestrator intervenes within the SLA (default 4h) |
| Dev pool saturated | all devs at 2 active workstreams | Orchestrator queues work; staffs when capacity frees |
| Triage underspecification | plan item sent back by a developer | Orchestrator routes back to the relevant planner |
| Ambiguous QA Plan | tester can't execute a case | Orchestrator routes back to QA Expert |
| Repeated PR failures | same work rejected >3× | Orchestrator escalates to human with a summary of what was tried |

See [staffing.md](staffing.md) for the full staffing and escalation rules.
