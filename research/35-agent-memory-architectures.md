# Research Report: Memory Architectures for LLM Coding Agents — the Short-Term/Long-Term Split, and When to Write vs Retrieve

**Agent:** Research Analyst (external literature — primary papers, benchmark leaderboards, lab engineering blogs, one adversarial track)
**Date:** 2026-11-12
**Scope:** The taxonomy, short-term/context management, retrieval-quality predictors, **write** policies (when, consolidation, contradiction, forgetting), memory for *coding*, measured harms; then a minimal design ranked by evidence-per-complexity.
**Method:** Primary reading of arXiv/ICLR/NeurIPS/ICML/EMNLP/USENIX papers plus the Anthropic post; numbers from abstracts, full text, and tables. Vendor claims cross-checked against independent runs, which contradict them. Builds on `research/30-self-improving-agent-pipelines.md`.

---

## Executive Summary (Top 8 Findings)

1. **The four-type taxonomy is real, but "long-term vs short-term" is obsolete as a *primary* cut.** CoALA gives working/episodic/semantic/procedural with an action space and decision loop [1]; the materials survey organizes by object/form/time [2]. The Dec-2025 landscape survey calls long/short-term taxonomies insufficient and re-cuts as **token/parametric/latent forms** × **factual/experiential/working functions** × **formation-evolution-retrieval dynamics** [3]. In every measured system these are one buffer, one retrieval function, one policy.

2. **Context degrades with length — measured.** Chroma varies only input length across 18 models at fixed task difficulty: degradation is monotonic, faster when needle-question similarity is low [4]. RULER: only half of 17 models are satisfactory at 32K despite claiming ≥32K [5]. NoLiMa: at 32K, 11 of 13 models claiming ≥128K fall below 50% of their own short-context baseline (GPT-4o 99.3%→69.7%) [6]. LongMemEval: long-context LLMs lose 30–60% even with oracle evidence present [7].

3. **What you put *in* the window beats which database you own.** Improving only the *reading* stage (Chain-of-Note + structured format) buys **up to 10 absolute points** on LongMemEval — comparable to the whole retrieval budget (+9.4% recall@k → +5.4% accuracy) [7]. A ~300-token focused prompt beats the same question inside ~113k tokens for every model family [4].

4. **Independent evaluation reverses the vendor leaderboard; every commercial memory system loses to a plain long-context agent.** MemoryAgentBench overall (GPT-4o-mini): Mem0 **21.1**, Cognee **20.6**, Zep **24.0**, MIRIX **26.2** — vs 128K FIFO agent **42.2**, BM25 **41.5**, GPT-5-mini 400K **60.6** [8]. Mem0's own paper claims it beats Zep [9]. **Never adopt a memory product on its vendor's LoCoMo table.**

5. **Retrieval is a scored union; the canonical function is Generative Agents'.** `score = α_rec·recency + α_imp·importance + α_rel·relevance` — recency exponential decay (0.995/hour), importance an LLM 1–10 at **write** time, relevance cosine, all min-max normalized, all α=1 [10]. That paper ablates *architecture components*, not α: **no published ablation establishes the weights**. Replicated: multi-key indexing (+9.4% recall@k) [7]; iterative > rerank > single-step [11]; graph/PPR pays for multi-hop (HippoRAG +20%) but **not** single-hop [12][13].

6. **Write policy is the least-measured, most consequential half.** Established: fact-sized units with timestamp + importance at extraction [9][10]; incremental consolidation, not rewrite [14][15]; keep contradictions [9][16]. **Unestablished: any forgetting curve beating plain recency/capacity eviction** — MemoryBank's Ebbinghaus decay [17] ranks near the bottom of every later benchmark (single-hop F1 5.00 [14]; AR-avg 35.6 [8]).
7. **Selective forgetting — what coding agents need most — is unsolved.** `FactConsolidation` (later fact supersedes earlier; answer from newest): **all methods fail multi-hop, ceiling ~28%**; only long-context agents do acceptably single-hop [8]. That is the "API changed / module rewritten / approach abandoned" case.

8. **Memory is an attack surface and a cost trap.** AgentPoison: **>80% ASR at <0.1% poison rate**, <1% benign impact, no fine-tuning [18]; PoisonedRAG: **90% ASR from 5 injected texts** in a million-text store, defenses insufficient [19]. Conversely **observation masking halves cost while matching or slightly beating LLM summarization's solve rate** on SWE-bench Verified across five configs [20].

