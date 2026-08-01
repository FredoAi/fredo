# Research Report: Issue-Tracker / Work-Item Lifecycle State Models

**Agent:** Research Analyst (issue tracker survey)
**Date:** 2026-07-31
**Scope:** GitHub, Jira, Linear, Azure Boards, Kanban, GitHub Projects automation, statecharts/xstate
**Model evaluated:** `intake → triage → staffing → implementation → testing → done` (+ transient `blocked`), labels `triage | ready-for-dev | in-progress-dev | ready-for-test | testing | blocked | done`

---

## 1. Executive summary — top 8 findings

1. **Every serious tool is a state machine under the hood — but they differ wildly in enforcement.** Jira is the only tool that *requires* a transition to exist before an item can move; Azure, GitHub, and Linear default to near-any-to-any movement unless explicitly restricted. GitHub Issues itself has **exactly two states** (`open`/`closed`) plus a `state_reason` — everything else is labels.

2. **"Blocked" is almost never modeled as a linear pipeline state.** Jira models it as a *flag* (custom checkbox `Flagged = Impediment`) or as a *resolution*; Linear models it as an issue *relation* (`blocks` / `blocked by`); Kanban treats it as a *lane/overlay + expedite class of service*; GitHub uses *issue dependencies*. The one place "blocked" appears as a status is in *waiting* statuses (e.g., Jira Service Management `Waiting for customer`, `Waiting for approval`). Industry consensus: **blocked is an attribute/overlay that can apply to any state, not a step in the flow** — a blocked item is still "in progress."

3. **Every tool reserves a distinct terminal for "canceled/abandoned/won't-do" separate from "done."** Linear has a `Canceled` *category* and an auto-managed `Duplicate` status; Jira uses a `Resolution` field (`Won't do`, `Duplicate`, `Cannot reproduce`) orthogonal to status; GitHub has `state_reason: not_planned`/`duplicate`; Azure Boards has a `Removed` state category that hides items from all boards. A lifecycle without a cancel/abandon terminal is the single most common modeling gap.

4. **"Reopen" (regression from a terminal state) is a first-class citizen in mature tools.** GitHub `state_reason: reopened`; Jira `Reopened`/`Resolved → Closed → Reopened`; Azure supports backward transitions and explicitly clears `Activated By/Date` and `Resolved By/Date` when regressing. A `done` state that is a hard sink (no exit edge) will break real pipelines.

