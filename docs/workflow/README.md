# Agentic SDD Workflow

Spec-Driven Development pipeline with multi-agent orchestration. 9 agents, 5 phases (one is a self-improvement gate), 18 scripts, 12 skills — one continuous loop from user request to shipped documentation.

---

## Master Diagram

```mermaid
flowchart TD
    U([User Request]) --> PO

    subgraph Phase1[Phase 1: Intake]
        PO[Product Owner]
        PO --> |backlog issue| BL[Backlog #N]
    end

    BL --> SA

    subgraph Phase2[Phase 2: Design]
        SA[Software Architect]
        SA --> |research| DM[Domain Model]
        SA --> |dispatch parallel| UX[UI/UX Architect]
        SA --> |dispatch parallel| QAL[QA Lead]
        UX --> |UX Design section| SA
        QAL --> |QA Plan section| SA
        SA --> |spec + capsules| SPEC[Spec Comment]
    end

    SPEC --> DEV

    subgraph Phase3[Phase 3: Implementation]
        DEV[Developer ×N] --> |draft PRs| PRS[Feature PRs]
    end

    PRS --> EL

    subgraph Phase4[Phase 4: Verification]
        EL[Engineering Lead]
        EL --> |review + merge| MERGED[Merged to spec branch]
        EL --> |dispatch| QAE[QA]
        QAE --> |e2e report| EL
    end

    EL --> SI

    subgraph IMP[Self-Improvement Gate]
        SI{Self-Improver evaluates}
        SI --> |all passed| REG[Register success + retro]
        REG --> DK[Documentation Keeper]
        DK --> |sync docs| DONE[Done]
        SI --> |failure detected| DIAG[Diagnose → classify failure]
        DIAG --> |phase restart| RESTART[Restart from optimal phase]
        DIAG --> |improvement needed| IMPROVE[Apply → POC → Validate]
        IMPROVE --> |validated| RESTART
        IMPROVE --> |failed| MUTATE[Mutate strategy]
        MUTATE --> IMPROVE
        MUTATE --> |strategies exhausted| ESCALATE[Escalate to human]
        RESTART --> Phase2
        RESTART --> Phase3
        RESTART --> Phase4
        RESTART --> Phase1
        ESCALATE --> DONE
    end
```

---

## Quick Reference: Ownership Matrix

| Agent | Question | Dispatches | Never |
|-------|----------|------------|-------|
| **Product Owner** | What are we building? | Software Architect | Read code, design architecture |
| **Software Architect** | How should we build it? | Developer, UI/UX Architect, QA Lead, Engineering Lead, Self-Improver | Write production code |
| **UI/UX Architect** | How should users experience it? | — | Write code, define architecture |
| **QA Lead** | How will we prove it works? | — | Execute tests, review code |
| **Developer** | Can I implement the approved plan? | — | Redesign architecture, touch forbidden files |
| **Engineering Lead** | Was the plan executed correctly? | Developer (retry), QA | Write code, change requirements |
| **QA** | Does the finished product work? | — | Judge architecture, write code |
| **Self-Improver** | How can we improve to complete the spec? | Documentation Keeper | Modify source code, edit opencode.json |
| **Documentation Keeper** | Is the documentation still accurate? | — | Touch source code, rewrite docs from scratch |

---

## Document Index

| File | Content |
|------|---------|
| [01-agents.md](01-agents.md) | Agent catalog: roles, permissions, models, dispatch authority, tool permissions matrix |
| [02-pipeline.md](02-pipeline.md) | Phase walkthrough: Intake → Design → Implementation → Verification → Self-Improvement Gate |
| [03-artifacts.md](03-artifacts.md) | Artifact catalog: every document/object produced in the pipeline with templates |
| [04-scripts.md](04-scripts.md) | Pipeline scripts: purpose, callers, outputs, known issues, script→phase map |
| [05-skills.md](05-skills.md) | Skills catalog: specialized instruction packs, load triggers, skill→agent matrix |
| [06-metrics.md](06-metrics.md) | Metrics, improvement validation (acceptance→attribution→improvement), IMPROVEMENTS.md lifecycle |

