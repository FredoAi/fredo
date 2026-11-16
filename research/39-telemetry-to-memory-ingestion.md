# Research Report: Telemetry → Memory — the Ingestion Path from Raw Spans to Durable, Retrievable Memory

**Agent:** Research Analyst (systems design; local + external literature)
**Date:** 2026-11-12
**Scope:** The write side of agent memory: telemetry → candidate → durable → retrieval index — source of truth, unit, segmentation, distillation, idempotency, write safety, schema, retention, phases.
**Method:** Fredo claims read from the tree, cited `file:line`; world claims to docs / primary papers. Builds on `research/20`, `30`, `35`, `36`. No file outside `research/` modified.

---

## Executive Summary (Top 8 Findings)

1. **Only one of Fredo's two derivations is re-derivable.** `rtdb/backfill.rs` replays `telemetry_spans` through the same classifier in a fixed order and re-derives byte-identical rows, so a marker plus a content-no-op gate suffices (`backfill.rs:15-33`). An LLM distillation is not a function of its input, so **memory must be derived-and-stored** — recompute would re-word, re-merge and resurrect deleted records.
2. **The unit is a fact-sized, source-anchored claim**, with a session digest second. "Write facts, not transcripts" is the only write policy with converging evidence (`35` §3-4); code-chunk memory is rejected — pre-indexing goes stale on first edit and trajectory distillation (+24-51%) beats repo retrieval (`35` §5).
3. **`session.idle` is already a terminal, telemetry-flushing boundary** — the plugin stamps the session span with `output`, totals and agent, ends it, then flushes (`session.ts:543-604`, `index.ts:402-405`); compaction is never emitted (`index.ts:17`).
4. **Distillation must not sit on the ingest hot path.** The row writer already sheds storage on overflow (`cache.rs:14-21`); the distiller is a separate bounded worker fed by `try_send`.
5. **The baseline to beat is not "nothing" — it is masking.** Observation masking halves cost while matching or exceeding LLM summarization across five configs (arXiv:2508.21433 [8]). **P1 memory is therefore LLM-free**, over already-computed `sessionRollup` facts.
6. **Idempotency needs two keys:** `occurrence_key` (replay) and `content_key` (consolidation), both UNIQUE + `ON CONFLICT` — the house pattern (`INSERT OR IGNORE`, PK-upsert, seq guards).
7. **Memory must outlive its sources.** Telemetry prunes at `tracing.retention_days` (7, `lib.rs:468`); records carry a verbatim `source_excerpt`, and provenance with evicted spans degrades to *unverifiable*.
8. **Deletion needs a tombstone table, not a nullable flag** — mirroring `application_data_delete` (`lifecycle.rs:71-81`).

---

## 1. Source of Truth: Derived-and-Stored

Raw spans persist on receipt before and independent of classification, `ON CONFLICT (span_id) DO NOTHING` (`span_store.rs:36-40,161-174`). Canonical rows are a read model over that log: replay is ordered so per-turn ids, token deltas and merge outcomes "re-derive deterministically" (`backfill.rs:15-21`), sharing extract helpers with the live path (`backfill.rs:6-13`, NFR-6) — Fowler's complete-rebuild property [1], Kleppmann's "logs are truth, views derived" [2].

**Why memory inverts it.** A canonical row is byte-comparable and cheap to recompute, so recompute is *desirable*. A distilled claim is not: sampling, model and prompt make it non-deterministic, an LLM call makes it expensive, and recompute *undesirably* rewrites what the user knows. Decisively, purely re-derivable memory turns "delete" into a view filter — already resolved in the declared-data layer (`store.rs:10`, `lifecycle.rs:23-28`).

**Decision: `memory_records` is durable.** `telemetry_spans` stays the record for raw evidence; `memory_records` for distilled knowledge. Rebuilds land only as *new candidates* respecting tombstones and `valid_to`. Migration is additive (`distill_*`); retention decouples from telemetry (§8); deletion tombstones by `(project_id, content_key)` (§5).

---

## 2. Unit of Memory