---

## 1. Taxonomy: Established vs Marketing

- **Working/context** — tokens in the window; the only memory attended to. Bounded, degrades with length [4][5][6].
- **Episodic** — timestamped records of interactions, retrieved by similarity+recency [1][10]. Benefit context-dependent (§5).
- **Semantic** — facts abstracted from episodes [1][10]. Abstraction reliably loses detail.
- **Procedural** — skills, workflows, tool-use patterns [1][21][22]. Established, and the **best-evidenced** form for coding (§5).
- **"Long-term memory" as a product** — usually "we store text somewhere and embed it." **Marketing:** no peer-reviewed result shows a commercial layer beating a well-managed long context [8].

Short/long as *stores* hides that the same text is often both: compaction demotes a long-term fact back into working memory. The form axis (token/parametric/latent) [3] is the better engineering cut because it encodes *cost* — token memory is free to write and costly to read, parametric is the reverse.

---

## 2. Short-Term / Context Management (measured numbers only)

| Mechanism | Measured effect | Src |
|---|---|---|
| **Observation masking** (stale tool output → placeholder) | **Halves instance cost** vs raw agent; solve rate **matches or slightly exceeds** LLM summarization on SWE-bench Verified (5 configs); hybrid −7%/−11% further. | [20] |
| **Compaction / recursive summarization** | Production default (Claude Code); no coding head-to-head win over masking. | [23][24] |
| **Note-taking & sub-agents** | NOTES.md/to-do re-read after reset enables multi-hour coherence; payoff scales with **query predictability**. Sub-agents burn 10k+ tokens and return 1–2k summaries; no budget ablation. | [23][25] |
| **Virtual paging (MemGPT)** | OS-style memory with self-directed page faults; its DMR benchmark was immediately contested (Zep 94.8 vs MemGPT 93.4). | [16][26] |
| **Sleep-time compute** | Pre-compute over persisted context *before* the query: **~5× less test-time compute** at equal accuracy; +13%/+18% when scaled; **2.5×** amortization; agentic-SWE case study included. | [25] |

**Decisive finding.** The window is an attention budget, not a container: one distractor hurts, four hurt more; near-miss distractors cause confident hallucination (GPT hallucinates most, Claude abstains most); **shuffling the haystack improves performance** [4]. Half of 17 models are unreliable at 32K [5], and failure is *non-lexical* matching [6] — exactly what "find where this behaviour is implemented" requires. LC beats RAG when resourced, at far higher cost [27].

---

## 3. Retrieval Quality: What Predicts a Good Recall

**Scored union beats any single signal** [10] — subject to the Finding 5 caveat.

| Finding | Evidence | Src |
|---|---|---|
| **Multi-key indexing is the best-replicated win** | +9.4% recall@k, +5.4% accuracy. Condensed keys *alone* do not help — concatenate to the full value. | [7] |
| **Granularity & temporality** | Rounds beat sessions; replacing values with facts/summaries *hurts* overall except multi-session aggregation. Time-aware indexing + query expansion: **+6.8–11.3%** temporal recall. | [7] |
| **Iterative > rerank > single-step** | 4 tasks / 6 datasets; mixed memory most robust to noise. | [11] |
| **Graph traversal pays for multi-hop only** | HippoRAG **+20%** multi-hop; single-step PPR matches IRCoT at **10–30× cheaper, 6–13× faster**. HippoRAG 2 restores factual recall, adds **+7%**. | [12][13] |
| **BM25 is strong; bigger k costs attention** | BM25 AR-avg **60.5** vs Text-Embed-3-Small 53.8, Contriever 33.9; overall 41.5 ≈ 128K agent 42.2. At chunk 4096, k=10 ≈ 40k tokens; smaller chunks help AR, hurt long-range. | [8] |
| **Selection > content of guidance** | AutoGuide: contexts alone 30→36%; guidelines without gating 30→37%; both 30→**46%**. k=3 best; k=5 regresses. | [22] |

Reading matters as much as retrieval: Chain-of-Note + structured JSON buys **up to +10 absolute points** on LongMemEval "even with perfect memory recall" [7].

---

## 4. Write Policies: When, Consolidate, Contradict, Forget

