# Research Report: Self-Improving Agent Systems, Experience Curation, and Skill Authoring

**Agent:** Research Analyst (external literature + community sources)
**Date:** 2026-10-25
**Scope:** What a "Self-Improver" role should own; how self-improving systems capture lessons, curate guardrails, and author skills; how to avoid guardrail bloat and validate improvement. Specifically: should "build agent tools/skills" be its own role separate from "curate guardrails/improve the pipeline"?
**Method:** Primary scientific papers (Voyager, Reflexion, ExpeL, Generative Agents, Self-Refine, STOP, Promptbreeder, EvoPrompt, ACE, Tree of Thoughts, Darwin Gödel Machine, SICA, SEAL, Agent Workflow Memory, self-evolving-agents survey) + engineering sources (Anthropic context engineering, Google SRE postmortem culture, DeepMind/OpenAI specification gaming).

---

## Executive Summary

- **Four distinct self-improvement mechanisms recur across the literature, on four different substrates:** (a) episodic memory + verbal reflection (transient, per-task text), (b) curated rules/guardrails/playbooks (persistent text context), (c) skill/tool/workflow authoring (executable code), and (d) weight-level self-edits. They have different artifacts, verification regimes, and blast radii — the field treats them as separate machinery, not one monolith.
- **Reflection is cheap and belongs to the executing agent; curation is expensive and belongs to a central role.** Reflexion/Generative Agents keep reflection in a per-agent episodic buffer; ExpeL and ACE *distill* many episodes into reusable cross-task insights/playbooks.
- **The canonical failure of naive self-improvement is context/guardrail bloat.** ACE names two: *brevity bias* (dropping domain detail for concise summaries) and *context collapse* (iterative rewriting eroding detail); it fixes them with structured, incremental generation→reflection→curation. Anthropic independently warns of an "attention budget," "context rot," and "bloated tool sets."
- **Durable behavior change is validated empirically, per change, against held-out benchmarks — not asserted.** The Darwin Gödel Machine validates every self-modification (SWE-bench 20%→50%, Polyglot 14.2%→30.7%); SICA (17%→53% SWE-bench Verified) and SEAL do the same.
- **Self-modifying systems require sandboxing, human oversight, and rollback.** STOP explicitly measured how often its self-generated code *bypassed its sandbox*; DGM ran all experiments with sandboxing + human oversight.
- **The dominant safety failure is specification gaming / reward hacking** — satisfying the literal objective while defeating intent (~60 catalogued examples).
- **Postmortem engineering supplies the missing governance layer:** blameless records, defined triggers, root-cause-depth review, an incident repository, trend analysis, and effectiveness surveys.
- **Recommendation: split the role.** Episodic reflection stays with executors; *guardrail/playbook curation* is the core Self-Improver; *tool/skill authoring* should be its own role because it emits executable, testable artifacts with a different verification regime and higher blast radius.
- **Separation of powers is mandatory:** the agent that authors a rule must not be the sole validator of its effect.
- **One shared evidence ledger should back all self-improvement functions** so skills, rules, and reflections are attributed to outcomes and can be retired when they stop helping.

---

## Technique/System Comparison

| Technique/system | Mechanism | Evidence |
|---|---|---|
| **Voyager** (skill library) | Ever-growing library of executable code skills + curriculum + self-verification; compositional and transferable | 3.3× unique items, 2.3× travel, milestones up to 15.3× faster |
| **Reflexion** | Verbal reflection stored in an episodic memory buffer; no weight updates | 91% pass@1 HumanEval vs 80% prior SOTA |
| **ExpeL** | Extracts natural-language insights/rules across tasks; recalls at inference | Consistent gain as experiences accumulate |
| **Generative Agents** | Memory stream + reflection (synthesis into higher-level memories) + retrieval | Ablation: observation/planning/reflection each critical |
| **Self-Refine** | Single LLM as generator, feedback provider, refiner | ~20% absolute across 7 tasks |
| **STOP** | LM-infused scaffolding program improves itself; measures sandbox-bypass frequency | Improved improver beats seed; sandbox-bypass measured |
| **Promptbreeder** | Evolutionary prompt self-improvement (self-referential mutation) | Beats CoT and Plan-and-Solve |
| **EvoPrompt** | Evolutionary algorithms over a prompt population | Up to 25% on BBH over human prompts |
| **ACE (Agentic Context Engineering)** | Context as an evolving playbook; modular generation→reflection→curation | +10.6% agents, +8.6% finance; adapts without labels |
| **Tree of Thoughts** | Deliberate search with self-evaluation, lookahead, backtracking | Game of 24: 74% vs 4% CoT GPT-4 |
| **Darwin Gödel Machine** | Self-modifies its own code, empirically validates each change, archive | SWE-bench 20%→50%; sandboxing + human oversight |
| **SICA** | Coding agent edits itself; non-gradient learning | 17%→53% SWE-bench Verified subset |
| **SEAL** | Model generates its own finetuning data + update directives; RL loop | Gains on knowledge incorporation / few-shot generalization |
| **Agent Workflow Memory** | Induces reusable workflows from experience; selectively injects | +24.6% / +51.1% on Mind2Web / WebArena |
| **Self-evolving agents survey** | Taxonomy across what/when/how/where to evolve | 77-page TMLR survey |
| **Memory-mechanism survey** | Systematizes memory design/evaluation as the substrate of self-evolution | 39-page survey |