5. **The "right" count is 3–6 *active* statuses, but total set of 6–8 incl. terminals is normal.** Defaults are tiny: Azure Basic `To Do/Doing/Done` (3), GitHub Projects `Todo/In Progress/Done` (+`No status`) (3–4), Linear default `Backlog > Todo > In Progress > Done > Canceled` (5). But *real* teams run 7–10 total — Linear's own product team runs `Icebox, Backlog, Todo, In Progress, In Review, Ready to Merge, Done, Canceled, Could not reproduce, Won't Fix, Duplicate`. So 6–7 states is **well-shaped** — provided you include a cancel terminal and a reopen edge.

6. **Validation on transitions is the thing that separates "a status field" from "a workflow."** Jira has validators, conditions, post-functions, and required-fields-on-transition-screens (this is the reference implementation). Linear has *triage rules* and one validation ("require priority before leaving Triage"). Azure has per-state *rules* and *reasons*. **GitHub has none** — no required fields, no guards, no enforced ordering; the closest thing is event-driven automation ("when X happens → set status to Y").

7. **The model is per-workflow-template, not per-issue-global — in every tool.** Jira: workflows mapped by *project + issue type* via workflow schemes. Azure: each *work item type* (User Story vs Bug vs Task) owns a distinct workflow; a "State" is project-level while board "Columns" are team-level *views*. Linear: statuses are *per-team* (fixed category order). GitHub Projects: per-project custom fields. Any pipeline model that assumes one global lifecycle for all issues is fighting the tooling grain.

8. **Formal state-machine/statechart modeling of work items has strong academic and practical support — but the industry consensus is to use it as a *guardrail*, not a straightjacket.** Workflow-patterns literature (van der Aalst) and statecharts (Harel; statecharts.dev) provide exactly the vocabulary needed — guarded transitions, history states, orthogonal regions, delayed transitions. The failure mode is over-engineering: every tool's documented best practice says "keep statuses few and meaningful, each with an explicit Definition of Done," because workflow bloat is the #1 maintenance complaint (esp. Jira). For an *AI-driven* pipeline the guardrail argument is stronger: an agent driving an issue needs a machine that is *deterministic*, not a free-form dropdown.

---

## 2. Per-tool breakdown

### 2.1 GitHub Issues + Projects

**(a) Canonical status list.** Issues: exactly `open` | `closed`, plus a `state_reason` of `completed`, `not_planned`, `duplicate`, or `reopened` (REST API). Any richer lifecycle is conventionally encoded in **labels** (which have no ordering and no enforcement). Projects (v2): a built-in single-select **Status** field with default options `No status` | `Todo` | `In Progress` | `Done`; all other "statuses" are custom single-select fields.

**(b) Allowed transitions.** None enforced. Any issue can be opened/closed at any time by anyone with triage/push; any project item can be dragged to any status column. The only "transition matrix" is what you program yourself via built-in workflows or GitHub Actions.

**(c) Blocked/waiting.** Modeled as **issue dependencies** (`blocked by` / `blocking`, tracked in `issue_dependencies_summary`), or implicitly by `closed` + `state_reason: not_planned`. There is no blocked status.

**(d) Validation.** None on transition. No required fields, no assignee requirements, no linked-PR requirements. Automation is one-way: "when item closed → set Status to Done," "when PR merged → set Status to Done," auto-add, auto-archive.

**(e) Per-issue vs per-template.** Per-project (Projects v2); per-repo/organization for issue fields; no per-issue-type workflows.

**(f) Pain points.** The two-state issue model forces teams to overload labels; Projects status is a plain dropdown with zero workflow semantics; automation can set statuses but cannot *validate* them; GitHub's own best-practices doc offers only "column limits ... to maintain focus" (i.e., cosmetic WIP caps) as flow control. Community complaint pattern: "GitHub tells you where work is, but never how it got there or where it's allowed to go next."

Sources: https://docs.github.com/en/issues/tracking-your-work-with-issues/about-issues · https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects · https://docs.github.com/en/rest/issues/issues · https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations · https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions · https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects · https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/quickstart-for-projects · https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields

### 2.2 Jira

**(a) Canonical status list.** No single canonical list — templates ship with `To Do`, `In Progress`, `Done`, plus `Open`, `In Review`, `Under review`, `Approved`, `Cancelled`, `Rejected`, `Reopened`, `Resolved`, `Closed`, `Backlog`, `Selected for Development`, `Building`, `Build broken`. Service-desk flows add `Waiting for support`, `Waiting for customer`, `Waiting for approval`, `Pending`, `Escalated`, etc. Two orthogonal fields: **Status** (workflow step) and **Resolution** (`Done`, `Won't do`, `Duplicate`, `Cannot reproduce`) which determines open-vs-closed.

**(b) Allowed transitions.** Explicit and enforced. "For a work item to move between two statuses, a transition must exist." Transitions are **one-way** (a back-and-forth needs two transitions), may loop (self-transition actions), and may be declared "from any status." Boards only let you drag to columns whose mapped statuses have a transition from the current status.

**(c) Blocked/waiting.** Three idioms, all community-contested: (i) a **Flag** (checkbox field, value `Impediment`, query `Flagged = Impediment`); (ii) *waiting* statuses; (iii) *resolution*. There is no canonical "Blocked" status; teams build their own.

**(d) Validation.** The richest in the industry: transitions carry **validators** (required fields, permissions, "must have assignee"), **conditions** (who can see/use the transition), **post-functions** (set resolution, assign, comment, transition screens with mandatory fields).

**(e) Per-issue vs per-template.** Per workflow **scheme** (project × issue type). Company-managed = admin-controlled; team-managed = per-team, simplified.

