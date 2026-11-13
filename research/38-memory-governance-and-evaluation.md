# Research Report: Governance, Safety, Privacy, and Evaluation of an Automatically-Populated Agent Memory Store

**Agent:** Research Analyst (adversarial track — assumes you will ship this)
**Date:** 2026-11-12
**Scope:** The non-capability half of memory derived from agent telemetry (spans, logs, chat turns, tool calls) rather than typed by the user: poisoning, telemetry-as-untrusted-input, secrets/PII/erasure, consent, offline evaluation, failure taxonomy, ship-blocking governance. Architecture: `research/35`; Postgres retrieval: `research/36`; plugin surface: `research/37`. Not repeated.
**Method:** Primary papers mined at table/appendix level, not abstracts. OWASP/ICO/EDPB primary pages. Vendor policy from the companies. Fredo tree for what exists today. Two citation errors in the brief corrected in §9. Blog opinion flagged inline; no SEO blog cited.

---

## Executive Summary (Top 8 Findings)

1. **Poisoning is cheap, replayed forever.** AgentPoison: **>80% ASR at <0.1% poison rate**, <1% benign drop, no fine-tuning [1]. PoisonedRAG: **90–97% ASR from 5 texts** into 2.68M clean [2]. MINJA needs **no memory access** — query-only reaches **98.2%/76.8%** injection/attack success [3]. Prompt injection affects one turn; poisoned memory recurs on every matching query.

2. **Every content-filter defense is measured and mostly fails.** Perplexity filtering, paraphrasing, hash dedup, k-expansion all leave ASR high [1][2]. Embedding sanitization fails on *by-construction* entanglement; LLM detectors don't generalize (**0 detections** on 2 of 3 agents) or over-fire (**34/50 false positives**) [3]. What survives is **write-path elimination, immutable trust tiers, capability separation**.

3. **Fredo's telemetry is hostile input, so "derive memory from telemetry" is a third-party write primitive.** `tool_use_rows.tool_output_json` holds file bodies, web pages, shell output, MCP responses verbatim (`engine.rs:482-499`). A memory from a tool result is one an attacker plants via a repo file or page — OWASP LLM01 Scenario #4 [12]. `SECURITY.md:36-37` concedes local processes can inject fake spans; memory makes the fake *durable*.

4. **Embeddings are recoverable, therefore not deletable.** **92%** exact reconstruction of 32-token inputs [8]; **50–70%** word recovery incl. clinical-note names [9][10]; OWASP names inversion as LLM08 [13]. The vector must live in the **same row** as its text (`research/36` §7).

5. **Secret scrubbing is a write-time gate; precision comes only from verification.** gitleaks = regex + Shannon entropy + keyword prefilter + allowlists [15]; trufflehog adds **provider verification across 639 detectors** — near-zero FP, but it needs egress a loopback app should refuse [16]. So: rules + entropy + **deny-by-default on credential-shaped paths/tool names**, before INSERT.

6. **No empirical HCI study of attitudes toward auto-derived coding-agent memory was located.** Adjacent: a 1-month organizational-memory deployment (n=21) finding a **"privacy-awareness tension"** [21]; 13 family dyads proposing **memory segregation, conversational consent, selective sharing, progressive management** [22]; a **331-participant RCT** where personalization raised quality *and trust* [20]. No user-research support exists for this feature.

7. **Public memory benchmarks cannot be primary evidence.** The only independent cross-vendor run reverses the vendor leaderboards (`research/35` F4); contamination is demonstrated (ChatGPT/GPT-4 guess **52%/57%** of masked MMLU options) [17]. Use a frozen local set, **five** baselines, **poison-trigger ASR** beside recall.

8. **Fredo has retention and purge for telemetry and nothing for memory.** `tracing.retention_days` defaults 7 (`lib.rs:468`); `rtdb.retention_days` / `rtdb.max_rows` default 7 / 100,000 (`store.rs:64-66`); `SpanStore::purge_all` exists (`span_store.rs:265`). No memory table, retention knob, browser, injection audit log, or kill switch — all ship blockers (§7).

