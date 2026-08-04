# Pipeline Phases

Six phases + a Self-Improver gate. Sequential handoffs between phases; parallel work within a phase wherever dependencies allow. Every handoff happens through GitHub issues and comments ([github.md](github.md)).

```
Business → Intake → Triage → Implementation → Testing → Audit → Done
   (You)      PO       SM          Dev pool        Tester     SI      SM
```

---

## Full Pipeline Flow

```mermaid
flowchart TD
    B([Business - You]) --> P1

    subgraph P1[Phase 1: Intake]
        PO[Product Owner]
        PO --> |structured dialogue| SUM[Design Summary]
        SUM --> |backlog issue| BL[Backlog Issue - label: triage]
    end

    BL --> SM1[Scrum Master]
    SM1 --> |dispatch parallel| TRIAGE
    subgraph P2[Phase 2: Triage]
        TRIAGE[Software Architect / UI-UX / QA Expert]
        TRIAGE --> |drafts + cross-review<br/>Decision / Question / Decision| CONV[Convergence marker]
        CONV --> |create seeded plan| IP[Implementation Plan Issue<br/>+ Staffing Plan]
    end

    IP --> SM2[Scrum Master]
    SM2 --> |compute headcount| HEAD{How many devs?}
    HEAD --> |create sub-issues| SUB[Dev sub-issues xN<br/>label: ready-for-dev]
    HEAD --> |create tester issue| TIS[Tester Issue<br/>from QA Plan]

    SUB --> P3
    subgraph P3[Phase 3: Implementation]
        DEV[Developer pool xN]
        DEV --> |worktree on spec/<N>, push directly| SPEC[spec/<N> integration branch]
        SPEC --> |all sub-issues pushed| READY[ready-for-test]
    end

    READY --> |spec PR auto-created on →testing| TIS
    subgraph P4[Phase 4: Testing]
        T[Single Tester]
        T --> |execute QA Plan| VERDICT{All pass?}
        VERDICT --> |no - reopen| SUB
        VERDICT --> |yes| AUDIT
    end

    subgraph GATE[Self-Improver Gate]
        AUDIT[Self-Improver]
        AUDIT --> |success| DONE2
        AUDIT --> |failure: restart from phase N| RESTART
        RESTART --> P1
        RESTART --> P2
        RESTART --> P3
        RESTART --> P4
    end

    DONE2[Phase 5: Done<br/>Scrum Master status + human review]
```

---

## Phase 1: Intake

**Owner:** Product Owner
**Input:** Business goals from the human
**Output:** Backlog issue (label: `triage`)
**Goals:** A backlog issue with confirmed requirements, Gherkin ACs, wireframe (UI only), priority, and label `triage` — agreed by the human before dispatch.

