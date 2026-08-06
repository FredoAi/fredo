# Staffing Heuristics & Guardrails

How the Self-Improver (orchestrator) converts triage estimates into headcount, how the pool is used, and the rules that keep the pipeline from degrading under pressure.

---

## Staffing Heuristic

The triage cluster estimates effort per plan sub-task (in story points). The Self-Improver converts effort to headcount using a simple rule.

**Default rule:** `1 full-stack developer ≈ 5 story points per delivery window`.

```
headcount = ceil(total_story_points / 5)
```

The triage cluster **must state the heuristic it used** in the Staffing Plan section of the Implementation Plan, so the conversion is auditable and adjustable.

### Example

| Sub-task | Effort |
|-----------|--------|
| Setup UI scaffold | 3 |
| Core event pipeline | 8 |
| Feature panel | 5 |
| **Total** | **16** |

`ceil(16 / 5) = 4` developers (default heuristic). If the pool is saturated (below), the Self-Improver reduces headcount and re-sequences — it does not over-assign.

---

## Max Parallel Tasks per Developer

Each developer may hold **at most 2 active workstreams**.

- "Active" = work committed to `spec/<N>` but not yet through testing.
- A developer picks up new work only when current work is merged or returned to the queue.
- Rationale: limiting context switching. A developer juggling 4 half-done workstreams produces worse output than one finishing 2 cleanly.

The Self-Improver enforces this when staffing and when dispatching retries.

---

## Tester Consolidation

**One accountable verdict per feature — posted on the feature issue.** There is no separate tester issue (`generate-work` was removed); the tester executes the QA Plan once on the feature's `spec/<N>` branch.

- The feature issue is the single source of truth: the tester posts its `## Tests Runs` / `## Evidence` verdict there (the plan issue is a legacy fallback).
- The tester tests the spec integration branch (`spec/<N>`) and the single spec PR (`spec/<N>` → `main`); no per-PR links are appended.
- The Tester runs the full QA Plan once the plan's checklist work is pushed (or incrementally as work lands, if the QA Plan supports staged testing).
- Rationale: per-PR testing duplicates work and fragments accountability. One feature = one accountable verdict.

---

## Escalation SLA

| Blocker | SLA | Action |
|---------|-----|--------|
| Work / issue labeled `blocked` | **4 hours** (default) | Self-Improver intervenes: assess, re-plan, or escalate |
| Repeated PR failures (same work rejected >3×) | immediate | Self-Improver escalates to human with "what we tried" summary |
| Pool saturated | continuous | Work queues; staffing re-evaluated as capacity frees |

The 4-hour SLA is a default. It is measured from the `blocked` label being applied, not from when the developer first noticed the issue — which is why labeling promptly matters.

---

## Traceability

Every design decision, change, and test result must be recorded in the issue comments.

- Design decisions → `Decision` comments on the Implementation Plan.
- Scope/plan changes → `Decision` + `Status` comments on the feature issue.
- Test results → `## Tests Runs` / `## Evidence` comments on the feature issue.
- Blockers → `Status` comment + `blocked` label on the feature issue.

No material information lives only in an agent's ephemeral context. If it isn't on the issue timeline, it didn't happen.

---

## Guardrail Summary

| Guardrail | Rule |
|-----------|------|
| Heuristic stated | Staffing Plan must cite the heuristic used |
| Headcount capped by pool | Never assign more developers than the pool can staff at 2-per-dev |
| Max 2 active workstreams/dev | No over-assignment, no context-switch thrash |
| 1 verdict per feature | Consolidated QA Plan, single accountable `## Tests Runs` verdict on the feature issue |
| 4h blocked SLA | Self-Improver acts on `blocked` within 4 hours |
| 3× retry ceiling | >3 rejections escalates to human |
| Traceability | All decisions/evidence on the issue timeline |
