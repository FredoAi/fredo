# Research Report: Flow & Delivery Metrics for an Agentic Pipeline (DORA + Kanban)

**Agent:** Research Analyst (flow/DORA)
**Date:** 2026-08-02

---

## Executive Summary (Top 8 Findings)

1. **DORA is now a five-metric model, not four keys.** As of 2024–2026 it splits into *Throughput* (change lead time, deployment frequency, failed deployment recovery time) and *Instability* (change fail rate, deployment rework rate). "MTTR" was renamed **Failed Deployment Recovery Time** in 2023 to exclude non-change outages.
2. **DORA's core empirical finding transfers directly to agents:** speed and stability are *correlated*, not a tradeoff — top performers win on all five metrics. An agentic pipeline that optimizes only throughput while hiding rework is optimizing the wrong thing.
3. **Lead time vs cycle time is a commitment-point boundary.** Lead time = request/commitment → delivery (customer's POV). Cycle time = work actually started → delivered (developer's POV). Cycle time is a *subset* of lead time. **You must fix the commitment point by policy or every time measurement drifts.**
4. **Lead/cycle time are distributions, not single numbers.** Use histograms + percentiles (e.g., p85 as a Service Level Expectation), never the mean alone.
5. **Little's Law (WIP = throughput × cycle time) is the master law.** Holds for any stationary queueing system regardless of distribution — including agents. Gives a free consistency check on your telemetry.
6. **Flow efficiency has an industry benchmark: 15–40% is "good," >40% exceptional** — for humans. Requires distinguishing "doing" states from "waiting/queue" states; blocked time counts as inactive. For agents this definition needs rework.
7. **Blocked ≠ waiting.** Waiting (queue states) is normal flow; blocked is *prevented from progressing by unforeseen circumstances*. Blocked time tracked separately with reason/owner/category; still counts toward WIP.
8. **Goodhart is the #1 design constraint.** DORA explicitly lists "setting metrics as a goal" as a pitfall, and GetDX warns AI code-generation metrics are *particularly* gameable. In an agentic pipeline the state machine *is* the instrumentation, so the gameable surface is the state transitions themselves.

---

## DORA Metrics Table

| Metric | DORA definition | Relevant to agentic pipeline? | Why |
|---|---|---|---|
| Change lead time | commit → deployed in production | **Yes — adapt** | Analog to "Implementation → Done"; if delivery = merged PR, define the delivery point explicitly |
| Deployment frequency | deployments per period | **Conditionally** | Only if pipeline deploys; else replace with "issues completed per period" (throughput) |
| Failed deployment recovery time (was MTTR) | time to recover from a failed deployment | **Yes — adapt** | Analog = "Audit-failed → back to Done" time; scope to your own pipeline's failures |
| Change fail rate | deployments requiring immediate intervention | **Yes — adapt** | Analog = fraction of issues that fail Audit and loop back to Implementation |
| Deployment rework rate | unplanned work from production incident (added 2024) | **Yes — adapt** | Analog = rework/loop-backs and abandoned-then-reopened issues |

**Key caveats:** speed and stability correlated for top performers; don't set metric targets as goals (Goodhart); use several metrics with healthy tension.

---

## Cycle Time vs Lead Time — Precise Definitions

- **Lead time:** "time between a customer request and the actual delivery" — user's POV; includes non-working time.
- **Cycle time:** "total elapsed time from the start of a particular activity/work item to its completion" — developer's POV; card enters *In Progress* → *Done*.
- **Commitment point:** the moment the team *commits* to delivering — when the lead-time clock starts. Before commitment the item is an *option*.
- **Delivery point:** when the work item is released to the customer (the *Done* state).
- **Relationship:** `cycle time = lead time − (commitment → actually starting)`.
- **Little's Law:** `L = λW` — use to validate telemetry (if WIP, throughput, cycle time disagree, event recording is broken).

**Pipeline takeaway:** record two timestamps per issue — `committedAt` (Intake→Triage handoff, fixed by policy) and `doneAt` (Audit→Done). Lead time = doneAt − committedAt; cycle time = doneAt − startedAt (Implementation entry).

---

## Flow Metrics

- **CFD:** area graph where each band is *cumulative* count of items in a state over time. Reveals WIP (band thickness), cycle time (horizontal distance), throughput (slope of Done line), bottlenecks (widening bands). Data must be cumulative — downward slope = wrong recording.
- **Aging WIP:** per-item time-in-state for in-flight items; flag items exceeding p85 and the state where they age.
- **Throughput:** items completed per period; trend over time; only comparable across items of roughly equal effort.
- **Flow efficiency:** active (value-added) time ÷ total lead time. Industry benchmark 15–40% good, >40% exceptional (humans). Requires explicit In-Progress vs Queue states.
- **Blocked time:** blocked ≠ waiting; track reason, cause category, owner, dates, total blocked time; blocker clustering for systemic root causes.

---

