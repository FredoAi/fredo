# Research Report: State Machines for an AI-Coded Agile Pipeline — Design Theory Survey

**Agent:** Research Analyst (design theory survey)
**Date:** 2026-07-31
**Scope:** Harel/UML statecharts, workflow engines (AWS Step Functions, Temporal, Camunda BPMN/CMMN, Airflow), GitHub-native models, agentic-AI orchestration (CFSM, CoALA, MetaGPT, LangGraph, OpenAI Agents SDK)
**Model evaluated:** `intake → triage → staffing → implementation → testing → done`, plus a transient `blocked` state, driven by GitHub signals with phase exit-condition validation and AI context injection.

---

## Executive Summary (Top 8 Findings)

1. **A flat FSM is the right tool here, not a statechart.** The proposed model is a linear phase pipeline with ~7 states — exactly the "small, well-specified state space" where classic FSMs are documented to be effective. Harel statecharts (hierarchy, orthogonal regions, history) buy their power from *factoring shared behavior across many states*; a 7-state linear pipeline has nothing to factor. The only place hierarchy/concurrency earns its keep is the `blocked` axis, which is best modeled as an orthogonal status, not a phase.

2. **The model is missing terminal states.** `done` alone is not enough. Every mature executor models *failure/cancellation/skip* as distinct, explicit terminal states: Airflow's `success`/`failed`/`skipped`/`removed`, AWS Step Functions' `Succeed`/`Fail`, GitHub Actions conclusions (`success`, `failure`, `cancelled`, `timed_out`, `skipped`, `action_required`, `stale`). Without `cancelled`/`abandoned`/`wontfix`/`merged`, stories that should die become permanent zombies in the pipeline.

3. **`blocked` must have a hard exit or it silently becomes a terminal state.** Mature systems never leave a waiting state unbounded: Airflow's `deferred`/`up_for_reschedule` are paired with triggers and `timeout`; BPMN models waiting as *intermediate catch events* that *must* be resumed or timed out; CMMN puts waiting plan items in `AVAILABLE` guarded by sentries. A `blocked` state with no timeout, no unblock signal, and no owner is a stuck state.

4. **Exit-condition guards are the single most important design decision, and the evidence strongly supports them.** "A phase cannot leave until its goals are met" is precisely CMMN *exit criteria + sentries*, Airflow *trigger rules*, GitHub Actions `if:` conditions, and agile *Definition of Done*. For AI coding, the strongest evidence is MetaGPT: naive LLM chaining produces "cascading hallucinations… logic inconsistencies"; encoding SOPs with **intermediate result verification** reduces errors. Exit-condition gates are that intermediate verification.

5. **A strict FSM helps AI agents when the state space is small and well-specified — and the papers confirm it.** Codified FSMs beat prompting-based baselines for LLM behavioral consistency; their documented weakness is *adaptation to open-ended semantic space*, which is not your problem — a 6-phase agile pipeline is closed and well-specified. Codified Profiles show explicit control structure buys *persistence*, *updatability* (debuggable logic vs. prompt soup), and offloads reasoning so weaker models perform well. MetaGPT's SOPs directly reduce cascading errors in *multi-agent coding*.

6. **Determinism is a feature, not a constraint — as long as you respect the boundary.** Temporal's core doctrine: workflow code must make the *same decision given the same recorded history*; all I/O (API calls, DB queries, **LLM invocations**) belongs in Activities, not in transition logic. Your state machine should decide transitions from a pure function of observable GitHub state, and treat any LLM judgment as a queried Activity, not as embedded transition logic.

7. **The model's granularity is right (phase-level, not step-level).** A state per agent tool-call over-constrains (defeats the point of agents); a two-state model gives no guards or visibility. Six phases plus one transient status is a defensible middle. Keep it coarse.

8. **Two design gaps to close before shipping: rework/back-edges and timeouts.** A strictly linear progression with no `testing → implementation` rollback forces either (a) infinite phase-cycling or (b) treating rework as a *self-transition* inside a phase — which is the clean choice for a "loop until ACs pass" pipeline. And every phase needs a staleness mechanism so "not yet done" is distinguishable from "stuck."

---

## 1. State Machine Design Principles (CS theory + practice)

**Definitions.** An FSM is a tuple `(Q, Σ, δ, q0, F)`: finite states, input symbols, transition function, initial state, accepting/final states. Two classical output models: **Mealy** (outputs on transitions) and **Moore** (outputs on states); UML state machines combine both via entry/exit actions.

