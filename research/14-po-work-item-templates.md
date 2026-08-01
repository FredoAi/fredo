# Research Report: PO Work Item Templates (GitHub/Jira/Linear)

**Agent:** Research Analyst (work item templates)
**Date:** 2026-08-01
**Scope:** GitHub issue forms, Jira stories, Linear, practitioner templates, feature vs bug, business framing

---

## Executive Summary — Top 8 Findings

1. **The work item is a contract, not a description.** Every source converges: a backlog item must let a reader answer *who it's for, what problem it solves, why it matters, what "done" looks like, and how to verify it*. GitLab's template literally instructs the four "strongly recommended" sections are "Problem to solve", "Intended users", "User experience goal", "Proposal".
2. **The "why" must be structurally forced before the "how."** Kubernetes' enhancement template has exactly two required fields: **"What would you like to be added?"** and **"Why is this needed?"**. NN/g: a problem statement *must not contain a solution*.
3. **Features and bugs need different field sets.** Bugs require expected vs actual, repro steps, environment, severity. Features require motivation/problem, scope, acceptance criteria.
4. **Acceptance criteria are the definition of "done" for the item; DoD is the definition for the increment.** GitLab separates "success metrics" (business outcomes) from "acceptance criteria" (does it work correctly) — the single most useful distinction found.
5. **Structure beats blank space.** GitHub issue forms (YAML schema with typed inputs + required validation) measurably raise issue quality. The modern trend is *structured intake forms*, not markdown templates.
6. **Prioritization belongs in structured fields, not the description.** Linear deliberately limits priority to 5 levels because "more granularity leads to diminishing returns"; RICE adds a reproducible score. A PO should capture *value signals at intake* and defer *effort estimates* to the team.
7. **Hierarchy is a first-class concern.** Jira: initiative → epic → story/task → subtask. Linear: project → issue → sub-issue. A work item should link to its epic/initiative.
8. **Templates are the tool's product, not an afterthought.** The best templates encode the *organization's definition of ready* — the INVEST checklist.

---

## Comparison of Feature-Request Templates

| Source | Fields (in order) | Strength |
|--------|-------------------|----------|
| **GitHub** (issue forms .yml) | `name`, `description`, `title`, `labels`, `assignees`, `type` + `body[]` with `validations.required` | Structured intake; required-field validation; typed inputs |
| **Kubernetes** | 1. What would you like to be added? *(required)* 2. Why is this needed? *(required)* | Minimal; forces justification; no solution |
| **GitLab** (feature proposal detailed) | Release notes → Problem to solve → Intended users → UX goal → Proposal → Permissions/Security → Documentation → Availability/Testing → **Feature Usage Metrics → What does success look like (success metrics vs AC)** → Buyer → Links | **Strongest example** — separates success metrics from AC; requires personas |
| **Jira** (Atlassian) | Summary, Description, Type, Priority, Story points, Status, Assignee, Reporter, Labels, Components, Links | Rich structured fields; hierarchy; estimation |
| **Linear** | Template carries properties (team, status, priority, assignee, project, labels, estimate, sub-issues) + description; **placeholder-text formatting** | Placeholder text forces the writer to fill each section |
| **Practitioner** (Pichler, NN/g) | Story + problem statement + 3–5 AC + INVEST | DoR gate via INVEST; user-first, solution-free framing |

**The throughline:** GitHub/Linear give the *mechanics* of structured intake; GitLab/Kubernetes/Atlassian/Pichler give the *content*. Best practice = use the mechanics to enforce the content.

---

## The Minimal Field Set Every Work Item Needs

1. **Title / Summary** — concise, searchable outcome statement
2. **Type** — bug / feature / task / epic
3. **Problem / Motivation / Why** — who's affected, the problem, why it matters
4. **Scope / What** — proposed behavior in user terms, free of implementation
5. **Acceptance criteria** — 3–5 testable conditions (checklist)
6. **Priority** — P0–P3 / High-Med-Low
7. **Status** — backlog / triage / in-progress / done
8. **Assignee & Reporter** — ownership and origin
9. **Estimate** — filled by team, not PO
10. **Parent link** — epic / initiative / project
11. **Labels** — area, stage, tier

**Feature adds:** intended users, success metrics, links/references. **Bug adds:** expected vs actual, repro steps, environment, severity, logs.

---

## Feature vs Bug Template Differences

| Dimension | Feature | Bug |
|-----------|---------|-----|
| Primary question | What opportunity/problem? | What broke? |
| The "why" | Motivation, business value, problem statement | Severity & impact |
| Description core | User story: persona + goal + benefit; scope | Expected vs actual behavior (always paired) |
| Reproduction | N/A | Steps to reproduce, frequency |
| Environment | Target users/tier/buyer | Version, OS, browser, provider, runtime |
| Evidence | Mockups, links | Logs, screenshots, repro project |
| Acceptance criteria | Central | Replaced by "what should have happened" |
| Estimation/severity | Value score at intake | Severity field |

---

## Business-Framing Best Practices

1. **Make "why" a required field placed before "how."**
2. **Write the problem as a user story with the benefit clause.**
3. **Use the 5 Ws** for the problem statement (who/what/where/when/why) + org impact + quantification.
4. **Require personas, not just roles.** Pichler: "If you don't know who your users are... you should not write any user stories."
5. **Separate "success metrics" from "acceptance criteria"** (GitLab).
6. **Ban implementation language from the why.** Atlassian: "if you're describing any part of the UI... you're missing the point."
7. **Frame at the right level:** coarse (epics) → refine to stories only when ready.

---

## Priority / Value Fields at Intake

**Capture at intake:** priority (5 levels max), RICE inputs (Reach/Impact/Confidence/Effort), category flags (MoSCoW, Impact-Effort), strategic alignment (OKR).
**Defer to team:** effort/estimate (story points), technical feasibility, test plan, buyer/tier, dependencies.

---

## Recommended PO Issue Template Structure

```
### 1. Summary (Title)
### 2. Problem to solve  [REQUIRED — "why" first, NO solutions]
### 3. Intended users
### 4. User experience goal  [REQUIRED]
### 5. Proposed behavior / Scope  [REQUIRED — "how" second]
### 6. Success metrics  [REQUIRED]
### 7. Acceptance criteria  [REQUIRED — 3-5, Given/When/Then or bullets]
### 8. Priority & value
### 9. Out of scope / constraints
### 10. Links & evidence
### (Deferred — filled by team at refinement: estimate, test approach, implementation)
```

**Bug variant:** Current behavior → Expected behavior → Steps to reproduce → Environment → Frequency → Severity → Logs/screenshots.

---

## Source List

- GitHub issue forms: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms
- Kubernetes ISSUE_TEMPLATE: https://github.com/kubernetes/kubernetes/tree/master/.github/ISSUE_TEMPLATE
- GitLab feature proposal: https://gitlab.com/gitlab-org/gitlab/-/blob/master/.gitlab/issue_templates/Feature%20proposal%20-%20detailed.md
- Atlassian user stories: https://www.atlassian.com/agile/project-management/user-stories
- Atlassian acceptance criteria: https://www.atlassian.com/work-management/project-management/acceptance-criteria
- Linear issue templates: https://linear.app/docs/issue-templates
- Linear priority: https://linear.app/docs/priority
- Roman Pichler 10 Tips: https://www.romanpichler.com/blog/10-tips-writing-good-user-stories
- NN/g Problem Statements: https://www.nngroup.com/articles/problem-statements/
- Intercom RICE: https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/
- Product School prioritization: https://productschool.com/blog/product-fundamentals/ultimate-guide-product-prioritization