| Candidate | Evidence | Verdict |
|---|---|---|
| **Fact** | Timestamp + importance; summaries hurt except multi-session aggregation (`35` §3-4) | **Primary** |
| **Episode / session digest** | SWE-Exp: distilling successful *and* failed repairs → 73.0% Pass@1, −6.0 without (`35` §5) | **Secondary** |
| **Procedural workflow** | AWM +24.6%/+51.1%; AutoGuide 79.1% vs ReAct 54.5%, but over-application confuses (ExpeL 59.0%) (`35` §5) | **P4**, curated, k≈3 |
| **Code chunk** / summary replacing facts | Pre-indexing goes stale on first edit; JIT identifiers win (`35` §5) | Reject |

Every record carries `project_id`, `kind`, `scope_session_id`, `source_span_ids`, `source_excerpt` (verbatim, survives eviction), timestamps, `trust`, `confidence`, `importance` (the only measured write-time signal — `35` §4), `embedding`/`embed_model`, generated FTS text.

**The project-scope gap (honest finding).** There is **no `project`/`repo`/`cwd` attribute in the plugin contract**: `telemetry-constants.ts:27-72` defines session, agent, token, model, provider, tool, totals and child-completion keys — nothing path-shaped. Options: (1) **preferred** — a new `project.id` resource attribute (plugin contract change, hard P1 dependency; any new `gen_ai.*` key must obey the OTel registry [14]); (2) heuristic from the first `read`/`edit` path; (3) `project_id='unscoped'`. Given AgentPoison's >80% ASR at <0.1% poison rate (`35` §6), **choose (3)**: an unscoped memory can be excluded; a mis-scoped one cannot.

---

## 3. Segmentation

**Existing boundaries.** *Session end* — final span attributes, status OK, span ended (`session.ts:543-571`), `session.idle` log (`:590-604`), landing as an `agent_session_rows` row with totals and `raw_json` carrying `output` (`engine.rs:504-522`). *Turn* — each `fredo.llm` span, corrId `<sessionId>_<counter>` (`ingest.rs:938-969`). *Tool call* — `fredo.tool.<name>` with `gen_ai.tool.call.result` (`message.ts:563-570`). *Compaction* — absent (`index.ts:17`).

Per-tool-call gives max fidelity at the highest volume over the least trustworthy content; turn-level is moderate. **Session-end is primary**: closed, complete, already flushed and aggregated. Semantic chunking shows no consistent gain (arXiv:2410.13070 [7]). RAPTOR's summarisation tree (+20% on QuALITY) is the right *shape* for rollup [6], but rounds beat sessions (`35`), so the hierarchy is **facts → session digest**.

**Rule:** at `session.idle`, read `chat_rows` + `tool_use_rows`, emit 0..N turn-scoped facts, then one episode digest generated *from the facts plus the session's `output`* — never the raw transcript. That is ACE's incremental generate→curate delta, avoiding context collapse (`30` §3, `35` §4).

---

## 4. The Distillation Step

**Heuristic first.** Masking halves cost while matching, sometimes exceeding, LLM summarization (arXiv:2508.21433 [8]). Fredo already computes deterministic session facts: `session_rollup.rs` exposes `RollupGroup`, `SessionRollupFacts` and pure `compute_facts`/`qualifies`/`fact_values` (`:190-240`, `:356-362`). **P1 = a projection over this aggregate + canonical rows. Zero LLM.**

**Local LLM, batched.** Model traffic goes through one managed `llama-server`, with a bounded health probe and a stream that "ALWAYS resolves within `timeout`" (`llm_server/commands.rs:456-512,682-683`). llama.cpp converts JSON Schema to GBNF and accepts `response_format` [13]. Cost, not capability, is the limit — the companion is a small GGUF at `--parallel 1` (`36` §1). **Rule:** one call per session at session end, over extracted facts + `output` + ≤N tool outcomes, grammar-constrained, hard timeout, falling back to P1 on any failure.

**Faithfulness.** Long-context performance degrades with length and mid-position [11]. Summarisers "are highly prone to hallucinate content that is unfaithful to the input document"; entailment correlates better than ROUGE (arXiv:2005.00661 [9]); tuned NLI detection reaches 74.4% balanced accuracy (arXiv:2111.09525 [10]). Hence: never store a claim without a verbatim `source_excerpt`; default LLM trust to `observation`; cap facts per session — over-application degrades behaviour (ExpeL 59.0% vs AutoGuide 79.1%).

---

## 5. Idempotency and Replay

`backfill.rs` is idempotent three ways (`:22-33`): deterministic replay order, PK-upsert, and a content-no-op gate so "seq never inflates and no duplicates appear", plus one-shot markers (`:103-113`). Memory needs the same plus one addition, because distillation is stochastic:

```
occurrence_key = sha256(project_id | kind | scope_session_id
                        | sorted(source_span_ids) | distill_version | prompt_hash)
content_key    = sha256(project_id | kind | normalize(subject|predicate|object))
```

`occurrence_key` guards replay: same spans + same distiller version → same key → `ON CONFLICT DO NOTHING`; bumping `distill_version` deliberately yields a *new* key, because a better distiller may add a record, not overwrite one. `content_key` guards consolidation: the same fact from two sessions collides and `ON CONFLICT DO UPDATE` bumps `reinforcement_count`/`last_seen_at` — Mem0's ADD/UPDATE/NOOP discipline (`35` §4) as an upsert. Normalisation must be specified: JCS discipline — fixed property order, fixed number/string serialisation, UTF-8 [12]. PostgreSQL guarantees `ON CONFLICT DO UPDATE` is atomic with one outcome under concurrency [5]. Marker: `memory.ingest.completed.v{N}` per `distill_version`; ingestion reads `telemetry_spans` through the read-only handle (`begin_read_only`, `engine.rs:125-181`) so `rtdb/store.rs`'s invariant holds.

---

## 6. Write-Path Safety (with report 38)

**(a) Never block; always shed.** The row cache updates synchronously then `try_send`s to a bounded queue; on overflow "the STORAGE work is SHED (counted, logged)" and live state never blocks (`cache.rs:14-21,203-216`). The distiller mirrors it: bounded MPSC of `SessionClosedEvent`, `try_send`, shed-and-count on full.

**(b) Separate connection budget.** The pool is 8 against a server limit of 12 (`engine.rs:23,772`). Holding a connection across an HTTP call starves the RTDB: acquire → write → release, or model first, acquire only for the insert.

**(c) Provenance and trust at insert.** `authoritative` = a user statement in `chat_rows.user_message`, or a repo file the agent read. `observation` = an LLM-derived fact or local trusted tool output (down-weighted). `quarantined` = `webfetch`/web-derived or unverifiable source (**excluded by default**). Measured harm justifies it: AgentPoison >80% ASR at <0.1% poison rate; PoisonedRAG 90% ASR from 5 texts (`35` §6). Quarantine-by-source is cheap: `tool_use_rows.tool_name` identifies `webfetch`.

**(d) Never write memory inside the span-classification loop.** The classifier derives rows unconditionally (`ingest.rs:201-243`); a model call in `process_span_rows` would put LLM latency on the OTLP receiver task. Session-end is the only trigger.

---

## 7. Schema: Dedicated Infrastructure Store

**Why not `application_data`.** Declared columns cap at TEXT/INTEGER/REAL/BLOB (`application_store.rs:41-62`) — no `tsvector`, no generated column, no expression index, no `SET STORAGE`, no cross-application read. Memory is infrastructure and needs all four. Precedent: `SpanStore` sits beside `PG_TELEMETRY_DDL`, created by the same startup registry (`engine.rs:586-617`). Register memory as a third init.

```sql
CREATE TABLE IF NOT EXISTS memory_records (
    record_id          TEXT PRIMARY KEY,  -- occurrence_key
    content_key        TEXT NOT NULL,     -- consolidation key
    project_id         TEXT NOT NULL,     -- 'unscoped' until project.id exists
    kind               TEXT NOT NULL,     -- fact | episode | procedure
    text               TEXT NOT NULL,
    source_excerpt     TEXT,              -- verbatim; survives eviction
    source_span_ids    TEXT NOT NULL DEFAULT '[]',
    scope_session_id   TEXT,
    trust              TEXT NOT NULL DEFAULT 'observation',
    confidence         REAL,
    importance         BIGINT,            -- 1..10, write-time
    reinforcement_count BIGINT NOT NULL DEFAULT 1,
    start_time_ns      BIGINT,
    created_at         TEXT NOT NULL,
    last_seen_at       TEXT NOT NULL,
    valid_from         TEXT NOT NULL,     -- bi-temporal
    valid_to           TEXT,              -- NULL = current
    deleted_at         TEXT,              -- soft delete for reads
    source_evicted_at  TEXT,
    distill_model      TEXT,
    distill_version    BIGINT NOT NULL DEFAULT 0,
    prompt_hash        TEXT,
    embedding          BYTEA,
    embed_model        TEXT,
    embed_dim          BIGINT,
    tsv tsvector GENERATED ALWAYS AS
        (to_tsvector('english', coalesce(text, ''))) STORED
);
ALTER TABLE memory_records ALTER COLUMN embedding SET STORAGE PLAIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_content
    ON memory_records (project_id, kind, content_key);
CREATE INDEX IF NOT EXISTS idx_memory_tsv ON memory_records USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_memory_scope_live
    ON memory_records (project_id, kind, start_time_ns)
    WHERE deleted_at IS NULL AND valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_memory_embed_pending
    ON memory_records (record_id) WHERE embedding IS NULL;

CREATE TABLE IF NOT EXISTS memory_tombstones (
    project_id TEXT NOT NULL, content_key TEXT NOT NULL, deleted_at TEXT NOT NULL,
    PRIMARY KEY (project_id, content_key)
);
```

