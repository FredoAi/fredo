# Research Report: Work Item Lifecycle State Machines — Agile/Scrum/Kanban Practice

**Agent:** Research Analyst (agile practice survey)
**Date:** 2026-07-31
**Scope:** How mature teams move a single work item from idea to done — statuses, transitions, gates, flow metrics
**Model evaluated:** `intake → triage → staffing → implementation → testing → done` (+ transient `blocked`)

---

## Executive Summary — Top 8 Findings

1. **The two gates that matter are Definition of Ready (DoR) and Definition of Done (DoD).** Everything upstream of DoR is "not yet committed"; everything downstream of DoD is "increment done." In a state machine these are **transition guards, not states** — DoR is the pull/entry criterion at the commitment point, DoD is the exit criterion for `done`.

2. **DoR is real but not part of Scrum.** The 2020 Scrum Guide has no "ready" state — it says backlog items "that can be Done by the Scrum Team within one Sprint are deemed ready," and the only formal commitment checklist it defines is the **Definition of Done**. DoR is a widely-adopted *practice* (INVEST-based) whose whole value is giving the team a "push back" contract.

3. **Columns should be *states of the work item*, not activities or people.** The recurring failure mode is boards built as "who is doing what" or "which activity is happening" — the guidance is to map the actual states a work item passes through and put WIP limits on them. **"Staffing/assignment" is an attribute, not a state.**

4. **5–6 columns is the practitioner sweet spot; 3–4 is the recommended starting point.** Every major tool defaults to ~5–6 states (GitHub: No status/Backlog/Ready/In progress/In review/Done; Linear: Backlog/Todo/In Progress/In Review/Done/Canceled). Basic boards are 3–4 columns. Guidance is "start simple, evolve as the board shows you where work gets stuck."

5. **"In Review" as a separate state is near-universal in modern tools but contested.** GitHub, Linear and GitLab all model review as a distinct stage/status; Businessmap calls a Review column "commonly accepted." The counterpoint (trunk-based development) is that review is *continuous* — review latency > "an hour or two … negatively affect[s] cycle times," so review should only be a state if it is a real queue.

6. **Reopening is modeled cleanest as a loop back to the in-progress state, not a separate "rework" state.** The Scrum Guide returns failed items to the backlog; mature teams track rework as a *counter/dimension*, not a column.

7. **Blocked: community consensus leans flag/label over status** because a blocked *status* hides age and corrupts Cumulative Flow / cycle-time data. If blocked is made a state anyway, it must be transient, carry a required reason, and be excluded from cycle time.

8. **Metrics are decided by where you put the commitment point and delivery point.** Cycle time starts at commitment (first active state), lead time starts at intake. Anything after `done` (reopened items) or outside the flow (blocked time) must be accounted separately or it pollutes the numbers.

---

## 1. DoR / DoD Mapping to Transition Guards