**When to write.** *Per message pair* — Mem0 extracts each pair with a rolling summary + last-10-message window, then a tool call chooses ADD/UPDATE/DELETE/NOOP: the only production pipeline with a published protocol [9]. *Cumulative-importance threshold* — Generative Agents reflect when summed importance exceeds **150** (~2–3/day) [10]. *End of session / on compaction* — notes persist, re-read after resets [23]. *Offline / sleep-time* — payoff scales with query predictability [25]. *Never* — masking ≈ summarization at half cost [20] is the null hypothesis to beat.

**Consolidation.** Incremental deltas, never wholesale rewrite: ACE names *context collapse* (rewriting erodes detail) and *brevity bias* (summaries drop specifics), fixing them with generate→reflect→curate deltas: **+10.6%** agents, **+8.6%** finance [15]. A-MEM links new notes to history and *updates neighbours'* attributes (~2× multi-hop F1) [14] — **but self-reported; A-MEM scores 18.85 J independently, below BM25 [8]**. Dedup-before-write is standard but unablated [9].

**Contradiction.** Invalidate, never delete: Graphiti's bi-temporal edges keep history answerable [16]; Mem0ᵍ marks conflicting relations obsolete [9]. In a repo, "we used to call the v1 endpoint" is real knowledge. LLMs are *surprisingly receptive* to coherent contradictory evidence yet *strongly confirmation-biased* when it is partly consistent with prior belief [28]; mitigations remain immature [29]. `FactConsolidation` → **≤28% multi-hop for every method** [8].

**Forgetting.** MemoryBank [17] posts the weakest numbers in every later comparison (single-hop F1 **5.00** [14]; AR-avg **35.6** [8]) — Ebbinghaus decay is a citation, not a result. Only capacity eviction reliably helps: FIFO is the baseline every system in [8] struggles to beat.

---

## 5. Memory for Coding Specifically

| Mechanism | Evidence (quantified) | Src |
|---|---|---|
| **Procedural: induced workflows** | AWM: **+24.6%** relative success on Mind2Web, **+51.1%** on WebArena; online variant generalizes by **8.9–14.0 absolute points** as the gap widens. | [21] |
| **Procedural: conditional guidelines** | AutoGuide (contrast +/− trajectories → conditional guideline → retrieve by context): ALFWorld **79.1%** vs ReAct 54.5% / ExpeL 59.0%; WebArena-Reddit **47.1%** vs ExpeL 21.8% / ReAct 8.0%; OOD 10.2→**20.4%**. | [22] |
| **Experience bank for issue resolution** | SWE-Exp distils successful *and failed* repairs: **73.0% Pass@1 SWE-Bench Verified** (Claude 4 Sonnet). Ablations: −6.0 w/o extracted experience, −3.8 w/o reranking, −3.2/−2.6 per level. | [30] |
| **Repo retrieval at generation time** | RepoCoder: **>10%** over in-file baseline on RepoEval. CodeRAG-Bench: canonical docs give GPT-4o **+27.4 SWE-Bench**, RepoEval **+7.5–17.2 pts**; but SWE-bench Lite stays hard and open-retrieval repo gains are "rather limited." | [31][32] |
| **Structural codebase memory / ACI** | Codebase-Memory (Tree-Sitter KG over MCP): **83% quality vs 92%** for file exploration, at **10× fewer tokens, 2.1× fewer tool calls** — unreviewed preprint [33]. SWE-agent: interface design alone → SWE-bench 12.5% [34]. | [33][34] |

**Failure note.** Anthropic's "just-in-time" pattern keeps *identifiers* (paths, symbols) and loads on demand; Claude Code drops `CLAUDE.md` up front and globs/greps for the rest, explicitly to bypass "stale indexing and complex syntax trees" [23]. Pre-indexing goes stale the moment the agent edits a file — §6's worst failure mode.

**How much does it help?** Procedural memory transfers; repo retrieval modestly; both less than interface design. The largest deltas (+24–51% AWM, +20–30 AutoGuide, 73% SWE-Bench Verified) come from **distilling trajectories into reusable guidance**, not storing code. Repo retrieval yields single-to-high-teens gains and degrades on repo-level reasoning [32]; the one direct SWE-bench comparison found masking competitive with an LLM summarizer [20].

---

## 6. Counter-Evidence: Measured Harms

