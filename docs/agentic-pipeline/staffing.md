# Staffing Heuristics & Guardrails

How the Scrum Master converts triage estimates into headcount, how the pool is used, and the rules that keep the pipeline from degrading under pressure.

---

## Staffing Heuristic

The triage cluster estimates effort per sub-issue (in story points). The Scrum Master converts effort to headcount using a simple rule.

**Default rule:** `1 full-stack developer ≈ 5 story points per sprint`.

```
headcount = ceil(total_story_points / 5)
```

The triage cluster **must state the heuristic it used** in the Staffing Plan section of the Implementation Plan, so the conversion is auditable and adjustable.

### Example

| Sub-issue | Effort |
|-----------|--------|
| Setup UI scaffold | 3 |
| Core event pipeline | 8 |
| Feature panel | 5 |
| **Total** | **16** |

`ceil(16 / 5) = 4` developers (default heuristic). If the pool is saturated (below), the Scrum Master reduces headcount and re-sequences — it does not over-assign.

---

## Max Parallel Tasks per Developer

Each developer may hold **at most 2 active sub-issues**.

- "Active" = labeled `ready-for-dev` or `in-progress-dev` (assigned but not yet merged).
- A developer picks up a new sub-issue only when a current one is merged or returned to the queue.
- Rationale: limiting context switching. A developer juggling 4 half-done sub-issues produces worse output than one finishing 2 cleanly.

The Scrum Master enforces this when staffing and when dispatching retries.

---

## Tester Consolidation

**One consolidated tester issue per feature — never one per PR.**

- The tester issue is created during Implementation staffing (Phase 3a) from the QA Plan.
- The tester issue references the spec integration branch (`spec/<N>`) and the single spec PR (`spec/<N>` → `main`); no per-PR links are appended.
- The Tester runs the full QA Plan once the feature's sub-issues are merged (or incrementally as sub-issues land, if the QA Plan supports staged testing).
- Rationale: per-PR testing duplicates work and fragments accountability. One issue = one accountable verdict per feature.

---

## Escalation SLA

| Blocker | SLA | Action |
|---------|-----|--------|
| Sub-issue labeled `blocked` | **4 hours** (default) | Scrum Master intervenes: assess, re-plan, or escalate |
| Repeated PR failures (same sub-issue rejected >3×) | immediate | Scrum Master escalates to human with "what we tried" summary |
| Pool saturated | continuous | Work queues; staffing re-evaluated as capacity frees |

The 4-hour SLA is a default. It is measured from the `blocked` label being applied, not from when the developer first noticed the issue — which is why labeling promptly matters.

---

## Traceability

Every design decision, change, and test result must be recorded in the issue comments.

- Design decisions → `Decision` comments on the Implementation Plan.
- Scope/plan changes → `Decision` + `Status` comments on the affected sub-issues.
- Test results → `Evidence` comments on the tester issue.
- Blockers → `Status` comment + `blocked` label on the sub-issue.

No material information lives only in an agent's ephemeral context. If it isn't on the issue timeline, it didn't happen.

---

## Guardrail Summary

| Guardrail | Rule |
|-----------|------|
| Heuristic stated | Staffing Plan must cite the heuristic used |
| Headcount capped by pool | Never assign more developers than the pool can staff at 2-per-dev |
| Max 2 active sub-issues/dev | No over-assignment, no context-switch thrash |
| 1 tester issue per feature | Consolidated QA Plan, single accountable verdict |
| 4h blocked SLA | Scrum Master acts on `blocked` within 4 hours |
| 3× retry ceiling | >3 rejections escalates to human |
| Traceability | All decisions/evidence on the issue timeline |