**Core principles that transfer to a workflow driver:**

- **State = a qualitative behavior mode, not a processing stage.** A state "is an efficient way of specifying a behavior, rather than a stage of processing"; flowchart nodes are *activities*, and mistaking activities for states is a classic modeling error ("A command is not a state"). For a workflow this is softened — phases *are* stages — but the principle still bites: don't create a state for every activity inside a phase.
- **Deterministic transitions.** "Each combination of state and event always points to the same next state." Determinism is what makes state machines testable.
- **Run-to-completion (RTC).** Events are processed one at a time, atomically, with no well-defined intermediate state. For a script driving GitHub: one signal ingestion → one guarded decision → one transition, never interleaved.
- **Extended state.** The "whole state" is (state variable) + (extended state variables). This prevents *state explosion*: an assignee name is an extended variable, not a new state. Your pipeline's assignee, PR URL, timestamps, and "which goals are met" are extended state.
- **Guards.** Boolean expressions over extended state + event parameters that *enable or disable* a transition; guard evaluation must be side-effect free.
- **Entry/exit actions.** State-scoped, guaranteed init/cleanup regardless of how the state is entered or left — the workflow analog: "on entering `implementation`, set the phase label + inject context; on leaving, validate DoD and record exit." This is the mechanism that makes "injects context into AI agents" a *state guarantee*, not a caller's courtesy.
- **Event deferral.** An event that arrives in a state that can't handle it is queued until the machine enters a state that can.

**FSM vs statechart — when FSM is enough.** Flat FSMs "tend to become unmanageable, even for moderately involved systems" due to *state and transition explosion*. The proposed model has ~7 states and a handful of transitions; there is no repetition to factor, so an FSM (possibly an *extended* FSM) is appropriate, and a statechart would be overkill. **When an FSM is overkill:** fewer than ~4 states and no shared events; or no meaningful guards. **When you need statecharts:** shared transitions across many states (hierarchy), independent concurrent axes (orthogonal regions), or resumable sub-flows (history).

---

## 2. Statecharts: What Hierarchy Gives Us — and Whether This Model Needs It

Harel's statecharts (1987) add to flat FSMs: **(a) hierarchy/superstates** — substates inherit superstate transitions ("programming by difference"); **(b) orthogonal regions** — independent concurrent axes; **(c) history states** — resume a composite state's last sub-state; plus **(d) entry/exit actions, internal transitions, event deferral**.

**Does the proposed model need hierarchy?**
- **Superstates:** Only if phases gain internal structure (e.g., `implementation = {planned, coding, review}`). At 6 top-level phases with no sub-states, hierarchy adds nothing — it would *reduce* clarity.
- **Orthogonal regions:** This is where it gets interesting. Your `blocked` is not a phase in the chain — it's a *status that can apply to any phase*. Modeling it as a 7th linear state forces 6 extra (phase → blocked) and 6 (blocked → phase) transitions and destroys the "which phase is it in while blocked?" information. The statechart-correct move is an orthogonal region: `phase ∈ {intake…testing}` × `status ∈ {active, blocked, deferred}`.
- **History:** Only relevant if you resume a phase after block/abort at the *sub-phase* level. At this granularity, "return to the phase you were in" is just a variable. Not needed.

**Bottom line:** the model does not need a statechart formalism or a library — but it should *borrow the orthogonal-`blocked` idea* rather than treat `blocked` as a step in the chain. A flat extended FSM with an explicit status axis covers it.

---

## 3. Anti-Patterns Checklist — and Whether the Proposed Model Commits Any

