# Research Report: Semantic and Hybrid Retrieval on Fredo's Embedded PostgreSQL 18 Stack

**Agent:** Research Analyst (external literature + first-principles measurement against the Fredo tree)
**Date:** 2026-11-12
**Scope:** Semantic / hybrid retrieval under fixed constraints - embedded PostgreSQL 18.6 (theseus-rs, `postgresql_embedded` 0.21, x86_64-pc-windows-msvc), no pgvector, no external vector DB / Redis / Python, one managed `llama-server`, `DynamicTableStore` columns limited to TEXT / INTEGER / REAL / BLOB.
**Method:** Verified constraints in `Cargo.toml`, `pg_supervisor/*.rs`, `storage/*.rs`, `application_data/*.rs`, `llm_server/config.rs`, `llama-server-launch.bat`; read primary sources (pgvector README/CHANGELOG/release API, PG 18 docs, llama.cpp server README, six model cards, MTEB, HNSW, ANN-Benchmarks); **measured** exact brute-force k-NN in optimized Rust (Ryzen 5 3600, 6C/12T, rustc 1.94.1).

---

## Executive Summary (Top 8 Findings)

1. **pgvector needs a fork of the distribution.** Zero GitHub releases (API returns `[]`) - no official Windows prebuilt; Windows is source-build only (`nmake /F Makefile.win`, `PGROOT`, x64 prompt, admin).
2. **Its 2026 changelog shows the cost:** two PG-18 compat fixes, three corruption/overflow classes (section 2 table).
3. **PostgreSQL 18 has no native vector type or ANN index.**
4. **Exact brute force already suffices at Fredo's scale - measured.** 100k x 768 = **12.0 ms**; 100k x 384 = **6.1 ms**; 1M x 1024 = **170 ms**. Corpus is "tens-to-hundreds of thousands of rows at most".
5. **Quantization is a storage win, not a speed win.** int8 at 6 threads measured **same latency as f32** (6.44 vs 6.07 ms @100k x 384) - both bandwidth-bound at ~7-8 GB/s; int8 cuts corpus **4x**.
6. **Postgres-native lexical retrieval is good, needs no new extension.** `tsvector` + GIN + `ts_rank_cd`; `pg_trgm` for typos; `ltree` for hierarchy/tags.
7. **SQL cannot do vector math** (`Table 9.57` has no dot/cosine/norm), and **LLVM JIT is disabled** on Windows - exact search must run in Rust.
8. **llama.cpp already serves embeddings.** **Recommendation: ship (B) FTS + pg_trgm + ltree now; design (C) as an additive Rust ranker behind a measured quality gate. Reject (A) pgvector and (D) external store.**

---

## 1. The Constraint Set (verified locally)

| Constraint | Evidence |
|---|---|
| PostgreSQL **18.6.0**, Windows x86_64 MSVC | `pg_supervisor/acquisition.rs:152` `PG_VERSION = "18.6.0"`; `:155` archive URL; `runtime.rs:1177` asserts `"=18.6.0"` |
| `postgresql_embedded` **0.21** owns lifecycle | `Cargo.toml:79`; `runtime.rs:150`, `:185` ("no spawn creation-flag hook") |
| No pgvector artifacts | Ground truth: no `vector` control file, no `vector.dll` |
| Windows x64 distribution | theseus-rs: ICU/OpenSSL/XML/XSLT/LZ4; Zstd 16-18; PL/Python 15-18; **readline and LLVM JIT disabled**; optional extensions not covered |
| Declared column types | `declaration.rs`: `Text, Integer, Real, Boolean, Json` -> `text/bigint/double precision/bytea` (`application_store.rs:54-59`) |
| One managed `llama-server` | `llama-server-launch.bat`: gemma-4-E2B, `--gpu-layers all --threads 6 --ctx-size 131072 --parallel 1` |
| Existing text payload | `chat_rows.user_message/agent_reply`, `tool_use_rows.tool_input_json/tool_output_json`, `span_store.attributes_json` - all `TEXT` |

Every option must be (i) an extension inside the pinned archive, or (ii) TEXT/REAL/BLOB + Rust.