**DoD — the hard gate (Scrum Guide).** "Work cannot be considered part of an Increment unless it meets the Definition of Done… If a Product Backlog item does not meet the Definition of Done, it cannot be released… Instead, it returns to the Product Backlog." DoD is the sole formal exit checklist in Scrum. Atlassian adds two cautions: DoD **≠ acceptance criteria** (DoD is the team's cross-story completion contract; AC is per-story conditions) and DoD should be a **living document**.

**DoR — the soft gate (practice, not framework).** "The team makes explicit and visible the criteria (generally based on the INVEST matrix) that a user story must meet prior to being accepted into the upcoming iteration." DoR "avoids beginning work on features that do not have clearly defined completion criteria" and "provides the team with an explicit agreement allowing it to 'push back' on accepting ill-defined features."

**Kanban translation — pull criteria.** The Kanban Maturity Model: a **"Ready to commit / Ready to pull"** column sits immediately before the first working step, and the DoR is visualized on the board as **pull criteria**. The KMM's example dev board (`Demand → Specify → Ready for Development → Development/Test/Deploy → Done`) shows DoR as the boundary between *upstream* (discovery) and *downstream* (commitment onward).

**Concrete mapping for the proposed model:**
- **DoR = guard `triage → staffing`** (or `staffing → implementation`): item is independent, valuable, estimable, small, testable (INVEST), has acceptance criteria, and a DoD is understood. Failure → back to `triage`/`intake`.
- **DoD = guard `testing → done`**: automated checks passed, review/verification recorded, deployable, no open blockers. Failure → loop to `implementation` (rework) with a counter.
- Neither DoR nor DoD is a status; both are checklists enforced at transitions.

---

## 2. Scrum/Kanban Board Best Practice

**The canonical skeleton.** Atlassian: David Anderson's five board components — visual signals (cards), **columns**, **WIP limits**, a **commitment point**, and a **delivery point**. Jim Benson's minimalism ("the more rules you add, the less contexts it fits into") anchors the "don't over-engineer" strand.

**Columns = states, not activities.** Businessmap: "Each column represents a different stage of your workflow. The cards go through the workflow until their full completion." The KMM distinguishes *emergent workflow states* from *concurrent/unordered activities* (which belong as checkboxes *within* a column, not as new columns). **A column must answer "what is the work item's current state," not "who is working on it."**

**WIP limits and swimlanes.** WIP limits make states legible — a column at its WIP cap "maxes out" and forces swarming. Swimlanes are orthogonal segmentation for classes of service, sub-teams, or expedite work — **not additional lifecycle states.**

**Commitment point and delivery point.** These are the two anchors that make flow measurable: commitment = the moment the team pulls work and takes ownership; delivery = when value is in the customer's hands. The proposed `intake`/`triage`/`staffing` are *upstream of the commitment point*; `implementation` onward is downstream. Decide explicitly where the commitment point sits, because that defines cycle time.

---

## 3. The "In Review" Question — Consensus and Counterpoint

**Consensus (vendor practice): review is a distinct stage.** Businessmap: "It is commonly accepted that such teams should have a 'Review' column in order to establish high-quality standards" — placed after development and before testing/deployment. GitHub's default project status set includes **In review**. GitLab models review as a full gate: assign reviewers, approve, **"Request changes" blocks the merge** until the author re-reviews and the requester approves.

**Counterpoint (continuous-review school): review is an activity, not a stage.** Trunk-based development argues for *continuous code review*: reviews are "critical… not allowed to back up," and "more than an hour or two [of review latency], and you are negatively affecting cycle times." Under this view, an "In Review" column is only justified if there is genuinely a separate reviewer queue with its own WIP.

**Where does review sit relative to testing?** Businessmap places Review between Development and Testing/Deployment; GitLab/GitHub place review at the merge gate. Practitioner consensus: review is a pre-merge gate on the *code*; testing is a pre-release gate on the *behavior*. In the proposed model the honest options are:
- **Review inside `implementation`** (pre-merge, agent/peer reviewed before the item leaves implementation) — matches TBD; avoids a new state.
- **Review as a separate state between `implementation` and `testing`** — matches Businessmap's commonly-accepted board and GitHub/Linear status sets; only if review is a real queue with a WIP limit and SLA.

Recommendation for an AI pipeline: fold review into `implementation`, with review evidence recorded as metadata on the `implementation → testing` transition.

---

## 4. Reopening / Rework Loops

**Evidence: loop back, don't add a state.** The Scrum Guide's own mechanism is a loop: an item that doesn't meet DoD "returns to the Product Backlog for future consideration" — it does *not* get its own "rework" lane. GitLab's review gate is a concrete loop: "Request changes" blocks the merge, the author addresses feedback, the reviewer re-reviews; no intermediate "Reworking" status exists. The KMM treats defects/rework as a **work type to visualize** rather than a workflow stage, and calls out *aborted* work as something to either give a column or tag-and-Done.

**Why loop-back is cleaner.** A dedicated "rework" state (a) adds a handoff and a column for a case that should be exceptional, (b) creates two parallel paths through the same activity, doubling state-machine edges, and (c) invites "rework" as a dumping ground. The evidence-supported pattern: **`review/testing` failures transition back to `implementation`** (or, for specification failures, back to `triage`), and a `reworkCount` field is incremented and surfaced as a metric. Reopening after `done` should increment a similar counter and re-enter at `triage` or `implementation`.

---

## 5. Triage: State or Activity?

**Linear — an explicit state, deliberately outside the normal workflow.** Linear's Triage is "a special inbox": issues created by integrations or non-team members land in **Triage**; the team **accepts** (moves to the team's default status), marks **duplicate**, **declines**, or **snoozes**. Crucially, "triage is considered to be outside the normal workflow" — by default triage issues are **excluded from all views and cycle-time charts** until accepted. Linear layers LLM automation on top (Triage Rules, Triage Intelligence).

**GitHub — triage as label/activity, not status.** GitHub has no first-class Triage status; triage is a convention: issue **templates and forms**, the ubiquitous `triage` **label**, **issue types**, and **issue dependencies**.

**Kanban consensus.** The KMM lists "Develop a triage discipline" as a core practice at maturity Level 3, and treats upstream (discovery) as a set of states *before* commitment.

**Synthesis.** Whether triage is a state or an activity tracks with *inbound volume and automation*:
- **Explicit triage state is valuable** when there is real inbound volume and/or when triage is automatable — Linear's Triage is exactly this, and its exclusion-from-metrics rule is the key design detail.
- **Triage as overhead** is the failure mode when volume is low — then it is an activity inside intake/backlog.

