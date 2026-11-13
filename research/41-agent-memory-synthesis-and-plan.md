# Research Report: Agent Memory for Fredo — Synthesis and Proposed Plan

**Agent:** Synthesis (of `research/35`–`research/40`) + local tree verification
**Date:** 2026-11-12
**Scope:** Resolve the six research streams into one defensible design for a memory system for Fredo. The model is **one store, two tiers of delivery**: a small *rendered projection* pushed into every prompt (short-term), and a *tool the agent calls* for depth (long-term). Telemetry is the input. Proposes the spec decomposition for the Product Owner. **No code changes.**
**Inputs:** `35-agent-memory-architectures.md`, `36-postgres-vector-retrieval.md`, `37-opencode-plugin-hooks-and-mcp.md`, `38-memory-governance-and-evaluation.md`, `39-telemetry-to-memory-ingestion.md`, `40-coding-agent-memory-prior-art.md`.

> **Revision 2 (2026-11-12, operator-driven).** The first draft treated short-term memory as a second store. It is not. The operator's model — *inject taxonomy terms and a short burst drawn from long-term memory; the agent pulls the rest* — is simpler and removes an entire subsystem (no session-scoped writes, no two-store sync, no stale second copy). §3, §4 (D7), §4.1 and the M2/M4 scope below are rewritten accordingly. **The plugin tool moves from M4 into M2**, because it is now the primary read path rather than a side door.

---

## Verdict

Build it — but build the **small, auditable, provenance-first** version, not a "memory product". The evidence is unusually one-sided:

- **Every commercial memory layer loses to a plain long-context agent under independent test** (`35` F4; `40` F6). The win condition is *what you put in the window*, not which store you own (`35` F3).
- **The industry converged on files for content and on tiny indexes for retrieval** (`40` F2). No major coding agent uses a database as its primary memory. Fredo's differentiation is not storage — it is **provenance + outcome correlation + a review UI**, which only an app owning the telemetry pipeline can build (`40` F6).
- **The write path is the security-critical path.** Telemetry contains tool output; a memory derived from a tool result is a third-party write primitive. AgentPoison measures **>80% ASR at <0.1% poison rate**, and no content-filter defense survives (`38` F1/F2).
- **Vectors are not needed to *start*, but shipping both arms together is the better plan** — FTS costs 1–2 engineer-days and zero install size; exact brute-force over `bytea` measures **6–12 ms at 100k×384/768** (`36` F4–F8). Shipping lexical+dense in one phase gives the eval all three arms at once (§4.1).
- **The two tiers are one store, two deliveries.** Short-term is a *rendered projection* (taxonomy of identifiers + a few bursts), long-term is a *tool call*. That removes an entire subsystem versus a session-memory store, and makes the taxonomy's shape the load-bearing design decision (§4.2).

The one thing I would change from the brief: **`pgvector` is effectively off the table** for a shipped desktop app — no official Windows build, an `nmake`+MSVC path, ABI coupling to the exact PG minor, three index-corruption classes in its 2026 changelog, and it breaks the SHA-256-pinned Postgres archive attestation the security audit already relies on (`36` §2).

---

## 1. What the six streams agree on

| Claim | Streams | Strength |
|---|---|---|
| Write **facts**, not transcripts | `35` §3–4, `39` §2, `40` §3 | Strong — converging evidence (ExpeL, Mem0, Copilot Memory, AWM) |
| **Capacity eviction beats decay curves** | `35` §4, `39` §8 | Strong — MemoryBank's Ebbinghaus decay ranks last everywhere |
| **Lexical/BM25 is a hard baseline** | `35` §3, `36` §3, `38` §6 | Strong — BM25 41.5 vs 128K agent 42.2 on MemoryAgentBench |
| **Observation masking > LLM summarization** on cost at equal solve rate | `35` F8, `39` F5 | Strong (arXiv:2508.21433, 5 configs) |
| **Reading/formatting beats retrieval engineering** | `35` F3 | Strong — up to +10 absolute points |
| **An index is a measurable cost; the full body is followed more often** | `40` F8 | **Measured** — 95% vs 72% (Copilot Memory A/B) |
| **Injection must never block the prompt** | `37` §2.2, `39` §6 | Strong — a hook throw propagates |
| **Trust tiers + write-path elimination are the only defenses that survive** | `38` §2 | Strong — measured failures for every filter |
| **Selective forgetting (superseded facts) is unsolved** | `35` F7 | Strong — ~28% ceiling on multi-hop |
| Exact-dot-product time is the binding constraint for vectors | `36` §4 | Measured locally |
| An honest eval has never been run on coding-agent memory | `35` §8, `38` F7, `40` §3 | Strong (absence of evidence) |