| Failure mode | Concrete measured harm | Src |
|---|---|---|
| **Memory poisoning** | AgentPoison: **>80% ASR at <0.1% poison rate**, <1% benign impact, no fine-tuning, transfers across driving/QA/EHR agents. | [18] |
| **KB corruption** | PoisonedRAG: **90% ASR from 5 texts** in a million-text DB; defenses insufficient. | [19] |
| **Context bloat** | Unmanaged growth is the costliest strategy in every config; in 3/5 setups the *most efficient* strategy also scored *higher* — "more context becomes a liability rather than an asset." | [20] |
| **Wrong/stale context** | Distractors reduce performance individually, compounding with length; models answer confidently from the distractor. Stale indexes are the same hazard. | [4][23] |
| **Over-applied guidance** | ExpeL (all guidelines, no selection) confuses the agent; 59.0% vs AutoGuide 79.1% on ALFWorld. | [22] |
| **Multi-turn degradation** | All tested frontier models lose **39% average** multi-turn vs single-turn — "when LLMs take a wrong turn… they get lost and do not recover." A memory write encodes that wrong turn. | [35] |
| **Benchmark self-reporting** | Vendor LoCoMo tables are incomparable (different backbones; Mem0 *excludes* the adversarial category); the independent run inverts the ordering. | [8][9] |

---

## 7. A First-Principles Minimal Design (evidence-per-complexity)

**Tier 0 — free, and beats sophisticated memory in direct tests.** (1) **Observation masking + hard capacity eviction** on tool outputs, keeping actions and decisions: halves cost, matches summarization's solve rate [20]. (2) **Just-in-time identifiers over pre-indexed content** [23]. (3) **A tiny always-resident project brief** (build commands, invariants, "where things live") — small: it sits in the attention budget permanently [4][23].

**Tier 1 — high evidence, low complexity.** (4) **Recency + similarity retrieval with a `source: authoritative|observation|guess` flag** [10]; authoritative beats recent on conflict, a cheap substitute for unsolved selective forgetting. (5) **Write facts, not transcripts**, fact-sized with timestamps, at a fixed trigger [7][9][10]. (6) **Chain-of-Note / structured reading** [7]. (7) **Invalidate, never delete**: bi-temporal `valid_from`/`valid_to`, default queries filtering `valid_to IS NULL` [9][16].

