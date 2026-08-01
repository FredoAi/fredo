# State Machine Skill (Designed — Future)

> **Status: DESIGNED, NOT IMPLEMENTED.** This document fixes the contract for the state-machine skill + script that gives each agent its pipeline context. It will be built in a later step. Until then, agents derive state from their dispatch prompt — but they are written against this contract now.

---

## Purpose

Agents are contextual. The same developer behaves differently mid-implementation than during a PR retry, and a Scrum Master orchestrating triage is in a different mode than one processing a blocker. Agents cannot reliably infer "where are we right now?" from raw issue text — and the pipeline needs one deterministic authority for state.

The state machine exists to answer, deterministically and for every agent that wakes up:

1. **Where are we?** — the current Phase of the pipeline.
2. **What happened to get here?** — the triggering event and prior phase.
3. **What is this phase trying to achieve?** — the phase's Goals (principle 3).
4. **What am I supposed to do in this phase?** — the agent's responsibilities + the playbook for this phase.
5. **What do I hand off when done?** — the next phase and its expected input.

---

## Design: A Minimal Skill + A Workhorse Script

Two pieces, working together. The split is deliberate and non-negotiable: **all state logic lives in the script; the skill is a thin loader.**

| Piece | Location | Role |
|-------|----------|------|
| **State Machine Skill** | `.opencode/skills/pipeline-state/SKILL.md` | **Minimal.** Does NOT encode the phase model, transitions, guards, or goals. Contains only what the agent needs to *invoke* the script and *read* its output: how to run it, how to read the context block, what to do with it. Loaded at agent start. |
| **State Machine Script** | `.opencode/scripts/pipeline-state.ps1` | **Does all the work.** Reads real signals (issues, labels, branches, worktrees, templates, comments), computes the current phase, validates guards (prior-phase completeness), and prints the context block the agent consumes. |

The script is the source of truth for state logic; the skill is static glue. The agent combines both: the skill tells it *how to invoke and read* the script, and the script tells it *where it is right now*. **If the skill ever grows phase descriptions or transition rules, that is a bug** — the skill must never duplicate (and thereby drift from) the script.

---

## What the State Machine Reads and Controls

The script is the pipeline's eyes and gatekeeper. It reads GitHub state, validates it, and only then reports the phase context. Per [01-principles.md](01-principles.md#2-a-state-machine-gives-each-agent-its-phase-context):

| Signal | What it reads / validates |
|--------|---------------------------|
| **Issues** | The feature's issue model is complete: Backlog → Implementation Plan → sub-issues → tester issue. Each exists and references its parent. |
| **Labels** | The label set (`triage`, `ready-for-dev`, `in-progress-dev`, `ready-for-test`, `testing`, `blocked`, `done`) matches the true phase. Mismatch = the script reports the discrepancy rather than trusting the label. |
| **Branches & worktrees** | The expected branch (`feat/<issue>-<desc>`) / worktree for the current work exists and is on the right base. |
| **Templates** | Issue bodies conform to their templates ([04-artifacts.md](04-artifacts.md)): required sections present, checklists intact. |
| **Comments** | Required comments exist per [05-github.md](05-github.md) prefixes: a `Decision` for every `Question`, `Evidence` on the tester issue, `Status` on transitions. |
| **Prior-phase completeness** | The exit conditions of the previous phase (its Goals) are verifiably met. If not, the script blocks entry and reports what's missing. |

### Determinism rule

The state machine computes phase from **real signals only** — never from an agent's self-report. If an agent claims a phase is done but the exit conditions aren't met, the script blocks the transition. Phase transitions happen by the script updating labels, not by agent assertion.

---

## The Phase Model

Six pipeline phases, matching [03-pipeline.md](03-pipeline.md). Each phase declares its Goals (principle 3), entry conditions, owner, and transitions.

| Phase | Goals (definition of done) | Entry condition (signal) | Owner | Exits to |
|-------|----------------------------|--------------------------|-------|----------|
| `intake` | Backlog issue exists with confirmed requirements, Gherkin ACs, priority, label `triage` | Backlog issue exists, label `triage`, no Implementation Plan | Product Owner | `triage` |
| `triage` | Implementation Plan issue posted with all required sections (Summary, Scope, Staffing Plan, Design, API contracts, QA Plan, Risks) | Implementation Plan issue created | Triage cluster (SM orchestrates) | `implementation` |
| `implementation` | All sub-issues created + assigned (≤2 active each), tester issue created, all sub-issues merged with passing CI; feature labeled `ready-for-test` | Implementation Plan present + assignees set (staffing guard) | Scrum Master (setup) + Developer pool (execution) | `testing` |
| `testing` | Tester verdict posted with per-case evidence; failures reopened to correct sub-issues | Feature labeled `ready-for-test` | Tester | `audit` or back to `implementation` |
| `audit` | Self-Improver verdict posted: success, or a restart phase + applied improvement | Tester verdict = all pass | Self-Improver | `done` or restart to `intake`/`triage`/`implementation`/`testing` |
| `done` | Feature labeled `done`, branches cleaned, human review initiated | Self-Improver verdict = success | Scrum Master + human review | — |