**(f) Pain points.** Complexity/over-customization is the classic complaint: workflow sprawl, "any-to-any" creep, admin overhead, the status-vs-resolution confusion, and the blocked modeling ambiguity. Atlassian's own guidance is explicitly conservative: copy the built-in workflow, keep statuses few.

Sources: https://support.atlassian.com/jira-cloud-administration/docs/work-with-issue-workflows/ · https://support.atlassian.com/jira-cloud-administration/docs/create-workflow-transitions/ · https://support.atlassian.com/jira-cloud-administration/docs/what-are-issue-statuses-priorities-and-resolutions/ · https://confluence.atlassian.com/jirasoftwareserver/transitioning-an-issue-938845575.html · https://confluence.atlassian.com/jirasoftwareserver/flagging-an-issue-938845533.html · https://www.atlassian.com/software/jira/guides/getting-started/basics

### 2.3 Linear

**(a) Canonical status list.** Fixed *categories*, custom statuses within them: **Backlog, Unstarted, Started, Completed, Canceled**, plus system-managed **Duplicate** and special **Triage**. Default workflow: `Backlog > Todo > In Progress > Done > Canceled`. Linear's own product team: `Icebox, Backlog, Todo, In Progress, In Review, Ready to Merge, Done, Canceled, Could not reproduce, Won't Fix, Duplicate`.

**(b) Allowed transitions.** Not enforced. Statuses are ordered within categories (drag to reorder); any issue can be moved to any status of the team. Auto-transitions exist (auto-close, auto-archive, "when blocking issue resolved, blocked relation → related").

**(c) Blocked/waiting.** **Issue relations** (`blocks` / `blocked by`), shown as flags in the sidebar. Linear does *not* ship a "Blocked" status type; a `Blocked` status is a *custom* status teams add (usually in the Started category). Blocked is a first-class *relation*, not a state.

**(d) Validation.** Minimal: Triage rules (automated actions on entry: set team/status/assignee/priority), "require priority before an issue leaves Triage" toggle, and Triage Intelligence (LLM-suggested assignee/labels/duplicates).

**(e) Per-issue vs per-template.** **Per-team** statuses; category order is global.

**(f) Pain points.** Per-team status proliferation; because blocked is a relation, blocked cards stay in their column and don't visually "park"; teams inventing their own `Blocked` statuses fragment reporting. Triage is deliberately excluded from all views by default (must opt in).

Sources: https://linear.app/docs/configuring-workflows · https://linear.app/docs/triage · https://linear.app/docs/issue-relations · https://linear.app/docs/conceptual-model

### 2.4 Azure DevOps / Azure Boards

**(a) Canonical status list.** Process-dependent, mapped onto **state categories**: `Proposed`, `In Progress`, `Resolved`, `Completed`, `Removed`. Basic: `To Do / Doing / Done`. Agile: `New / Active / Resolved / Closed / Removed`. Scrum: `New / Approved / Committed / Done / Removed`. CMMI: `Proposed / Active / Resolved / Closed`.

**(b) Allowed transitions.** "The default workflows support any-state-to-any-state transitions. You can customize these workflows to restrict specific transitions." Each work item type (User Story, Bug, Task…) has its **own** workflow.

**(c) Blocked/waiting.** No built-in blocked state. `Removed` = hidden from all backlogs/boards; `Resolved` = "solution implemented but not yet verified" (its own category). Impediments are a *separate work item type* in Scrum.

**(d) Validation.** Per-state/per-transition **rules** and **reasons** on every transition; system-maintained `Activated By/Date`, `Resolved By/Date`; auto-complete via linked PR; automated parent-state rollup from child states.

**(e) Per-issue vs per-template.** Per process template → per work item type. **State (project-level logic) vs Column (team-level view)** is an explicit, documented distinction.

**(f) Pain points.** Any-to-any default is criticized as non-enforcing; category model is coarse (`Resolved` ≈ "done but unverified" is routinely misunderstood); customizing states requires process-admin rights.

Sources: https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/agile-process-workflow · https://learn.microsoft.com/en-us/azure/devops/boards/work-items/guidance/choose-process · https://learn.microsoft.com/en-us/azure/devops/boards/work-items/workflow-and-state-categories

### 2.5 Kanban practice (lean/kanban literature)

**(a) Canonical status list.** None fixed — columns model *your actual workflow* ("usually more than To Do / Doing / Done"; STATIK step 4: model the workflow from the real process). Each column has an explicit pull policy / Definition of Done.

**(b) Allowed transitions.** Pull-based movement left→right; **WIP limits** per column/state/lane cap concurrency; blocked items stop flow.

**(c) Blocked/waiting.** Blockers are displayed on the board and removed ASAP (the "accidents on the autobahn" model). Blocked is typically a **flag/lane** or a **class of service** (expedite passes even when WIP is exhausted) — *not* a flow column. A blocked card is still WIP.

**(d) Validation.** Explicit **policies** ("sparse, simple, visible, always applied"): pull criteria, WIP limits, replenishment rules, classes of service.

**(e) Per-issue vs per-template.** Per *system* — the board models one service's workflow; multi-team = multiple connected boards.

**(f) Pain points.** Teams that add a "Blocked" *column* lose WIP semantics (the item is counted out of In Progress), inflate lead time, and hide the real bottleneck. The literature's correction is "blocked is an overlay, not a column."

Source: https://kanban.university/kanban-guide/

### 2.6 GitHub Projects automation — as a "state machine"

Automation = the only mechanism that *moves* items deterministically: built-in workflows (item closed → `Done`; PR merged → `Done`), auto-archive, auto-add, plus arbitrary GraphQL mutations from Actions. Limitations: rules are **unidirectional event→set-value**; no guards on the *source* state, no required-field validators, no rejection, no transition history semantics, and any actor can overwrite a status — concurrency/fighting-automations is a real failure mode. Evidence for the industry direction: "state transitions as event-driven code" is exactly what a pipeline needs, but GitHub's implementation is the *weakest* form (no guard conditions).

Sources: https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations · https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions

### 2.7 State transitions modeled as code (statecharts / xstate)

- **Formal basis:** Harel's *statecharts* (1987) extend FSMs with **hierarchy, orthogonal regions, guards, history, and delayed transitions** — exactly the features issue lifecycles need (e.g., `blocked` as an orthogonal overlay that returns via a **history state** to the pre-blocked status; `in-review` as a *sub-state* of `implementation`).
- **Evidence for:** statecharts.dev shows guards and auto-transitions are the clean way to express "can only leave triage if priority is set" or "done requires linked PR." Applied to work items, xstate-style machines give *provably valid* states — the same argument as Jira's enforced transitions, but executable as code and testable.
- **Evidence against / cautions:** statecharts add real modeling overhead; every vendor's best-practice guidance emphasizes *keeping the model small*. Workflow-patterns research (van der Aalst & ter Hofstede, 2003) catalogs ~20 control-flow patterns — a plain linear FSM cannot express all of them, and issue lifecycles genuinely need only a handful. Conclusion: **model the lifecycle as a small, guarded FSM (Jira-style), and reach for statechart features (orthogonal blocked, history, sub-states) only where they reduce complexity — don't build a full statechart engine to move a card.**

Sources: https://statecharts.dev/what-is-a-state-machine.html · https://statecharts.dev/what-is-a-statechart.html · Harel 1987 · van der Aalst & ter Hofstede 2003

---

## 3. Comparison table

| Tool | Statuses | Transitions enforced? | Blocked modeling | Validation |
|---|---|---|---|---|
| **GitHub Issues** | `open` / `closed` + `state_reason` | No — 2 states, free toggling | Issue dependencies (`blocked by`/`blocking`) | None on transition |
| **GitHub Projects** | `No status / Todo / In Progress / Done` | No — free drag; automation sets values one-way | No built-in blocked | None; no required fields |
| **Jira** | Per-template + `Resolution` field orthogonal | **Yes** — transition must exist, one-way | Flag (`Impediment`), *waiting* statuses, or resolution | Validators, conditions, post-functions, required fields |
| **Linear** | Categories `Backlog / Unstarted / Started / Completed / Canceled` + `Duplicate` + `Triage` | No — free move within category | **Issue relation** (`blocks` / `blocked by`) | Triage rules; "require priority to leave Triage" |
| **Azure Boards** | Per-WIT; categories `Proposed / In Progress / Resolved / Completed / Removed` | Default any-to-any; restrictable | No built-in blocked; `Removed` hides | State categories, per-transition rules + reasons |
| **Kanban** | Custom columns = workflow steps | Pull + WIP limits (soft) | Flag / lane / class-of-service — **not** a column | Explicit policies: pull criteria, DoD, WIP |
| **GH Projects automations** | Any single-select field | No — event→set-value rules, no guards | n/a | No validators |
| **Statecharts/xstate** | Arbitrary; hierarchical | Yes — declarative, guarded, testable | Orthogonal region + history state | Guards, entry/exit actions, delayed transitions |

---

## 4. Industry consensus on the "right" status set

- **Defaults are small (3–5), but production teams converge on ~6–8 total, including a cancel terminal and (usually) a review/verification state.** 6–7 states is neither too many nor too few — it is *exactly* the band real teams land on, provided two conditions hold:
  1. every state maps to a real **activity gate with a Definition of Done** (not a role or department);
  2. the set includes **both terminal outcomes**: `done` *and* a cancel/abandon/duplicate terminal.
- Consensus guidance across Atlassian, Azure, and Kanban: *fewer, well-defined columns beat more, fuzzy ones*; statuses should describe **work-stage** ("Ready for Test"), not **people** ("QA", "Dev"); every transition should have a pull policy.
- The three states the whole industry agrees are **mandatory**: an intake/backlog pool, an active-work state, and a terminal completed state. The states the industry *almost always adds*: a review/verification step and a cancel terminal.

---

## 5. Critique of the proposed model

**Overall shape:** Good — a recognizable, well-ordered pipeline (intake→triage→staffing→implementation→testing→done) that maps cleanly onto Jira/Azure/Linear practice. The phase names map to real gates. But it has five structural problems:

1. **No terminal for canceled/abandoned/duplicate.** Every surveyed tool has one. Without it, rejected specs, won't-fix items, and duplicates accumulate in `triage` forever or get force-marked `done` (corrupting metrics). **This is the biggest gap.**
2. **`done` is a hard sink with no exit — no `reopened`.** All four major tools support reopening a terminal item. A pipeline that cannot regress cannot survive test failures → rework → re-test cycles. The AI-coded context makes this *more* likely, not less.
3. **`blocked` as a "transient state" is the wrong shape.** Consensus is that blocked is an *overlay* (attribute/flag/relation) applicable to any state, not a step in the sequence. As a plain FSM state you get: (a) two extra transitions per state (→blocked, →back), (b) no guarantee of *returning to the same state* (statechart history solves this), (c) blocked items vanishing from WIP counts. Recommendation: model blocked orthogonally (a `blocked: bool` + `blockedReason`), or if it must be a state, pair it with a mandatory `resumeTo` history edge.
4. **`staffing` is not a state in the industry — it's the assignee field.** The pipeline's "ready-for-dev" label is the right *concept* (Jira `Selected for Development`, Scrum `Committed`), but "staffing" as a *phase* implies assignment is a flow step. Better: make `ready-for-dev` a state **guarded by "assignee is set"** (exactly Jira's validator pattern). Don't model staffing as a state; model it as a transition guard.
5. **`intake` and `triage` overlap, and `in-review` is missing.** (a) Most tools have *one* of intake or triage. Two adjacent "not started" states add friction with little information gain — consider collapsing `intake` into `triage`. (b) Where does review go? Jira/Linear both place `In Review` inside the *active-work* cluster, and Azure's `Resolved` category exists precisely for "implemented but not verified." For an AI-coding pipeline, **code/PR review is a real, distinct gate** and should be a state (or sub-state) between `implementation` and `testing` — *not* folded into either. If the pipeline is fully autonomous, `testing` can absorb it; if a human ever approves diffs, it needs its own state.

**Redundant / could-merge:** `intake`+`triage` (merge); `staffing` as a phase (fold into a guard); `testing` vs `done` are correctly distinct (Azure `Resolved` vs `Closed` precedent).

**Missing (full list):** `canceled`/`won't-do`/`duplicate` terminal; `reopened`/regression edges; `in-review` (if human review exists); an explicit `ready-for-X` gate label set; validation metadata (assignee, linked PR, acceptance criteria, blocked-reason); a stale/timeout rule (Linear auto-close/archive precedent).