**Non-obvious clauses.** `STORED` is mandatory — PG 18 defaults generated columns to **VIRTUAL** [4], storing nothing and defeating the index (`36` §3.1). `SET STORAGE PLAIN` is mandatory at 768/1024 dims — a bare vector exceeds the ~2 kB TOAST threshold (`36` §4). `embedding IS NULL` is the work queue (`36` §7). `valid_from`/`valid_to` is "invalidate, never delete" (`35` §4). `deleted_at` filters reads; tombstones block resurrection.

**Retrieval.** P2 is lexical only: `websearch_to_tsquery` (never raises on raw input) with `ts_rank_cd`, weights `{0.1,0.2,0.4,1.0}`, normalisation `32` [3]. RRF (`Σ 1/(60+rank)`) with a dense arm is deferred to P4 behind a measured Recall@10 gate (`36` §6). No pgvector: no official Windows build, three corruption/overflow classes in its 2026 changelog (`36` §2).

---

## 8. Retention and Eviction: Capacity, Not Decay

MemoryBank's Ebbinghaus decay is the weakest system in every later comparison (single-hop F1 5.00; AR-avg 35.6), and "only capacity eviction reliably helps — FIFO is the baseline every system struggles to beat" (`35` §4). **Do not implement decay.** Defaults: `memory.max_records_per_project` 10,000 (cf. `rtdb.max_rows` 100,000); `memory.retention_days` 180, outliving telemetry's 7; `quarantine_ttl_days` 7; evict oldest `last_seen_at` first, `reinforcement_count` desc tiebreak.

**Forgetting when telemetry is gone.** Telemetry prunes at 7 days (`SpanStore::delete_expired`), so `source_span_ids` dangle; a reconciliation pass sets `source_evicted_at` and retrieval down-weights those rows as *unverifiable* (`35` §4). Because `source_excerpt` lives **in the record**, memory stays auditable after the span is gone — the reason that column is non-negotiable.

---

## 9. Phased Implementation Sketch

Phases are shippable and testable; P1-P2 carry no quality risk (LLM-free).

| Phase | Delivers | Acceptance-shaped observable |
|---|---|---|
| **P1 — Deterministic store** | `memory_records` + `memory_tombstones` DDL beside `PG_TELEMETRY_DDL`; `MemoryStore` beside `span_store.rs`; session-end projection over `sessionRollup` + rows; `project_id` (fallback `'unscoped'`); no LLM | After a session, ≥1 `kind='episode'` row with non-empty `source_excerpt` and `source_span_ids` resolving in `telemetry_spans`. Re-running yields **0** new rows; delete + re-run → **0**. |
| **P2 — Lexical retrieval** | `websearch_to_tsquery` + `ts_rank_cd(…,32)` over `tsv`; scope + trust filtering (`trust <> 'quarantined'`); `valid_to IS NULL AND deleted_at IS NULL` default | An identifier from session N returns N's record top-5 within 100 ms at 100k rows; a project-A query never returns a project-B record; quarantined rows need opt-in. |
| **P3 — Batched LLM distillation** | Bounded `try_send` worker off the session-end hook; one `llama-server` call per session with `response_format`; timeout → fall back to P1; `kind='fact'` with `distill_*` columns; trust `observation`; per-session cap `k` | With `llama-server` stopped, a session still yields its P1 episode and RTDB row-write p95 is unchanged. Every P3 fact has non-null `distill_model` + `prompt_hash`. Same version → 0 new rows; bumped → new rows, no mutation. |
| **P4 — Consolidation, embeddings, procedures** | `content_key` upsert bumping `reinforcement_count`/`last_seen_at`; contradiction via `valid_to`; optional `bytea` embeddings + Rust exact scan + RRF k=60 gated on Recall@10; curated `kind='procedure'`, k≈3 | Two sessions producing the same fact yield **1** row with `reinforcement_count = 2`. A superseded fact has `valid_to` set, absent from default retrieval, still queryable. Embeddings ship only if Recall@10 beats P2. |