---

## 1. Poisoning: Measured Economics

| Attack | Mechanism | Numbers | Relevance |
|---|---|---|---|
| **AgentPoison** [1] NeurIPS'24 | Trigger maps the query into a unique embedding region so poisoned demos are retrieved | **≥80% ASR**, <1% benign drop, **<0.1%** poison; 82% retrieval / 63% e2e; **one record, single-token trigger** | Only the embedder is needed — Fredo ships a publicly-known local embedder (`research/36` §5) |
| **PoisonedRAG** [2] USENIX'25 | Black-box = put the target question + desired answer in a document | **97% ASR on NQ** from **5 texts / 2,681,468**; **0.95** vs a **21,015,324-text** dump | Black-box is a repo markdown file |
| **MINJA** [3] 2025 | Induce the agent to write the poisoned record; no trigger in the victim's query | **98.2% ISR / 76.8% ASR**; 99.3/98.9 GPT-4o RAP; utility drop <2% on 3/4 | Agent can **author its own poison** from a steered trajectory |
| **CrAIBench** [4] 2025 | Prompt + memory injection vs ElizaOS | Agents **"significantly more vulnerable to memory injection compared to prompt injection"** | Read-side defenses don't transfer to write-side compromise |

**Structural point.** Retrieval is not a control — AgentPoison optimizes *into* "a unique and compact region in the embedding space" [1], so raising recall raises reach. Corruption also becomes precedent, "progressively lower[ing] the threshold for similar attacks" [5]; Fredo compounds it because the pipeline composites child rows under a parent, so one poisoned subagent session looks like corroborated parent fact.

---

## 2. What Defends, and What Does Not

**Measured failures.** Perplexity filter [1] Tbl 6: ASR-t **47.2 / 61.2 / 59.6**; trigger PPL "almost inseparable" from benign. LLM rephrasing [1][2]: **50.0 / 62.0 / 17.0**; PoisonedRAG NQ **0.97 → 0.87**. SHA-256 dedup [2]: **0.97 → 0.97**. k-expansion [2] §7.4: at **k=50**, N=5, still **41% / 43%** on HotpotQA. Embedding sanitization [3] §5.4: "conceptually feasible but fails in practice." Targeted LLM detector [3] Tbl 5: 131/135 on target, **0 on the other two agents**; general prompt: **34/50 false positives**. Rate limiting / isolation / decay [3] §5.4: bypassed by identity disguise, coordinated attackers, acting immediately before the victim.

| Effective defense | Evidence | Cost |
|---|---|---|
| **Write-path elimination** — no facts from untrusted sources | No measured bypass; OWASP LLM08 "accept data only from trusted and verified sources" [13]; LLM01 #4 [12] | Classify sources before write |
| **Trust tiering + quarantine** | `research/35` Tier-1 primitive (`authoritative\|observation\|guess`); here a security control, immutable at write | Only as good as the assignment |
| **Capability separation (CaMeL)** | **77% of AgentDojo tasks with *provable* security** vs 84% [6] | Control from trusted query only |
| **Spotlighting / datamarking** | ASR **>50% → <2%** [7] | Probabilistic; reduces effect, not the write |
| **SecAlign** | first to push injection **<10%** incl. unseen attacks [11] | Needs fine-tuning — unavailable to a fixed-GGUF app |
| **BIPIA boundary awareness** | white-box ASR **near zero** [14] | White-box needs training |
| **A-MemGuard consensus** | "Cuts ASR by **over 95%**" [5] | **Preprint**; multi-path vs 100–150 ms |

**Read.** Nothing that works is a content filter; the strongest numbers need training Fredo doesn't control. **Fredo must buy safety on the write path.**

---

## 3. Telemetry as Untrusted Input

