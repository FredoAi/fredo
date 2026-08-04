# State Machine Skill (Implemented as Rust Scripts)

> **Status: IMPLEMENTED** as a cross-platform `rust-script` binary: `.opencode/scripts/pipeline-state.rs` (the state machine, metrics reader, audit engine, and integrity verifier all in one). This document is the contract it implements. Agents reach it through the `pipeline-state` skill.

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
| **State Machine Skill** | `.opencode/skills/pipeline-state/SKILL.md` | **Minimal.** Does NOT encode the phase model, transitions, guards, or goals. Contains only what the agent needs to *invoke* the script and *read* its output: how to run it, how to read the context block, how to request a GitHub action, what to do with the result. Loaded at agent start. |
| **State Machine Script** | `.opencode/scripts/pipeline-state.rs` | **Does all the work.** Reads real signals (issues, labels, branches, worktrees, templates, comments), computes the current phase, validates guards (prior-phase completeness), **executes the GitHub writes agents request**, appends the metric event, and prints the context block the agent consumes. |

The script is the source of truth for state logic; the skill is static glue. The agent combines both: the skill tells it *how to invoke and read* the script, and the script tells it *where it is right now*. **If the skill ever grows phase descriptions or transition rules, that is a bug** — the skill must never duplicate (and thereby drift from) the script.

---

## What the State Machine Reads and Controls

The script is the pipeline's eyes, gatekeeper, and **single writer**. It reads GitHub state, validates it, executes the writes agents request, and reports the phase context. Per [01-principles.md](01-principles.md#2-a-state-machine-gives-each-agent-its-phase-context):

| Signal | What it reads / validates |
|--------|---------------------------|
| **Issues** | Each issue's `state`, `labels`, `title`, and `body` — the raw signals it computes phase from and validates action requests against. |
| **Labels** | The label set (`triage`, `ready-for-dev`, `in-progress-dev`, `ready-for-test`, `testing`, `audit`, `blocked`, `done`) matches the true phase. Mismatch = the script reports the discrepancy rather than trusting the label. |
| **Templates** | On `create-issue`, the drafted body is validated against the PO template sections (backlog/bug) — the only template conformance the script enforces. Other bodies are drafted by agents to their templates; the script does not re-validate them. |
| **Comments** | Required comments exist per [05-github.md](05-github.md) prefixes: `Evidence` on the tester issue, `Status` on transitions. |
| **Prior-phase completeness** | The exit conditions of the previous phase (its Goals) are verifiably met. If not, the script blocks entry and reports what's missing. |

### Determinism rule

The state machine computes phase from **real signals only** — never from an agent's self-report. If an agent claims a phase is done but the exit conditions aren't met, the script blocks the transition. Phase transitions happen by the script updating labels, not by agent assertion.

### Single-writer rule

The state machine is the **only** thing that writes GitHub in the pipeline. Agents draft content and request actions; the script validates each request against the guards, executes it, and records the metric event. Agents read GitHub directly (viewing issues, comments, branches) but never write it. This is what makes the determinism rule enforceable: the same authority that decides state is the only one allowed to mutate state.

### Ownership: asset vs authority

The state machine is both the pipeline's referee and a pipeline asset. Two distinct relationships, kept separate:

- **Runtime authority is non-negotiable.** During a run, the state machine is the single writer and phase authority, and it applies to *every* agent — including the Self-Improver. No agent (SI included) bypasses it: no direct `gh`/`git` pipeline writes, no improvised transitions, no hand-editing state.
- **Maintenance is the Self-Improver's.** The state machine is a pipeline script, and scripts are the SI's improvement toolkit (principle 6). The SI owns the code: it fixes, hardens, and extends `pipeline-state.rs`, `pipeline.json`, this doc, and the `pipeline-state` skill. It is the only agent that edits the state machine's logic. **The principles (`01-principles.md`) are above the SI** — the SI follows them and never edits them; a principle-level change is proposed to the human and applied only on approval.

Three gates make the maintenance ownership safe:

1. **The referee must stay honest.** Every state-machine edit must pass `test-scripts.ps1` before it counts — a change that breaks the guards or the metrics is itself a pipeline failure.
2. **Documented in the same pass.** The change is documented in the pipeline docs in the same pass as the code.
3. **Anti-tamper line.** The SI edits the state machine's *logic* (guards, transitions, metrics, validation) — **never the record**. The event log, audit verdicts, and error log are append-only and must never be rewritten, edited, or backdated. The record is the evidence the SI judges on; editing it destroys the audit.