## 2. What the streams contradict, and how I resolve it

**(a) Files vs database.** `40` shows every shipped coding-agent memory is a file (Claude Code `MEMORY.md`, Cursor rules, Cline memory bank). `39` argues for a dedicated Postgres store. **Resolution:** both. Postgres is the **system of record** (provenance, FTS index, tombstones, per-project scoping, outcome correlation — none of which a markdown file can do). The **agent-facing surface stays file-shaped and tiny**: a rendered brief injected into the system prompt, and a short result list from a recall tool. Do not expose the schema to the agent.

**(b) Plugin tool vs MCP for reads.** `37` F7 says the plugin tool wins outright because it is the only surface carrying `sessionID`. The brief asked for MCP. **Resolution (revised in Rev 2):** the **plugin tool is the primary read path** and ships in M2; the MCP server is a thin adapter over the same service, shipped in M4 for cross-agent reuse (Claude Code, Cursor, anything MCP). MCP is not session-aware in OpenCode 1.15.5, which is acceptable because long-term memory is project-scoped anyway — but it means MCP can never serve session-adjacent memory, so it cannot be the only surface.

**(e) Short-term as a store or a view.** The first draft implied a session-scoped store. **Resolution (Rev 2):** short-term is a **rendered projection of long-term memory** — taxonomy + bursts, computed per prompt, never persisted. This removes a subsystem (no session writes, no two-store sync, no stale second copy) and replaces it with two requirements: identifier-shaped taxonomy terms, and a non-persisted projection (§4.2). The two tiers differ in *delivery* (push vs pull), not in *storage*.

**(c) LLM distillation or not.** `35`/`39` say the baseline to beat is masking, and `36`/`38` say a small local model is slow and injection-prone. **Resolution:** **Phase 1 is LLM-free** — deterministic facts from `sessionRollup` plus span attributes. LLM distillation arrives only in a later phase, batched at session end, off the hot path, with a hard timeout and a Phase-1 fallback.

**(d) The "project scope gap".** `39` §2 reports no project/repo/cwd attribute in the plugin contract and calls it the one hard dependency. **Correction, verified locally:** the plugin host already provides everything needed — `PluginInput` carries `directory`, `worktree`, and `project: { id, worktree, ... }`, and `Session.projectID` / `Session.directory` exist in the SDK (`@opencode-ai/plugin/dist/index.d.ts`; `@opencode-ai/sdk/dist/gen/types.gen.d.ts:465-492`). The gap is only that `apps/opencode-plugin` does not *emit* it yet — a small additive change, not a blocker.

## 3. The design (one screen)

**One table, two tiers of delivery.** "Short-term" is a *rendered view* of long-term memory — computed per prompt, never stored. There is no session memory table and therefore no sync problem: deleting a memory changes the very next render.

```
                         memory_records  (one table, project-scoped)
                                     │
                     ┌───────────────┴───────────────┐
                     │                               │
             SHORT-TERM (push)                LONG-TERM (pull)
        taxonomy + 2–3 bursts                query on demand
        ~250–300 tok, every request           ~1–2k tok, when asked
        RENDERED, never stored                RANKED, with provenance
                     │                               │
      system.transform appends          plugin tool / MCP tool
                     │                               │
                     ▼                               ▼
      ┌───────────────────────┬───────────────────────────────┐
      │ lexical arm           │ dense arm                     │
      │ tsvector+gin          │ bge-small @384d exact cosine  │
      │ ts_rank_cd            │ (skipped if absent)           │
      │ (+ pg_trgm rescue)    │                               │
      └───────────┬───────────┴───────────────┬───────────────┘
                  └────────► RRF k=60 ◄────────┘

                    WRITE PATH (never blocks)
  OTLP ──► ingest classifier ──► rows ──► session.idle ──► distiller (try_send)
                                                              │
                                       trust tier + secret gate + dedup key
                                                              ▼
                                                     memory_records (PG)
                                                              │
                                             embedding worker (async, optional)
```