---

## 6. Concrete recommendations to improve the proposed model

1. **Add a `canceled` terminal state** (with optional `reason`: won't-do, duplicate, superseded, not-planned). Borrow GitHub's `state_reason` semantics; make it a *terminal* that's analytically distinct from `done`.
2. **Add a `reopened`/regression path:** explicit edges `done → implementation`, `testing → implementation`, `canceled → intake` (or `triage`). Encode `reopened` as an explicit reason on the edge.
3. **Re-model `blocked` as an orthogonal overlay, not a pipeline state.** Persist `blocked: {reason, since, by}` as an attribute valid in any non-terminal state; entering/leaving must preserve the underlying state (statechart *history* semantics). If a flat FSM is required, implement `blocked` with a mandatory `blocked → <prior-state>` edge and a required `reason`.
4. **Add an `in-review` gate between implementation and testing** (labels `ready-for-review` → `in-review`), with `in-review → implementation` on "changes requested." Only collapse this into `testing` if no human review step exists in the pipeline.
5. **Drop `staffing` as a phase; express it as a guard:** `ready-for-dev` requires a non-null assignee; `implementation` (in-progress-dev) requires the assignee to have started. This mirrors Jira validators.
6. **Collapse `intake` into `triage`** unless external integration channels demand a separate raw-inbox. Keep a single `triage` entry state with a guard "has priority + has acceptance criteria" to leave it (Linear's "require priority before leaving Triage" precedent).
7. **Define the transition matrix explicitly, Jira-style, as one-way edges** (a reverse edge must be declared separately). Publish the matrix as code/testable tables.
8. **Add per-transition validation, minimum viable set:** into `ready-for-dev` → assignee set; into `testing` → acceptance criteria present (and linked PR/artifact); into `done` → verification artifact exists; into `blocked` → reason required.
9. **Declare the model per-work-item-type, not global.** Store the state machine as a template and allow per-type variants (e.g., "bug" can skip staffing).
10. **Add a stale/timeout policy** (delayed transition): items idle past N days auto-flag — otherwise an AI pipeline's unattended items rot invisibly.
11. **Keep the total ≤ 8 states per template** (recommended final set: `triage → ready-for-dev → in-progress-dev → in-review → testing → done`, + `canceled`, + orthogonal `blocked`).

---

## 7. Source list

**GitHub:** About issues · About Projects · REST API — Issues (`state_reason: completed|reopened|not_planned|duplicate`) · Using the built-in automations · Automating Projects using Actions · Best practices for Projects · Quickstart for Projects · Understanding fields
**Jira/Atlassian:** Understand workflows · Create workflow transitions · What are issue statuses, priorities, and resolutions? · Transitioning an issue (DC) · Flagging an issue (DC) · 7 steps to get started in Jira
**Linear:** configuring workflows · Triage · Issue relations · Concepts
**Azure DevOps:** Agile process workflow · Choose a process · Workflow category states
**Kanban:** The Official Guide to the Kanban Method (Kanban University)
**State machines:** statecharts.dev (what is a state machine / statechart) · Harel 1987 · van der Aalst & ter Hofstede 2003 (Workflow Patterns)

*All per-tool URLs were fetched directly during research. Harel 1987 and van der Aalst 2003 are canonical citations. Community-sentiment claims reflect long-standing, widely-reported patterns consistent with the primary sources.*
