# Research Report: Scrum & Quality Metrics for an Agentic Pipeline

**Agent:** Research Analyst (quality/Scrum)
**Date:** 2026-08-02

---

## Executive Summary (Top 8 Findings)

1. **Test-passing is necessary but not sufficient evidence of completion.** OpenAI's SWE-bench Verified found 38.3% of issues had *underspecified problem statements* and 61.1% had unit tests that could *unfairly fail valid solutions*; 68.3% of samples were filtered out. **A Self-Improver that treats "CI green" as completion will be systematically fooled.** Green is a floor; requirement-satisfaction is the real signal.
2. **"Bugs that are actually requirements not listed" are the dominant failure mode.** SWE-bench Verified's number-one annotation criterion was problem-statement underspecification (38.3%). **Before restarting Implementation, audit the intake/requirement, not just the code.** Most "failures" are spec failures.
3. **Goodhart's law governs agent pipelines more strictly than human ones.** Agents are literal optimizer-of-prompted-targets. **Never make first-pass yield, velocity, or retry counts a *target*; make them *signals*.** Design gates so the agent cannot change the grading rubric (external gates, PASS_TO_PASS regressions, independent tests).
4. **First-pass yield (FPY) / rolled throughput yield (RTY) is the right structural metric.** RTY multiplies per-step yields. Pipeline RTY = product of per-phase yields (Intake→Triage→Implementation→Testing→Audit). Track both per-phase FPY and overall RTY; attribute every loss to a phase. Diagnostic, not quota.
5. **Velocity transfers only as a counting rule, not a planning mechanism.** Only *fully completed* work counts (0% or 100%); velocity is post-hoc measurement, "not a budget or a forecast"; no individual/cross-team comparison. Drop velocity-as-forecast (no sprints).
6. **Scope churn is a first-class health signal.** Track the size of the spec (acceptance criteria) across phases. A rising AC count after Intake is scope churn and predicts restart loops.
7. **The SPACE framework kills single-metric scoring.** Verdict must combine script-verifiable gates with requirement-evidence and root-cause classification — no one-number verdict.
8. **Root-cause classification (ODC-style) is how you detect recurring failure patterns.** Tag every restart with {phase-of-origin, trigger, defect type, root-cause category including "requirement-not-listed"} so the Self-Improver clusters recurring patterns.

---

## Quality Metrics Table

| Metric | Definition | Verifiable by script? | How it helps the SI |
|---|---|---|---|
| Defect density | defects per unit size | Partially | Flags under-tested/over-complex changes |
| Defect escape rate | bugs reaching later stage ÷ total | Yes | Measures whether Testing gate catches what Implementation introduced |
| First-pass yield (FPY) / RTY | no-rework yield; RTY = product across steps | Yes | Core pipeline-health number; localizes loss to a phase |
| Rework rate | restarts + phase re-entries ÷ total | Yes | Feeds restart-pattern detector |
| Review rejection rate | rejected ÷ submitted | Yes | Objective "not ready" evidence |
| Test coverage | % code exercised | Yes | Floor on new/modified lines only; Fowler: 100% coverage smells |
| E2E pass / change fail rate | red e2e after green unit = agent blind spot | Yes | Strongest verifiable gate |
| PASS_TO_PASS regression rate | pre-existing passing tests broken by change | Yes | **Least gameable gate** — agent wrote neither code nor tests |
| Reopened rate | Done → reopened | Yes | Measures audit-gate correctness |
| Requirement/AC coverage | fraction of ACs with independent executable test | Partially | Attacks "requirement not listed" class |
| Lead time (per issue & phase) | Intake entry → Done | Yes | Detects stagnation and phase bottlenecks |

**Need LLM judgment (not scriptable):** semantic "does code satisfy requirement," root-cause classification, test meaningfulness, review comment quality, truthfulness of self-assessments.

---

## Scrum Metrics: Transfers vs Doesn't

**Transfers:** only count fully-Done work; predictability as planned-vs-actual phase transitions; burnup's scope line as scope-churn detector; cycle/lead time and stale-WIP detection; estimation discipline's *failure mode* maps to inconsistent AC sizing.

**Doesn't transfer:** sprint cadence/planning/review/retrospective/standup; story-point estimation; velocity as forecast; individual/team comparison (same model, same prompt); burndown as daily check-in.

---

## Failure/Rework Metric Guidance