| # | Anti-pattern | Source evidence | Committed? |
|---|---|---|---|
| 1 | **Too many states** (state explosion) | UML, statecharts.dev | **No.** 7 states. Fine. |
| 2 | **States that are really activities** (phases named after ongoing work) | UML, statecharts.dev | **Borderline.** `staffing` and `testing` are activity-flavored, but in a workflow/phase pipeline this is standard and acceptable. Just don't subdivide further. |
| 3 | **Missing terminal states** (no `cancelled`/`failed`/`abandoned`) | Step Functions, Airflow, GH Actions | **YES — commits it.** Only `done` is terminal. |
| 4 | **States with no exit** (Step Functions hard rule: every state must declare `Next` or `End`) | Step Functions | **Potential.** `blocked` as proposed has no defined unblock/timeout exit. |
| 5 | **Unguarded transitions** | UML, Step Functions, Airflow, GH Actions | **No.** The proposal's signature feature is exit-condition validation. Ensure *every* transition is guarded. |
| 6 | **Implicit states via flags** | UML | **No — the opposite.** Only 6 phases; not hiding state in booleans. |
| 7 | **Diamond/ambiguous transitions** (guards overlap) | UML | **No, if** guards are mutually exclusive per (state, event) pair. |
| 8 | **No observability / not testable** | Step Functions, stately.ai | **Not yet.** Declare the transition table as data; unit-test every triple. |
| 9 | **Zombies / stuck-running** | Airflow heartbeat-timeout reaping | **Implicit risk.** If the implementing agent dies mid-phase with no staleness check, the phase hangs. |
| 10 | **Infinite loops** (unguarded back-edges) | Step Functions, Airflow | **Risk.** "Loop until ACs pass" must be bounded (timeout → cancel/escalate). |

---

## 4. Guards / Validation on Transitions — Best Practice

Guards are what turn a drawing into a *contract*:

- **CMMN (Camunda) — the closest formal match.** CMMN distinguishes **entry criteria** (fires `AVAILABLE → ENABLED`, i.e., *when may the phase begin / Definition of Ready*) from **exit criteria** (fires `ACTIVE → TERMINATED`, i.e., *when may the phase end*). Both are **sentries**: a condition + an event. Your "phase exit conditions (goals)" are literally CMMN exit criteria; agile calls them **Definition of Done**.
- **Airflow trigger rules** — `all_success`, `one_failed`, `all_done`, etc. formalize *under what predecessor-outcome set* a task may run. Note: `all_success` cascades skips — a real gotcha for guard design when cancellation is involved.
- **GitHub Actions `if:` conditions** — arbitrary expressions gating whether a job runs; a job failing its guard is *skipped*, and skipped jobs "report Success." Lesson: **choose guard-failure semantics deliberately** (skip vs. block vs. fail) — silent success on a failed guard is a classic trap.
- **AWS Step Functions Choice states** — guards as pure data-shape matches with a required **default path**.

**Best practice distilled:**
1. Model **exit conditions per phase** (DoD) as guards on the forward transition — this is your core mechanism and it's well-supported.
2. Model **entry conditions per phase** (DoR) as separate, lighter guards: `staffing` on "triage verdict exists," `implementation` on "assignee exists + branch created," `testing` on "PR open + CI green."
3. Make guards **pure functions of observable state** — no I/O inside guard evaluation, no wall-clock inside decisions. If a guard needs judgment, expose it as a query the LLM answers *and records*, then read the record.
4. Ensure guards for the same event are **mutually exclusive** so evaluation order never matters.
5. Decide the failure mode when a guard fails: **stay in phase**, but distinguish *not-yet* (waiting) from *never-will* (blocked → escalate) via a timer.

---

## 5. Terminal States — Why They Exist and What Happens Without Them

- **Airflow Task Instance states:** `success`, `failed`, `skipped`, `removed` are **terminal**; `upstream_failed` is terminal-ish; `up_for_retry`, `deferred`, `awaiting_input`, `queued`, `running` are transient. The state diagram is a linear spine with failure/skip/defer branches off the side.
- **AWS Step Functions** requires every state to end in either a `Next`, `Succeed`, or `Fail` — terminal states are syntactically mandatory.
- **GitHub Actions** workflow-run *conclusions*: `success`, `failure`, `cancelled`, `timed_out`, `action_required`, `stale`, `skipped` — cancellation and timeout are first-class endings.
- **GitHub Issues** natively: `open` / `closed`, with `state_reason` distinguishing `completed` vs `not_planned`.

**What happens when terminal states are missing:** work items that logically terminate (rejected at triage, duplicate, superseded, wontfix) have no legal exit, so the machine *holds them forever* — consuming retries, alerts, and queue slots, and polluting metrics. This is the state-modeling equivalent of Airflow's zombie tasks.

**Guidance:**
- Adopt at least: `done`, `cancelled` (human-abandoned), `wontfix`/`superseded` (closed-not-done), and treat GitHub's native `closed` + `state_reason` as the authoritative "no longer active" signal.
- Once terminal, **no further transitions** — the machine must *reject* events targeting terminal items.
- Keep `done` distinct from `closed-not-done` for metrics and guardrail telemetry.