**Tier 2 — worth it, only after Tier 0–1 are measured.** (8) **Procedural distillation**: mine successful *and failed* trajectories into context-conditional guidelines retrieved by current state, top-k≈3 — the best-evidenced *large* win for coding [21][22][30]; needs a curator role that validates (report 30's split). (9) **Sleep-time precomputation** over the persisted repo, amortized across questions, when predictable [25]. (10) **Hybrid lexical+vector with iterative re-retrieval** [8][11].

**Tier 3 — unproven; adopt only on a local ablation win.** KG memory / PPR [12][13]; Ebbinghaus decay [17]; LLM summarization as the primary strategy [20]; commercial memory layers [8]; structural codebase graphs [33].

**One-line answer.** *A small always-resident project brief; aggressive masking of tool output; fact-sized, timestamped, invalidatable writes at a defined trigger; recency+similarity retrieval with an authority flag; structured reading. Everything else — graphs, decay, LLM summarizers, memory products — must beat that baseline locally.*

---

## 8. What Is Honestly Unmeasured

- **Optimal retrieval weights** — Generative Agents' α=1 is copied everywhere, never ablated [10].
- **Optimal write cadence** — no study compares per-turn vs end-of-task vs threshold writes at a fixed token budget.
- **Forgetting curves** — no decay schedule beats capacity eviction; selective forgetting ceilings at ~28% multi-hop [8].
- **Per-entry causal contribution** — aggregate deltas only (report 30 §4's attribution problem).
- **Coding-specific memory, cleanly** — SWE-Exp/AWM/AutoGuide measure *trajectory distillation*, not "does remembering this repo help"; nothing isolates repo memory from retrieval from interface design [32].
- **Cost-normalized comparison** — almost no paper reports accuracy at matched token/dollar budget [8][20][27].
- **Vendor-vs-vendor** — unresolved. Mem0 reports beating Zep [9]; Zep reports beating MemGPT on DMR and +18.5% on LongMemEval [16]; the independent run reverses Mem0/Zep [8]. Zep's methodological rebuttal could not be retrieved (`blog.getzep.com` 404s, no Wayback snapshot), so I claim nothing about it.

---

## Full Citation List

1. Sumers et al. — *CoALA*, TMLR 2024. arXiv:2309.02427
2. Zhang et al. — *Survey: Memory Mechanism of LLM Agents*, 2024. arXiv:2404.13501
3. Hu et al. — *Memory in the Age of AI Agents*, 2025/26. arXiv:2512.13564
4. Hong, Troynikov, Huber (Chroma) — *Context Rot*, Jul 2025. research.trychroma.com/context-rot **[non-peer-reviewed]**
5. Hsieh et al. — *RULER*, COLM 2024. arXiv:2404.06654
6. Modarressi et al. — *NoLiMa*, ICML 2025. arXiv:2502.05167
7. Wu et al. — *LongMemEval*, ICLR 2025. arXiv:2410.10813
8. Hu, Wang, McAuley — *MemoryAgentBench*, 2026. arXiv:2507.05257
9. Chhikara et al. (Mem0) — *Mem0*, 2025. arXiv:2504.19413
10. Park et al. — *Generative Agents*, UIST 2023. arXiv:2304.03442
11. Zeng et al. — *Structural Memory of LLM Agents*, 2024. arXiv:2412.15266
12. Gutiérrez et al. — *HippoRAG*, NeurIPS 2024. arXiv:2405.14831
13. Gutiérrez et al. — *HippoRAG 2*, ICML 2025. arXiv:2502.14802
14. Xu et al. — *A-MEM*, NeurIPS 2025. arXiv:2502.12110
15. Zhang et al. — *ACE*, ICLR 2026. arXiv:2510.04618
16. Rasmussen et al. (Zep) — *Zep/Graphiti*, 2025. arXiv:2501.13956
17. Zhong et al. — *MemoryBank*, 2023. arXiv:2305.10250
18. Chen et al. — *AgentPoison*, NeurIPS 2024. arXiv:2407.12784
19. Zou et al. — *PoisonedRAG*, USENIX Sec 2025. arXiv:2402.07867
20. Lindenbauer et al. (JetBrains) — *The Complexity Trap*, DL4C@NeurIPS 2025. arXiv:2508.21433
21. Wang et al. — *Agent Workflow Memory*, 2024. arXiv:2409.07429
22. Fu et al. — *AutoGuide*, 2024. arXiv:2403.08978
23. Anthropic — *Effective context engineering for AI agents*, Sep 2025. anthropic.com/engineering/effective-context-engineering-for-ai-agents **[blog, non-peer-reviewed]**
24. Wang et al. — *Recursive Summarization for Dialogue Memory*, Neurocomputing. arXiv:2308.15022
25. Lin et al. (Letta) — *Sleep-time Compute*, 2025. arXiv:2504.13171
26. Packer et al. — *MemGPT*, 2023. arXiv:2310.08560
27. Li et al. — *Self-Route*, EMNLP 2024. arXiv:2407.16833
28. Xie et al. — *Adaptive Chameleon or Stubborn Sloth*, ICLR 2024. arXiv:2305.13300
29. Xu et al. — *Knowledge Conflicts for LLMs: A Survey*, 2024. arXiv:2403.08319
30. Chen et al. — *SWE-Exp*, 2025. arXiv:2507.23361
31. Zhang et al. — *RepoCoder*, EMNLP 2023. arXiv:2303.12570
32. Wang et al. — *CodeRAG-Bench*, 2024. arXiv:2406.14497
33. Vogel et al. — *Codebase-Memory*, 2026. arXiv:2603.27277 **[unreviewed preprint, single source]**
34. Yang et al. — *SWE-agent*, NeurIPS 2024. arXiv:2405.15793
35. Laban et al. — *LLMs Get Lost In Multi-Turn Conversation*, 2025. arXiv:2505.06120

**Further reading (not cited inline):** *From Human Memory to AI Memory* (2504.15965); *Context Engineering Survey* (2507.13334); *EM-LLM* (2407.09450); *MemOS* (2507.03724); *Prompt-Injection Design Patterns* (2506.08837); *LoCoMo* (2402.17753). Reused repo artifacts: `research/30-self-improving-agent-pipelines.md` (ACE, ExpeL, AWM, Reflexion, Voyager), `research/09-papers-agent-skills.md`, `research/01-papers-ai-agent-prompts.md`.

**Caveats.** (i) Several headline numbers (Mem0, Zep, A-MEM) are vendor self-reports on LoCoMo; the only independent cross-vendor comparison is MemoryAgentBench, which reverses them [8]. (ii) `Context Rot` and `MemoryAgentBench` are 2025–26 artifacts — less replicated. (iii) The Anthropic post and Codebase-Memory preprint are non-peer-reviewed. (iv) No paper compares architectures at matched token/dollar budget.