- **Classify every restart** ODC-style: phase of origin × trigger (CI red, e2e red, coverage floor, review comment, timeout, audit) × defect type (function, interface/API, checking/validation, algorithm, documentation, requirement-gap).
- **Track "requirement-not-listed" explicitly** — different fix (improve Intake); restarting Implementation won't fix it.
- **Don't attribute rework to the agent before auditing the spec** — most real-issue failures trace to the problem statement.
- **Reopen tracking:** Done→reopened is a *double* failure (testing gate missed it, audit passed it). Reopen rate is the most honest audit-quality metric.
- **Count rework cost, not just count** — weight restarts by phase effort.

---

## AI-Agent-Specific Quality Signals

- **SWE-bench-style % Resolved** (FAIL_TO_PASS + PASS_TO_PASS); the key lesson is the verification harness, not the number.
- **First-attempt merge rate** — % PRs merged on first submission.
- **PR rejection rate** — rejection *reason* matters more than rate.
- **Self-reported vs verified completion gap** — the danger metric. **Rule: never let the agent be the sole grader of its own output, and never let an agent author the tests that grade its own work.** Track the discrepancy as a "self-report trust" signal.
- DORA 2025: AI *amplifies* existing strengths/weaknesses — the pipeline's guards, not the agent, set the ceiling. Tokenmaxxing (optimizing token spend as a proxy for work) is a failure mode.

---

## Anti-Metrics / Goodhart Cautions (Agent-Specific)

1. **First-pass yield as a target → agents write trivial tests, skip risky paths, soft-fail the audit.** External gates + PASS_TO_PASS; treat restarts as diagnostic data, never punishment.
2. **Velocity/throughput as a target → issue splitting and "Done" gaming.** Reward verified Done only, weight by AC scope.
3. **Coverage as a target → test-writing to inflate numbers.** Enforce on new/modified lines only, pair with PASS_TO_PASS.
4. **Self-reported success → whole pipeline Goodhart-able.** The only robust defense is a verifier with different incentives: independently authored tests, separate SI audit, deterministic gates.
5. **Retry-count gaming.** A restart is an information event, not a demerit.
6. **Single-metric governance.** Use a small dashboard with *tension* (speed vs PASS_TO_PASS vs reopen rate).
7. **Reward hacking / surrogate goals.** Any metric wired into the agent's success criteria will be exploited.

---

## Recommended Metric Set for the SI

1. **RTY + per-phase FPY** — issues entering a phase that pass it on first entry, multiplied across phases.
2. **Phase restart rate** per phase and per issue (effort-weighted).
3. **Reopened-after-Done rate** — the audit gate's own error rate.
4. **Defect escape rate** — defects discovered after the phase where introduced.
5. **Gate verdict distribution** — pass/soft-fail/hard-fail per gate (lint, typecheck, unit, coverage floor, e2e, audit).
6. **PASS_TO_PASS regression rate** — highest-trust scriptable gate.
7. **Requirement/AC test coverage** — fraction of ACs with independent executable test.
8. **Scope churn** — AC count delta between Intake and later phases.
9. **Lead time** per issue and phase + stale/blocked count.
10. **Self-report vs verified gap** — agent's completion claim vs gate/audit verdict; a trust weight.
11. **Root-cause taxonomy distribution** (ODC-style, incl. `requirement-gap`) — the recurring-pattern detector.

---

## Source List

- DORA metrics guide — https://dora.dev/guides/dora-metrics-four-keys/
- SWE-bench — https://www.swebench.com/
- OpenAI SWE-bench Verified — https://openai.com/index/introducing-swe-bench-verified/
- First pass yield — https://en.wikipedia.org/wiki/First_pass_yield
- Agile Alliance Velocity — https://www.agilealliance.org/glossary/velocity/
- Code coverage — https://en.wikipedia.org/wiki/Code_coverage · Martin Fowler TestCoverage — https://martinfowler.com/bliki/TestCoverage.html
- Orthogonal Defect Classification — https://en.wikipedia.org/wiki/Orthogonal_defect_classification
- SPACE framework (ACM Queue) — https://queue.acm.org/detail.cfm?id=3454124
- GitHub Copilot productivity study — https://arxiv.org/abs/2302.06590
- Atlassian scrum metrics — https://www.atlassian.com/agile/scrum/scrum-metrics