---

## 2. Option A - Add pgvector

`set PGROOT=...` -> `nmake /F Makefile.win` -> install, from an x64 Native Tools prompt as administrator. Documented failures map onto Fredo: `C2196` (wrong arch), missing `postgres.h` (bad `PGROOT` - Fredo has no developer install, only a relocated archive), and `float_to_shortest_decimal_bufn` on PG 17.0-17.2 - proving **ABI coupling to the exact PG minor**. `CREATE EXTENSION vector` is easy; getting `vector.dll` + control/upgrade SQL into `lib/` and `share/extension/` of a SHA-256-verified archive is not.

**Provenance cost - decisive.** Audit finding #2 records the verified archive is discarded and the crate re-fetches. Options: **(1) fork the archive** (build, host, re-pin; rebuild every PG minor - 18.7 is out); **(2) post-extract injection** (ship the DLL as a Tauri resource - but the installed tree is then not byte-identical to the pinned archive, exactly finding #2's class of gap); **(3) build on the user's machine** (needs MSVC; disqualified). Only (2) fits Fredo's cadence, and it weakens the integrity argument.

| Release | Relevant fix |
|---|---|
| **0.8.7** | **Buffer overflow in IVFFlat build** (#1036) |
| **0.8.4** | **`hnsw graph not repaired` on HNSW vacuuming**; insert-during-vacuum error |
| **0.8.3** | **Possible index corruption with HNSW vacuuming**; **Hamming/Jaccard regression *with Postgres 18*** |
| 0.8.2 | **Buffer overflow in parallel HNSW build** (#959); `EXPLAIN` **fixed for Postgres 18** |
| 0.8.1 | Added PG 18 rc1 |

Two of eight 2026 releases were PG-18 compat fixes; three were corruption/overflow classes. Vacuum-hazard mitigation is `REINDEX INDEX CONCURRENTLY` then `VACUUM`. 0.7.0 added CPU dispatching on Linux only, so a Windows build is baseline-ISA or risks `Illegal instruction`. **Verdict:** ~3-5 days for a first build, then a permanent rebuild-per-minor tax plus ownership of an untested extension combination.

---

## 3. Option B - Postgres-Native, Zero New Extensions

**3.1 FTS.** `websearch_to_tsquery` "will never raise syntax errors, which makes it possible to use raw user-supplied input for search" (supports `"phrases"`, `OR`, `-negation`). Ranking: `ts_rank_cd` (cover density, per Clarke/Cormack/Tudhope 1999); weights `{A,B,C,D}` default `{1.0,0.4,0.2,0.1}`; normalization `32`. **GIN is "the preferred text search index type"**; prefer a **stored generated `tsvector` column** over an expression index. **PG 18 gotcha:** generated columns now **default to VIRTUAL** - a virtual `tsvector` recomputes on read and stores nothing, silently defeating the index, so the DDL **must** say `STORED`.

**3.2 pg_trgm.** `similarity()` in [0,1]; `%` at `similarity_threshold` **0.3**; `word_similarity`/`strict_word_similarity` at **0.6**/**0.5**; `gin_trgm_ops`/`gist_trgm_ops` (`siglen` **12**). **Short strings behave poorly** - padding gives `"cat"` only **four** trigrams; use `word_similarity` when one side is short (`word_similarity('word','two words')=0.8` vs `similarity('word','words')=0.571429`). **Index asymmetry:** `ORDER BY t <-> 'word' LIMIT 10` "can be implemented quite efficiently by **GiST**, but **not** by GIN".

**3.3 ltree.** `lquery`/`ltxtquery`; `@>`/`<@`/`~`/`@`, `lca()`; GiST `gist_ltree_ops` (`siglen` 8). A **filter** for session/app subtree and tag hierarchy - not a ranker.

**3.4 Vectors in plain columns.** PG 18 has **no array vector arithmetic** - `Table 9.57` is only append/cat/dims/fill/length/position/remove/replace/reverse/sample/shuffle/sort/upper/cardinality/trim/unnest; operators `@> <@ && ||`. **No dot, cosine, or norm** (pgvector's FAQ: `double precision[]` only works by casting to `vector`). C is therefore **not** "`ORDER BY` a distance in SQL" - it is *bring vectors to Rust and scan a contiguous `f32` buffer*. Per-query fetch (307 MB @100k x 768) is wire-bound; only a **process-owned cache** keyed by an epoch works: 307 MB f32 or 77 MB int8.

**3.5 Quantization.** int8 measured: **no latency win**, **4x size win**. Binary quantization adds **32x vs f32** at real recall cost; the pattern is pgvector's own `bit` strategy - **coarse search quantized, re-rank wider at full precision**. **Defer until >~250k chunks.** **3.6 PG 18 native - verified absence.** No vector type, embedding function, or ANN index. Indirect gifts: **async I/O**, **parallel GIN builds**, **skip scan**.

---

## 4. Option C - Rust Brute Force: Measured Numbers

Deterministic xorshift unit vectors; 8-way unrolled scalar dot (LLVM auto-vectorised to AVX2; **no explicit SIMD, no BLAS**); bounded-heap top-10; `rustc -O`; 1- and 6-thread `std::thread` (per physical core - correct for a bandwidth-bound scan); medians of 3-50 reps after warmup; Ryzen 5 3600, 6C/12T, 3.6 GHz. **Conservative vs a `simsimd`/`faer` kernel (2-4x faster).**

| N | dim | f32 1-thread | f32 6-thread | int8 6-thread | f32 corpus | int8 corpus |
|---:|---:|---:|---:|---:|---:|---:|
| 10 000 | 384 | 2.2 ms | 0.86 ms | 0.88 ms | 15.4 MB | 3.8 MB |
| 10 000 | 768 | 4.0 ms | 2.2 ms | 2.0 ms | 30.7 MB | 7.7 MB |
| 10 000 | 1024 | 5.1 ms | 2.1 ms | 2.0 ms | 41.0 MB | 10.2 MB |
| 100 000 | 384 | 21.6 ms | **6.1 ms** | 6.4 ms | 153.6 MB | 38.4 MB |
| 100 000 | 768 | 39.8 ms | **12.0 ms** | 12.0 ms | 307.2 MB | 76.8 MB |
| 100 000 | 1024 | 53.0 ms | **16.0 ms** | 15.3 ms | 409.6 MB | 102.4 MB |
| 1 000 000 | 384 | 223.1 ms | **60.4 ms** | 61.9 ms | 1.54 GB | 384 MB |
| 1 000 000 | 768 | 428.5 ms | **121.8 ms** | 122.8 ms | 3.07 GB | 768 MB |
| 1 000 000 | 1024 | 597.0 ms | **170.2 ms** | 170.2 ms | 4.10 GB | 1.02 GB |

Sustained **~3.5-4.1 GFLOP/s single-thread, ~7-8.2 GB/s** - saturating in both cases, which is *why* quantization yields no speedup (bandwidth-bound, not ALU-bound; the auto-vectorised int8 loop is not 2x denser without `pmaddubsw` paths).

**Versus HNSW/IVFFlat.** I did **not** benchmark pgvector. Sources: HNSW gives "logarithmic complexity scaling" (arXiv:1603.09320); ANN-Benchmarks: "very different approaches ... yield comparable quality-performance trade-offs" (arXiv:1807.05614). **Wrong trade shape:** ANN makes 10M-1B-vector scans sub-10 ms on a server; Fredo is 10k-200k on one desktop, where 6-12 ms brute force is at or below end-to-end ANN latency once executor overhead, TOAST detoast, and planning are added. Brute force gives **recall = 1.0**; HNSW at default `ef_search = 40` with a filter can return far fewer than k.

**TOAST trap (A and C).** PG moves values out of line above ~2 kB. `vector` = `4d+8`, `halfvec` = `2d+8`, `bit` = `d/8+8`, raw f32 `bytea` = `4d` -> 384 = 1544 B (inline), **768 = 3080 B**, **1024 = 4104 B**. At 768/1024 a bare vector exceeds the threshold alone, turning a sequential scan into random TOAST reads. pgvector documents the fix (`SET STORAGE PLAIN`) and 0.6.0 switched storage `extended`->`external`. **Any `bytea` design MUST declare `SET STORAGE PLAIN`.**

---

## 5. Embedding Models Usable with the Shipped `llama-server`

`tools/server/README.md` lists "OpenAI API compatible chat completions, responses, and **embeddings** routes" plus reranking. Flags: `--embedding`, `--pooling {none,mean,cls,last,rank}`, `--embd-normalize N` (default **2**), `--embd-gemma-default`, `--rerank` (PR #9510). `--embedding` is a *mode* flag; Fredo's companion runs chat, so embedding needs **a second loopback server** or the chat server without `--embedding` - and spike #2948's RSS/startup priors argue against casually adding another process.

| Model | Params | Dims | Ctx | MTEB | Licence | On-disk (f16 / Q8) |
|---|---:|---:|---:|---|---|---:|
| `bge-small-en-v1.5` | 33.4 M | 384 | 512 | **62.17 avg / 51.68 retr.** (v1) | MIT | ~67 / ~35 MB |
| `bge-base-en-v1.5` | 109 M | 768 | 512 | 63.55 / 53.25 (v1) | MIT | ~220 / ~110 MB |
| `bge-large-en-v1.5` | 335 M | 1024 | 512 | 64.23 / 54.29 (v1) | MIT | ~670 / ~340 MB |
| `nomic-embed-text-v1.5` | 137 M | 768 (MRL->64) | 8192 | **62.28** @768; 61.96 @512; 61.04 @256; 59.34 @128 | Apache-2.0 | ~275 / ~140 MB |
| `embeddinggemma-300m` | 300 M | 768 (MRL->128) | 2048 | **69.67** English v2 @768; 66.66 @128; multi v2 61.15; code v1 68.76; QAT Q4_0 69.31 | Gemma (gated) | ~600 / ~320 MB |
| `Qwen3-Embedding-0.6B` | 0.6 B | 1024 (32-1024) | 32k | **70.70** English v2; 64.33 multi v2 | Apache-2.0 | ~1.2 GB / ~640 MB |

**MTEB honestly.** (1) **v1 and v2 scores are not comparable** - bge reports v1 "Average (56)"; EmbeddingGemma/Qwen3 report v2 "Mean (Task)". (2) The paper: "no particular text embedding method dominates across all tasks" (arXiv:2210.07316). (3) **BGE's FAQ forbids thresholds:** "the similarity distribution ... is about [0.6, 1] ... what matters is the relative order, not the absolute value."

**Fit.** Install size matters (spike #2948: +164 MB PostgreSQL was material; the app ships a 2.6 GB chat GGUF + 987 MB projector). **`bge-small-en-v1.5` @384d is the first-cut sweet spot:** MIT, 512 ctx, 384 dims (inline), ~35-67 MB. `embeddinggemma-300m` is quality-per-byte leader, but its card says "activations do not support float16" - use QAT Q8_0/Q4_0 or f32. **No throughput claim is made** - measure with `--embedding`.

**Prompt prefixes are mandatory for some models.** nomic: "the text prompt *must* include a task instruction prefix" (`search_document:`/`search_query:`). EmbeddingGemma: `task: search result | query: {content}`. Qwen3: `Instruct: {task}\nQuery:{query}` (+1-5%). **A model swap is a re-index plus a prompt-contract change, not a drop-in.**

---

## 6. Hybrid Retrieval Design

FTS nails identifiers (`btree_gist`, `io_combine_limit`), error strings, quoted phrases - misses paraphrase. Dense retrieves paraphrase/cross-lingual - unreliable on rare tokens and exact identifiers. Agent history is **dominated by identifiers and error strings**, biasing toward lexical-first.

**RRF** (Cormack, Clarke & Buttcher, SIGIR 2009): `score(d) = sum 1/(k + rank_list(d))`, `k = 60`. It fits because `ts_rank_cd` returns an unbounded corpus-dependent float while cosine returns a model-specific distribution (section 5) - fusing *ranks* sidesteps calibrating incompatible scales.

```sql
WITH lexical AS (
  SELECT id, RANK() OVER (ORDER BY ts_rank_cd(tsv, q) DESC) AS rank
  FROM chunks, websearch_to_tsquery('english', $1) q
  WHERE tsv @@ q ORDER BY ts_rank_cd(tsv, q) DESC LIMIT 50
),
dense AS (SELECT * FROM unnest($2::bigint[], $3::int[]) AS t(id, rank))
SELECT COALESCE(l.id, d.id) AS id,
       COALESCE(1.0/(60 + l.rank), 0) + COALESCE(1.0/(60 + d.rank), 0) AS score
FROM lexical l FULL OUTER JOIN dense d ON l.id = d.id
ORDER BY score DESC LIMIT 10;
```

The dense arm runs in Rust (section 3.4) - one round trip per cache epoch.

| Design | Lexical | Dense | Fusion | When |
|---|---|---|---|---|
| **B1. Lexical-only** | FTS + `ts_rank_cd` + `websearch_to_tsquery`; `ltree` scope | - | - | Ship first. Zero new deps, offline day one |
| **B2. + trigram rescue** | FTS primary; on 0 results, `word_similarity` top-N | - | fallback | When users report "no results for a typo" |
| **B3. RRF hybrid** | FTS rank list | Rust exact k-NN rank list | RRF k=60 | When an eval shows lexical misses paraphrase |

B1 -> B2 is a day. B2 -> B3 is the real step: model in installer, second server mode, cache invalidation, re-index-on-model-change migration. A cross-encoder reranker (`--rerank`) is more accurate but adds ~300 MB resident - **out of scope until B3 is measured and found wanting.**

---

## 7. Storage and Schema Design

```sql
CREATE TABLE search_chunks (
  id bigserial PRIMARY KEY,
  source_kind text NOT NULL, source_id text NOT NULL,
  session_id text NOT NULL, app_path ltree, chunk_index integer NOT NULL,
  content text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS
      (to_tsvector('english', coalesce(content,''))) STORED,
  embedding bytea, embed_model text, embed_dim integer,
  created_at text NOT NULL,
  UNIQUE (source_kind, source_id, chunk_index)
);
ALTER TABLE search_chunks ALTER COLUMN embedding SET STORAGE PLAIN;   -- section 4
CREATE INDEX search_chunks_tsv_gin ON search_chunks USING GIN (tsv);
CREATE INDEX search_chunks_scope   ON search_chunks (session_id);
CREATE INDEX search_chunks_path    ON search_chunks USING GIST (app_path);
```

**Why one table:** *atomicity* - text, `tsvector`, vector in one `INSERT`, no dual-write window (strongest argument against D); *`embed_model` is the migration key* (`WHERE embed_model <> $new` drives a background re-embed, since candidate dims differ); *`bytea` is width-agnostic*, so 384->768->1024 is a re-embed, not DDL.

**Write amplification per chunk:** heap row (content + `tsv` at ~30-60% of content + vector 1.5-4 kB); GIN entries for `tsv` (**GIN is the write-heavy index, not the vector**); WAL; and, with pgvector, an HNSW insert touching ~`m`xlayers pages - the expensive one, and the one whose vacuum the changelog shows to be corruption-prone.

**Trigram:** do **not** index `content` with `gin_trgm_ops` by default. Use the documented pattern: a small `words` table from `ts_stat(...)` with `GIN (word gin_trgm_ops)`.

**Do not use `DynamicTableStore`:** types cap at TEXT/INTEGER/REAL/BLOB; no `tsvector`, expression indexes, or `SET STORAGE`. Retrieval is a backend concern like `telemetry_spans` (hand-written DDL at `engine.rs:526-580`) - add beside `PG_TELEMETRY_DDL`, on the same `EngineHandle`/`sqlx::PgPool`.

**Consistency.** Chunks are a **projection of already-durable rows** - derived, regenerable, so at-least-once projection is acceptable *provided idempotency*: `UNIQUE(...)` + `ON CONFLICT DO UPDATE`. The only non-transactional step is the `llama-server` HTTP call: insert with `embedding = NULL`, let a worker `UPDATE` it - **`embedding IS NULL` is the work queue.**

---

## 8. Recommendation Matrix

Effort in engineer-days for an implementer familiar with the tree; risk is product risk.

| | **A. pgvector** | **B. FTS + pg_trgm (+ltree)** | **C. Rust brute force over `bytea`** | **D. External vector store** |
|---|---|---|---|---|
| **Effort (first working)** | 3-5 d build + 1-2 d wiring | **1-2 d** | 3-5 d (encoder, cache, invalidation, re-index) | 5-10 d |
| **Recurring cost** | **1 rebuild per PG minor**, forever; untested ext combo | ~0 (already shipped) | 0 build; own ANN/quantization + invalidation bugs | New process, upgrade path, crash mode |
| **New install size** | +~0.5 MB DLL (+fork/pipeline) | **+0 MB** | +0 code; **+35 MB (bge-small Q8) to +1.2 GB (Qwen3 f16)** | +0.5 MB + model |
| **New resident RAM** | ~0 (in-PG) | ~0 | 77 MB (100k x 768 int8) -> 307 MB (f32) -> 3 GB (1M x 768) | process + index |
| **Quality** | Best ceiling (exact or ANN ~0.95+ recall) | Good on identifiers/errors/phrases; **weak on paraphrase** | Same dense quality as A; **recall 1.0** | Same as C/A |
| **Latency @100k x 768** | unbenchmarked exact; HNSW ~ low ms | **sub-ms** (GIN) | **12 ms** (6-thread f32) | ~1-5 ms |
| **Failure modes** | index corruption (3x in 2026), TOAST random reads, untested combo | typos, synonyms, OOV identifiers | cache staleness, encoder down, half-embedded corpus | **dual-write divergence**, orphan process |
| **Provenance** | **Breaks pinned-archive attestation** (audit #2) | Clean | Clean | Clean (new process to audit) |
| **Reversible?** | Hard (DLL into archive) | Trivially | Trivially (nullable column) | Hard |
| **Verdict** | **No** | **Yes - ship this** | **Yes - optional additive ranker** | **No** |

**Primary recommendation: ship B now; design C as an additive ranker behind a measured quality gate; reject A and D.**

1. **B1 (1-2 d).** `search_chunks` with a **`STORED`** `tsvector` + GIN; `websearch_to_tsquery`; `ts_rank_cd` with weight classes and normalization `32`; `ltree` scope; idempotent `ON CONFLICT` upsert.
2. **B2 (0.5 d).** Trigram *rescue* on zero-result queries via the `words` table + `GIN (word gin_trgm_ops)`.
3. **Measure.** 100-query eval set from real history with hand-labelled relevant chunks; record Recall@10 and MRR for B1/B2. **Without this number, no decision to add embeddings is defensible.**
4. **C, only if the eval shows a real gap** (hypothesis: paraphrase-heavy *chat* queries, none on *tool/error*). Then bge-small-en-v1.5 @384d, Q8_0 GGUF, `bytea` + `SET STORAGE PLAIN`, in-process `Vec<f32>` cache keyed by epoch, exact scan, RRF k=60 fused with FTS - **additive and reversible**, the property A and D lack.

**Flip conditions.** *To A* if all hold: corpus > **~500k chunks at 768+ dims** (>60-120 ms brute force) *or* an SLO forces sub-10 ms semantic search; Fredo accepts **forking/re-signing the PG archive**; someone owns the pgvector build matrix across minors; and the eval shows ANN recall loss is acceptable. *To D* only if the corpus reaches **millions of chunks**, pgvector is refused, *and* a second supervised process plus reconciliation is accepted - a "never" for a desktop app. *B -> C alone* if lexical contributes ~nothing to RRF (unlikely; agent history is identifier-dense). *Do not flip on* "vectors are modern", "everyone uses HNSW", "MTEB says 70 > 62" - none measures Fredo's corpus.

**Deliberate gaps.** (1) pgvector exact-scan latency - unmeasured. (2) Embedding throughput on this CPU - unmeasured; one `--embedding` run over ~1k chunks sizes it. (3) Recall@10 of B1/B2 vs B3 on Fredo's history - unmeasured, and the only number that should decide between B and C.

---

## Full Citation List

**pgvector.** (1) README - Windows `nmake /F Makefile.win` + `PGROOT` + x64 prompt; `C2196`, `float_to_shortest_decimal_bufn` (PG 17.0-17.2); storage `4d+8`/`2d+8`/`d/8+8`; `SET STORAGE PLAIN`; `hnsw.ef_search` 40; `REINDEX ... VACUUM`; `binary_quantize` + re-rank. (2) CHANGELOG - 0.8.7 (#1036), 0.8.4, 0.8.3 (HNSW vacuum corruption; PG-18 Hamming/Jaccard), 0.8.2 (#959; PG-18 `EXPLAIN`), 0.8.1, 0.7.0 (CPU dispatch Linux only), 0.6.0 (`extended`->`external`). (3) `/repos/pgvector/pgvector/releases` -> `[]`. (4) `examples/hybrid_search/rrf.py` - `k = 60`, `FULL OUTER JOIN`.

**PG 18 docs.** (5) 12.3 - `websearch_to_tsquery`; `ts_rank_cd`; weights `{0.1,0.2,0.4,1.0}`; normalization `32`. (6) 12.2 - stored generated `tsvector`. (7) 12.9 - "GIN ... preferred"; GiST `siglen` 124. (8) F.35 `pg_trgm` - `"cat"` -> 4 trigrams; `word_similarity` 0.8; thresholds 0.3/0.6/0.5. (9) F.22 `ltree` - `lquery`/`ltxtquery`, `lca()`. (10) 9.19 - `Table 9.57`; **no dot/cosine/norm**. (11) 66.2 TOAST. (12) 5.4 - **generated columns default VIRTUAL**. (13) 8.4 `bytea`. (14) E.7 - **no vector type or ANN index**.

**Fredo repo.** (15) `research/spikes/2948-embedded-postgres-spike.md` - +164 MB distribution, ~9.7 s cold start, 277.7 MB peak RSS, `settings.timeout = None` hang. (16) `research/34-security-audit-2026-10-22.md` #2 - verified archive discarded. (17) `pg_supervisor/acquisition.rs:152,155`; `runtime.rs:1177`. (18-21) `storage/engine.rs:450-580`, `storage/application_store.rs:41-70`, `application_data/declaration.rs`, `llm_server/config.rs` + `llama-server-launch.bat`. (22) theseus-rs `docs/support-policy.md` - **readline and LLVM JIT disabled**.

**llama.cpp.** (23) `tools/server/README.md` - **embeddings** route; `--embedding`, `--pooling`, `--embd-normalize` (default 2), `--embd-gemma-default`, `--rerank` (PR #9510).

**Model cards.** (24) `bge-small-en-v1.5` - 33.4 M, 384d, MTEB v1 62.17/51.68, MIT, "[0.6, 1]" FAQ; `bge-base`/`bge-large` v1: 768/63.55/53.25, 1024/64.23/54.29. (25) `nomic-embed-text-v1.5` - 768d MRL->64, 8192 ctx, 62.28->56.10 at 768->64d, Apache-2.0. (26) `embeddinggemma-300m` - 0.3 B, 768d MRL->128, English v2 69.67; multi v2 61.15; code v1 68.76; QAT Q4_0 69.31; **no float16 activations**; Gemma licence. (27) `Qwen3-Embedding-0.6B` - 0.6 B, 1024d, 32k ctx, English v2 70.70 / multi v2 64.33, Apache-2.0.

**Papers.** (28) Muennighoff et al., *MTEB*, arXiv:2210.07316 - "no ... method dominates across all tasks." (29) Malkov & Yashunin, *HNSW*, arXiv:1603.09320. (30) Aumuller et al., *ANN-Benchmarks*, arXiv:1807.05614. (31) Cormack, Clarke, Buttcher, SIGIR 2009, doi:10.1145/1571941.1572114 - sum 1/(k+rank), `k = 60`. (32) Clarke, Cormack, Tudhope, IP&M 1999 - cover-density basis of `ts_rank_cd`. (33) This report's harness: section 4.
