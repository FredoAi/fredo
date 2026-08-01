# Research Report: Scientific Literature on Agent Skills

**Agent:** Research Analyst (papers)
**Date:** 2026-08-01
**Scope:** Peer-reviewed papers + preprints on progressive disclosure, skill selection/descriptions, skill libraries, context budget, skill composition

---

## Executive Summary — Top 10 Findings

1. **Context position matters more than context size.** "Lost in the Middle" (Liu et al., TACL 2023): LLMs use information best at the start/end of context and degrade sharply for mid-context material. On-demand skill loading (which puts a skill near the recent/active end of context at the moment it's needed) is safer than pre-loading a large skill catalog into the static system prompt. **Conflict:** "Never Lost in the Middle" (He et al., ACL 2024) shows position effects can be trained away — treat on-demand loading as a robust design strategy, not a guaranteed model property.

2. **Long prompts carry large redundancy — compression keeps performance at 20×.** LLMLingua (EMNLP 2023) achieves up to 20× prompt compression with little loss. Keeping the always-loaded prompt small is nearly free. MemGPT demonstrates the OS paging pattern: keep a small "main memory" of instructions and page skill content in/out on demand.

3. **Retrieval-based tool selection triples accuracy while cutting prompt tokens.** RAG-MCP cut prompt size >50% and raised tool-selection accuracy from 13.6% to 43.1% by retrieving only the relevant tool descriptions before the LLM sees them. Corroborated by Gorilla (retriever reduces API-call hallucination) and LongBench.

4. **Description quality drives selection more than content quality.** "From Docs to Descriptions" (10,831 real MCP servers): functionality- and accuracy-smells shift LLM tool selection by +11.6% / +8.8%; standard-compliant descriptions get selected at 72% vs a 20% baseline. BiasBusters: *small perturbations* to descriptions change choices; semantic alignment between the user query and tool metadata is the single strongest driver of selection.

5. **Retrieving the right instructions/examples at the right time is a proven lever.** Semantic retrieval of in-context examples beats random selection with large gains (up to +41.9%/+45.5%). Self-RAG shows *adaptive/on-demand* retrieval beats both no-retrieval and indiscriminate retrieval.

6. **Progressive disclosure is now an explicit, primary-source design principle.** Anthropic's Agent Skills standard defines three levels: (1) `name`+`description` pre-loaded → (2) full SKILL.md read on trigger → (3) linked reference files read on demand. Direct descendant of Nielsen's progressive-disclosure HCI guideline: put frequently-needed items in level 1 and give each progression "strong information scent."

7. **Skill libraries work when skills are code/executable + compositional — and degrade when retrieval is flat.** Voyager's ever-growing, self-verified skill library compounds abilities and transfers to new worlds. But the 2026 lifecycle survey (124 papers) finds **flat retrieval degrades as libraries grow**; SkillOps documents "skill technical debt" accumulating at library level.

8. **Free-form prose skills cause a "confused → re-retrieve → still confused" loop.** Skill-as-Pseudocode converted markdown prose into typed contracts + invocation templates and beat the Graph-of-Skills baseline 82 vs 47 paired wins at **−22.8% tokens and −14.5% LLM calls**. GoSkills: "retrieving relevant skills is not the same as presenting usable context" — agents need role-labeled execution contracts (Start / Support / Check / Avoid). **Conflict:** Anthropic ships prose SKILL.md and reports it works; the reconciliation is structured, contract-like prose with explicit inputs/outputs/when-to-use/failure modes.

9. **Instructions are hierarchical; injected skill instructions must be treated as privileged.** The Instruction Hierarchy shows LLMs conflate system-prompt instructions with untrusted content. As skill catalogs grow, conflicts across many instruction sources scale — frontier models only hit ~40% accuracy when instruction conflicts span up to 12 privilege tiers.

10. **Specifications (not just facts) must be extractable from skill content.** Agentic Context Learning: 55.4% of rubric items evaluate "specification acquisition" vs only 22.6% content — yet 76.7% of specs are *not stated in the user query*; even frontier models score under 24%. A SKILL.md must *state its own contract explicitly* because the agent won't reliably infer it.

---

## Progressive Disclosure / On-Demand Instruction Loading

| Finding | Evidence |
|---|---|
| Loading only what's needed keeps active context small, avoids mid-context degradation | [1] Lost in the Middle (TACL 2023) |
| Long prompts compress 20× with little loss | [3] LLMLingua (EMNLP 2023) |
| OS-style paging (small resident set + on-demand loads) is the reference architecture | [4] MemGPT (2023) |
| On-demand pattern is now a documented product convention | [30] Anthropic Agent Skills — 3-level disclosure; "context that can be bundled into a skill is effectively unbounded" |
| HCI foundation: right initial/secondary split + strong information scent | [31] Nielsen (NN/g, 2006) |
| **Conflict** | [6] Never Lost in the Middle (ACL 2024) — position effects trainable away; [33] Agentic Context Learning — on-demand wins where relevant signal is small; full-context is not automatically worse when all context is task-relevant |

**SKILL.md takeaway:** frontmatter `name` + `description` is the only always-in-context surface (level 1). Body = level 2. Linked files = level 3. Split scenario-specific detail into linked files, never inline.

---

## Skill Selection / Description Quality

| Finding | Evidence |
|---|---|
| Selection accuracy collapses as candidate set grows; retrieval restores it | [15] RAG-MCP — semantic retrieval triples selection accuracy (43.13% vs 13.62%); [8] Gorilla |
| Description quality affects selection *more than* underlying content | [16] From Docs to Descriptions (10,831 MCP servers) — +11.6%/+8.8%; 72% vs 20% baseline |
| Descriptions are decision inputs with subtle failure modes | [17] BiasBusters (ICLR 2026) — semantic alignment is strongest driver; small perturbations shift choices; first-listed bias. [18] JTPRO (ACL 2026) — underspecified schemas cause mis-selection |
| Tool description content is an attack surface | [16b] TRUSTDESC — tool-poisoning attacks embed malicious instructions inside descriptions |
| Selection is one of several separable sub-capabilities | [11] T-Eval; [12] API-Bank; [7] Toolformer |

**SKILL.md takeaway:** the `description` is a selection router — write it as a *semantic alignment target* naming the task/domain/trigger/inputs in user vocabulary. Treat it as testable surface; perturb and re-benchmark.

---

## Skill Library & Composition

| Finding | Evidence |
|---|---|
| Executable, self-verified skill libraries compound and transfer | [9] Voyager — 3.3× items, milestones up to 15.3× faster, transfers to a new world |
| Memory-as-retrieval (relevance + recency + importance) is the standard | [10] Generative Agents (UIST 2023) |
| Skill ordering/prerequisites matter | [23] Skill-it! — prerequisite-ordered skills learn faster |
| RL + skill library beats on success AND efficiency | [24] SAGE — +8.9% completion, 26% fewer steps, 59% fewer tokens |
| **Prose skills underperform contract-structured skills** | [27] Skill-as-Pseudocode — 82 vs 47 paired wins, −22.8% tokens, −14.5% calls. [28] GoSkills — role-labeled contracts (Start/Support/Check/Avoid) beat flat lists |
| Libraries need maintenance, not just retrieval | [25] Dynamic Agent Skills survey (124 papers) — flat retrieval degrades as libraries grow. [26] SkillOps — skill technical debt. [29] Skill Drift — skills silently decay as APIs change |
| Composition of atomic modules is effective and cheap | [5b] Self-Discover (up to +32% over CoT); [5c] Self-Debug (up to +12%) |

**SKILL.md takeaway:** make each skill self-contained and *verifiable* (self-check / expected-output example). Express procedures as explicit contracts with entry points, prerequisites, failure modes. Budget library maintenance: prune/pin versions, validate claims.

---

## Context Budget

| Finding | Evidence |
|---|---|
| Both too little and too much are costly; "too much" fails by attention dilution | [1] Lost in the Middle; [2] LongBench |
| Extreme compression possible without meaningful loss | [3] LLMLingua 20× |
| Scaling tools/topics in one prompt is the enemy of selection | [15] RAG-MCP; [17] BiasBusters |
| Quality of a few curated instructions beats volume | [24] LIMA — 1,000 curated examples match much larger models in 43% of comparisons |
| Retrieval-augmented instruction quality: relevance beats quantity | [21] Good In-Context Examples; [22] Learning To Retrieve Prompts; [20] Self-RAG |

**SKILL.md takeaway:** budget the *always-loaded* footprint aggressively (frontmatter only). Treat the skill body as a self-contained unit that doesn't depend on details from other skills. Favor a small number of curated, high-quality skills over a sprawling catalog.

---

## Concrete Actionable Recommendations for Writing a Good SKILL.md

1. **Treat the frontmatter `description` as a router, not a summary.** It is the *only* always-in-context text about the skill. Write it to maximize semantic alignment with likely user queries (what it does, for which inputs/domains, under which trigger conditions). Test by perturbing it and re-benchmarking trigger rate.
2. **Lead the body with an explicit contract.** State in the first screenful: When to use / When NOT to use, Inputs, Outputs, Prerequisites. The agent is unlikely to infer an unstated specification. Model on GoSkills' role-labeled contract (Start/Support/Check/Avoid) and SaP's signature-plus-template split.
3. **Put concrete invocation templates, not just prose.** Include an example command/step sequence the agent can copy — eliminates the confused→re-retrieve loop.
4. **Use progressive disclosure with exactly two–three levels.** Frontmatter → core SKILL.md → linked reference files for rare/voluminous detail. More than ~2 disclosure levels gets confusing.
5. **Keep the always-loaded context small — by construction.** If a skill must reference many others, cross-reference by name and let the agent load them on demand (MemGPT paging).
6. **Write to be retrieved, not read linearly.** Include the distinctive terms and task phrasings agents will use when searching — the retriever matches on description and headers.
7. **Make every skill verifiable and self-checking.** Include a check command, expected output, or self-test — feeds the "admission/repair" lifecycle stage.
8. **Prefer a small set of high-quality, composable skills over a large catalog.** Curation beats volume; order prerequisite skills before advanced ones.
9. **Guard against skill decay and injection.** Pin/documented dependency versions, validate claims against live APIs, specify trust boundaries.
10. **Treat instruction conflicts explicitly.** State priority explicitly ("this overrides X" / "unless system says otherwise"); assume the model won't reliably resolve conflicts across many sources.
11. **Iterate from observation, not assumption.** Run representative tasks, watch when the agent triggers/over-triggers/under-triggers, fold successes *and* common mistakes back into the skill.

---

## Source List

1. Lost in the Middle — Liu et al., TACL 2023 — https://arxiv.org/abs/2307.03172
2. LongBench — Bai et al., ACL 2024 — https://arxiv.org/abs/2308.14508
3. LLMLingua — Jiang et al., EMNLP 2023 — https://arxiv.org/abs/2310.05736
4. MemGPT — Packer et al., 2023 — https://arxiv.org/abs/2310.08560
5. RAG — Lewis et al., NeurIPS 2020 — https://arxiv.org/abs/2005.11401
6. Never Lost in the Middle — He et al., ACL 2024 — https://arxiv.org/abs/2311.09198
7. Toolformer — Schick et al., 2023 — https://arxiv.org/abs/2302.04761
8. Gorilla — Patil et al., 2023 — https://arxiv.org/abs/2305.15334
9. Voyager — Wang et al., 2023 — https://arxiv.org/abs/2305.16291
10. Generative Agents — Park et al., UIST 2023 — https://arxiv.org/abs/2304.03442
11. T-Eval — Chen et al., 2023 — https://arxiv.org/abs/2312.14033
12. API-Bank — Li et al., EMNLP 2023 — https://arxiv.org/abs/2304.08244
13. ExpeL — Zhao et al., AAAI-24 — https://arxiv.org/abs/2308.10144
14. Retroformer — Yao et al., 2023 — https://arxiv.org/abs/2308.02151
15. RAG-MCP — Gan & Sun, 2025 — https://arxiv.org/abs/2505.03275
16. From Docs to Descriptions — Wang et al., 2026 — https://arxiv.org/abs/2602.18914
17. BiasBusters — Blankenstein et al., ICLR 2026 — https://arxiv.org/abs/2510.00307
18. JTPRO — Ghoshal et al., ACL 2026 — https://arxiv.org/abs/2604.19821
19. The Instruction Hierarchy — Wallace et al., 2024 — https://arxiv.org/abs/2404.13208
20. Self-RAG — Asai et al., ICLR 2024 — https://arxiv.org/abs/2310.11511
21. What Makes Good In-Context Examples — Liu et al., 2021 — https://arxiv.org/abs/2101.06804
22. Learning To Retrieve Prompts — Rubin et al., NAACL 2022 — https://arxiv.org/abs/2112.08633
23. Skill-it! — Chen et al., 2023 — https://arxiv.org/abs/2307.14430
24. SAGE — Wang et al., 2025 — https://arxiv.org/abs/2512.17102
25. Dynamic Agent Skills — Li, TMLR 2026 — https://arxiv.org/abs/2607.10113
26. SkillOps — Pu et al., 2026 — https://arxiv.org/abs/2605.13716
27. Skill-as-Pseudocode — Li et al., 2026 — https://arxiv.org/abs/2605.27955
28. GoSkills — Zeng et al., 2026 — https://arxiv.org/abs/2605.06978
29. Skill Drift — Fan et al., 2026 — https://arxiv.org/abs/2605.10990
30. Anthropic Agent Skills (open standard) — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
31. Progressive Disclosure — Nielsen, NN/g 2006 — https://www.nngroup.com/articles/progressive-disclosure/
32. Many-Tier Instruction Hierarchy — Zhang et al., 2026 — https://arxiv.org/abs/2604.09443
33. Agentic Context Learning — Zhong et al., 2026 — https://arxiv.org/abs/2607.09794

**Caveats:** position effects trainable away [6]; retrieval not always the answer [33]; prose-vs-structured skills contested [30 vs 27/28]; 2026 preprints unpeer-reviewed — treat numbers as directional.