**The two tiers, stated precisely:**

| | Short-term (push) | Long-term (pull) |
|---|---|---|
| What | Taxonomy of identifiers + 2–3 recent bursts + a count | Full ranked results |
| How | Rendered from live rows, injected via `experimental.chat.system.transform` | `memory_recall` tool, project-scoped |
| Cost | ~250–300 tokens × every model request (5–15×/turn, prompt-cached) | ~1–2k tokens, only when called |
| Purpose | Make the agent *aware* something exists | Give it the actual content |
| Failure mode | Too abstract ⇒ never triggers a pull | Too expensive ⇒ context bloat |

**Invariants** (each becomes an acceptance criterion somewhere):
1. Memory can never delay or fail a prompt. Every hook fails open; a throw is a bug.
2. Nothing is retrieved that cannot be traced to a `source_excerpt` and `source_span_ids`.
3. Tool-derived observations are quarantined by default; the user can see the tier.
4. Delete is immediate, and re-derivation never resurrects it (tombstones).
5. Injected memory is **data, never instructions** — it lands after the system prompt's authoritative block, labelled as untrusted notes.
6. The settings toggle is the single authority: off ⇒ no injection, no MCP tools, byte-identical prompt.
7. **The short-term projection is computed from live rows, never persisted** — a taxonomy term that outlives its memories would make the agent query and get nothing, teaching it to stop querying.
8. **Taxonomy terms are concrete identifiers, not abstract categories** (`rtdb-ingest-classifier`, not `architecture`) — the condition under which a signpost actually triggers a pull (§4.2).

## 4. Decisions (CONFIRMED by the operator, 2026-11-12)

| # | Decision | Confirmed choice | Consequence |
|---|---|---|---|
| D1 | **Default state** | A settings toggle in the Fredo Settings surface (Companion/Appearance/Fredo Setup/Telemetry pattern); no separate invisible default | The toggle governs BOTH the MCP exposure and the hook injection — one switch, two effects, stated in the UI copy |
| D2 | **Distillation** | **Deterministic first, LLM layer later** | M1 derives memories from structured session data with no AI; M5 adds `kind='fact'` rows from the local `llama-server` as an ADDITIONAL layer with timeout + fallback to M1 output. Never replaces, never blocks. |
| D3 | **Read surfaces** | **Plugin tool + MCP** | One memory service, two adapters: plugin tool = session-aware; `fredo mcp-memory` = cross-agent, project-scoped |
| D4 | **Scope unit** | **Project/repo** | `project_id` NOT NULL; `'unscoped'` rows are never retrievable |
| D5 | **Retention** | **Forever — user deletes manually** | `memory.retention_days = 0` means "never expire". Compensate with a size warning + bulk delete in M3, since the store then grows monotonically. |
| D6 | **Vectors** | **Ship both arms** — lexical in **M2a**, dense + RRF fusion in **M2b** | See §4.1. M2a has zero new dependencies and is fully useful alone; M2b adds the embedding model + worker + cache. Dense degrades silently to lexical when unavailable. |
| D7 | **Short-term model** | **A rendered projection, not a store** — taxonomy of identifiers + 2–3 bursts + a recall count, computed from live rows each prompt | Removes the session-memory subsystem entirely. Adds two requirements instead: the taxonomy must be identifier-shaped, and the projection must never be persisted. See §4.2. |
| D8 | **Read-path priority** | **The plugin tool is primary**; the short-term block is a *signpost* | The plugin tool ships in **M2a**, not M4. It is now the main read path, so its latency and result quality matter more than the injected block's content. |

## 4.1 How "ship both" works, and why it beats staging

**Two retrieval arms over the same table, fused by Reciprocal Rank Fusion** — `score(d) = Σ_arms 1/(60 + rank_arm(d))`, the standard k=60 setting (`36` §6).