| Column | Content | Trust |
|---|---|---|
| `tool_use_rows.tool_output_json` | File bodies, shell stdout, web fetch, MCP responses | **Untrusted** |
| `tool_use_rows.tool_input_json` | Paths, commands, queries | Untrusted-adjacent |
| `chat_rows.user_message` | Typed prompt | Semi-trusted (a paste is not) |
| `chat_rows.agent_reply` | Model output | Untrusted for facts; may have ingested tool output |
| `telemetry_spans.attributes_json` / `events_json` | OTLP attrs incl. `gen_ai.*` | Untrusted — any local process writes `:4317`/`:4318` |

**Compounding path.** Grep finds a committed `NOTES.md` line shaped as guidance → the writer extracts it because it is *semantically plausible and task-aligned* (MINJA's property [3]) → stored with no provenance distinction from a user-stated fact → retrieved every session in a small per-project store with no benign dilution → nothing explains why the agent believes it.

**Rules that follow.** Facts only from `user` + `agent_decision` provenance; tool output is *evidence*, never a fact source [12][13]. Immutable `source_kind`/`source_id`/`trust_tier` at write — a mutable tier is a bypass. Label recalled memory "data, not instructions" [7][12]; it may never trigger a tool call on its own authority [6]. Writes land in **quarantine**; promotion needs corroboration or approval [3][5]. Fixed-size, tier-ordered block (`research/35` §6).

**Counterpoint.** Approval-per-fact kills adoption; auto-promote is the vulnerable design. A-MemGuard's 95% suggests a middle: *automatic corroboration-based* promotion — a fact re-derived from a second, differently-provenanced observation [5]. Hypothesis, not practice.

---

## 4. Privacy: Scrubbing, Embeddings, Erasure

**What lands in telemetry.** Credentials outlive rotation. Third-party PII (fixtures, sample clinical data, log lines) — the org is controller, Fredo makes it durable. Proprietary code outlives the session. Paths/usernames are low alone, high for correlation.

**Secret scanning.** gitleaks [15]: regex + `secretGroup` + Shannon `entropy` (example `3.5`) + `keywords` prefilter + allowlists; now **feature-complete, security-patched only**. trufflehog [16]: prefilter over **639 detectors** then **dynamic verification** (e.g. AWS `GetCallerIdentity`) — the only near-zero-FP floor, needing egress. **Fredo position:** live verification calls `aws.amazon.com` with user keys — bad egress for a product whose story is "nothing leaves the machine" (`SECURITY.md:32`). Defensible subset: **rules + entropy + keyword prefilter + allowlist, as a hard gate before INSERT**, plus **deny-by-default on credential-shaped paths and tool names**.

**Embeddings are not deletable — measured.** **92%** exact reconstruction of 32-token text [8]; **50–70%** word recovery, F1 **0.5–0.7**, incl. names from clinical notes [9]; generative inversion reconstructs whole sentences [10]. A vector is lossy but *recoverable*; deleting text while keeping it is not deletion. OWASP LLM08 pairs inversion with "strict logical and access partitioning" and "immutable logs of retrieval activities" [13]. **Only defensible design:** `content` + `embedding` in the **same row**, so one `DELETE` removes both (`research/36` §7).

**What erasure demands.** Erasure must be considered per request; the ICO holds that removing one person's data is "unlikely to affect your ability to fulfil the purposes," so refusal is hard to justify [18]. Where an individual cannot be identified Arts. 15–20 don't apply — **but the controller must demonstrate that**, and it flips when they supply identifying data [18]. EDPB Opinion 28/2024 governs AI-model processing [19]. **Practical:** a local app makes the user the controller, so erasure matters *more*: **enumerability** (list every memory held) and **a delete that deletes** (row + vector + derived summary). A summary hiding entries behind an LLM paraphrase — OpenAI's improved memory [23] — is a transparency regression sold as a feature.

---

## 5. Consent, Transparency, Control

**No peer-reviewed empirical study of attitudes toward auto-derived coding-agent memory was located** — arXiv searches crossing *user attitudes / perceptions / interviews* with *assistant memory / personalization / creepy* returned no direct match.

| Study | N | Finding | Relevance |
|---|---|---|---|
| Organizational-memory chatbot, 1 month (CHI'26) [21] | **21**, 4 labs, 107 Qs | **"Privacy-awareness tension"**: private questions **hid documentation gaps** | Auto-capture removes the deliberate act of contributing — and the social signal that a record exists |
| Family agents (CSCW'25) [22] | **13 dyads** | Independently proposed **memory segregation, conversational consent, selective sharing, progressive memory management** | Four user-requested controls ≈ §7's checklist |
| Personalization RCT [20] | **331**, 3 arms | Personalized AI → **significantly higher quality/creativity**, **higher trust** | The gain is real — which is why raised trust in an unauditable store is a governance problem |

**The creepy line, grounded behaviourally:** users object not to remembering but to **remembering what they did not mean to disclose, somewhere they cannot see, with no way to correct it**.

**Shipped vendor policy (primary).** ChatGPT [23]: opt-out default; "memory summary" is "a high-level view" that "does not necessarily include every detail"; delete the memory **and** the source chat, since "deleting a chat alone does not necessarily delete a separate saved memory"; logs kept "up to **30 days**". Claude [24]: **fully optional**, admin-disableable, **separate memory per project** as "a safety guardrail", incognito, import/export. GitHub Copilot [25]: no memory, but **content exclusion** at repo/org/enterprise — and publishes its limits: exclusion "might not detect indirect file access… **not a substitute for operating-system permissions**".

---

## 6. Evaluation: An Honest Offline Design

| Benchmark | What | Number | Defect |
|---|---|---|---|
| **LongMemEval** [26] ICLR'25 | 500 Qs, 5 abilities | Assistants show **30% drop** | Chat-centric; no code/tool output |
| **LoCoMo** [27] 2024 | ~300 turns, ~9K tok, ≤35 sessions | RAG and long-context lag human | The leaderboard the independent run reverses (`research/35` F4) |
| **MemoryAgentBench** [28] 2025/26 | Incremental multi-turn, 4 competencies | Mem0 **21.1**, Cognee 20.6, Zep 24.0, MIRIX 26.2 vs **BM25 41.5**, 128K FIFO **42.2** | Not a code harness |
| **MemBench** [29] ACL'25 Findings | Factual vs reflective × participation vs observation | **Effectiveness, efficiency, capacity** | Synthetic scenarios |

**Corpus.** 50–150 frozen tasks from Fredo's own `chat_rows`/`tool_use_rows`, hand-labelled gold memories, snapshot hashed.

**Metrics, together.** Recall@5/@10; MRR; answer accuracy; **token cost per task** incl. the block's share; **p95 latency** vs the ~100–150 ms budget (`research/37` §6); **staleness rate** (synthetic file-changed-after-write); **contradiction rate**; **poison-trigger ASR** *with* benign delta — <1% benign drop is what makes it dangerous [1].

**Five baselines.** **No memory** (null); **full context** (the one every commercial system failed to beat); **BM25-only** (strong on identifier-dense history, `research/36`); **recency-only FIFO**; **plausible-random write policy** — same count and budget, random selection. **Almost nobody runs the fifth**, and it answers whether the *extraction policy* mattered or merely *any block of project text*.

**Untrustworthy results.** Contamination — TS-Guessing: **52% / 57%** exact on masked MMLU options [17]; detection is its own subfield [30]. Oracle leakage — models lose 30–60% *even with oracle evidence* [26]. Single-run variance — MINJA per-pair ASR spans **30%–100%** over 9 pairs [3]; use ≥3 seeds. Self-judging — human-label 20%. Cost-blindness — report a Pareto curve (`research/35` §8). Cherry-picked k — report k=3 and k=10.

**Verdict.** Gate on the **local ablation against all five baselines with poison ASR in the same table**; a LongMemEval score is a plumbing check.

---

## 7. Failure Taxonomy and Governance Checklist

| # | Failure | Mitigation | Status |
|---|---|---|---|
| 1 | **Stale facts after refactor** | Bi-temporal `valid_to`; `FactConsolidation` multi-hop ceiling **~28%** (`research/35` F7) | **Partial** — repo-state check at inject time is the only hedge |
| 2 | **Contradiction between memories** | Keep both, tag authority, prefer authoritative on conflict | **Partial** — fixed at display, not at reasoning |
| 3 | **Wrong-project bleed** | Hard partition on `session_id`/`directory`; OWASP LLM08 §2 [13] | **Fully mitigable** — `ToolContext` carries `directory` (`research/37` §4.1) |
| 4 | **Over-retrieval drowning context** | 300–800-token cap, k≈3 | **Mitigable** with a *measured* k |
| 5 | **"Why does it think that?"** | Per-memory source link; "sources" under reply [23] | **Mandatory**; no such surface today |
| 6 | **Irreversibility** | Enumeration + true delete + export (§4) | **Mitigable**; OpenAI's summary-not-complete [23] is the anti-pattern |
| 7 | **Poison persistence** | Write-path tiers, quarantine, corroboration (§3) | **Partial** — residual: plausible fact, semi-trusted source |
| 8 | **Compounding error** | Corroboration before promotion [5] | **Partial** |
| 9 | **Cost creep** | Capacity eviction — reliably helps (`research/35` §4) | **Mitigable** |

Three of nine are fully mitigable (3, 5, 6), all *product* work, not research. The two most safety-relevant (1, 7) have no complete solution in the literature.

**Ship-blocking artifacts — all currently missing.** (a) **Memory retention separate from telemetry** (row defaults are 7 days; inheriting 7 silently deletes it). (b) **Per-project isolation in the query, not the UI** [13][24]. (c) **Memory browser + editor + delete** [23][24]. (d) **Injection audit trail** — OWASP LLM08 #4 [13]; no `fredo.memory.recall` event today (`research/37` §6). (e) **Kill switch** — stopping writes while serving old ones is not one [23][24]. (f) **Provenance display per injected block**. (g) **Export** — GDPR portability [18]. (h) **Scrub-on-write gate** — §4.

**Extend, don't duplicate.** Fredo already has a Telemetry settings section (`SettingsSurface.tsx:231-233`), stats + `purge_all`, bounded row retention, and a local-only posture (`SECURITY.md:32`). Ship the browser, delete, audit log **in the same spec as the write path** — you cannot retrospectively delete what was never attributed (OpenAI [23]).

---

## 8. What Is Honestly Unknown

No measured HCI data on auto-derived coding-agent memory (§5). No published measurement of a *coding* memory poisoned through tool output — the attack numbers are QA/EHR/shopping, transferred by mechanism, not measured on a code corpus. No defense with a proof for this setting; CaMeL's proof [6] concerns tool-call control flow, not a store that reintroduces past data. Selective forgetting is unsolved (~28% multi-hop ceiling) and is the capability coding memory needs most. Quarantine/corroboration cost is unmeasured; A-MemGuard's 95% [5] likely violates a 100–150 ms budget. Secret-scrub recall on tool output is unpublished.

---

## 9. Caveats and Citation Corrections

(i) **arXiv:2403.05530 is Gemini 1.5, not a memory-injection paper** — the intended paper is arXiv:2503.03704 (MINJA) [3]. (ii) **arXiv:2310.06816 is "Text Embeddings Reveal (Almost) As Much As Text"** [8]; *"Are Neighbors Enough?"* is arXiv:2207.13354, a neural n-gram architecture paper with no bearing on embedding inversion — do not cite it here. (iii) A-MemGuard [5] is an unreviewed preprint; its 95% is self-reported. (iv) Attack numbers are non-code domains. (v) TruffleHog's 639/verification claim is a company blog. (vi) §5's adjacent studies are explicitly *not* the missing study.

---

## Full Citation List

**Attacks.** [1] Chen et al. — *AgentPoison*, NeurIPS 2024, arXiv:2407.12784 (§A.2.4 Tbl 6). [2] Zou et al. — *PoisonedRAG*, USENIX Sec 2025, arXiv:2402.07867 (Tbl 11–13, §7.4). [3] Dong et al. — *MINJA*, arXiv:2503.03704v5 (§5.4 Tbl 5). [4] Patlan et al. — *Real AI Agents with Fake Memories*, arXiv:2503.16248. [5] Wei et al. — *A-MemGuard*, arXiv:2510.02373 **[preprint]**.

**Defenses.** [6] Debenedetti et al. — *CaMeL*, arXiv:2503.18813 (77% vs 84%). [7] Hines et al. — *Spotlighting*, arXiv:2403.14720 (>50%→<2%). [11] Chen et al. — *SecAlign*, ACM CCS 2025, arXiv:2410.05451 (<10%). [14] Yi et al. — *BIPIA*, KDD 2025, arXiv:2312.14197. — *AgentDojo*, arXiv:2406.13352.

**Embedding inversion.** [8] Morris et al. — EMNLP 2023, arXiv:2310.06816 (92%). [9] Song & Raghunathan — CCS 2020, arXiv:2004.00053 (50–70%). [10] Li et al. — ACL Findings 2023, arXiv:2305.03010.

**Standards / regulators.** [12] OWASP *LLM01:2025 Prompt Injection* (Scenario #4; mitigations #4, #6). [13] OWASP *LLM08:2025 Vector and Embedding Weaknesses* (risks #1–#4; mitigations #1–#4). — OWASP *Agentic AI – Threats and Mitigations* (Feb 2025). — NIST *AI RMF 1.0* + *Generative AI Profile*. [18] ICO *Guidance on AI and data protection*. [19] EDPB *Opinion 28/2024*.

**Secrets tooling.** [15] gitleaks README. [16] Truffle Security, *Introducing TruffleHog v3* **[company blog]**.

**HCI.** [20] Kelley et al. — arXiv:2510.27681 (n=331 RCT). [21] Lee et al. — *CHOIR*, CHI'26, arXiv:2509.20512 (n=21). [22] Wen et al. — CSCW 2025, arXiv:2508.11030 (13 dyads).

**Vendor policy.** [23] OpenAI — *Memory in ChatGPT*. [24] Anthropic — *Bringing memory to Claude*, 11 Sep 2025. [25] GitHub — *Excluding content from GitHub Copilot*. — Apple — *Private Cloud Compute*.

**Benchmarks.** [26] Wu et al. — *LongMemEval*, ICLR 2025, arXiv:2410.10813. [27] Maharana et al. — *LoCoMo*, arXiv:2402.17753. [28] Hu et al. — *MemoryAgentBench*, arXiv:2507.05257. [29] Tan et al. — *MemBench*, ACL Findings 2025, arXiv:2506.21605. [30] Deng et al. — *Data Contamination*, NAACL 2024, arXiv:2311.09783. — Ravaut et al. — *Contamination Detection Survey*, TMLR 2025, arXiv:2404.00699. — Chhikara et al. — *Mem0*, arXiv:2504.19413 **[vendor; reversed by [28]]**.

**Repo artifacts (verified).** `storage/engine.rs:458-582`; `rtdb/store.rs:64-66`; `storage/span_store.rs:265`; `lib.rs:468`; `SettingsSurface.tsx:231-233`; `docs/SECURITY.md:32,36-37,184`. Prior: `research/35`, `research/36`, `research/37`.