Plus a **transient** phase for stalled work:

| Phase | Entry condition | Owner | Exits to |
|-------|-----------------|-------|----------|
| `blocked` | Any issue labeled `blocked` (a condition on any active phase, not a step in the flow) | Scrum Master (within SLA) | the phase it was blocked from (unblocked) |

---

## The Context Block (Script Output)

`pipeline-state.ps1` prints a block the agent reads at start. Contract:

```text
=== PIPELINE STATE ===
Phase:            <intake|triage|implementation|testing|audit|done|blocked>
Feature:          #<backlog issue number>
Phase owner:      <agent name>
Triggering event: <e.g. "Implementation Plan posted", "PR #42 merged">
Previous phase:   <phase>
Goals:            <the phase's definition-of-done — measurable outcomes>
Playbook:         <how-to for this phase — the steps the agent follows, pointer to docs>
Responsibilities: <the agent's actions in this phase — pointer to docs section>
Handoff:          <next phase + what must exist for the transition>
Validation:       <what the script checked and passed, or what is blocking entry>
Doc references:   <03-pipeline.md#..., 05-github.md#..., 06-staffing.md#...>
====================
```

### Inputs the script reads
- Issue labels (`triage`, `ready-for-dev`, `in-progress-dev`, `ready-for-test`, `testing`, `blocked`, `done`).
- Issue type (Backlog / Implementation Plan / Dev sub-issue / Tester issue) + parent references.
- Presence of referenced artifacts (Implementation Plan body sections, PRs linked, verdict comment).
- Branch/worktree existence and base.
- Comment coverage per the prefix rules.
- The dispatched agent's role (from the dispatch prompt).

### Output contract rules
- **Deterministic:** same input signals → same phase + validation result. No LLM judgment in the script.
- **Role-scoped:** the Playbook, responsibilities, and doc references in the context block are filtered to the dispatched agent's role — a Developer waking up sees developer responsibilities, not the whole pipeline.
- **Referenced, not duplicated:** the context block points at doc sections rather than restating their content, so there is exactly one authoritative definition.

---

## How Agents Consume It

1. Agent wakes (dispatched by its parent or the human).
2. Agent loads the `pipeline-state` skill (minimal loader: how to invoke the script, how to read its output).
3. Agent runs `pipeline-state.ps1` with its role → gets the context block.
4. Agent reads its Goals (what "done" means) + Playbook (how to do it), performs its work, posts the required comments (per [05-github.md](05-github.md) comment prefixes).
5. Agent completes its handoff artifact (the state script's "must exist for transition" signal) and returns.

---

## What Each Agent Reads From the State

| Agent | Reads | Uses for |
|-------|-------|----------|
| Product Owner | `intake` phase + backlog Goals | Knowing the definition of done for intake (confirmed requirements, ACs, priority) |
| Scrum Master | Current phase + which sub-issues are `blocked` + staffing Goals | Orchestration, staffing, escalation decisions |
| Triage cluster | `triage` phase + Implementation Plan Goals | Knowing exactly what a complete plan must contain |
| Developer pool | `implementation` / `blocked` / retry phase + sub-issue Goals | Knowing what to build, what's stalled, what to fix |
| Tester | `testing` phase + QA Plan Goals + merged PR list | Running the QA Plan against the right artifacts |
| Self-Improver | `audit` phase + full issue record + metrics/logs/traces | Judging completion; improving prompts/skills/scripts/references/observability; choosing restart phase |

---

## Future Build Order

1. Write `pipeline-state.ps1` first (signal reader → validator → context block printer) — it is the entire state machine.
2. Write the `pipeline-state` skill as a **minimal loader** (how to run the script, how to read the context block, what to do with it — no phase model, no transitions).
3. Add the "load skill + run script at start" instruction to each agent `.md`.
4. Wire the script into the git-operations workflow so phase transitions also update labels.

This doc and the pipeline docs are the source of truth for that build. Agent identity lives in `.opencode/agents/*.md` (the 02-agents.md catalog page is transitional and will be removed). The skill and script implement, never redefine, what is written here.