**Non-goals:** decay curves (§8); pgvector (`36` §2); per-tool-call memory; compaction triggers (not emitted); code-chunk as a primary unit (§2).

---

## 10. Deliberate Gaps

1. **`project.id` does not exist** — every scoping claim depends on a plugin contract change or the `'unscoped'` fallback: the one hard dependency outside `research/`.
2. **No cost/quality comparison at matched token budget** for small-model distillation on a desktop CPU — unmeasured field-wide (`35` §8). P3's "model down ⇒ P1 unchanged" criterion means the gap costs upside, never a regression.
3. **Fact-level causal contribution is unmeasured** (aggregate deltas only, `30` §4, `35` §8).
4. **Selective forgetting is unsolved** — all methods cap at ~28% multi-hop on `FactConsolidation` (`35` §6); `valid_to` + authority flag is the cheap substitute.
5. **`occurrence_key` stability** depends on `source_span_ids` — stable, since `telemetry_spans.span_id` is a PK and spans are insert-only (`span_store.rs:36-40`). Deriving from the raw log, not canonical rows, matters: correlation ids are minted per process.

---

## Full Citation List

**Local** (`path:line`, under `apps/tauri/src-tauri/src/` unless noted): `docs/ARCHITECTURE.md:108,114-121,144,367`; `rtdb/{ingest.rs:201-243,938-969, backfill.rs:1-33,97-113}`; `storage/{span_store.rs:36-40,161-174, engine.rs:23,125-181,457-523,533-582,586-617,772, application_store.rs:41-62}`; `application_data/{session_rollup.rs:190-240,356-362, lifecycle.rs:63-127, store.rs:10,40-67}`; `rtdb/{cache.rs:14-21,203-216, store.rs:60-66}`; `lib.rs:468,477-489`; `llm_server/commands.rs:456-512,682-683`; `apps/opencode-plugin/src/{telemetry-constants.ts:27-72, index.ts:17,397-409, handlers/session.ts:543-604, handlers/message.ts:563-570}`; `docs/telemetry-reference.md:11-90,129-156`; `research/{20,30,35,36}`.

**External.** [1] Fowler, *Event Sourcing*, 2005. [2] Kleppmann, *DDIA*, 2017. [3] PG 18 §12.3 *Controlling Text Search* (`websearch_to_tsquery`; `ts_rank_cd`, Clarke/Cormack/Tudhope 1999; weights `{0.1,0.2,0.4,1.0}`; normalisation `32`; §12.2 covers the stored-`tsvector` + GIN shape). [4] PG 18 §5.4 *Generated Columns* — default **VIRTUAL**. [5] PG 18 `INSERT` — atomic UPSERT. [6] Sarthi et al., *RAPTOR*, 2024 — arXiv:2401.18059. [7] Qu, Tu, Bao, *Is Semantic Chunking Worth the Computational Cost?*, 2024 — arXiv:2410.13070. [8] Lindenbauer et al., *The Complexity Trap*, DL4C@NeurIPS 2025 — arXiv:2508.21433. [9] Maynez et al., *Faithfulness and Factuality in Abstractive Summarization*, ACL 2020 — arXiv:2005.00661. [10] Laban et al., *SummaC*, TACL 2022 — arXiv:2111.09525. [11] Liu et al., *Lost in the Middle*, TACL 2023 — arXiv:2307.03172. [12] RFC 8785 (JCS), 2020. [13] llama.cpp `grammars/README.md`. [14] OTel GenAI semantic conventions — the registry every new `gen_ai.*` key must obey.

**Caveats.** (i) Masking [8] and semantic-chunking [7] carry the most weight; both are recent, so magnitudes are directional, direction solid. (ii) RAPTOR's +20% is multi-document QA, not agent episodes — the *shape* transfers, the *number* does not. (iii) No study compares write cadence at a fixed budget (`35` §8); §3 is judgement, not an empirical optimum.