For an AI-driven pipeline, an explicit, *time-boxed* `triage` state with **exit criteria** (classified, duplicate-checked, prioritized, DoR-checkable) is well supported by the Linear evidence — including keeping triage time out of cycle-time charts.

---

## 6. Blocked: Status or Flag? Community Consensus

**The consensus position (flag/label):** Blocked is a *condition on a work item*, not a stage in the workflow. Businessmap: "When something stops your team from continuing work on a task, they can label it as blocked and start working on another assignment **without breaking any WIP limits**" — blocked is a visual marker on a card that *remains in its column*. Blocked reasons are collected as data for **blocker clustering**. GitHub models the same thing structurally: "blocked by" is an **issue dependency**, never a status.

**Why blocked-as-status is an anti-pattern:**
- **It hides age.** An item moved to "Blocked" vanishes from the active WIP columns and CFD bands; nobody sees it aging.
- **It corrupts flow metrics.** A blocked status either terminates the "in-flow" clock (making the team look faster) or, if included, makes work look like it's actively progressing.
- **It breaks WIP accounting.** If blocked items leave WIP columns, the WIP limit no longer reflects reality.

**The counter-position (vendor practice):** Linear offers **Blocked** as a first-class status; Jira teams commonly add "Blocked" as a status. The pragmatic resolution: **if blocked is a status, it must be (a) transient, (b) require a mandatory reason field, and (c) be excluded from cycle time / reported separately as "blocked time."** This is precisely the compromise a state machine makes easy — which is the one genuine argument for a *transient* `blocked` state rather than a flag: automation can enforce the reason and the time-box.

**Recommendation:** model `blocked` as a **transient orthogonal modifier** that can be applied from any active state, carrying a required reason and an age alarm — functionally a flag with machine-enforced discipline.

---

## 7. Recommended State Count

- **3–4:** "The basic Kanban board… usually consists of 3 to 4 columns without any complications… a great start for teams new to the concept."
- **5:** the KMM's canonical software-dev board (`Demand → Specify → Ready for Development → Development/Test/Deploy → Done`).
- **6:** GitHub Projects default (No status / Backlog / Ready / In progress / In review / Done) and Linear's default (Backlog / Todo / In Progress / In Review / Done / Canceled).
- Atlassian's workflow guidance is the "keep it simple" anchor: the recommended graphic for software teams is a small set (To Do / In Progress / In Review / Done).

**The "5–6 columns max" guidance** is a rule of thumb: beyond ~6 columns, the board stops communicating at a glance, every added column is a new handoff/queue. The rigorous version: **add columns only to visualize a state where work observably gets stuck.**

**The proposed model sits at the ceiling:** `intake, triage, staffing, implementation, testing, done` = **6 states** (+ transient blocked). That is within the tolerated band but at the top of it — every state above `implementation` should survive the "does work observably wait here?" test.

---

## 8. Metrics Implications

- **Cycle time** = commitment point → delivery point. **Lead time** = request → done. Little's Law and the CFD only work if the state model is a faithful, monotonic map of the flow.
- **Blocked as status** breaks the CFD/cycle-time mapping. Fix: exclude blocked time from cycle time and report it separately.
- **`done` as terminal** — the CFD band for "done" should be closed; reopened items must not re-enter through done. Track reopen rate as a separate quality metric.
- **Upstream states pollute cycle time** if the commitment point is set too early. Linear's answer: Triage is *outside* the workflow and excluded from charts. Decide whether `intake`/`triage`/`staffing` are part of *lead time only* (recommended) or also cycle time.
- **Flow efficiency** (active time ÷ total time) depends on distinguishing "waiting" from "doing." If `staffing` is a waiting state, it directly degrades flow efficiency — a signal to fold staffing into the commitment gate rather than keep it as a free-floating waiting room.

---

## 9. Vendor Practice vs. Community Consensus vs. Opinion

| Topic | Vendor practice | Community consensus | Opinion |
|---|---|---|---|
| DoD | Atlassian/Jira checklists; GitLab merge checks | DoD is the exit contract; rework is the consequence | DoD as a "living document" |
| DoR | Linear/Asana-style checklists | DoR = pull criteria; INVEST-based | "DoR is for the team, by the team" |
| In Review | GitHub/Linear status; GitLab approval gate; Businessmap Review column | Review is a pre-merge quality gate | Review is continuous, not a stage (TBD) |
| Triage | Linear Triage = status outside workflow; GitHub = labels/forms | Triage discipline is a KMM core practice | Triage only if volume/automation justify it |
| Blocked | Linear/Jira offer Blocked status; GitHub uses dependencies | Blocked is a flag; status hides age and breaks metrics | "Blocked is not a status" |
| State count | 6 (GitHub/Linear), 5 (KMM), 3–4 (basic) | ~5–6 max; add only where work waits | "Keep it simple" |