---

## 1. How Systems Turn Lessons into Durable Behavior Change

The literature shows a **funnel**; each stage changes persistence and verification cost:
1. **Capture (episodic).** Raw experience as natural language (Reflexion buffer; Generative Agents memory stream).
2. **Reflect (intra-task).** Self-Refine/ToT generate and act on feedback within a task.
3. **Distill (cross-task → rules).** ExpeL extracts insights; ACE curates "evolving playbooks."
4. **Author (→ executable skills).** Voyager stores executable, verifiable code skills; AWM induces workflows.
5. **Self-edit (→ weights/code).** SEAL writes its own finetuning data; DGM/SICA edit the agent's own codebase.

**Key insight:** durability increases as you move down the funnel, and so does the cost and risk of being wrong. A reflection is cheap to discard; a committed guardrail or a merged skill affects every future run. **Curation and validation (not generation) are the scarce functions.**

## 2. One Role or Several?

They are **three separate functions**, for three reasons the sources make explicit:
- **Different substrates.** Episodic text buffer vs curated rule/playbook text vs executable code/weights. The self-evolving-agents survey decomposes evolution across *models, memory, tools, architecture*.
- **Different verification.** Skills/code are executable and testable; rules are textual and need eval suites; memory is retrieval-based, evaluated by behavior ablation.
- **Different blast radius and cadence.** A per-task reflection is low-risk and high-frequency; a global guardrail or a new tool is high-risk and low-frequency (DGM/STOP show it can break containment or be gamed).

**Conclusion:** episodic reflection is a property of every executing agent; curation is a central role; **skill/tool authoring is a third role.**

## 3. Avoiding Guardrail Bloat and Rule Overfitting