---

## 6. Blocked / Deferred / Waiting-on-External — How Mature Systems Model It

Every serious engine models "waiting" as a **resumable suspension, not a terminal, and never as an unbounded state:**

- **BPMN intermediate catch events** — a process *pauses* at a message/timer/conditional/signal catch and resumes when the external event correlates; there is always a concrete resume event.
- **Airflow `deferred` + `up_for_reschedule`** — a task parks itself and hands off to an external trigger; sensors get a `timeout` beyond which they *fail*.
- **CMMN `AVAILABLE`** — a plan item sits in `AVAILABLE` until its sentry's conditions are met — the canonical "not yet actionable, and here is the exact condition that will make it actionable" model.
- **UML event deferral** — events that can't be handled now are queued until a state that can handle them is entered.
- **GitHub-native**: **issue dependencies** ("blocked by / blocking") are a first-class relationship.
- **Temporal** — long-running workflows *wait* on `Signals` and `Timers`; the wait is part of the recorded Event History, so it resumes deterministically after crashes.

**Guidance:** model `blocked` as an **orthogonal status** (any phase can be marked blocked) with a mandatory 3-tuple: *reason* (label or comment), *unblock condition* (comment/`unblock:` marker or dependency resolution), and *timeout* (auto-escalate to human, or auto-cancel). If you keep `blocked` as a linear state instead, you must still provide transitions `blocked → every phase` and a timeout — otherwise it's a terminal state in disguise.

---

## 7. Agentic Pipeline Evidence — Does a Strict FSM Help Agents?

The evidence is strongly "yes" — with a granularity caveat.

- **Codified FSMs (arXiv 2602.05905)** — "traditional hand-crafted, rule-based FSMs… are effective in small, well-specified state spaces" but "struggle to adapt to the open-ended semantic space." The solution, CFSMs, codify text into explicit states/transitions and *"enforce character consistency"*, beating generic prompting baselines. Reading: **your pipeline's state space is small and well-specified, so a hand-crafted FSM is squarely in its sweet spot.** The open-ended risk lives *inside* a phase (agent behavior), not in the phase structure.
- **Codified Profiles (arXiv 2505.07705)** — explicit control structure beats prompt-appended descriptions on: **(1) Persistence** — complete, consistent execution vs. reliance on "the model's implicit reasoning"; **(2) Updatability** — systematic inspection/revision vs. "difficult to track or debug in prompt-only approaches"; **(3) Controllable Randomness**. Bonus: offloading reasoning to structure let a **1B-parameter model** do what prompting needed a much larger model to do.
- **MetaGPT (arXiv 2308.00352)** — the most directly relevant: naive chained-LLM multi-agent coding produces "logic inconsistencies due to **cascading hallucinations**"; encoding **Standardized Operating Procedures** with agents that "verify intermediate results" reduces errors. Your exit-condition gates are precisely those intermediate verifications.
- **CoALA (arXiv 2309.02427)** — the theoretical frame: agents need a *structured action space* and a *decision procedure* around memory; the FSM is your decision procedure, GitHub is the external environment, phase context is working memory.
- **LangGraph** — production practice: "low-level orchestration framework for building long-running, **stateful** agents," with durable execution, human-in-the-loop interrupts, and explicit control flow — even the most flexible agent frameworks ship a structured graph, not free text.
- **OpenAI Agents SDK** — primitives: agents, handoffs, **guardrails** ("validation of agent inputs and outputs… fail fast"). The design philosophy — *few primitives, boundaries validated, freedom inside the loop* — is the correct philosophy for your FSM: validate at phase boundaries, let the agent work freely inside.
- **Temporal** — the boundary rule: workflow code = deterministic decision logic; **LLM invocations are Activities** (I/O) whose results are recorded and replayed, never embedded in the state decision.

**Does it hurt flexibility?** Only if the FSM over-reaches into agent behavior (a state per agent step, or the FSM trying to steer individual tool calls). At phase granularity, the FSM *is* the flexibility — it gives agents bounded autonomy and guarantees the pipeline can't derail.

---

## 8. Concrete Recommendations for the Proposed Model