---

## 10. Concrete Recommendations for the Proposed Model

1. **Keep 6 states, but demote `staffing` to a gate.** `staffing` (agent assignment) is an *attribute* ("assignee"), not a workflow state. Implement `staffing` as **exit criteria of `triage`** (or a merged `intake/triage`): an item is staffable when it is triaged, prioritized, and has a DoR.
2. **Collapse `intake` + `triage` unless volume is real.** Adopt the Linear model: `triage` is a time-boxed special state that sits *outside* the flow for metrics (lead-time-only), with explicit exit criteria and a mandatory time-box. If inbound volume is low, merge into a single `intake` state.
3. **Model DoR as the guard on `triage → staffing`** (INVEST + acceptance criteria + known DoD). DoR failure returns the item to `triage`/`intake`.
4. **Model DoD as the guard on `testing → done`** and attach it to the transition. Include: all ACs verified, checks green, review evidence recorded, no open blockers, deployable artifact. DoD failure loops to `implementation` and increments `reworkCount`.
5. **Fold code review into `implementation`** rather than adding a 7th state. For an AI-driven pipeline, review is a verification step performed before the item exits implementation; record review outcome as metadata on the transition. If review demonstrably becomes a bottleneck (measured), promote it to a state — with a WIP limit and a review-latency SLA.
6. **Model rework as a loop, not a state.** `testing → implementation` (behavioral/DoD failure); specification failures loop to `triage`. Track `reworkCount` and `reopenCount` as first-class metrics.
7. **Implement `blocked` as a transient orthogonal modifier on any active state**, not a pipeline stage: required reason, optional linked dependency, age alarm/escalation, and **excluded from cycle-time and CFD**. Add a `blockedDuration` dimension for blocker clustering.
8. **Anchor metrics explicitly.** Commitment point = `implementation` start. Delivery point = `done`. **Cycle time = implementation → done**; **lead time = intake → done**; `triage`/`staffing` time counts toward lead time only.
9. **Do not add states after `done`.** Reopened items re-enter at `triage` (new intent) or `implementation` (bug fix) with a reopen counter. "Canceled/Abandoned" is the one additional terminal you should consider adding — every real tracker has one, and "done" must not absorb discarded work.
10. **Make every transition carry its evidence payload** (DoR checklist, review record, DoD checklist, blocked reason, rework counter). Because the pipeline is machine-executed, the guards are enforceable — that is precisely the DoR/DoD-as-transition-guard design the literature recommends, and it is the biggest advantage an AI-driven state machine has over a human-run board.

---

## Source List

1. The 2020 Scrum Guide (Schwaber & Sutherland) — https://scrumguides.org/scrum-guide.html
2. Agile Alliance Glossary — Definition of Ready (INVEST) — https://agilealliance.org/glossary/definition-of-ready/
3. Agile Alliance Glossary — Definition of Done — https://agilealliance.org/glossary/definition-of-done/
4. Atlassian — Definition of Done in Agile — https://www.atlassian.com/agile/project-management/definition-of-done
5. Atlassian — Definition of Ready (DoR) Explained — https://www.atlassian.com/agile/project-management/definition-of-ready
6. Atlassian — What is a kanban board? (Anderson's 5 components, commitment/delivery point, Benson's minimalism) — https://www.atlassian.com/agile/kanban/boards
7. Atlassian — Creating Agile workflows — https://www.atlassian.com/agile/project-management/workflow
8. Linear Docs — Triage — https://linear.app/docs/triage
9. GitHub Docs — About issues — https://docs.github.com/en/issues/tracking-your-work-with-issues/about-issues
10. GitHub Docs — Best practices for Projects — https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects
11. GitHub Docs — Quickstart for Projects — https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/quickstart-for-projects
12. GitLab Docs — Merge request reviews — https://docs.gitlab.com/ee/user/project/merge_requests/reviews/
13. Businessmap — What Is a Kanban Board? — https://businessmap.io/kanban-resources/getting-started/what-is-kanban-board
14. Businessmap — 26 Practical Kanban Board Examples — https://businessmap.io/kanban-resources/kanban-software/kanban-board-examples
15. Businessmap — Applying the Kanban Maturity Model — https://businessmap.io/kanban-resources/kanban-software/kanban-maturity-model
16. Businessmap — Cycle Time: Maximized Productivity — https://businessmap.io/continuous-flow/cycle-time
17. Trunk Based Development — Continuous Code Review — https://trunkbaseddevelopment.com/continuous-review/