| Arm | Technology | Strong at | Cost |
|---|---|---|---|
| Lexical | `tsvector` (STORED) + GIN, `ts_rank_cd(…,32)`, `pg_trgm` rescue on zero results | identifiers, error strings, file paths, symbol names | ~0 (already in the distribution) |
| Dense | bge-small-en-v1.5 @384d Q8 GGUF through a dedicated embedding path (NOT the companion server — see M2 prerequisite 1); exact cosine over a `bytea` column with `SET STORAGE PLAIN`; process-owned `f32` cache keyed by epoch | paraphrase, "where is X implemented", conceptual queries | 35 MB model, an embedding worker, a cache, a re-embed pass on model change |

**Why fusion rather than a fallback chain:** a degraded embedder (absent model, embedding server down, half-embedded corpus) leaves the lexical arm intact, so the read path is *always* functional — RRF naturally weights whichever arm has results. This preserves the fail-open invariant while still shipping the dense capability.

**Both tiers use the same fused retriever.** The short-term projection is a *different rendering* of the same ranking (top tags + top bursts), not a separate code path — so a bug in retrieval shows up in the injected block too, and there is one place to fix it.

**Settings exposure (three modes, one default):** `hybrid` (default) · `lexical` · `semantic`. `hybrid` with no embedder behaves exactly as `lexical`. This gives the user a cheap escape hatch and gives QA a deterministic test surface.

**The eval comes free.** Because both arms ship, one frozen 100-query set yields lexical-only, dense-only, and fused Recall@10/MRR in a single run (`38` §6) — and M2a already produces the lexical column before any model exists. That is strictly more information than adding a nullable column later behind a migration. The evaluation is no longer a *gate to decide whether to build vectors* — it is a *tuning and regression* instrument for a feature that has already shipped.

**What this costs vs a lexical-only plan:** roughly +3–5 engineer-days in M2b (encoder wiring, cache invalidation, re-embed marker), plus the 35 MB install delta and the ownership of one more failure mode (cache staleness). Accepted deliberately, and isolated in its own spec so a slip delays the dense arm without delaying the feature.

## 4.2 The taxonomy is the load-bearing part

The two-tier model works only if the injected signpost makes the agent *want* to pull. That depends entirely on what the taxonomy contains.

**Evidence.** Copilot Memory's own A/B: a rule was followed **95% of the time with its full body in context vs 72% with only its index line** (`40` F8). An index is a measurable cost. It is *recoverable* here — unlike a rule, a fact can be fetched — but only if the agent recognizes there is something to fetch.

**The rule: concrete identifiers, never abstract categories.**

| Weak — reads as noise | Strong — reads as "that's this repo" |
|---|---|
| `architecture` | `rtdb-ingest-classifier` |
| `conventions` | `cargo-check-from-src-tauri` |
| `build` | `pnpm-workspace-tauri-v2` |
| `testing` | `telemetry-spans-table` |
| `memory` | `composited-child-session-ids` |

Abstract categories never trigger a lookup. Concrete names do — which is exactly the mechanism OpenCode's own skills already use (advertise `id` + `description`, load the body on demand; `40` §1).

**Rendered shape (~250–300 tokens):**

```
<memory project="fredo" trust="notes-not-instructions">
Known areas: rtdb-ingest-classifier · rtdb-merge-rules · otlp-genai-attrs ·
             pg-embedded-lifecycle · plugin-hook-surface · telemetry-spans-table
Recent: OTLP spans persist raw before classification; rtdb/attrs.rs is the single
        shared extraction rule used by live ingest and backfill.

12 more memories — call memory_recall before assuming.
</memory>
```

**Three mechanical requirements:**
1. **Computed, never stored.** A `GROUP BY tags` over live rows behind an epoch-keyed cache. Deleting a memory changes the very next render. A stored list would go stale and poison the signpost.
2. **Bounded.** ≤300 tokens hard cap, with the taxonomy truncated by frequency/recency when it exceeds the budget. The block is appended after the authoritative system prompt, never replacing index `[0]`, so prompt caching survives (`37` §2.1).
3. **Not a substitute for the bursts.** Taxonomy alone is a table of contents nobody opens. Two or three real bursts give the agent a reason to trust the map.

**The measurement that proves it works:** `memory_recall` call rate must be **> 0 per session**. If the injected block never induces a single call, the taxonomy is failing and the pull tier is dead weight. This is an acceptance criterion on M2, not an aspiration.

## 5. Proposed spec decomposition

