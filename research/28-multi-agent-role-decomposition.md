# Research Report: Multi-Agent Role Decomposition for Agentic Pipelines

**Agent:** Research Analyst (external literature + community/framework sources)
**Date:** 2026-10-25
**Scope:** How established multi-agent / agentic systems decompose ROLES — especially for software engineering and long-running autonomous pipelines. What role separations are standard, and what is the evidence for/against each? Informs a proposed split of Fredo's Self-Improver into Orchestrator / Documentator / Auditor / SelfImprover (+ candidates).
**Method:** Primary scientific papers (MetaGPT, ChatDev, AutoGen, AgentVerse, MAST, Magentic-One, Agent Laboratory, surveys) + framework/vendor docs (CrewAI, LangGraph, OpenAI Agents SDK, Semantic Kernel, Azure Architecture Center) + community practitioner threads (Anthropic, Cognition, Hacker News).

---

## Executive Summary

- **Role specialization is the single most reliable lever in software-agent frameworks.** ChatDev's largest ablation drop came from removing role assignments (executability 0.88 → 0.58, quality 0.40 → 0.22) — larger than removing any phase or mechanism. MetaGPT's role ablation shows monotonic gains from adding Product/Architect/Project roles over Engineer alone (executability 1.0 → 4.0; human revisions 10 → 2.5).
- **The canonical software-engineering role set is:** planner/architect + manager/orchestrator + worker/executor + verifier + (optionally) documenter. MetaGPT = Product Manager, Architect, Project Manager, Engineer, QA Engineer; ChatDev = CEO/CTO/CPO + Programmer + Reviewer + Tester; Agent Laboratory = PhD student, postdoc, ML engineer, professor across literature-review → experimentation → report-writing.
- **Orchestration is almost universally a distinct role.** Anthropic's production Research system uses a lead "orchestrator" that spawns parallel subagents; Microsoft's Magentic-One uses a dedicated Orchestrator that plans, tracks progress, and re-plans via a task ledger; CrewAI and AutoGen both ship a dedicated manager agent.
- **Verification/audit is the best-evidenced separation for reliability.** MAST (1,642 annotated traces) makes "Task Verification" one of three top-level failure categories; explicit verifiers reduce total failures, and adding a high-level verification step to ChatDev gave +15.6% task success. The standard pattern name is "maker-checker" / "generator-verifier" / "evaluator-optimizer".
- **Documentation as a standalone *agent* has weak support; documentation as a shared *artifact* has strong support.** Documentation is usually the communication medium (MetaGPT's structured docs replace chat) or a shared store, not a role. The one clear dedicated "documentation agent" precedent is Anthropic's CitationAgent (narrow, mechanical).
- **Self-improvement is a real but non-standardized separate concern**, distinguished by *timescale* (post-spec / cross-spec) rather than per-item work. No major framework ships a first-class "SelfImprover" role.
- **Splitting helps when** tasks are parallelizable/breadth-first (Anthropic: multi-agent beat single-agent by 90.2%), when context windows overflow, when one agent faces prompt/tool overload, or when distinct security boundaries are needed.
- **Splitting hurts via coordination overhead, cost, and lost context.** Anthropic: multi-agent uses ~15× the tokens of chat. MAST: 41–86.7% failure rates across 7 SOTA systems; inter-agent misalignment is a whole failure category (~30%+ of modes). Cognition argues for coding specifically that dispersed decision-making and unshared context make multi-agent "fragile," and recommends single-threaded agents.
- **Coding is a weaker fit for heavy multi-agent splitting than research.** Anthropic explicitly notes most coding tasks have "fewer truly parallelizable tasks."
- **Net for a 4-way split:** Orchestrator, Auditor, and (conditionally) SelfImprover are well-grounded separations; **Documentator is the weakest** as a standalone agent. A **Worker/Developer** (and arguably a **Planner/Architect distinct from Orchestrator**) is the missing role.

---

## Role-Pattern Table

| Role pattern | Systems using it | Evidence / benefit | Cost / risk |
|---|---|---|---|
| **Planner / Architect** | MetaGPT, Agent Laboratory, ChatDev | Structured intermediate artifacts raise code-gen success and reduce cascading hallucination | Extra tokens/latency; a handoff where the spec can be misread (MAST FM-1.1 = 11.8%) |
| **Orchestrator / Supervisor / Manager** | Anthropic Research, Magentic-One, CrewAI, AutoGen, LangGraph, Semantic Kernel | Centralizes decomposition, routing, progress tracking, re-planning; enables parallelism; modular | Bottleneck (synchronous subagents); over-delegation; stalls on ambiguous goals |
| **Worker / Executor** | MetaGPT, ChatDev, Magentic-One, all frameworks | The base capability; specialization changes outputs materially | Without a clear spec, workers "implement simple logic," low information density |
| **Verifier / Critic / Auditor** | MetaGPT (QA), ChatDev (Reviewer+Tester), AutoGen (reflection/debate), Anthropic (CitationAgent, LLM-as-judge) | Explicit verifiers reduce total failures (+15.6% ChatDev); counters self-grading bias | Superficial checks give false confidence (MAST FM-3.2/3.3); needs acceptance criteria + iteration cap |
| **Documentation / Memory** | MetaGPT (structured docs), ChatDev (memory), Agent Laboratory (report), Anthropic (filesystem artifacts) | Structured docs prevent "game of telephone"; filesystem artifacts cut token overhead | As a *standalone agent* it adds a context-losing hop |
| **Self-Improver / Meta-optimizer** | MetaGPT (outlook), Anthropic (self-improving tool-testing agent) | Runs at a different cadence; rewriting tool descriptions cut task time 40% | No standardized role; self-grading risk if it also audits |
| **Peer / swarm / debate** | AutoGen, AgentVerse, NLSOM, OpenAI swarm | Groups can outperform single agents | Inter-agent misalignment; loops; Azure recommends ≤3 agents |
| **Society-of-Mind / agent economies** | Minsky (origin), NLSOM, AgentVerse | Agents added modularly via a shared language interface | Open questions on social structure; emergent negatives |

---

## When Separating a Role Helps vs Hurts

**Helps**
- **Parallelizable / breadth-first work.** Anthropic: multi-agent beat single-agent by 90.2%; token usage explained 80% of performance variance.
- **Context-window pressure.** Subagents act as "intelligent filters" and reduce path dependency.
- **Prompt/tool overload or security boundaries.** Azure: use multi-agent when "a single agent can't reliably handle certain tasks due to prompt complexity, tool overload, or security requirements."
- **Reliability via independent verification.** MAST: the two highest-leverage interventions were role-spec fixes (+9.4%) and a high-level verification step (+15.6%).
- **Role assignment itself.** ChatDev's ablation: removing roles was the single biggest performance hit.

**Hurts**
- **Cost.** Anthropic: multi-agent ≈ 15× tokens vs chat; agents ≈ 4×.
- **Coordination overhead & new failure modes.** MAST FC2 (Inter-Agent Misalignment) spans ~30%+ of observed failure modes.
- **Lost context / error propagation.** Cognition: "share full context and full agent traces"; "actions carry implicit decisions."
- **Self-grading bias.** If the producer also verifies, verification is superficial (MAST: verifiers "perform only superficial checks").
- **Loop/termination failures.** MAST FC1: step repetition 15.7%, unaware of stopping conditions 12.4%.
- **Coding-specific caution.** Anthropic: coding has fewer parallelizable tasks; Cognition: multi-agent "only results in fragile systems" today.

**General rule from the sources:** *Use the lowest level of complexity that reliably meets requirements* (direct call → single agent+tools → multi-agent); prefer workflows over agents where possible. Separate a role only when it removes a demonstrated failure mode or an overload — not for symmetry.

---

## Implications for a 4-Role Split (Orchestrator / Documentator / Auditor / SelfImprover)

**Recommendation: keep 3 of the 4 as genuine agents (Orchestrator, Auditor, SelfImprover), demote Documentator from an *agent* to a *shared artifact/memory layer* (plus an optional narrow attribution sub-agent), and add the missing Worker/Developer (and consider Planner/Architect distinct from Orchestrator).**

- **Orchestrator — YES, separate.** Strongest-supported split (Anthropic lead agent, Magentic-One Orchestrator, CrewAI manager, AutoGen GroupChatManager, LangGraph supervisor). Design against: bottleneck if subagents are synchronous; over-delegation; stalls on ambiguity. Note: orchestration ≠ planning (MetaGPT separates PM/Architect/PM from execution).
- **Auditor — YES, separate.** Best-evidenced separation for reliability. Keep it independent from the Worker (counters self-grading bias). Requirements: explicit acceptance criteria, iteration cap, fallback/escalation, and multi-level verification (low-level correctness *and* high-level objective).
- **SelfImprover — YES, separate, but justify by cadence.** Runs post-spec/cross-spec, unlike per-item audit. Risk: if it also audits, self-grading bias returns. Feed it the Auditor's findings, not its own grading.
- **Documentator — WEAKEST as a standalone agent.** Implement documentation as a shared, persistent artifact/memory store; if attribution/consistency is needed, add a *narrow* citation/formatting agent (CitationAgent precedent) rather than a general Documentator.

**Missing roles to add:**
1. **Worker / Developer / Executor** — the base role in every framework.
2. **Planner / Architect (possibly distinct from Orchestrator).**
3. **A shared memory / artifact layer** (not a role, but required).
4. *(Optional)* **A critic distinct from the auditor** for generative debate vs pass/fail.

**Design guardrails (from the sources):**
- Use the lowest complexity that works; add a role only to remove a demonstrated failure mode.
- Share full context/traces, not just messages; prefer shared artifacts over message-passing through a coordinator.
- Compact context between agents; persist long-running state externally.
- Give the Auditor clear acceptance criteria + iteration cap; verify at multiple levels.
- Give the Orchestrator effort-scaling rules to prevent over-delegation.
- Assign cheaper/smaller models to simple roles.
- Expect coding to benefit less from parallelism than research.

---

## Full Citation List

1. **MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework** — Sirui Hong, Mingchen Zhuge, Jiaqi Chen, et al. ICLR 2024; arXiv:2308.00352. https://arxiv.org/abs/2308.00352
2. **ChatDev: Communicative Agents for Software Development** — Chen Qian, Wei Liu, Hongzhang Liu, et al. ACL 2024; arXiv:2307.07924. https://arxiv.org/abs/2307.07924
3. **AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation** — Qingyun Wu, Gagan Bansal, Jieyu Zhang, et al. (Microsoft Research), 2023. arXiv:2308.08155. https://arxiv.org/abs/2308.08155
4. **AgentVerse: Facilitating Multi-Agent Collaboration and Exploring Emergent Behaviors** — Weize Chen, Yusheng Su, Jingwei Zuo, et al. ICLR 2024; arXiv:2308.10848. https://arxiv.org/abs/2308.10848
5. **Large Language Model based Multi-Agents: A Survey of Progress and Challenges** — Taicheng Guo, Xiuying Chen, Yaqi Wang, et al. 2024. arXiv:2402.01680. https://arxiv.org/abs/2402.01680
6. **Why Do Multi-Agent LLM Systems Fail? (MAST)** — Mert Cemri, Melissa Z. Pan, Shuyi Yang, et al. (UC Berkeley), 2025. arXiv:2503.13657. https://arxiv.org/abs/2503.13657
7. **Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks** — Adam Fourney, Gagan Bansal, Hussein Mozannar, et al. (Microsoft Research), 2024. arXiv:2411.04468. https://arxiv.org/abs/2411.04468
8. **How we built our multi-agent research system** — Hadfield, Zhang, Lien, Scholz, Fox, Ford (Anthropic Engineering), 2025. https://www.anthropic.com/engineering/multi-agent-research-system
9. **Don't Build Multi-Agents** — Walden Yan (Cognition), 2025. https://cognition.ai/blog/dont-build-multi-agents
10. **Agent Laboratory: Using LLM Agents as Research Assistants** — Samuel Schmidgall, Yusheng Su, Ze Wang, et al., 2025. arXiv:2501.04227. https://arxiv.org/abs/2501.04227
11. **Mindstorms in Natural Language-Based Societies of Mind (NLSOM)** — Mingchen Zhuge, Haozhe Liu, Francesco Faccio, et al. Computational Visual Media 11(1), 2025; arXiv:2305.17066. https://arxiv.org/abs/2305.17066
12. **Multi-Agent Collaboration Mechanisms: A Survey of LLMs** — Khanh-Tung Tran, Dung Dao, Minh-Duong Nguyen, et al., 2025. arXiv:2501.06322. https://arxiv.org/abs/2501.06322
13. **CrewAI — Crews** (docs). https://docs.crewai.com/concepts/crews
14. **OpenAI Agents SDK — Agent orchestration** (docs). https://openai.github.io/openai-agents-python/multi_agent/
15. **Semantic Kernel Agent Orchestration** (docs). https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/
16. **AI Agent Orchestration Patterns** — Azure Architecture Center, Microsoft Learn. https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns
17. **How to think about agent frameworks** — Harrison Chase (LangChain), 2025. https://blog.langchain.com/how-to-think-about-agent-frameworks/
18. **Launch HN: Webhound (YC S23)** — Hacker News, 2025. https://news.ycombinator.com/item?id=45373008
19. **Launch HN: Spine Swarm (YC S23)** — Hacker News, 2026. https://news.ycombinator.com/item?id=47364116
