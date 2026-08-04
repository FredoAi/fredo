# State Machine Skill (Implemented as Rust Scripts)

> **Status: IMPLEMENTED** as a cross-platform `rust-script` binary: `.opencode/scripts/pipeline-state.rs` (the state machine, metrics reader, audit engine, and integrity verifier all in one). This document is the contract it implements. Agents reach it through the `pipeline-state` skill.

---

## Purpose

Agents are contextual. The same developer behaves differently mid-implementation than during a PR retry, and the Self-Improver orchestrating triage is in a different mode than one processing a blocker. Agents cannot reliably infer "where are we right now?" from raw issue text — and the pipeline needs one deterministic authority for state.

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
| **State Machine Skill** | `.opencode/skills/pipeline-state/SKILL.md` | **Minimal.** Does NOT encode the phase model, transition rules, or guard logic — those live only in the script + this doc. It carries how to *invoke* the script and *read* its output (action reference + an operational summary of the exit gates so an agent knows what a transition requires), and is loaded at agent start. |
| **State Machine Script** | `.opencode/scripts/pipeline-state.rs` | **Does all the work.** Reads real signals (issues, labels, branches, worktrees, templates, comments), computes the current phase, validates guards (prior-phase completeness), **executes the GitHub writes agents request**, appends the metric event, and prints the context block the agent consumes. |

The script is the source of truth for state logic; the skill is static glue. The agent combines both: the skill tells it *how to invoke and read* the script, and the script tells it *where it is right now*. **If the skill ever grows phase descriptions or transition rules, that is a bug** — the skill must never duplicate (and thereby drift from) the script.

---

## What the State Machine Reads and Controls

The script is the pipeline's eyes, gatekeeper, and **single writer**. It reads GitHub state, validates it, executes the writes agents request, and reports the phase context. Per [principles.md](principles.md#2-a-state-machine-gives-each-agent-its-phase-context):

| Signal | What it reads / validates |
|--------|---------------------------|
| **Issues** | Each issue's `state`, `labels`, `title`, and `body` — the raw signals it computes phase from and validates action requests against. |
| **Labels** | The label set (`triage`, `triage-plan`, `ready-for-dev`, `in-progress-dev`, `ready-for-test`, `testing`, `audit`, `blocked`, `done`) matches the true phase. Mismatch = the script reports the discrepancy rather than trusting the label. |
| **Templates** | On `create-issue`, the drafted body is validated against the PO template sections (backlog type, incl. bug-variant bodies) — the only template conformance the script enforces. `create-issue --issue-type impl-plan` with **no** `--body-file` seeds the issue body from `templates/triage-plan-template.md` (filling the title/backlog placeholders). Other bodies are drafted by agents to their templates; the script does not re-validate them. |
| **Comments** | Required comments exist per [github.md](github.md) prefixes: `Evidence` on the tester issue, `Status` on transitions. The testing exit guard scans the **tester issue** (label `testing`, resolved via the plan) for the tester's `Evidence` verdict, falling back to the feature issue only when the tester issue cannot be resolved. |
| **Prior-phase completeness** | The exit conditions of the previous phase (its Goals) are verifiably met. If not, the script blocks entry and reports what's missing. |

### Determinism rule

The state machine computes phase from **real signals only** — never from an agent's self-report. If an agent claims a phase is done but the exit conditions aren't met, the script blocks the transition. Phase transitions happen by the script updating labels, not by agent assertion.

### Single-writer rule

The state machine is the **only** thing that writes GitHub in the pipeline. Agents draft content and request actions; the script validates each request against the guards, executes it, and records the metric event. Agents read GitHub directly (viewing issues, comments, branches) but never write it. This is what makes the determinism rule enforceable: the same authority that decides state is the only one allowed to mutate state.

### Ownership: asset vs authority

The state machine is both the pipeline's referee and a pipeline asset. Two distinct relationships, kept separate:

- **Runtime authority is non-negotiable.** During a run, the state machine is the single writer and phase authority, and it applies to *every* agent — including the Self-Improver. No agent (SI included) bypasses it: no direct `gh`/`git` pipeline writes, no improvised transitions, no hand-editing state.
- **Maintenance is the Self-Improver's.** The state machine is a pipeline script, and scripts are the SI's improvement toolkit (principle 6). The SI owns the code: it fixes, hardens, and extends `pipeline-state.rs`, `pipeline.json`, this doc, and the `pipeline-state` skill. It is the only agent that edits the state machine's logic. **The principles (`principles.md`) are above the SI** — the SI follows them and never edits them; a principle-level change is proposed to the human and applied only on approval.

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
| `context` | Prints the phase context block for the dispatched agent (add `--raw` for JSON). For `self-improver` it ALSO prints the **orchestration snapshot** — linked plan #, open sub-issues, open tester issues, A2A file path, spec branch, open blockers — so the orchestrator sees what exists without re-discovering it | Issue exists |
| `create-issue` | Creates a backlog/impl-plan/sub-issue/tester issue from a drafted body file. With `--issue-type impl-plan` and **no** `--body-file`, the machine seeds the issue body from `docs/agentic-pipeline/templates/triage-plan-template.md`, filling the `<issue>`/`<title>`/`<backlog>` placeholders — each agreed section is then filled by the `triage → implementation` transition (assembles the plan from the A2A file), or repaired by the Self-Improver via `update-plan`. Otherwise the drafted body file is posted as-is | Product Owner or Self-Improver; body conforms to PO template sections (backlog/bug); valid issue type; impl-plan with no body-file seeds from the triage template |
| `triage-init` | Creates the A2A working file `.opencode/tmp/<issue>/triage.md` (ephemeral, gitignored) for triage deliberation, seeded from the triage template's per-agent `## <Agent>` sections plus a `## Discussion` section (idempotent — re-running is a no-op once the file exists). **The `intake → triage` transition auto-seeds this file** — the action is kept only as a manual fallback and is redundant with that side-effect | Self-Improver only |
| `tests-commit` | Persists the durable, reusable per-feature test suite `.opencode/tests/<feature>/` to `main` via the Contents API: `--issue <N> --feature <name>`. Every `.md` in the folder is upserted to `main` (tests are per-feature-domain and accumulate across specs, so they are NOT spec-scoped — they ride main as the regression asset). Fails if the folder is missing or holds no `.md` files | Self-Improver (auto side-effect of `triage → implementation`; shared with the Tester, who persists results after execution) |
| `update-plan` | Writes one section into an Implementation Plan issue body: `--issue <impl-plan-N> --section <agent-or-key> --body-file <draft>` replaces that `##` section (idempotent — re-running overwrites only that section; all others are untouched). Sections: `software-architect`, `ui-ux`, `qa` (agent sections) and `summary`, `staffing`, `deployment`, `risks` (SI sections). **The `triage → implementation` transition assembles the plan and fills all sections automatically** — the action is kept for edge/repair only | Self-Improver only; `--section` (one of `software-architect`/`ui-ux`/`qa`/`summary`/`staffing`/`deployment`/`risks`) + `--body-file` required |
| `transition` | Moves an issue to the next phase (updates label + status comment). `--to-phase` is optional — inferred when the phase has a single legal exit (required for `testing`/`audit`). **`--to-phase done` is refused** — `done` is reached only through `audit-record --verdict success` (which closes the issue). **Auto side-effects (idempotent) before the label change:** `intake → triage` **seeds the A2A working file** `.opencode/tmp/<issue>/triage.md` (from the triage template's per-agent sections + `## Discussion`; on an `audit → triage` restart the stale file is backed up and re-seeded fresh); entering `implementation` **assembles the Implementation Plan** (creates the seeded impl-plan issue — with the `Backlog:` line filled with the feature issue — and fills every section from the converged A2A file), **generates the work items** (`generate-work`: dev sub-issues from the plan's `- [ ]` items + the consolidated tester issue from the `### QA Plan`), **persists the QA-seeded test suites** (`tests-commit`, feature names parsed from the QA Expert's `**Feature tests:**` line), and creates the spec branch `spec/<N>`; entering `testing` opens the spec PR (`spec/<N>` → `main`); `testing → audit` merges the spec PR (blocked unless it is mergeable). A failed side-effect aborts the transition cleanly — no half-state. Posts an automatic `Status` comment recording the transition (the GitHub timeline is the log) | Self-Improver only; source phase label removed, target label added; legal transition; prior-phase exit guard passes (triage's exit guard is the convergence marker only) |
| `comment` | Posts a prefixed comment (`Decision`/`Question`/`Status`/`Evidence`) | Prefix is one of Decision/Question/Status/Evidence; `Decision` is Self-Improver only (it carries exit-guard markers); body-file provided |
| `create-worktree` | Creates a worktree **detached at the tip of the spec integration branch** `spec/<N>` (auto-resolved from the sub-issue's `Parent: Implementation Plan #N`, falling back to `main`). Path defaults to `.worktrees/<N>`. Detached worktrees allow many developers in parallel | Developer only; sub-issue labeled `ready-for-dev`/`in-progress-dev` (single-developer pipeline; no assignee required) |
| `remove-worktree` | Removes a worktree after the developer has pushed (path defaults to `.worktrees/<N>`) | Developer only; refuses dirty worktrees |
| `generate-work` | Reads the Implementation Plan issue and creates the work items: one sub-issue per `- [ ]` item under the Software Architect section's `### Sub-issue Decomposition` heading (label `ready-for-dev`, parent = plan), plus the consolidated tester issue from the QA Expert section's `### QA Plan` (label `testing` — it reads as the testing phase). **Runs automatically as a `triage → implementation` side-effect** — the manual action is redundant with the transition and kept for edge cases | Self-Improver only; refuses if sub-issues already reference the plan |
| `prune` | Removes leftover local `feat/` branches (legacy — no current code path creates them) and prunes orphaned worktrees | Self-Improver only (local-only hygiene); idempotent; never `main`/`master` or `spec/*` |
| `upload-evidence` | Commits a screenshot to `.opencode/evidence/<tester-issue>/` on the spec integration branch (Contents API) and posts an `Evidence` comment embedding `![file](github.com/<repo>/raw/spec/<N>/...)` so it renders inline for repo members even on a private repo | Tester or self-improver; `--body-file` + `--image` required; spec branch resolved from the tester issue's parent (or `--base`) and must exist |
| `close-issue` | Closes an issue to `canceled` (any non-done phase) or `done` (audit-phase features only; **dev sub-issues — body references `Parent: Implementation Plan #` — close as `done` from any phase**, so the Self-Improver closes each sub-issue after reviewing its push). The `done` path for features is normally automatic via `audit-record --verdict success` | Self-Improver only; `--to-phase done\|canceled`; `done` gated to audit-phase features or dev sub-issues; `canceled` refused for done issues |
| `block` / `unblock` | Sets/clears the `blocked` modifier with reason | Self-Improver or Developer; reason present (`block`); label toggled |
| `audit` | Prints the issue's audit bundle for the Self-Improver AND runs the integrity gate first — a tampered record is flagged before the SI judges. The bundle is the **record-anchored** evidence: recorded history (events, rework, blocked, tester Evidence, GH record) **plus linked-artifact status** (open sub-issues on the plan, spec-PR-merged) **plus a telemetry error tail** (ERROR spans, 24h, best-effort) | Issue exists |
| `audit-record` | Posts the Self-Improver's `Decision` comment (success or restart phase) AND drives the next phase automatically: `--verdict success` → `audit→done` + close as done + auto-post a final metrics summary; `--verdict restart --phase <p>` → `audit→<p>` | Self-improver only; `--verdict success\|restart`; restart phase must be a legal exit |
| `health` | Prints the pipeline health report (event/error log scan, per-agent call counts, Little's Law consistency check, **SLA-overdue blockers** flagged past the default 4h). The Little's Law check derives the **average cycle time from the event log** (implementation start → done) and flags `CHECK REQUIRED` when WIP diverges from throughput × cycle; with no completed issues it reports CONSISTENT with an "insufficient completed data" note instead of a false alarm | Read-only |
| `metrics` | Derives per-issue or aggregate pipeline metrics from the event log (`--all` for aggregate, `--json` for machine output) | Read-only |
| `verify` | Anti-tamper integrity gate: scans the event/error logs for out-of-order timestamps, duplicate event IDs, or rewrites | Read-only; exits 3 on tamper |

**Flow:**
1. Agent reads GitHub directly (context, signals, prior comments).
2. Agent drafts content to a temp file (issue body, comment body).
3. Agent runs `pipeline-state.rs --action ...` with the draft path + arguments.
4. The script validates the request against the guards → executes the write → appends the metric event → returns the result (e.g., new issue number, comment URL).
5. If a guard fails, the script returns `BLOCKED: <reason>` and the agent does not get the write.

**Why this matters:** because every GitHub write goes through the state machine, there is no way for an agent to mutate state without passing the guards — the anti-Goodhart structural guarantee from the Metrics section is enforced at the write layer, not just reported.

### Transition side-effects (the machine owns the mechanics)

The mechanical orchestration steps are now **transition internals** — deterministic side-effects the state machine executes automatically, so no agent runs them by hand:

- **`intake → triage` — A2A seed.** The machine auto-seeds the A2A working file `.opencode/tmp/<issue>/triage.md` (idempotent). The Self-Improver does NOT run `triage-init` manually.
- **`triage → implementation` — plan assembly + work generation + test persistence.** The machine (a) assembles the Implementation Plan — creates the seeded impl-plan issue from `docs/agentic-pipeline/templates/triage-plan-template.md` and fills every section (`software-architect`, `ui-ux`, `qa`, `summary`, `staffing`, `deployment`, `risks`) from the converged A2A file; (b) generates the work items — dev sub-issues from the plan's `- [ ]` items plus the consolidated tester issue from the `### QA Plan` table; (c) persists the QA-seeded test suites to `main` via `tests-commit` (feature names parsed from the QA Expert's `**Feature tests:** <name1, name2>` line in the A2A file); (d) creates the spec branch `spec/<N>`.

The triage exit guard is now **only** the convergence marker — the Implementation Plan does not need to pre-exist, the transition creates it. The manual `triage-init`, `generate-work`, `tests-commit`, and `update-plan` actions are kept for edge/repair only; the transition owns the happy path.

---

## The Phase Model

Six pipeline phases, matching [pipeline.md](pipeline.md). Each phase declares its Goals (principle 3), entry conditions, owner, and transitions.

**Metric anchors (fixed by policy):** commitment point = the Intake→Triage handoff (lead-time clock starts); delivery point = Audit→Done (cycle-time clock ends). Cycle time = Implementation entry → Done; lead time = commitment → Done. Intake/Triage count toward lead time only. See [Metrics](#metrics-the-pipelines-memory).

| Phase | Goals (definition of done) | Entry condition (signal) | Owner | Exits to |
|-------|----------------------------|--------------------------|-------|----------|
| `intake` | Backlog issue exists with the required intake sections (## Title, ## Problem / Why now, ## Intended users, ## Proposed behavior / Scope, ## Success metrics, ## Acceptance criteria, ## Out of scope, ## Priority), label `triage` | Backlog issue exists, label `triage`, required sections present (the machine does not separately enforce "no Implementation Plan" — a plan existing mid-intake is a non-issue) | Product Owner | `triage` |
| `triage` | Deliberation converged: each planner wrote its section draft and agent-tagged points in the A2A working file `.opencode/tmp/<issue>/triage.md`, no unresolved `## Discussion` items remain, and the convergence marker `Decision` comment ("Triage converged — all planner questions resolved.") is present. The Implementation Plan is auto-assembled by the `triage → implementation` transition — it does not need to pre-exist | Feature labeled `triage-plan` (transition from `intake`; the A2A file is auto-seeded) | Self-Improver (orchestrator; machine phase owner per `pipeline.json`) | `implementation` — **exit guard requires the convergence marker only (agreement gate)** |
| `implementation` | All plan sub-issues created; every sub-issue closed as `done` by the Self-Improver after reviewing its push — **zero open sub-issues is the exit signal** | Implementation Plan present (assembled by the transition); machine phase owner is `developer` (per `pipeline.json`) | Self-Improver (setup/review) + Developer pool (execution) | `testing` — **exit guard: zero open sub-issues** |
| `testing` | Tester verdict posted with per-case evidence; failures re-dispatched to correct sub-issues | Feature labeled `ready-for-test` | Tester | `audit` or back to `implementation` |
| `audit` | Self-Improver verdict posted: success, or a restart phase + applied improvement | Tester Evidence verdict present (the machine requires a verdict comment, not necessarily "all pass" — "all pass" is the Self-Improver's judgment, since a FAIL verdict routes back to implementation) | Self-Improver | `done` or restart to `intake`/`triage`/`implementation`/`testing` |
| `done` | Feature labeled `done`, branches cleaned, human review initiated | Self-Improver verdict = success | Self-Improver + human review | — |

Plus a **transient** phase for stalled work:

| Phase | Entry condition | Owner | Exits to |
|-------|-----------------|-------|----------|
| `blocked` | Any issue labeled `blocked` (a condition on any active phase, not a step in the flow) | Self-Improver (within SLA) | the phase it was blocked from (unblocked) |

**Agreement gate (triage):** leaving triage requires the convergence marker — a `Decision` comment on the feature issue containing `Triage converged — all planner questions resolved.` The `transition` action refuses `triage → implementation` while the marker is absent. The marker is posted by the Self-Improver once the planners converge — no unresolved items remain in the `## Discussion` section of the A2A working file `.opencode/tmp/<issue>/triage.md`. The Implementation Plan does not need to pre-exist: the `triage → implementation` transition assembles it (creates the seeded impl-plan issue and fills every section from the converged A2A file), generates the work items, persists the test suites, and creates the spec branch.

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
Doc references:   <pipeline.md#..., github.md#..., staffing.md#...>
--- (self-improver only: orchestration snapshot) ---
Impl plan:        <plan # or "none">
Open sub-issues:  <count of open sub-issues referencing the plan>
Open tester issues: <count of open testing-labeled issues>
A2A file:         <.opencode/tmp/<issue>/triage.md or "none">
Spec branch:      <spec/<N> or "absent">
Open blocked:     <count of open blocked issues>
====================
```

### Inputs the script reads
- Issue `state`, `labels`, `title`, `body`.
- Comments on the issue, checked against the prefix rules ([github.md](github.md)).
- The dispatched agent's role (from the dispatch prompt).

### Output contract rules
- **Deterministic:** same input signals → same phase + validation result. No LLM judgment in the script.
- **Role-scoped:** the Playbook in the context block is filtered to the dispatched agent's role — a Developer waking up sees the Developer playbook, not the orchestrator's. The other fields (goals, responsibilities, doc references) are the same generic text for every agent.
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

### Event schema (one JSONL line per emitted event; a single action call may append several events)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ts` | string RFC 3339 UTC | yes | time the event occurred |
| `event_id` | string UUID | yes | unique event id |
| `event_name` | string enum | yes | the action emitted: `state_machine.call`, `state_machine.failure`, `phase.started`, `phase.completed`, `create-issue`, `triage-init`, `assemble-plan`, `tests-commit`, `comment`, `transition`, `block`, `unblock`, `create-worktree`, `remove-worktree`, `generate-work`, `update-plan`, `close-issue`, `upload-evidence`, `audit-record`, `audit.verdict` |
| `actor` | string | yes | agent name |
| `entity` | object | yes | `{ issueId, repo? }` |
| `phase` | string | yes | pipeline phase at call time |
| `outcome` | string enum | yes | `success` / `failure` / `blocked` / `unknown` / `passed` / `failed` (`state_machine.call` emits `success` or `blocked`; `audit.verdict` emits `passed`/`failed`) |
| `attempt` | integer ≥ 1 | yes | retry ordinal of this call |
| `startTs` / `endTs` | string | not yet emitted | **designed** phase-duration anchors (see `phaseDurations`) |
| `durationMs` | integer | not yet emitted | **designed** endTs − startTs |
| `correlation_id` | string | yes | trace id linking all events of one issue |
| `sequence` | integer | not yet emitted | **designed** monotonic per-file counter |
| `attributes` | object | no | typed key-values emitted today: `validation` (context call), `from`/`to` (transition), `phase`, `reason` (block), `verdict` (audit), `closed_as` (close-issue), `action` (failure) |
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
| `phaseDurations` | ✅ implemented | per-phase elapsed from `phase.started`/`phase.completed` (emitted on create-issue and every transition) | each phase |
| `reworkCount` | ✅ implemented | # of `testing → implementation` loops | events |
| `retryCount` | ▫️ designed | per-sub-issue retries / PR rejections | events |
| `reopenCount` | ▫️ designed | done → reopened | events |
| `blockedCount` / `blockedDuration` | ✅ blockedCount / ▫️ blockedDuration | # blockers + total blocked time (excluded from cycle time) | events |
| `firstPass` | ▫️ designed | verified on first attempt, no rework | events |
| `auditVerdict` | ✅ implemented | SI: success / restart-phase + improvement | audit events |
| `agentWorkload` | ▫️ designed | calls + active time per agent per issue | events |

**B. Pipeline health — aggregated across issues (for the Self-Improver + humans)**

| Metric | Status | Definition |
|--------|--------|------------|
| `throughput` | ✅ implemented | distinct issues with recorded events ÷ the log's span (hours) — a rough activity rate, NOT a completed-per-period moving average |
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
| Self-Improver | Current phase + which sub-issues are `blocked` + staffing Goals + `audit` phase full issue record + metrics/logs/traces | Orchestration, staffing, escalation decisions; judging completion; improving prompts/skills/scripts/references/observability; choosing restart phase |
| Triage cluster | `triage` phase + Implementation Plan Goals | Knowing exactly what a complete plan must contain |
| Developer pool | `implementation` / `blocked` / retry phase + sub-issue Goals | Knowing what to build, what's stalled, what to fix |
| Tester | `testing` phase + QA Plan Goals + spec integration branch | Running the QA Plan against the right artifacts |

**Writing:** every agent requests its GitHub writes through the [Action Request API](#the-action-request-api) — the state machine validates, executes, and records. No agent writes GitHub directly.

---

## Build Status

**Implemented:** `pipeline-state.rs` (phase model, transitions, exit guards, Action API, context block, metric append, metrics readers, audit engine, health report, `verify` integrity gate) as a cross-platform `rust-script`. The `pipeline-state` skill is the loader.

**Remaining:**
1. **Agent permissions (done):** the single-writer rule is now **enforced at the config level**, not just guardrailed. `opencode.json` gives every agent a `bash` rule set that is a **default-deny allowlist** — it denies direct pipeline-write commands (`gh issue create/edit/close`, `gh pr merge/close`, `gh label create/edit/delete`, `git push origin main/master`, `git merge main/master`) and explicitly allows only read/execute operations (reads, running the state machine via `rust-script`). The one deliberate exception — the developer pushing to the **spec integration branch** (`git push` to `spec/<N>`, `main`/`master` denied) — is developer-only. Because the state machine runs `gh`/`git` *internally* inside `rust-script`, denying the agent's direct calls does not block the machine. Guardrails now live in the playbooks — the agent `.md` files carry no guardrail text, and the playbooks are the behavioral backstop.
2. **Load-skill-at-start (done):** every agent `.md` now opens with an `## Assignment` directive — get your work from the state machine and the ticket — and every playbook opens with a "Start of work" step: load the `pipeline-state` skill, run the script, read the context block before working.
3. **Label bootstrap (done):** the pipeline labels (`triage`, `triage-plan`, `ready-for-dev`, `in-progress-dev`, `ready-for-test`, `testing`, `audit`, `blocked`, `done`) are pre-created in the repo. This is the one-time exception to the single-writer rule — the state machine can't create the labels it relies on, so a human (or the pipeline owner) creates them once at setup. If one is missing, re-run: `gh label create <name> --description "<purpose>" --force`.

This doc and the pipeline docs are the source of truth. Agent identity lives in `.opencode/agents/*.md`. The skill and script implement, never redefine, what is written here.