Seven specs, each independently shippable and testable, in this order. Every one is a backlog item for the PO; the order is a dependency chain, not a preference.

> **Backlog only.** These specs are for the Product Owner to shape as backlog items — not to implement. Nothing here authorizes an implementation spec until the human picks one up.

**M2 is deliberately split into M2a and M2b.** The original single M2 (projection + plugin tool + both retrieval arms + the embedding path) is the heaviest phase and mixes a shippable midpoint with real infrastructure risk. M2a is fully useful on its own with zero new dependencies; M2b adds the dense arm and is the only phase that touches model acquisition. If M2b is deferred indefinitely, M2a still ships a working feature.

| # | Spec | Delivers | Observable acceptance (shape) |
|---|---|---|---|
| **M1** | **Memory store foundation** | `memory_records` + `memory_tombstones` DDL beside `PG_TELEMETRY_DDL`; `MemoryStore` beside `span_store.rs`; `project.id` emitted by the plugin; deterministic session-end projection from `sessionRollup`/row data; **no LLM, no retrieval, no UI** | After a session ends, ≥1 `kind='episode'` row exists with non-empty `source_excerpt` and `source_span_ids` resolving in `telemetry_spans`. Re-running ingestion produces **0** new rows. Delete → re-run → **0**. An unscoped session lands in `project_id='unscoped'` and is retrievable by nothing. |
| **M2a** | **Projection + read path (lexical)** — *the first useful phase; zero new dependencies* | **(a) Short-term projection**: taxonomy of identifier-shaped tags + 2–3 bursts + recall count, rendered from live rows behind an epoch-keyed cache, ≤300 tokens, injected via `experimental.chat.system.transform` after index `[0]`. **(b) Plugin tool `memory_recall`**: the PRIMARY read path, carrying `sessionID`, reaching Rust over the existing `\\.\pipe\fredo-ipc` (`CliCommand::MemoryRecall`). **(c) Lexical arm only**: `websearch_to_tsquery` + `ts_rank_cd(…,32)` over a **`STORED`** `tsvector` + GIN, with `pg_trgm` zero-result rescue. | **The block ≤300 tokens and contains identifier-shaped tags, not categories.** With the toggle off, the block is absent and the prompt is byte-identical to today. With PostgreSQL stopped mid-session, prompts still succeed and the block is silently empty. A project-A query never returns a project-B record. **In a scripted session where the injected block names a tag, the agent calls `memory_recall` at least once.** Deleting a memory removes its tag from the next render. **No model download, no new process, no new native dependency is introduced by this spec.** |
| **M2b** | **Dense arm + fusion** — *additive; may be deferred without breaking M2a* | The embedding inference path (one of the three options in the prerequisites below, chosen in triage); bge-small-en-v1.5 @384d Q8 GGUF into `bytea` (`SET STORAGE PLAIN`) with a process-owned `f32` cache keyed by epoch; model acquisition via the pinned manifest; the re-embed marker pass; **RRF k=60 fusion** over lexical + dense; three retrieval modes (hybrid/lexical/semantic). | **With the embedder absent or stopped, retrieval silently degrades to lexical and still returns results — no error, no empty answer.** The same frozen query set returns non-empty results in all three modes. Recall@10 for `hybrid` ≥ `lexical` on the frozen set (reported, not gated). A model change triggers exactly one marker-gated re-embed pass and never duplicates rows. **M2a's acceptance criteria all still pass unchanged.** |
| **M3** | **Memory control surface** | The settings application section: **the memory on/off toggle** (governs both MCP exposure and hook injection), browse, search, per-row provenance (`source_excerpt`, span link, trust tier), delete, bulk delete, mute/pin, re-embed action, store-size indicator + warning, and the **injection audit log** (what was injected into which session, when, which tags, which arm ranked each recalled row) | Every injected block in M2a has a corresponding audit row. Deleting a memory removes it from the very next retrieval within the same session. A quarantined row is visible but excluded from retrieval unless explicitly enabled. Toggling memory off takes effect on the next prompt without restarting Fredo or the agent. |
| **M4** | **MCP surface for other agents** | `fredo mcp-memory` stdio server (JSON-RPC 2.0, `initialize`/`tools/list`/`tools/call`), read-only, project-scoped, exactly **one** tool; setup-wizard option to register it in `opencode.json`; honours the same on/off toggle. **Thin adapter over the M2a service — no second retrieval implementation.** | The MCP server answers a `memory_recall` call with the same rows the plugin tool returns for the same project, and refuses to answer for a project it was not scoped to. With the server absent, OpenCode starts normally (no config error). With memory toggled off, `tools/list` is empty or the server exits cleanly. **MCP calls carry no `sessionID` (OpenCode 1.15.5), so no session-adjacent memory is returned through this surface** — project scope only. |
| **M5** | **Batched LLM distillation** | Bounded `try_send` worker off `session.idle`; one grammar-constrained `llama-server` call per session; `distill_model`/`prompt_hash` stamped; timeout → M1 fallback; trust tiers enforced | With `llama-server` stopped, the session still yields its deterministic episode and the RTDB write p95 is unchanged. Every distilled fact carries a non-null `distill_model` and `prompt_hash`. The same distillation version produces 0 new rows on re-run; a bumped version produces new rows without mutating old ones. |
| **M6** | **Consolidation + procedures** | `content_key` upsert bumping `reinforcement_count`/`last_seen_at`; contradiction via `valid_to`; curated `kind='procedure'` rows injected sparingly (k≈3) | Two sessions producing the same fact yield **1** row with `reinforcement_count=2`. A superseded fact has `valid_to` set, absent from default retrieval, still queryable. A procedure row is only injected when gated above threshold. |

