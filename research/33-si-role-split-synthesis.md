# Research Report: SI Role Split — Synthesis (5 vs 6 roles)

**Agent:** Synthesis (of `research/28`–`research/32`)
**Date:** 2026-10-25
**Scope:** Synthesize the external evidence (`28`–`31`) and the internal SI audit (`32`) into a decision on splitting Fredo's Self-Improver: which roles, whether 5 or 6, and the sequencing. No code changes.
**Inputs:** `research/28-multi-agent-role-decomposition.md`, `29-verification-audit-separation.md`, `30-self-improving-agent-pipelines.md`, `31-agent-skill-tool-packaging.md`, `32-si-role-internal-audit.md`.

---

## Verdict

The proposed four roles — **Orchestrator · Documentator · Auditor · SelfImprover** — are a strong step but **not sufficient**. Both the external research and the internal audit converge on a **5-role minimum**: add a **Pipeline Platform** role (the pipeline's own machinery: state machine + scripts/skills + permissions + measurement).

- **4 roles fix** the biggest conflicts (C1 orchestrate-vs-audit, C4 produce-vs-narrate, C5 write-docs-vs-judge-docs) and match the strongest external consensus (orchestrator + verifier are the two best-supported separations).
- **4 roles leave unowned** the highest-privilege concerns: the referee's code (C3), the permission/sandbox map (C6), and the degenerate measurement (C9) — all *demonstrated* in `research/32`.

---

## External evidence (research/28–31)

| Role | External verdict |
|---|---|
| **Orchestrator** | Strongest-supported split (Anthropic lead agent, Magentic-One, CrewAI, AutoGen, LangGraph). Role specialization is the single biggest lever (ChatDev ablation). |
| **Auditor** | Best-evidenced *for reliability* (MAST; maker-checker). Must be independent in *information and incentive* — self-preference bias is causal (Panickssery), intrinsic self-correction fails (Huang), and auditor ≠ improver (Goodhart — Gao). |
| **Documentator** | **Weakest as a standalone agent.** Docs are better a shared *artifact/memory layer*; only a narrow mechanical precedent (CitationAgent). |
| **SelfImprover** | Real but non-standardized; justified by *cadence*. **Tool/skill authoring is a different role** (executable, testable code; higher blast radius — Voyager/AWM/DGM/STOP). |
| **Tooling/skills** | A committed, parameterized, allowlisted library is the correct pattern (Anthropic Agent Skills + MCP). The **ad-hoc write-and-execute escape hatch is the primary anti-pattern** (lethal trifecta; "agent writes AND executes code" = high risk). |

**Anti-over-splitting caution:** multi-agent ≈ 15× tokens (Anthropic); inter-agent misalignment ~30%+ of failure modes (MAST); Cognition warns multi-agent is fragile for coding. *Add a role only to remove a demonstrated failure mode.*

---

## Internal evidence (research/32)

The SI carries **8 concerns** and **10 conflicts-of-interest (C1–C10)**, notably:
- **C1** orchestrate-then-audit the same feature; **C2** author guardrails then self-grade them (**88/178 = 49% `Pending`**); **C3** owns the referee's code; **C6** broadest exec surface (`edit: allow` + `cargo*/pnpm*/node*/bun*`) while told it never touches product code; **C7** brief-composition overload (recurring SI-side root causes); **C9** audit gate near-degenerate (**76/77 pass**) with **measurement/data-capture** the real bottleneck.

The audit's recommendation: **5 roles** (add Pipeline Platform/Steward), because the 4-role split leaves the referee's code (C3) and the permission map (C6) unowned, and does not fix measurement (C9).

---

## The two options

### 5 roles
`Orchestrator · Auditor · Documentator · SelfImprover · Pipeline Platform` (the 5th owns state machine + tooling/skills + permissions + measurement).

**Pros**
- Fewest agents → least coordination overhead (MAST/Anthropic cost evidence).
- One coherent owner for "the pipeline's machinery" — no handoffs between tool-author, machine-maintainer, instrumenter.
- Simplest migration from today's single SI; fewer prompts/permission blocks.
- Matches "lowest complexity that works."

**Cons**
- Bundles **author-the-tools** with **own-the-referee + access + observability** — the highest-privilege cluster in one agent.
- **C3** (referee's code) and **C6** (broadest exec + grants permissions) stay bundled.
- **C9** (measurement) not independently owned → the loop can still self-grade its tools' effect.
- Still broad → risks relocating the SI's overload (C7) rather than fixing it.

### 6 roles
Split the 5th into **Toolsmith** (authors skills/scripts for the agents) + a **machine/measurement owner** (state machine + permissions + instrumentation).

**Pros**
- **Separation of duties is clean** — tool-author ≠ referee ≠ measurement owner → resolves **C3, C6, C9**.
- **Measurement gets an independent owner** — addresses the real bottleneck (76/77 audit signal) without self-grading.
- Distinct artifact classes get distinct verification (tools = executable/tested; machine + metrics = config/instrumentation).
- Smaller, focused scopes → less per-agent overload.
- **Toolsmith maps directly to "build skills/scripts to give our agents tools"** — and is the role whose absence caused finding #6 (tester ad-hoc scripts).

**Cons**
- One more agent → more coordination, tokens, handoffs (MAST/Anthropic cost warnings).
- More prompts, playbooks, permission blocks to maintain; more drift surface.
- The machine/measurement owner may be a **thin, bursty** role.
- Boundary-confusion risk between Toolsmith and machine-owner (both "pipeline code").
- More migration churn.

---

## Which conflicts each resolves

| Conflict | 5 roles | 6 roles |
|---|---|---|
| C1 orchestrate-vs-audit | ✅ | ✅ |
| C4 produce-vs-narrate | ✅ | ✅ |
| C5 write-docs-vs-judge-docs | ✅ | ✅ |
| C7 orchestrator overload | ✅ | ✅ |
| C2 self-graded guardrails | ⚠️ (move effectiveness to Auditor) | ✅ |
| C3 referee's code | ❌ | ✅ |
| C6 permissions/exec surface | ❌ | ✅ |
| C9 degenerate measurement | ❌ | ✅ |

---

## Final Decision (2026-10-25)

The split is **5 roles**. The proposed **Documentator was dropped**: the research found documentation-as-a-standalone-agent the weakest-supported role, and Fredo already has the shared artifact/memory layer the research recommends — **GitHub is the pipeline's memory and log (principle 5), and documenting is every agent's job**. The only distinct task — the gate-time product-doc sync — becomes a **`doc-sync` skill/script** the Orchestrator runs at the gate.

| Role | One question | Owns |
|---|---|---|
| **Orchestrator** | *Where is every work item, and what moves it forward?* | dispatch, transitions, staffing, blockers, teardown, the gate `doc-sync` |
| **Auditor** | *Was this issue actually completed — judged on the record?* | independent, read-only verdict |
| **SelfImprover** | *Did the pipeline's own rules cause this failure, and what durable lesson fixes it?* | guardrails, playbooks, references, retro curation |
| **Toolsmith** | *What reusable, vetted capability do the agents need next?* | skills + scripts for agents (incl. the tooling library) |
| **Machinist** | *Is the machine — state machine, permissions, metrics — correct and honest?* | state machine, permissions/sandbox, measurement |

**Delivery: human-led, staged (stage-by-stage), no GitHub issue.** Each stage extracts one role from the monolithic Self-Improver, cuts over the state machine, and verifies (`test-scripts.ps1` + a mini-canary).

| Stage | What | Fixes |
|---|---|---|
| **0** | Amend `principles.md` (Principle 6 → 5 roles; no Documentator) | the contract |
| 1 | **Auditor** (read-only verdict) | C1 |
| 2 | **SelfImprover** (guardrail/playbook curation) | C2 |
| 3 | **Toolsmith** (skills/scripts + the tooling library) | finding #6 |
| 4 | **Machinist** (state machine + permissions + measurement) | C3, C6, C9 |
| 5 | **Orchestrator** (rename the residual + run `doc-sync` at the gate) | C7 |

**Sequencing rationale:** Auditor first (biggest conflict C1, cleanest extraction); the SI keeps state-machine ownership through stages 1–3, then hands it to the Machinist (stage 4); the residual is renamed to Orchestrator last (stage 5). Measurement (C9) is extracted with the Machinist.

**Naming note:** the machine role is **Machinist** (scoped to the *agentic pipeline*, not the Fredo product). "Platform Engineer" and "Steward" were rejected as ambiguous/undesired.

**Governance stays external:** human-owned boundaries (`AGENTS.md`, non-permission `opencode.json`, `principles.md`) and an external gate on the state machine (`test-scripts.ps1` run outside the role it binds).