1. **Keep the flat, phase-level FSM. Do not reach for a statechart library.** Six linear phases is a small, well-specified space; flat + extended state is appropriate and testable. Resist adding sub-states until there is observed need.
2. **Add explicit terminal states.** Minimum set: `done`, `cancelled` (abandoned by human), `closed_not_done` (wontfix/superseded/duplicate). Model them off GitHub's native `closed` + `state_reason` so the machine and GitHub can never disagree.
3. **Promote `blocked` from a linear state to an orthogonal status axis** (`phase × status ∈ {active, blocked}`), or, if kept linear, give it a mandatory exit: reason + unblock condition + timeout with auto-escalate/cancel. Bind it to GitHub issue dependencies.
4. **Enforce the "every state has an exit" rule:** enumerate a full transition table — every state must declare either a guarded next phase, a terminal, or a timeout — and reject at runtime any (state, event) pair not in the table.
5. **Implement exit conditions as CMMN-style exit criteria per phase** (DoD gates), evaluated as side-effect-free pure functions of GitHub signals. Add light entry criteria (DoR) only where they prevent wasted agent work. Use `tracing`/logs of guard evaluations for debuggability.
6. **Model rework explicitly.** Either declare legal back-edges (e.g., `testing → implementation`) — guarded and bounded — or, better for a "loop until ACs pass" pipeline, treat rework as **staying in the phase** (a self-transition / internal activity). Declare which; never leave it implicit.
7. **Add a staleness/heartbeat mechanism per phase:** a phase that exceeds its budget without exiting is either marked blocked or auto-escalated — never left hanging.
8. **Keep transitions deterministic; put judgment in recorded queries.** If an LLM judgment is needed (triage verdict, "is this blocked?"), run it as an activity, *persist its result to a comment/label*, and have the guard read the record — never call the LLM inside transition logic.
9. **Inject phase context as an entry action.** On entering each phase, write the phase's goals/DoD into the agent's prompt; on exiting, record the verified exit conditions. This makes context injection a state guarantee and gives every transition a machine-readable audit trail.
10. **Make the machine exhaustively testable.** Declare the transition table as data and unit-test every (state × event × guard) triple. Include a test that every terminal state is truly absorbing and that `blocked` always has an exit.

---

## Source List

1. Codifying Character Logic in Role-Playing — arXiv:2505.07705 — https://arxiv.org/abs/2505.07705
2. Codified Finite-state Machines for Role-playing — arXiv:2602.05905 — https://arxiv.org/abs/2602.05905
3. UML state machine — https://en.wikipedia.org/wiki/UML_state_machine
4. AWS Step Functions: Workflow states — https://docs.aws.amazon.com/step-functions/latest/dg/concepts-states.html
5. Temporal: Workflows — https://docs.temporal.io/workflows
6. Camunda 7: Message Events — https://docs.camunda.org/manual/7.24/reference/bpmn20/events/message-events/
7. Camunda 7: CMMN Entry and Exit Criteria — https://docs.camunda.org/manual/7.24/reference/cmmn11/concepts/entry-exit-criteria/
8. Airflow 3.3: Tasks — https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html
9. GitHub Docs: Using conditions to control job execution — https://docs.github.com/en/actions/using-jobs/using-conditions-to-control-job-execution
10. Cognitive Architectures for Language Agents (CoALA) — arXiv:2309.02427 — https://arxiv.org/abs/2309.02427
11. State diagram — https://en.wikipedia.org/wiki/State_diagram
12. Stately: What are state machines and statecharts? — https://stately.ai/docs/state-machines-and-statecharts
13. MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework — arXiv:2308.00352 — https://arxiv.org/abs/2308.00352
14. GitHub Docs: Understanding GitHub Actions — https://docs.github.com/en/actions/learn-github-actions/understanding-github-actions
15. Atlassian: Definition of Done in Agile — https://www.atlassian.com/agile/project-management/definition-of-done
16. GitHub Docs: About issues — https://docs.github.com/en/issues/tracking-your-work-with-issues/about-issues
17. LangGraph — https://github.com/langchain-ai/langgraph
18. OpenAI Agents SDK — https://openai.github.io/openai-agents-python/
19. Harel, D. (1987). Statecharts — https://www.weizmann.ac.il/math/harel/sites/math.harel/files/users/user56/Statecharts.pdf
20. GitHub Docs: About single select fields — https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-single-select-fields

**Verdict note:** the highest-leverage changes are (a) terminal states, (b) a bounded `blocked` axis, and (c) explicit rework + timeout semantics. Those close the anti-pattern gaps the proposed model currently has; everything else is already well-supported by design theory and workflow-engine practice.