- **Structured incremental updates, not wholesale rewrites** (ACE's cure for context collapse).
- **Explicit curation stage with dedup/refine/organize** (ACE's "curation" is first-class).
- **Respect the attention budget** — smallest set of high-signal tokens; diverse canonical examples over "laundry lists of edge cases" (Anthropic).
- **Prune bloated tool sets** — "one of the most common failure modes we see is bloated tool sets."
- **Distill many episodes into few rules** (ExpeL's insight extraction is a compression step).
- **Postmortem hygiene** — defined triggers, root-cause-depth review, incident repository, trend analysis to "reduce duplicate incidents" (Google SRE).
- **Retirement/effectiveness** — Google SRE surveys teams; ACE's curation refines the playbook over time.

## 4. How Self-Improvement Is Validated

- **Per-change empirical validation against held-out benchmarks** (DGM validates each self-modification; SICA/SEAL measure downstream performance).
- **Fitness on a dataset, then held-out testing** (Promptbreeder/EvoPrompt; the guard against overfitting is a separate validation set).
- **Execution feedback without labels** (ACE).
- **Recurrence/attribution at the process level** (Google SRE postmortem review + trend analysis).
- **Caveat on attribution.** Most systems measure *aggregate* improvement; few isolate a single rule's causal contribution. A rigorous Self-Improver should track **per-rule activation vs outcome** with a **counterfactual/holdout** set.

## 5. Known Failure Modes of Self-Modifying Pipelines

| Failure mode | What it looks like |
|---|---|
| **Specification gaming / reward hacking** | Satisfies the literal objective, defeats intent |
| **Reward tampering** | Manipulates the representation of the objective |
| **Sandbox escape** | Self-generated code bypasses containment |
| **Context collapse / brevity bias** | Iterative rewriting erodes detail |
| **Guardrail/rule bloat & overfitting to the last incident** | Brittle hardcoded prompts; laundry-list edge cases |
| **Regression / capability loss** | Self-edits hurt previously passing tasks |
| **Transfer failure** | Insights learned on train tasks don't generalize |
| **Compounding errors from autonomy** | Multi-turn autonomy compounds mistakes |

Mitigations consistently recommended: **sandboxing + human oversight**, **rollback/archive**, **held-out validation**, **structured curation**, **separation of authoring from validation**.

---

## What Should a Self-Improver Own, and What Should Be Split Out?

**Short answer: yes — "build agent tools/skills" should be a separate role from "curate guardrails/improve the pipeline."**

| Function | Owned by | Why |
|---|---|---|
| **Episodic reflection / in-task self-critique** | **Executing agents** | Per-task, cheap, low-risk; it is the raw signal, not curation |
| **Guardrail / prompt / playbook curation** | **Self-Improver (core)** | Cross-run, persistent, high-blast-radius text; needs dedup, retirement, effectiveness tracking |
| **Skill / tool / workflow authoring** | **Separate "Capability Builder" role** | Emits executable, testable code with a different verification regime and higher blast radius |
| **Effectiveness / attribution measurement** | **Shared, independent function** | Neither author should validate its own change; needs held-out tasks + recurrence tracking |
| **Evidence ledger (experience store)** | **Shared substrate** | One record of episodes→insights→rules→skills→outcomes so artifacts can be attributed and retired |

**Why split:** (1) different artifact → different pipeline (text rules need an eval suite; tools need unit/integration/sandbox gates); (2) different failure modes (rule-authoring → bloat/overfitting; tool-authoring → bugs/containment breaches); (3) different cadence and cost; (4) separation of powers.

**What must remain shared regardless of split:** one evidence ledger; one attribution/effectiveness function owned independently of the authors; guardrails around self-modification (sandboxing, human oversight, rollback, specification-gaming monitoring); human-owned boundaries (`AGENTS.md`, `opencode.json`) that the Self-Improver and Capability Builder must not edit.

---

## Full Citation List

1. **Voyager: An Open-Ended Embodied Agent with LLMs** — Wang, Xie, Jiang, Mandlekar, Xiao, Zhu, Fan, Anandkumar, 2023. arXiv:2305.16291.
2. **Reflexion: Language Agents with Verbal Reinforcement Learning** — Shinn et al., 2023. arXiv:2303.11366.
3. **ExpeL: LLM Agents Are Experiential Learners** — Zhao, Huang, Xu, Lin, Liu, Huang, AAAI-24. arXiv:2308.10144.
4. **Generative Agents: Interactive Simulacra of Human Behavior** — Park, O'Brien, Cai, Morris, Liang, Bernstein, 2023. arXiv:2304.03442.
5. **Self-Refine** — Madaan et al., 2023. arXiv:2303.17651.
6. **Self-Taught Optimizer (STOP): Recursively Self-Improving Code Generation** — Zelikman, Lorch, Mackey, Kalai, COLM 2024. arXiv:2310.02304.
7. **Promptbreeder: Self-Referential Self-Improvement Via Prompt Evolution** — Fernando, Banarse, Michalewski, Osindero, Rocktäschel (DeepMind), 2023. arXiv:2309.16797.
8. **EvoPrompt: Connecting LLMs with Evolutionary Algorithms** — Guo et al., ICLR 2024. arXiv:2309.08532.
9. **Agentic Context Engineering (ACE)** — Zhang, Hu, Upasani, et al., ICLR 2026. arXiv:2510.04618.
10. **Tree of Thoughts** — Yao, Yu, Zhao, Shafran, Griffiths, Cao, Narasimhan, NeurIPS 2023. arXiv:2305.10601.
11. **A Survey of Self-Evolving Agents** — Gao, Geng, Hua, et al., TMLR 2026. arXiv:2507.21046.
12. **Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents** — Zhang, Hu, Lu, Lange, Clune, 2025. arXiv:2505.22954.
13. **A Self-Improving Coding Agent (SICA)** — Robeyns, Szummer, Aitchison, 2025. arXiv:2504.15228.
14. **Self-Adapting Language Models (SEAL)** — Zweiger, Pari, Guo, Akyürek, Kim, Agrawal, 2025. arXiv:2506.10943.
15. **A Survey on the Memory Mechanism of LLM-based Agents** — Zhang, Bo, Ma, et al., 2024. arXiv:2404.13501.
16. **Agent Workflow Memory** — Wang, Mao, Fried, Neubig, 2024. arXiv:2409.07429.
17. **Effective context engineering for AI agents** — Anthropic, 2025. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
18. **Building effective AI agents** — Anthropic, 2024. https://www.anthropic.com/engineering/building-effective-agents
19. **Postmortem Culture: Learning from Failure** (SRE Ch. 15) — Lunney, Lueder, Google, 2017. https://sre.google/sre-book/postmortem-culture/
20. **Faulty reward functions in the wild** — Clark, Amodei (OpenAI), 2016. https://openai.com/index/faulty-reward-functions/
21. **Specification gaming: the flip side of AI ingenuity** — Krakovna et al. (DeepMind), 2020. https://deepmind.google/discover/blog/specification-gaming-the-flip-side-of-ai-ingenuity/

**Caveats:** no rigorous primary source uses the exact phrase "lessons-learned database" or "guardrail bloat"; the closest well-sourced concepts are ACE's *context collapse/brevity bias* and Anthropic's *context rot / bloated tools*.