The runtime authority is structural, not personal: the SI can improve *how* the machine decides, never *what* it has already recorded.

---

## The Action Request API

Agents do not call `gh`/`git` for pipeline operations. Instead, the agent runs the state machine script with an **action request**; the script validates, executes, records, and returns the result.

```text
pipeline-state.rs --action <action> --issue <N> [-Arguments...]
```

| Action | What the state machine does | Guards it validates |
|--------|------------------------------|---------------------|
| `context` | Prints the phase context block for the dispatched agent (add `--raw` for JSON) | Issue exists |
| `create-issue` | Creates a backlog/impl-plan/sub-issue/tester issue from a drafted body file | Body conforms to PO template sections (backlog/bug); valid issue type |
| `transition` | Moves an issue to the next phase (updates label + status comment) | Source phase label removed, target label added; legal transition; prior-phase exit guard passes |
| `comment` | Posts a prefixed comment (`Decision`/`Question`/`Status`/`Evidence`) | Prefix is one of Decision/Question/Status/Evidence; body-file provided |
| `create-worktree` | Creates a worktree **checked out on the spec integration branch** `spec/<N>` (auto-resolved from the sub-issue's `Parent: Implementation Plan #N`, falling back to `main`). One worktree per branch at a time | Sub-issue labeled `ready-for-dev`/`in-progress-dev` (single-developer pipeline; no assignee required) |
| `remove-worktree` | Removes a worktree so the next sub-issue can create one on `spec/<N>` | Developer only; refuses dirty worktrees |
| `create-spec-branch` | Creates the spec integration branch `spec/<issue>` from `main` and pushes it to origin. All sub-issue work, testing, and evidence happens on this branch; it is never deleted | Scrum-master only; idempotent (skips if the branch already exists) |
| `merge-pr` | Merges the spec PR (`spec/<N>` → `main`) after testing passes; the integration branch always survives so evidence URLs keep rendering | PR open, `mergeStateStatus` CLEAN, CI checks green |
| `prune` | Removes local `feat/` branches already merged to `main` (or any `spec/` integration branch); prunes orphaned worktrees | Idempotent; only merged `feat/` branches; never `main`/`master` or `spec/*` |
| `upload-evidence` | Commits a screenshot to `.opencode/evidence/<tester-issue>/` on the spec integration branch (Contents API) and posts an `Evidence` comment embedding `![file](github.com/<repo>/raw/spec/<N>/...)` so it renders inline for repo members even on a private repo | Tester or scrum-master; `--body-file` + `--image` required; spec branch resolved from the tester issue's parent (or `--base`) and must exist |
| `close-issue` | Closes an issue to `done` or `canceled` | `done` requires current phase = audit + audit verdict; `canceled` any non-done phase |
| `block` / `unblock` | Sets/clears the `blocked` modifier with reason | Reason present (`block`); label toggled |
| `audit` | Prints the issue's audit bundle (full recorded history) for the Self-Improver | Issue exists |
| `audit-record` | Posts the Self-Improver's `Decision` comment (success or restart phase) AND records the `audit.verdict` metric event | Self-improver only; `--verdict success\|restart` |
| `health` | Prints the pipeline health report (event/error log scan, per-agent call counts) | Read-only |
| `metrics` | Derives per-issue or aggregate pipeline metrics from the event log (`--all` for aggregate, `--json` for machine output) | Read-only |
| `verify` | Anti-tamper integrity gate: scans the event/error logs for out-of-order timestamps, duplicate event IDs, or rewrites | Read-only; exits 3 on tamper |

**Flow:**
1. Agent reads GitHub directly (context, signals, prior comments).
2. Agent drafts content to a temp file (issue body, comment body).
3. Agent runs `pipeline-state.rs --action ...` with the draft path + arguments.
4. The script validates the request against the guards → executes the write → appends the metric event → returns the result (e.g., new issue number, comment URL).
5. If a guard fails, the script returns `BLOCKED: <reason>` and the agent does not get the write.

**Why this matters:** because every GitHub write goes through the state machine, there is no way for an agent to mutate state without passing the guards — the anti-Goodhart structural guarantee from the Metrics section is enforced at the write layer, not just reported.

---

## The Phase Model

Six pipeline phases, matching [03-pipeline.md](03-pipeline.md). Each phase declares its Goals (principle 3), entry conditions, owner, and transitions.

**Metric anchors (fixed by policy):** commitment point = the Intake→Triage handoff (lead-time clock starts); delivery point = Audit→Done (cycle-time clock ends). Cycle time = Implementation entry → Done; lead time = commitment → Done. Intake/Triage count toward lead time only. See [Metrics](#metrics-the-pipelines-memory).

| Phase | Goals (definition of done) | Entry condition (signal) | Owner | Exits to |
|-------|----------------------------|--------------------------|-------|----------|
| `intake` | Backlog issue exists with confirmed requirements, Gherkin ACs, priority, label `triage` | Backlog issue exists, label `triage`, no Implementation Plan | Product Owner | `triage` |
| `triage` | Implementation Plan issue posted with all required sections (Summary, Scope, Staffing Plan, Design, API contracts, QA Plan, Risks) | Implementation Plan issue created | Triage cluster (SM orchestrates) | `implementation` |
| `implementation` | All sub-issues created + assigned (≤2 active each), tester issue created, all sub-issues merged with passing CI; feature labeled `ready-for-test` | Implementation Plan present + sub-issues staffed (staffing guard) | Scrum Master (setup) + Developer pool (execution) | `testing` |
| `testing` | Tester verdict posted with per-case evidence; failures reopened to correct sub-issues | Feature labeled `ready-for-test` | Tester | `audit` or back to `implementation` |
| `audit` | Self-Improver verdict posted: success, or a restart phase + applied improvement | Tester verdict = all pass | Self-Improver | `done` or restart to `intake`/`triage`/`implementation`/`testing` |
| `done` | Feature labeled `done`, branches cleaned, human review initiated | Self-Improver verdict = success | Scrum Master + human review | — |

Plus a **transient** phase for stalled work:

| Phase | Entry condition | Owner | Exits to |
|-------|-----------------|-------|----------|
| `blocked` | Any issue labeled `blocked` (a condition on any active phase, not a step in the flow) | Scrum Master (within SLA) | the phase it was blocked from (unblocked) |

---

## The Context Block (Script Output)

`pipeline-state.rs` prints a block the agent reads at start. Contract:

```text
=== PIPELINE STATE ===
Phase:            <intake|triage|implementation|testing|audit|done>
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
- Issue `state`, `labels`, `title`, `body`.
- Comments on the issue, checked against the prefix rules ([05-github.md](05-github.md)).
- The dispatched agent's role (from the dispatch prompt).

### Output contract rules
- **Deterministic:** same input signals → same phase + validation result. No LLM judgment in the script.
- **Role-scoped:** the Playbook, responsibilities, and doc references in the context block are filtered to the dispatched agent's role — a Developer waking up sees developer responsibilities, not the whole pipeline.
- **Referenced, not duplicated:** the context block points at doc sections rather than restating their content, so there is exactly one authoritative definition.

---

## How Agents Consume It

1. Agent wakes (dispatched by its parent or the human).
2. Agent loads the `pipeline-state` skill (minimal loader: how to invoke the script, how to read its output, how to request a GitHub action).
3. Agent runs `pipeline-state.rs` with its role → gets the context block.
4. Agent reads its Goals (what "done" means) + Playbook (how to do it), performs its work.
5. **To write GitHub** — the agent drafts content to a temp file and runs `pipeline-state.rs --action <action> --issue <N>`. The script validates the request against the guards, executes it, records the metric event, and returns the result. **The agent never calls `gh`/`git` to write.** It reads GitHub directly for context.
6. Agent completes its handoff artifact (the state script's "must exist for transition" signal) and returns.

---

## Metrics: The Pipeline's Memory

The state machine is called by **every agent on every call** — and each call is a telemetry event. Because the state machine is the choke point, it is also the pipeline's passive metrics collector: agents never think about metrics; the call itself is the measurement. This is principle 2 point 3 ("It is the pipeline's memory") made concrete, and it is what the Self-Improver audits against (principle 6).

### Storage: per-issue JSONL event log

- **Format:** JSONL (UTF-8, one JSON object per line, `\n` terminator).
- **Location:** `.opencode/state/issues/<issueNumber>.jsonl` — **one file per issue**, appended by the state machine.
- **Why per-issue files:** single-writer by construction (only the agent handling that issue calls the state machine for it → no locking, no corruption); trivial retention (delete/gzip on issue close); cross-issue queries scan many small files, which is fast at this scale.
- **Raw events are the system of record.** All metrics are **derived from the log on demand** — never stored incrementally. This is event sourcing: the log gives complete rebuild, temporal query, and replay; aggregates are caches, not truth. (Avoids the high-cardinality trap of pre-aggregating `actor × issue × phase` totals at write time.)
- **SQLite is the escape hatch, not the starting point.** If query complexity/frequency grows, import the log into SQLite as a derived read model; the JSONL stays the source of truth.

### Event schema (every state-machine call appends one line)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ts` | string RFC 3339 UTC | yes | time the event occurred |
| `event_id` | string UUID | yes | unique event id |
| `event_name` | string enum | yes | the action emitted: `state_machine.call`, `create-issue`, `comment`, `transition`, `block`, `unblock`, `create-worktree`, `remove-worktree`, `create-spec-branch`, `merge-pr`, `close-issue`, `upload-evidence`, `audit.verdict` |
| `actor` | string | yes | agent name |
| `entity` | object | yes | `{ issueId, repo? }` |
| `phase` | string | yes | pipeline phase at call time |
| `outcome` | string enum | yes | `success` / `failure` / `blocked` / `unknown` (`state_machine.call` emits `success` or `blocked`) |
| `attempt` | integer ≥ 1 | yes | retry ordinal of this call |
| `startTs` / `endTs` | string | not yet emitted | **designed** phase-duration anchors (see `phaseDurations`) |
| `durationMs` | integer | not yet emitted | **designed** endTs − startTs |
| `correlation_id` | string | yes | trace id linking all events of one issue |
| `sequence` | integer | not yet emitted | **designed** monotonic per-file counter |
| `attributes` | object | no | typed key-values: `tokensUsed`, `exitCode`, `errorType`, `model` |
| `message` | string | no | human-readable summary |

**Governance:** the state machine owns and emits the schema — identical field names/types from every emitter, add fields additively, never rewrite history. Every event carries `entity.issueId` + `correlation_id`.

### The metric catalog

All derived from the event log. Grouped by consumer.

**Status legend:** `✅ implemented` = derived today by `pipeline-state.rs` (`metrics`, `audit`, `health`); `▫️ designed` = catalogued for future derivation — the underlying events are (or will be) recorded, but the aggregate isn't computed yet. The derived set is intentionally small and honest; the catalog is the full design target.

**A. Per-issue lifecycle — what the Self-Improver audits against**

| Metric | Status | Definition | Anchor |
|--------|--------|------------|--------|
| `leadTime` | ▫️ designed | doneAt − committedAt | **commitment point = Intake→Triage handoff** (fixed by policy) |
| `cycleTime` | ▫️ designed | doneAt − startedAt | **delivery point = Audit→Done**; cycle starts at Implementation entry |
| `phaseDurations` | ▫️ designed | per-phase elapsed — requires `phase.started`/`phase.completed` events, not yet emitted | each phase |
| `reworkCount` | ✅ implemented | # of `testing → implementation` loops | events |
| `retryCount` | ▫️ designed | per-sub-issue retries / PR rejections | events |
| `reopenCount` | ▫️ designed | done → reopened | events |
| `blockedCount` / `blockedDuration` | ✅ blockedCount / ▫️ blockedDuration | # blockers + total blocked time (excluded from cycle time) | events |
| `firstPass` | ▫️ designed | verified on first attempt, no rework | events |
| `auditVerdict` | ✅ implemented | SI: success / restart-phase + improvement | audit events |
| `agentWorkload` | ▫️ designed | calls + active time per agent per issue | events |

**B. Pipeline health — aggregated across issues (for the Scrum Master + humans)**

| Metric | Status | Definition |
|--------|--------|------------|
| `throughput` | ✅ implemented | issues completed per period (moving average) |
| `avgCycleTime` / `avgLeadTime` | ▫️ designed | rolling averages, **distributions + p85**, never mean alone |
| `flowEfficiency` | ▫️ designed | active agent-work in working states ÷ total lead time (use for *trend*, not absolute target) |
| `blockedRatio` | ▫️ designed | blocked issues / total |
| `retryRate` | ▫️ designed | issues needing rework / total |
| `firstPassRate` | ▫️ designed | first-pass issues / total |
| `reopenRate` | ▫️ designed | reopened / completed |
| `staleCount` | ▫️ designed | issues idle past the SLA in a phase |
| `phaseBottlenecks` | ▫️ designed | longest avg duration phase |
| `wipConsistency` | ✅ implemented | Little's Law check: WIP ≈ throughput × avg cycle time — flags broken telemetry |

**C. Agent economics — cost/perf tuning (where agentic pipelines differ from human teams)**

| Metric | Status | Definition |
|--------|--------|------------|
| `tokensPerIssue` / `tokensPerAgent` | ▫️ designed | token cost per issue/agent (OTel `gen_ai.usage.*` naming) |
| `costPerDoneFeature` | ▫️ designed | tokens × price per completed issue — **the primary economics number** |
| `reasoningTokenShare` | ▫️ designed | thinking tokens ÷ total |
| `contextUtilization` | ▫️ designed | peak context ÷ window; alarm > ~70% (context rot) |
| `callsPerAgent` | ✅ implemented | agent invocation count |
| `toolCallSuccessRate` | ▫️ designed | per-agent tool-call success |
| `reworkShare` | ▫️ designed | retry-loop tokens ÷ feature total |

**D. Quality & honesty — the anti-Goodhart guardrail layer**

| Metric | Status | Definition |
|--------|--------|------------|
| `stateMachineDecision` | ✅ implemented | allowed vs blocked (guard failed) — the honesty + quality barometer |
| `verifiedCompletionRate` | ▫️ designed | agent claims corroborated by exit-guard evidence (CI green, `Evidence` comment, merged PR) — the agent-honesty score |
| `testMutationFlag` | ▫️ designed | agent modified test files outside scope — zero-tolerance alarm |
| `selfReportVsEvidence` | ▫️ designed | discrepancy between agent's claimed completion and gate verdict |
| `auditPassRate` | ▫️ designed | % passing Audit first attempt — the quality counterweight to throughput |
| `reopenRate` | ▫️ designed | audit-gate's own error rate (done → reopened) |
| `rootCause` | ▫️ designed | SI's failure classification per restart (phase-of-origin × trigger × defect type, incl. `requirement-gap`) |

### Anti-metrics — what we deliberately do NOT track

From the Goodhart research. These are signals, never targets, and never agent rewards:

- **First-pass rate / cycle time as a target** — optimizing them invites trivial tests and state-gaming. They are diagnostics.
- **Raw token minimization** — token spend explains ~80% of agent success; cutting it cuts solves. Track `costPerDoneFeature`, never tokens alone.
- **Velocity / raw issue counts** — no sprints; counting raw issues invites splitting to inflate throughput. Count verified-Done only, weight by AC scope.
- **Metrics as agent performance evaluation** — explicitly frame all metrics as pipeline-health/self-improvement inputs, never as agent performance reviews (malicious-compliance risk).

### Structural integrity guardrails (the anti-Goodhart layer)

- No skipped/illegal phase transitions (policy-enforced).
- Timestamps monotonic, RFC 3339 UTC, commitment point locked by policy.
- Append-only event log — history can never be rewritten or backdated.
- Record who/what requested each transition.
- Independent verification: QA-Expert-authored tests executed by the Tester, never agent-authored tests grading agent work.

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

**Writing:** every agent requests its GitHub writes through the [Action Request API](#the-action-request-api) — the state machine validates, executes, and records. No agent writes GitHub directly.

---

## Build Status

**Implemented:** `pipeline-state.rs` (phase model, transitions, exit guards, Action API, context block, metric append, metrics readers, audit engine, health report, `verify` integrity gate) as a cross-platform `rust-script`. The `pipeline-state` skill is the loader.

**Remaining:**
1. **Agent permissions (done):** the single-writer rule is now **enforced at the config level**, not just guardrailed. `opencode.json` gives every agent a `bash` rule set that is a **default-deny allowlist** — it denies direct pipeline-write commands (`gh issue create/edit/close`, `gh pr merge/close`, `gh label create/edit/delete`, `git push origin main/master`, `git merge main/master`) and explicitly allows only read/execute operations (reads, running the state machine via `rust-script`). The one deliberate exception — the developer pushing to the **spec integration branch** (`git push` to `spec/<N>`, `main`/`master` denied) — is developer-only. Because the state machine runs `gh`/`git` *internally* inside `rust-script`, denying the agent's direct calls does not block the machine. The guardrail text in each agent `.md` remains as the behavioral backstop.
2. **Load-skill-at-start (done):** every agent `.md` and playbook now opens with a "Start of work" step — load the `pipeline-state` skill, run the script, read the context block before working.
3. **Label bootstrap (done):** the pipeline labels (`triage`, `ready-for-dev`, `in-progress-dev`, `ready-for-test`, `testing`, `audit`, `blocked`, `done`) are pre-created in the repo. This is the one-time exception to the single-writer rule — the state machine can't create the labels it relies on, so a human (or the pipeline owner) creates them once at setup. If one is missing, re-run: `gh label create <name> --description "<purpose>" --force`.

This doc and the pipeline docs are the source of truth. Agent identity lives in `.opencode/agents/*.md` (the 02-agents.md catalog page is transitional and will be removed). The skill and script implement, never redefine, what is written here.