**M2b carries four prerequisites the PO must scope explicitly** (they are not incidental, and **M2a must not absorb them**). The dense arm must be *implemented* in M2b but *optional at runtime* — so prerequisite 1 is real work even though the acceptance criterion requires graceful degradation:
1. **An embedding inference path — and it cannot reuse the companion server.** `LlamaServerState` holds **AT MOST ONE** managed `llama-server` (`applications/llm_server/state.rs:13-28`, "The companion runtime owns AT MOST ONE managed server"), launched with the chat/vision GGUF; a llama.cpp server loads one model, so it cannot also serve an embedding model. Three viable options, to be chosen in triage: **(a)** a second managed child on its own port with the embedding GGUF and its own PID marker/orphan sweep (mirrors the existing lifecycle — most code, cleanest isolation); **(b)** lazy start/stop of a dedicated embedding server around the embedding worker (lowest idle RAM, worst latency on first embed); **(c)** in-process embedding via a Rust crate (e.g. `fastembed`/`candle`) — no second process, but a new native dependency and it must not resurrect the retired `LlmEngine` pattern. **Do not assume `/v1/embeddings` is a flag away — it is not.**
2. **Model acquisition.** bge-small-en-v1.5 Q8 GGUF must join the pinned acquisition manifest (`infrastructure/companion/models.rs` — `subdir` + `expected_bytes` + optional `sha256` per file). Note the manifest carries **one `subdir` per manifest**, so an embedding model in a different folder needs either a second manifest entry or a per-file subdir — a schema decision for triage, not a given.
3. **Plugin → Rust transport.** The plugin (Bun) must reach the memory service. Reuse the existing `\\.\pipe\fredo-ipc` (`infrastructure/ipc.rs`, 0o600) with a `CliCommand::MemoryRecall` variant, per `37` §5 — not a new HTTP listener, and explicitly **not** port 9223 (`#[cfg(debug_assertions)]`-only tester bridge).
4. **A re-embed path.** Changing the embedding model invalidates every vector; the store needs an `embed_model` stamp and a marker-gated re-embed pass (the same pattern as `rtdb.backfill.completed`).