---

## Phase at a Glance

| Phase | Owner | Key actions | Artifact produced |
|-------|-------|-------------|-------------------|
| 1. Intake | Product Owner | Clarify → Design summary → Backlog | Backlog issue |
| 2. Design | Software Architect | Research → Consult UX+QA → Spec → Capsules | Spec, contract, capsules |
| 3. Implementation | Developer ×N | Worktree → Implement → Build → Draft PR | Feature PRs |
| 4. Verification | Engineering Lead + QA | Review → Merge → Coherence → E2E | Merged PRs, metrics, e2e report |
| **Gate** | **Self-Improver** | **Evaluate → Diagnose → Improve → POC → Validate → Restart or Escalate** | **Improvement artifacts, Retro Log, escalation report** |

---

## Improvement Loop Flow

```mermaid
flowchart TD
    P4[Phase 4 Complete] --> SI{All criteria met?}

    SI --> |yes| REG[Register success:<br/>metrics + retro log]
    REG --> DONE[Done]

    SI --> |no| CLASS{What failed?}

    CLASS --> |capsule scope/review| R3[Restart Phase 3<br/>Developer retry]
    CLASS --> |architecture/REQ gap| R2[Restart Phase 2<br/>Architect redesign]
    CLASS --> |requirements unclear| R1[Restart Phase 1<br/>Product Owner clarify]
    CLASS --> |e2e failures only| R4[Restart Phase 4<br/>QA re-test]
    CLASS --> |agent/skill/script/observability| IMP[Improvement Needed]

    IMP --> CHOOSE{Choose target + strategy}
    CHOOSE --> APPLY[Apply improvement]
    APPLY --> POC[Run POC: re-execute from target phase]
    POC --> V1{Acceptance?}
    V1 --> |no| MUTATE[Mutate strategy]
    V1 --> |yes| V2{Attribution?}
    V2 --> |no| MUTATE
    V2 --> |yes| V3{Improvement?}
    V3 --> |regressed| REVERT[Revert + mutate]
    V3 --> |improved or neutral| KEEP[Persist + document]
    KEEP --> RESTART[Restart from phase]
    MUTATE --> |same strategy < 3| APPLY
    MUTATE --> |same strategy ≥ 3, switch category| CHOOSE
    MUTATE --> |all categories exhausted| ESCALATE[Escalate to human]

    R3 --> P4
    R2 --> P4
    R1 --> P4
    R4 --> P4
    RESTART --> P4
    ESCALATE --> DONE
```

---

## Connection Map

```
Agent              Scripts              Skills               Artifacts
───────            ────────             ──────               ─────────
Product Owner  →  backlog-create       git-operations       Backlog issue
                  project-status
                  project-status

Software       →  spec-create          git-operations       Spec comment
Architect          project-status        frontend-design      Contract file
                                         telemetry-query      Capsule comments

UI/UX          →  —                    frontend-design      UX Design section
Architect                               chakra-ui-builder    Visual wireframe
                                                             (image, for QA)

QA Lead        →  —                    —                    QA Plan section

Developer      →  workspace-create     git-operations       Draft PRs
                  pr-create

Engineering    →  pr-review            git-operations       Merged PRs
Lead               project-status       dev-environment      Metrics entry
                  project-status
                  workspace-cleanup
                  retro-append

QA             →  dev-env              git-operations       E2E report
                  e2e-inject           dev-environment      (compares rendered UI
                  git-ops-comment      fredo-cli-events      against visual wireframe
                                       opencode-cli-runner   from UI/UX Architect)
                                       telemetry-query
                                       spec-test-gen

Self-Improver  →  retro-append         git-operations       Improvement records
                                       retro-analysis        Retro Log
                                       telemetry-query       Escalation report

Documentation  →  git-ops-comment      git-operations       Doc patches
Keeper                                                       Doc update summary
```
