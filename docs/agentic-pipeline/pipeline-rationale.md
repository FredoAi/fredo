# Deterministic Context for a Stochastic Agentic Pipeline

> This document explains *why* Fredo's agentic pipeline is built the way it is — the
> deterministic state machine, how it injects context, and what the Self-Improver
> does. It's the maintainer's internal build automation, documented here so the
> design is legible to anyone who audits the repo. It isn't required reading for most
> contributors (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

## The problem

LLM agents are **stochastic**. Give the same specification to two model runs and you
can get two different plans, two different implementation choices, two different
outcomes. That's fine for loosely-defined exploration, but it is a liability when the
system is meant to produce *repeatable, auditable* work on a real codebase — the same
feature should be built the same way each time, and a failure should be explained, not
attributed to mood.

You cannot make the model deterministic. So instead of trying, Fredo makes the
**plumbing around it deterministic**, and injects that determinism into the agent as
**context**. The pipeline is deterministic; the agents remain stochastic but are
contained by, and steered by, that determinism.

## The idea in one line

> Use **deterministic control** (a state machine that owns state, transitions, and
> artifacts as the single writer) to **inject context** into each agent so the
> pipeline's *stochastic* behavior stays bounded and convergent — and use the
> Self-Improver as the feedback loop that turns each failure into a tighter
> deterministic control.

## The deterministic backbone: the state machine

The pipeline runs on a state machine (`.opencode/scripts/pipeline-state.rs`, driven
via `rust-script`) whose configuration is the **single source of truth**
(`.opencode/pipeline.json`). The machine, not any agent, owns:

- **Phases and transitions.** `backlog → planning → implementation → testing → audit
  → cleanup → done`, with explicit transitions (e.g. `testing:audit`).
- **Exit guards.** Each phase defines its "definition of done"
  (`exit_guard` in `pipeline.json`). A phase cannot be exited until its guard is met —
  so an agent can't half-finish and move on.
- **Issue state.** The state machine reads/writes GitHub labels, the issue project, and
  the per-issue event log (`.opencode/state/issues/*.jsonl`, append-only, anti-tamper).
- **The GitHub timeline as the log.** GitHub issues and comments are the durable,
  human-auditable record — `## Triage Plan`, `## Development Summary`, `## Fix Plan
  (round N)`, `## Tests Runs`, `## SI Summary` are machine-posted, machine-stamped
  artifacts.

Because the machine is the **single writer**, there is no ambiguity about "who moved
the issue" or "what state are we in" — the answer is read, not guessed. Multi-agent
races are impossible where state is centrally owned.

## Injecting determinism as context

The interesting part is not the state machine alone; it's that its determinism is
**handed to each agent up front, as context**, so the agent doesn't have to reconstruct
its situation (and reconstruct it differently each run). On dispatch, an agent gets:

- **Phase context** — what phase it is in, and that phase's `Goals` (the definition of
  done), so it knows exactly what "finished" means for this phase.
- **Its playbook** (`.opencode/agents/<role>.md` + `docs/agentic-pipeline/playbooks/*`),
  which is the codified, curated procedure for the role.
- **The A2A planning file** (`.opencode/tmp/<issue>/triage.md`) for the triage cluster —
  a shared file each planner edits once, so planning is convergent rather than
  divergent.
- **Machine-stamped round + retry reason.** The round (`(round N)`) and the retry reason
  are **derived** from the audit verdict's event log, never self-reported by the agent.
  So a restarted agent knows it is *completing missed acceptance criteria*, not
  redoing the feature or re-posting prior content.
- **Deterministic limits.** Permissions are scoped per role (`opencode.json`), and the
  playbooks/guardrails bound retries (`G-092`: no more than 3 identical tool calls),
  forbid unbounded tool loops, and route blocked tool access honestly
  (`G-102`: measurement ACs blocked by sandbox-denied verbs are classified as
  environment/tool-access, never fake-verified).

The effect: an agent can still reason stochastically, but it always starts from the
same, correct, self-describing frame. The variance is in the reasoning; the contract,
the state, and the definition of done are fixed. That is the "deterministic control
injecting context to bound stochastic behavior."

## The Self-Improver: the control loop

Determinism alone doesn't make the pipeline get *better*. The **Self-Improver** is the
feedback loop:

- It is the **orchestrator**: it dispatches the triage cluster, the developer pool, and
  the tester, and runs the state-machine transitions.
- It is the **auditor**: after testing, it posts the verdict — success, or restart from
  a chosen phase. On failure it records the **missed-AC reason** (the concrete list the
  retry will read), so the restart is a targeted completion, not a rerun.
- It **improves the root cause**. Every failure is turned into a durable control: a
  guardrail added/amended in `docs/agentic-pipeline/playbooks/references.md` (the
  `G-###` list), a playbook tightened, a skill note added, or an observability/metric
  bump. The `retro-analysis` skill and the guardrail catalog's `observed` /
  `effectiveness` entries are the evidence trail for "did this control actually work."
- It is also the **documentation owner**, syncing the product docs
  (`ARCHITECTURE.md`, `CLI_GUIDE.md`, `SETUP.md`, `SECURITY.md`, `FAQ.md`) at the gate.

So the loop is: a stochastic event (an agent failed some way) → the Self-Improver
converts it into a deterministic control (a guardrail or context rule) → the next run
inherits that control. Over many specs the pipeline's behavior converges: more of what
was once accident is now specified. That's the mechanism that makes "deterministic
control over a stochastic pipeline" an on-going process rather than a one-time design.

## Why GitHub as the backbone

The pipeline deliberately uses GitHub issues/comments as its communication backplane and
log rather than a private database. That makes the work transparent and auditable, and
it means the artifacts (plans, verdicts, evidence) live where humans already look. It
also means the pipeline itself is observable — `--action health` and the metric catalog
surface the pipeline's own state and anti-metrics.

## Trade-offs

- **It is the maintainer's system.** External contributors interact through
  Discussions, fork-and-PR, and the product docs — not through the pipeline's issues
  (which are locked because the pipeline reads issue text as trusted context).
- **Determinism has a cost.** Building a state machine, exit guards, playbooks, and
  guardrails is more up-front machinery than "just let agents work." It pays off in
  reproducibility and audibility, but it is a real authoring/maintenance burden.
- **Stochasticity is contained, not removed.** The model's variance still exists; the
  goal is that it can't drift out of the controlled frame, not that it's eliminated.

## Where things live

| Concern | Location |
|---------|----------|
| State machine script | `.opencode/scripts/pipeline-state.rs` |
| Phase/transition/label config | `.opencode/pipeline.json` |
| Agent definitions + permissions | `.opencode/agents/*`, `opencode.json` |
| Phase walkthrough | `docs/agentic-pipeline/pipeline.md` |
| Design principles | `docs/agentic-pipeline/principles.md` |
| State machine spec | `docs/agentic-pipeline/state-machine.md` |
| Guardrail catalog | `docs/agentic-pipeline/playbooks/references.md` |
| Roles | `docs/agentic-pipeline/README.md`, `docs/agentic-pipeline/playbooks/*` |
| Per-issue event log + metrics | `.opencode/state/issues/*.jsonl`; `--action health` |