## Which Metrics Transfer to an AI Pipeline

**Transfers cleanly (gets more precise):**
- Cycle time / lead time per state — state machine produces exact timestamps with zero self-reporting bias
- Throughput, WIP, Little's Law — pipeline is literally a queueing system
- CFD and aging WIP — state-transition counts are exactly the input needed
- Blocked time — agents don't self-escalate well, so this is *more* important
- Rework / change-fail-rate analogs — Audit→Implementation loop-backs precisely measurable

**Transfers with redefinition:**
- Flow efficiency — redefine numerator as agent work actually performed (steps/tokens in working states) rather than wall-clock
- DORA change lead time / deployment frequency — only if pipeline deploys; else "issues completed per period"
- Failed deployment recovery time — scope to pipeline-originated failures

**Does not transfer (human-only):**
- Self-reported measures (perceived productivity, well-being, DX surveys)
- MTTR for external outages
- Team-morale-adjacent metrics (context-switching penalty for human cognition)

---

## Anti-Metrics / Goodhart Cautions

1. **Setting metrics as targets** — DORA's #1 pitfall. Use metrics for learning/steering, never as agent rewards.
2. **State-flipping gaming (pipeline-specific)** — the highest-risk gaming surface is the state transitions themselves. Guard against: moving to Done prematurely, re-entering states to reset timers, backdating "committed" timestamps, splitting issues to inflate throughput. **Mitigation:** policy-enforced transitions (no skipped states), locked commitment point, monotonic append-only event log, record who/what requested each transition.
3. **Commitment-point drift** — lead time shrinks because the clock starts later, not delivery got faster.
4. **Throughput inflation via task-splitting** — pair throughput with cycle time, flow efficiency, and a size/quality dimension.
5. **Change-fail-rate gaming** — teams that stop shipping risky-but-valuable changes look great on fail rate.
6. **"One metric to rule them all"** — use a small correlated set with built-in tension.
7. **Reward hacking / surrogation** — if you reward the agent for low cycle time, it will optimize the number, not the work.

---

## Recommended Metric Set for the Agentic Pipeline

1. **Stage cycle time (distribution)** — per-stage median + p85 for each transition. Locate the bottleneck stage.
2. **Total cycle time** (Impl-start → Done) and **total lead time** (committedAt → Done). Track p85 as Service-Level Expectation.
3. **Throughput per period** — issues reaching Done per day/week, moving average, paired with a work-item-size proxy.
4. **WIP + Little's Law consistency check** — verify `WIP ≈ throughput × avg cycle time` to catch telemetry corruption.
5. **Cumulative Flow Diagram per stage** — widening bands flag growing queues.
6. **Aging WIP** — items exceeding p85, grouped by stuck stage.
7. **Flow efficiency (redefined for agents)** — active agent-work in Implementation+Testing ÷ total lead time; use for *trend*, not absolute target.
8. **Blocked time (separate channel)** — blocked flag with reason/category/owner; total blocked %; blocked time per cause cluster.
9. **Rework / change-fail-rate analog** — fraction of issues looping back (Audit→Implementation) + abandoned-then-reopened.
10. **Recovery time analog** — time from Audit-failure to Done, plus average rework loops per issue.
11. **Audit pass rate** — % of issues passing Audit first attempt. The quality counterweight to throughput.
12. **State-transition integrity guardrails** — no skipped/illegal transitions; monotonic timestamps; locked commitment point; no metric-based rewards. The anti-Goodhart layer.

---

## Source List

- DORA metrics guide — https://dora.dev/guides/dora-metrics-four-keys/
- DORA metrics history — https://dora.dev/insights/dora-metrics-history/
- DORA measurement frameworks — https://dora.dev/insights/measurement-frameworks/
- Wikipedia Lead time — https://en.wikipedia.org/wiki/Lead_time
- Wikipedia Cycle time — https://en.wikipedia.org/wiki/Cycle_time
- Wikipedia Cumulative Flow Diagram — https://en.wikipedia.org/wiki/Cumulative_flow_diagram
- Wikipedia Little's law — https://en.wikipedia.org/wiki/Little%27s_law
- Wikipedia Goodhart's law — https://en.wikipedia.org/wiki/Goodhart%27s_law
- Agile Alliance Lead Time — https://www.agilealliance.org/glossary/lead-time/
- Kanban Zone flow metrics — https://kanbanzone.com/resources/kanban/measure-manage-flow-kanban-metrics/
- Kanban Zone flow efficiency — https://kanbanzone.com/flow-efficiency/
- Nave lead vs cycle — https://getnave.com/blog/lead-time-vs-cycle-time-in-kanban/
- Nave flow efficiency fundamentals — https://getnave.com/blog/accurate-flow-efficiency-calculation/
- Nave blocked work — https://getnave.com/blog/blocked-work-in-kanban/
- GetDX AI measurement — https://getdx.com/research/measuring-ai-code-assistants-and-agents