1. **Explore context** — understand scope, constraints, priority. Is this a trivial task (typo, label, single-file tweak) or a complex feature (new architecture, data flow, multiple surfaces)? Adjust dialogue depth accordingly.
2. **Structured dialogue** — one question at a time. Never ask about implementation details — flag them `[Technical: defer to triage]`.
3. **Design summary** — What, Wireframe (ASCII, UI only), Behavioral (Gherkin), Non-Behavioral, Risks/Unknowns.
4. **User confirmation** — the human approves the summary. No dispatch until this happens.
5. **Create backlog issue** — draft the body per the [backlog template](artifacts.md#backlog-issue), then request the state machine's `create-issue` action (labeled `triage`). The state machine is the single GitHub writer.
6. **Handoff to Scrum Master** — the Product Owner dispatches the Scrum Master with the backlog issue number.

**Simplicity heuristic:** trivial tasks get a one-line summary and a single dialogue round — but the summary + confirmation step is never skipped.

---

## Phase 2: Triage

**Owner:** Triage cluster (Software Architect + UI/UX Expert + QA Expert), orchestrated by the Scrum Master
**Input:** Backlog issue
**Output:** Implementation Plan issue (includes Staffing Plan)
**Goals:** A converged triage deliberation on the feature issue, then an Implementation Plan issue seeded from [templates/triage-plan-template.md](templates/triage-plan-template.md) with all required sections (Summary, Software Architect, UI/UX Expert, QA Expert, Staffing Plan, Deployment Notes, Risks) — every backlog requirement covered by a sub-issue.

### Scrum Master responsibilities
1. Read the backlog issue.
2. **Transition the feature to the triage phase** — request the state machine's `transition` action (applies the `triage-plan` label) *before* dispatching the triage cluster, so the triage subagents (software-architect / ui-ux-expert / qa-expert) read the triage phase in their context block.
3. **Dispatch the three planners in parallel** with the same brief (backlog + any Product Owner notes). Each planner works independently and posts its section draft to the feature issue.
4. **Coordinate the deliberation** — see [the triage deliberation protocol](#the-triage-deliberation-protocol). Track open `Question` comments and route each to its owning section.
5. **Post the convergence marker** — when no planner question remains open, request a `Decision` comment on the feature issue with body `Triage converged — all planner questions resolved.` This marker is the **agreement gate**: the state machine refuses the `triage → implementation` transition while it is absent.
6. **Create the Implementation Plan from the template** — request `create-issue --issue-type impl-plan` with **no** `--body-file`: the state machine seeds the issue body from `templates/triage-plan-template.md`, filling the `<issue>`, `<title>`, and `<backlog>` placeholders. Then write each agent's agreed section into the seeded body via `update-plan --issue <impl-plan-N> --section <agent-or-key> --body-file <draft>` (idempotent per-section replacement).
7. **Handoff** — request the `transition` action `triage → implementation` (auto-creates the spec branch). `generate-work` later turns the plan's sub-task checkboxes and QA Plan into dev sub-issues and the tester issue.

### The triage deliberation protocol
1. **Parallel drafts.** The Scrum Master dispatches the three planners in parallel with the same brief. Each planner posts its section draft on the **feature issue** as a `Decision` comment: prefix `Decision`, body `Draft — <Your Section>:\n<content>`.
2. **Cross-review.** Each planner reads the other two planners' drafts (from the feature issue timeline) and posts a `Question` comment for every conflict or gap it finds — it never edits another planner's section.
3. **Resolution.** The owner of the questioned section replies to each `Question` with a `Decision` comment that resolves it (or explicitly defers with a reason). No `Question` is left orphaned.
4. **Convergence.** When every planner question is resolved, the Scrum Master posts the convergence marker `Decision` comment: `Triage converged — all planner questions resolved.` The state machine's triage exit guard requires this marker (**agreement gate**) before `triage → implementation`.
5. **Plan assembly.** Only after convergence does the Scrum Master create the Implementation Plan issue (seeded from the template) and write each agreed section into it via `update-plan`.

### Planners
- **Software Architect** — research, domain model (file:line citations), EARS-style requirements, API contracts, data models, scope decomposition into independent sub-issues, **effort estimates** per sub-issue (these feed the Staffing Plan).
- **UI/UX Expert** — design assets (mockups, component specs, interaction flows, states, accessibility). Returns "N/A" for backend-only work. Bases the draft on the Software Architect's Domain Model draft (read from the timeline).
- **QA Expert** — QA Plan (test cases per requirement, pass/fail criteria, test data, non-functional checks), edge cases, regression risks. Bases the draft on the Software Architect's Domain Model draft (read from the timeline).

### The Implementation Plan must contain
| Section | Content |
|---------|---------|
| **Title** | Concise feature name + parent issue number |
| **Summary** | Goal + acceptance criteria |
| **Software Architect** | Domain model (file:line), EARS requirements, API contracts & data models, sub-issue decomposition + effort estimates |
| **UI/UX Expert** | Design assets (or "N/A") |
| **QA Expert** | QA Plan (test cases, pass/fail criteria, required test data, non-functional checks) |
| **Staffing Plan** | Number of developers required, suggested roles, estimated effort — and the heuristic used (see [staffing.md](staffing.md)) |
| **Deployment notes** | Branch strategy, CI checks, infrastructure needs |
| **Risks & mitigations** | Blockers and fallback options |

The state machine seeds the **Implementation Plan issue** from [templates/triage-plan-template.md](templates/triage-plan-template.md) via `create-issue --issue-type impl-plan` (no `--body-file`); the Scrum Master writes each agent's agreed section via `update-plan`. Dev sub-issues and the tester issue reference this parent issue.

---

## Phase 3: Implementation

**Owner:** Scrum Master (setup) + Developer pool (execution)
**Input:** Implementation Plan issue
**Output:** All sub-issues pushed to `spec/<N>`; the feature is labeled `ready-for-test`
**Goals:** All sub-issues created, assigned (≤2 active each), implemented, merged to base with passing CI and scope respected; feature labeled `ready-for-test`.

### 3a. Staffing (Scrum Master)

1. **Read the Staffing Plan** — extract total effort and the planner's suggested headcount.
2. **Apply the staffing heuristic** — convert effort to developer headcount (default: 1 full-stack dev ≈ 5 story points per sprint). See [staffing.md](staffing.md#staffing-heuristic).
3. **Check pool availability** — every developer has a max of 2 active sub-issues. Reduce headcount if the pool is saturated.
4. **Generate the work items** — request the state machine's `generate-work` action on the Implementation Plan issue: it creates one sub-issue per `- [ ]` item in the plan's Software Architect `### Sub-issue Decomposition` section (label `ready-for-dev`, parent = plan) and the consolidated tester issue from the QA Expert's `### QA Plan` section (label `testing`). One tester issue per feature — it does not get created per-PR; it consolidates all work for the feature. It refuses to run twice (duplicate guard).
5. **Spec integration branch** — auto-created by the state machine as a side-effect of the `triage → implementation` transition (`spec/<spec-issue>` from `main`). This is the working base for every developer's worktree, testing, and the evidence trail (see [github.md](github.md#branch-naming)).
6. **Transitions** — sub-issues → `ready-for-dev`; the tester issue is created with `testing` (step 4) so it reads as the testing phase.

### 3b. Development (Developer pool)

Each developer picks up its assigned sub-issue:

1. **Read the sub-issue** + parent Implementation Plan for full context. Read the API contracts and design assets.
2. **Create a worktree detached at the tip of `spec/<N>`** — request the state machine's `create-worktree` action (`--worktree-path <path>`; base auto-resolved from the sub-issue's `Parent: Implementation Plan #N`). Detached worktrees let many developers run in parallel.
3. **Implement** — strictly within sub-issue scope. Never touch files outside the sub-issue; never redesign architecture.
4. **Verify locally** — lint, typecheck, build, tests.
5. **Push with `git push origin HEAD:spec/<N>`** — the developer's one allowed direct write (never `main`/`master`). Pull/merge `spec/<N>` first if the push is rejected.
6. **Remove the worktree** (`remove-worktree`) and **Report** — a `Status` comment on the sub-issue: what shipped, verification results, any scope notes.

### Dependency handling
- If a sub-issue blocks on another's work: request the state machine's `block` action (label `blocked` + `Status` comment) and notify the Scrum Master. Never stall silently.
- If a sub-issue is ambiguous: request the state machine's `comment` action with a `Question`. Never improvise scope.

### Retry path
When the Scrum Master requests changes:
1. Re-enter the worktree, fetch + rebase.
2. Fix exactly what was requested.
3. Push to the same branch — the PR updates.
4. Post `Status: PR #N updated`.

### Merge
The Scrum Master reviews each developer's pushes on the spec integration branch against their sub-issues, requests changes when needed, and returns failed work to the same developer. When all sub-issues are pushed to `spec/<N>`, the Scrum Master transitions the feature to `testing` — which **auto-creates the spec PR** (`spec/<N>` → `main`) and applies the `testing` label — making the tester issue actionable. Once testing passes, the Scrum Master transitions to `audit`, which **auto-merges the spec PR**; the `spec/<N>` branch is kept so evidence URLs keep rendering.

---

## Phase 4: Testing

**Owner:** Tester (single)
**Input:** Consolidated tester issue (label: `testing`)
**Output:** Verdict on the tester issue (evidence posted); the Scrum Master transitions the feature to `audit` (auto-merging the spec PR), the Self-Improver's `audit-record --verdict success` auto-transitions `audit → done` and closes as done, or sub-issues are reopened
**Goals:** Tester verdict posted with per-case evidence; all failures reopened to the correct sub-issues with expected-vs-actual and repro steps.

1. **Read the tester issue** — QA Plan checklist, the spec integration branch to test (`spec/<N>`), and required test data.
2. **Ensure the dev instance is running on the spec integration branch** (see the dev-environment workflow).
3. **Execute each test case** in order:
   - Attach evidence per case: screenshots, logs, DOM snapshots, test output. Screenshots are committed to `.opencode/evidence/<tester-issue>/` on `spec/<N>` and embedded in `Evidence` comments via `upload-evidence`, so they render inline for repo members.
   - Classify PASS / FAIL.
4. **Verdict:**
   - **All pass** → post the test report (`Evidence` comment), notify the Scrum Master — who transitions the feature to `audit` (auto-merging the spec PR). The Self-Improver's `audit-record --verdict success` then auto-transitions `audit → done` and closes the issue as done.
   - **Any fail** → reopen the offending dev sub-issue(s) with a precise failure description (expected vs actual, evidence, repro steps). Post the partial test report.

### Reopened sub-issues
Reopened sub-issues go back through Implementation (Phase 3) and, once merged, return to the Tester via the same consolidated tester issue — the tester issue stays open until the whole feature passes.

---

## Self-Improver Gate

**Owner:** Self-Improver (dispatched by Scrum Master)
**Input:** Tester verdict + the issue's full record
**Output:** `done`, or a restart instruction (phase + improvement applied)

1. **Audit** — read the Tester's verdict and the issue's recorded history (decisions, evidence, retries). Decide: was the issue completed successfully?
2. **Doc-sync** — the SI is the documentation owner. Classify the merged spec diff into doc categories (`ARCHITECTURE.md`, `CLI_GUIDE.md`, `SETUP.md`, `SECURITY.md`, `FAQ.md`), patch the affected product docs, and commit. Product docs are only coherent against the full merged diff, which the SI — running last — is uniquely positioned to see. If the product state doesn't match the docs, that is a failure.
3. **Success** → `audit-record --verdict success` — the state machine **auto-transitions `audit → done` and closes the issue as done**. Return to the Scrum Master.
4. **Failure** → choose the phase to restart from (Intake, Triage, Implementation, or Testing), **after improving** the root cause of the failure. `audit-record --verdict restart --phase <p>` **auto-transitions `audit → <p>`**. Improvement toolkit: agent prompts, skills, scripts, **references** (add/edit/delete in the playbook folder's `references.md`), **observability** (add metrics, logs, or traces for visibility), and **pipeline docs** (document the change in the same pass). Stale product docs are a valid failure reason → restart to Implementation with "sync docs" in scope.
5. **Return** — the restart instruction goes to the Scrum Master, who re-dispatches the pipeline from the chosen phase.

**Status: implemented.** The Self-Improver agent (`.opencode/agents/self-improver.md`) runs this gate; its steps are in `playbooks/self-improver.md`. Its verdict is recorded via the state machine's `audit-record` action, which also drives the next phase automatically.

---

## Phase 5: Done

**Owner:** Scrum Master
**Input:** Self-Improver verdict = success
**Output:** Closed feature, human review
**Goals:** Feature labeled `done`, branches cleaned, final `Status` summary posted, human review initiated.

1. Confirm all sub-issues and the tester issue are merged/passed.
2. Feature is already labeled `done` and closed as done — `audit-record --verdict success` did both automatically.
3. Post a final `Status` summary: what shipped, test results, remaining risks (if any).
4. Clean up — the spec integration branch `spec/<N>` is **kept** (it carries the evidence trail, and `prune` never touches `spec/*`); remove any leftover local worktrees via `prune`.
5. **Human review** — the human validates the finished feature manually. If the human finds an issue, they report back and the Product Owner opens a follow-up backlog item (labeled `triage`, with the bug variant of the PO template).

---

## Escalation

| Situation | Trigger | Action |
|-----------|---------|--------|
| Blocked sub-issue | label `blocked` | Scrum Master intervenes within the SLA (default 4h) |
| Dev pool saturated | all devs at 2 active sub-issues | Scrum Master queues work; staffs when capacity frees |
| Triage underspecification | sub-issue sent back by a developer | Scrum Master routes back to the relevant planner |
| Ambiguous QA Plan | tester can't execute a case | Scrum Master routes back to QA Expert |
| Repeated PR failures | same sub-issue rejected >3× | Scrum Master escalates to human with a summary of what was tried |

See [staffing.md](staffing.md) for the full staffing and escalation rules.