**Explicit non-goals** (write these into the specs' forbidden changes):
- No `pgvector`, no external vector DB, no second process for storage.
- No decay/Ebbinghaus curves.
- No per-tool-call memory granularity.
- No code-chunk / repository-preindexing memory.
- No memory writes from `webfetch` output without quarantine.
- No second DDL source — memory DDL lives beside `PG_TELEMETRY_DDL`.
- No new `gen_ai.*` attribute outside the OTel GenAI registry.
- **No separate short-term / session memory table** — short-term is a projection of long-term (D7).
- **No persisted taxonomy list** — it is rendered from live rows every time (invariant 7).
- **No abstract-category taxonomy** (`architecture`, `conventions`) — identifiers only (invariant 8).

## 6. The eval: a tuning and regression instrument, not a gate

Because both arms ship by M2b, the eval is no longer a decision gate — it is how you tune RRF weights and detect regressions. `38` §6 is the operative chapter. **M2a's lexical arm already produces a usable eval run**; M2b adds the dense and fused columns to the same frozen set. Minimum viable, and cheap:

- **Frozen local set:** 100 queries drawn from real Fredo history, hand-labelled relevant records. Frozen at creation; never regenerated after the feature ships.
- **Baselines:** no memory; full session context; recency-only top-k; **lexical-only**; **dense-only**; **fused (RRF)**; and (the one nobody runs) a **randomly-selected** write policy. The single run yields all arms at once — the main reason "ship both" beats staging.
- **Metrics:** Recall@10, MRR, **tokens injected per turn**, **p95 retrieval latency**, staleness rate (retrieved a superseded fact), and **poison-trigger ASR** as a first-class metric beside recall.
- **Two tier-specific metrics that must be reported separately** (they measure different tiers and one cannot substitute for the other):
  - **Signpost efficacy** — `memory_recall` calls per session, and the fraction of sessions with ≥1 call. This is the ONLY measure of whether the short-term projection works. Recall@10 says nothing about it: retrieval can be perfect while the agent never asks.
  - **Pull quality** — Recall@10/MRR over the queries actually issued by `memory_recall`, which differ in shape from the injected prompt (natural-language vs raw request).
- **Ablation of the two tiers:** (i) injection only, tool disabled; (ii) tool only, injection disabled; (iii) both. If (i) ≈ (iii), the pull tier is not earning its complexity. If (ii) ≈ (iii), the signpost is not earning its tokens. This comparison is the core experiment of the whole feature.
- **Tuning output:** the RRF weighting, the per-arm `k` cutoffs, and the taxonomy budget split are chosen from this run, not from intuition.
- **Untrustworthy signals to refuse:** any vendor LoCoMo/MemoryAgentBench number; any single-run result; any benchmark whose evidence was visible to the model during training.

## 7. Open risks, ranked

| Risk | Severity | Mitigation in the plan |
|---|---|---|
| Poisoned memory derived from tool output | **Critical** | Trust tiers + quarantine + write-path restriction (M1/M5); never derive facts from `webfetch` by default |
| Injected memory read as instructions | **High** | Labelled untrusted-data block; never above system index 0; never formatted as imperative (`38` §2, `37` §2.1) |
| Cross-project bleed | **High** | `project_id` NOT NULL with `'unscoped'`; retrieval refuses unscoped (`39` §2) |
| Memory silently wrong and unfixable | **High** | M3 browser + provenance + delete; tombstone prevents resurrection |
| Secrets captured into memory | **High** | Rule+entropy gate before INSERT; deny-by-default on credential-shaped paths (`38` §5) |
| Hook API churn (`experimental.*`) | Medium | Fail-open + `if (!fn) continue` semantics mean removal degrades to "no memory", never "broken session" (`37` §1) |
| Cache thrash from a changing injected block | Medium | Keep the block small and stable; never replace `system[0]` (`37` §2.1) |
| Empty-context users get a worse experience than no memory | Medium | The settings toggle; M2a's byte-identical-when-off criterion |
| Embedding cache staleness / half-embedded corpus | Medium | Epoch-keyed cache; `embedding IS NULL` is the work queue; dense arm drops out, lexical continues |
| Unbounded growth under "retain forever" | Medium | M3 store-size indicator + bulk delete; no silent eviction, since eviction contradicts the chosen retention stance |
| **The pull tier never fires** (signpost too abstract) | **High** | Identifier-shaped taxonomy (§4.2); the ≥1 `memory_recall`-per-session acceptance criterion on M2; the tier ablation in §6 |
| **The injection becomes decoration** (tags without bursts) | Medium | Two or three real bursts alongside the taxonomy; the §6 ablation shows whether the block contributes at all |
| **Taxonomy drift** (terms outliving their memories) | Medium | Projection computed from live rows, never persisted (invariant 7); delete removes the tag on the next render |

## 8. What I would tell the PO to include in every spec

1. The **fail-open invariant** as an explicit acceptance criterion, tested by stopping PostgreSQL **and** by stopping the embedding path.
2. The **byte-identical-when-off** assertion for the prompt path, tested by flipping the settings toggle.
3. A **provenance** assertion on every row — no row without `source_excerpt`.
4. The **tombstone** idempotency test (delete → re-derive → still gone).
5. The **trust-tier** assertion — quarantined rows excluded by default.
6. The **settings-toggle authority** — one switch governs injection AND MCP exposure; no hidden second default.
7. The **signpost efficacy** assertion — a scripted session where the injected block names a tag must produce ≥1 `memory_recall` call.
8. The **identifier-shaped taxonomy** assertion — no abstract category may appear in the projection; assert on the rendering function's output shape, not on a hardcoded list.
9. The **≤300-token** hard cap on the injected block, measured on the rendered string.
10. An explicit statement of which baseline the phase must beat, and that "it works" is not a criterion.

---

## Full Citation List

This report synthesises; the citations live in its inputs.

1. `research/35-agent-memory-architectures.md` — taxonomy, context degradation, retrieval predictors, write policy, coding memory, measured harms.
2. `research/36-postgres-vector-retrieval.md` — pgvector feasibility, FTS/`pg_trgm`/`ltree`, measured brute-force, embedding models, RRF, schema, recommendation matrix.
3. `research/37-opencode-plugin-hooks-and-mcp.md` — hook capability matrix, V1/V2 fault line, MCP config semantics, tool-tax measurement, transport, security.
4. `research/38-memory-governance-and-evaluation.md` — poisoning economics, defense grading, telemetry-as-hostile-input, embeddings-are-not-deletable, secret scrubbing, eval design, failure taxonomy, governance artifacts.
5. `research/39-telemetry-to-memory-ingestion.md` — derived-and-stored, unit of memory, segmentation, distillation, idempotency, write safety, schema, retention, phases.
6. `research/40-coding-agent-memory-prior-art.md` — OpenCode primitives, Claude Code/Cursor/Copilot/Aider/Cline, Mem0/Letta/Zep, MCP memory servers, `AGENTS.md`, failure modes.
7. Local verification: `apps/opencode-plugin/node_modules/@opencode-ai/plugin/dist/index.d.ts` (hook contracts, `PluginInput.directory/worktree/project`, `ToolContext`); `apps/opencode-plugin/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:465-492,607-616` (`Session.projectID`, `Session.directory`, `Project`); `apps/tauri/src-tauri/src/infrastructure/storage/engine.rs` (`PG_TELEMETRY_DDL`, `register_slice3_pg_schema_inits`); `apps/tauri/src-tauri/src/infrastructure/storage/span_store.rs`; `apps/tauri/src-tauri/src/infrastructure/ipc.rs` (`CliCommand`, `\\.\pipe\fredo-ipc`); `apps/tauri/src-tauri/src/applications/llm_server/state.rs:13-28` (**AT MOST ONE** managed server); `apps/tauri/src-tauri/src/applications/llm_server/config.rs` (argv builder — chat/vision only, no embedding mode); `apps/tauri/src-tauri/src/infrastructure/companion/models.rs` (pinned manifest, one `subdir`); `apps/tauri/src-tauri/src/applications/pg_supervisor/acquisition.rs:152-158` (PG 18.6.0, pinned archive).

## Revision history

| Rev | Date | Change |
|---|---|---|
| 1 | 2026-11-12 | Initial synthesis of `research/35`–`40`; six-spec decomposition. |
| **2** | **2026-11-12** | **Operator-driven.** Short-term memory redefined as a *rendered projection* rather than a store (§2e, D7, §3, §4.2). Plugin tool promoted from M4 into the read path as primary (D8). Taxonomy shape made a first-class requirement with an identifier-only invariant. Added: signpost-efficacy criterion, two-tier ablation in the eval, projection-not-persisted non-goal, and the "embedding cannot reuse the companion server" prerequisite. |
| **3** | **2026-11-12** | **M2 split into M2a / M2b** so the feature has a shippable midpoint with zero new dependencies (M2a: projection + plugin tool + lexical arm) and the model/infrastructure risk is isolated (M2b: dense arm + RRF + embedding path + re-embed). Seven specs total. Marked **backlog-only**: these are shapes for the Product Owner, not an implementation authorization. |
