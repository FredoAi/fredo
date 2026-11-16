# Research Report: Memory in Coding Agents - Shipped Prior Art

**Agent:** Research Analyst (prior-art survey) | **Date:** 2026-11-12
**Scope:** Shipped products/OSS memory for coding work - storage, retrieval, write trigger, user control, verified benefit; weighted to OpenCode.
**Method:** Each product's own docs, repos, or arXiv; unverified claims recorded as negative results; vendor benchmarks **self-reported**.

---

## Executive Summary (Top 8)

1. **OpenCode has no memory subsystem - the right move is a plugin.** Its V2 docs index covers skills, references, compaction, snapshots, warming, plugins - **none for memory** [1]. It ships the substrate: `AGENTS.md` with lazy nested discovery + live reload [2], progressive-disclosure skills [3], plugin `ctx.storage`, `session.hook("context")`, `instructions.entry` [4].
2. **The industry converged on files:** Claude Code `CLAUDE.md` + `.claude/rules` + auto-memory with a `MEMORY.md` index capped at **200 lines/25 KB** [5]; Cursor `.cursor/rules` [6]; Copilot instructions [7]; Cline/Roo/Continue markdown "memory bank" [8][9]. **None uses a database as primary memory.**
3. **The only rigorous A/B found is Copilot Memory, and effects are small:** +3% precision / +4% recall on review, **+7% relative PR merge rate (90% vs 83%)**, p<0.00001 [10].
4. **Copilot's best idea is citation verification at read time.** Memories carry `citations: ["src/...:12", ...]`; the agent re-reads those lines on the current branch and re-stores a correction when they fail. Offline curation was rejected as too complex [10]. 90-day expiry, vote-based retirement [12].
5. **`AGENTS.md` is instructions, not memory** - authored, reviewed, git-versioned, vs. machine-written, provisional, decaying [13]. It is also the cross-tool interchange format [2][5][6][7][8][13].
6. **Productized memory loses to plain context under independent test.** MemoryAgentBench: Mem0 21.1, Zep 24.0 vs 128K FIFO 42.2, GPT-5-mini-400K 60.6 [14][45]. Letta's **filesystem-only** agent scores **74.0% LoCoMo** vs Mem0's reported 68.5% [16]; Mem0 now claims 92.5 from its **managed platform, optimizations not in the OSS SDK** [17].
7. **The only outcome-level evidence here is GitHub's** - citations plus read-time verification, measured on merges, not LoCoMo.
8. **The failure mode is trust/staleness.** An auto-memory rule was followed **95%** with the full body in context vs **72%** with only its index line [18]; `/cd` leaves auto-memory pinned to the old project [19].

---

## 1. OpenCode's native primitives

**No `memory` concept, no `remember` tool, no store** - grepping the V2 docs index for both returns nothing [1]. What exists is substrate:

- **`AGENTS.md` [2]** - global plus every file workspace-to-home; nested read *lazily*; **live reload**. `instructions` adds files/globs/`~/`/HTTP.
- **Skills [3]** - only id/name/description advertised per step, body on demand. **Progressive disclosure is the retrieval strategy that ships**; an index costs ~1 line per entry.
- **`ctx.storage` [4]** - plugin-scoped durable JSON KV with `scan({prefix,cursor})` - where a real index (FTS, hit counts) can live.
- **`session.hook("context")` [4]** - mutate system/messages/tools/options before dispatch: the **injection point** for recall.
- **`instructions.entry.put` [4]** - keyed `<context key>` blocks at each step boundary: a native per-session memory slot.
- **`session.hook("compaction")` [4]** - sees the transcript and can set `result` to skip the call: **write memory before compaction evicts it**. Compaction [20] keeps ~15k recent, uses opaque non-portable provider checkpoints, and is lossy.
- **Snapshots [22] / Warming [23] / References [21]** - `/undo` rollback; cache keep-alive at real cost; external dirs with a `description`.

**Consequence:** the work is *policy and UI*, not plumbing - when to write, where, how to recall, how the human audits it. All four are plugin-configurable; **nothing requires patching OpenCode**. OpenCode deliberately does not auto-learn - hence third-party plugins [24][25][26].

## 2. Claude Code, Cursor, Aider, Cline/Roo/Continue

| Tool | Mechanism | Notable gap |
|---|---|---|
| **Claude Code** [5] | Managed -> `~/.claude/CLAUDE.md` -> `./CLAUDE.md` -> `CLAUDE.local.md`; root-first, subdirs on demand. `@path` **4 hops**. `.claude/rules/*.md` + `paths:`. **Auto memory:** `~/.claude/projects/<p>/memory/` with `MEMORY.md` index (first **200 lines / 25 KB**) + on-demand topics | *"context, not enforced configuration"*; `PreToolUse` hooks are the real enforcement. ~$13/dev/day; compaction "is itself a large request" [27] |
| **Cursor** [6] | `.cursor/rules/*.mdc` (plain `.md` **ignored**), 4 activation modes, Team->Project->User, **<500 lines**, `AGENTS.md` | **Memories** announced **beta** 2025-06-04 [28]; `/docs/context/memories` now **308->`/docs/rules`**, no GA/deprecation note (**unverified**) [29]. No codebase embeddings [29] |
| **Aider** [30][31][32] | Tree-sitter repo map ranked by a **graph algorithm**, 1k-token default, every request; `CONVENTIONS.md` | **No `/remember`**: 43 `cmd_*` methods on `main`, none `cmd_remember` [33][34]; the verb is Letta's [35] |
| **Cline / Roo / Continue** [8][9][36] | Six markdown files read **in full at task start**, shipped as a pasted instruction blob; Continue ships `.continue/rules/*.md` | No first-party `cline/memory-bank` repo (404) - **community convention**; Roo **shut down 2026-05-15** |

Markdown wins because agents read files well, a human can fix any file, and "update memory bank" is a *visible ritual* - at the cost of loading the whole set.

## 3. GitHub Copilot - a genuinely novel memory design

Instructions: `.github/copilot-instructions.md`; `.github/instructions/NAME.instructions.md` with `applyTo:` globs (+`excludeAgent`); `AGENTS.md` anywhere, nearest wins; precedence personal -> path-specific -> repo-wide -> agent -> org; they ship with **every** message [7].

**Copilot Memory** [10][12]: two scopes, separately owned - repo-level facts (shared; created only with write access) and user-level preferences (follow the person; on Business/Enterprise owned by the billing entity). **Memory as a tool call:** `store_memory({subject, fact, citations[], reason})` - e.g. "API version must match between client SDK, server routes, and docs" with three file:line citations. **Just-in-time verification:** offline dedupe/conflict/expiry "would introduce significant engineering complexity and LLM costs," so the agent re-reads cited locations on the current branch; contradiction -> store a correction; confirmation -> re-store to refresh the timestamp (retrieval alone does not reset the clock). **Retirement:** up/down voting; default expiry **90 days**, configurable **7-180**. **Rails:** secrets and model-control tokens rejected. Adversarial seeding "self-healed" [10]. **Vendor's own line:** *"a stored fact should not be relied on as a rule... use custom instructions instead"* [12]. Caveat: the changelog says on-by-default for Pro/Pro+ [11] while docs describe per-client defaults (VS Code off; CLI programmatic needs `--enable-memory`) [12].

## 4. Agent-memory products, OSS, and MCP servers

- **Mem0** [17][37] - vector + optional graph, LLM extraction. Paper: +26% over OpenAI memory, -91% p95 latency, >90% token savings; README: LoCoMo 92.5. **But the README admits scores come from the managed platform, "proprietary optimizations not available in the open-source SDK"** - independent run ranks it last (21.1) [14].
- **Letta / MemGPT** [38][35][39] - paper: OS-style tiered context; product: **git-backed MemFS** markdown, root files in the system prompt, dirs behind `MEMORY.md`, **no vector index by default**. Its own blog measures a filesystem-only agent at **74.0% LoCoMo** [16].
- **Zep / Graphiti** [40][41] - bi-temporal KG + episodes; hybrid semantic+BM25+graph. Paper: DMR 94.8 vs 93.4, LongMemEval up to +18.5% at -90% latency - self-reported, independently ranked 24.0 [14]. Heavy ops; reference MCP ships **with no auth by design**.
- **claude-mem** [24] - SQLite + Chroma; hooks feed a second "observer" agent; recall is `search` -> `timeline` -> `get_observations`. **Supports OpenCode.** No independent eval; its README flags the token ratio as "not a measured recall" (#4138). Paid tier.
- **basic-memory** [42] and **mcp-memory-service** [25] - markdown+SQLite (AGPL) / SQLite-CF-Milvus (single maintainer); neither publishes a benchmark.

Every headline is a **LoCoMo** number - retrieval from synthetic long conversation, not "does the agent stop re-reading the same 40 files next Tuesday?"

**MCP memory servers** [43][44]: the reference `memory` server persists a knowledge graph as **JSONL** (entity/relation/observation CRUD, `read_graph`/`search_nodes`/`open_nodes`). Good engineering - atomic saves, cross-process locking, a warning that the default file can sit in `node_modules` - but the repo calls it a *reference implementation... not production-ready*; substring search only, no temporal dimension. Its prompt dumps the whole graph each chat - the anti-pattern Copilot's citation model fixes.

## 5. What failed, was rolled back, or is credibly criticized

Both vendors draw the instructions/memory line (Copilot [12], Claude Code [5]); blurring it is the documented failure: a feedback rule saved into auto-memory was silently under-applied, workaround a `Stop` hook [18]. **No vendor publishes a clean memory postmortem - itself a finding.**

- **Rules under-apply** - ~430 replies/15 days: followed 78% (Opus 5.5), 59% (Sonnet 5.5), 59% (Fable 5.1); **95% with the full body in context vs 72% with only the `MEMORY.md` index line** [18].
- **Scope goes stale** - after `/cd`, auto-memory stays on the *old* project [19].
- **Vendor benchmark dispute** - Letta: "Mem0 published controversial results claiming to have run MemGPT on LoCoMo... our team could not determine a way to backfill LoCoMo into MemGPT/Letta... Mem0 did not respond (#3004)" [16].
- **Leaderboard reversed independently** - MemoryAgentBench: "current methods fall short"; Mem0 21.1 / Cognee 20.6 / Zep 24.0 / MIRIX 26.2 vs 128K FIFO 42.2, BM25 41.5 [14][45].
- **Filesystem beats the product** - Letta's 74.0% LoCoMo exceeds Mem0's own reported 68.5% [16].
- **Doc churn** - Cursor's Memories page now 308->Rules [6][28][29]; "on by default" vs "VS Code: off" [11][12].

## 6. Comparison Table

| System | Storage / retrieval | Write trigger | Verified? |
|---|---|---|---|
| **OpenCode** | None; `AGENTS.md`+`instructions`+plugin `ctx.storage` | Human authoring, `/init`; live reload | n/a - lossy compaction only [20] |
| **Claude Code** | `CLAUDE.md`/rules/`memory/` markdown; <=200/25 KB index, path scopes | Human; Claude writes auto-memory | No A/B; under-applied, `/cd` bug [18][19] |
| **Cursor** | `.cursor/rules/*.mdc` + `AGENTS.md`; mode-scoped, Instant Grep | Human; agent can create rules | No; Memories page gone [6][28][29] |
| **GitHub Copilot** | Instructions + Copilot Memory with `citations[]`; **read-time check** | `store_memory` tool call; CLI import | **Yes - vendor A/B:** +7% rel. PR merge |
| **Aider** | Computed repo map (graph-ranked) + `CONVENTIONS.md` | None automatic; human `read:` | No A/B; **no `/remember`** [33][34] |
| **Cline / Roo / Continue** | `memory-bank/` markdown; reads all files at task start | Manual ritual | No; Roo shut down [8][9][36] |
| **Mem0 / Letta / Zep** | Vector / MemFS markdown / temporal KG | Per turn; `/remember`+dreaming; ingestion | Letta partly; Mem0 and Zep **no** [14][17][35][39] |
| **claude-mem / basic-memory / mcp-memory** | SQLite+Chroma / markdown+SQLite / SQLite-CF-Milvus | Hooks + observer; explicit writes | No [24][42][25] |
| **MCP ref `memory`** | JSONL graph; substring search | Agent tool calls | n/a [43][44] |

User control: file systems expose plain files + git; productized ones a dashboard/API CRUD; Copilot alone adds per-repo/per-user scopes, admin policy and expiry.

## 7. File-based vs database-backed

**Files win for anything a human must trust**: every shipped coding-agent memory feature is files [5][6][7][8][9][39][42]; files get `git diff`, `grep`, editor navigation, merge resolution, MDM policy and `rm` free; the best independent result here is a **filesystem agent beating a memory product** [16]; and the failures that hurt - under-application, wrong scope, staleness - are *auditable* in files, invisible in a vector store [18][19].

**Databases win for three narrow jobs:** an **index over the files** [24][42]; **telemetry-shaped data with no file form** - access counts, cost per memory; Copilot's vote/expiry machinery is the only part that retires anything [12]; **cross-machine sharing with real concurrency control** [39].

**Content stored *only* in a DB does not work:** the user cannot read it, the agent cannot `grep` it, and the vendor's own benchmark is the only evidence it helps.

**Synthesis for Fredo:** *content in files, index and evidence in PostgreSQL.* Fredo's embedded Postgres already holds `telemetry_spans` + `*_rows` [46], so memory can carry **provenance and usage evidence** without a second store - while the text stays markdown a human can open.

## 8. What is genuinely differentiated for Fredo

1. **Outcome correlation without asking the vendor.** Copilot A/Bs because it sees PRs merge [10]. Fredo sees the same session's spans, edits, test runs and pipeline outcomes *locally* [46], so it can answer "did this memory change the outcome?" per memory, per repo - the attribution `research/35` flags as unsolved [14].
2. **Write-back at the moment before loss.** `session.hook("compaction")` hands us the transcript and lets us substitute a result; `context` injects recall into the *next* request only, keeping the cached prefix intact [4][27].
3. **Provable freshness.** Stamp each memory with commit SHA, file mtimes and producing span, then *show* staleness - Copilot's citation check against local git, free [10][12]. Scope becomes visible, killing the `/cd` bug [19].
4. **Human-in-the-loop by construction.** A diff-style review queue (accept/reject/edit) plus a provenance panel that jumps to the span [18][12].
5. **Free cross-tool portability.** Memory can be emitted as `AGENTS.md`, `CLAUDE.md`, `.cursor/rules` - not a silo [13].
6. **Retrieval that uses real usage signal.** Aider spends 1k tokens on a static graph ranking [30]; Fredo knows which files sessions actually read, which edits failed, and which questions were re-asked.

**Not differentiated:** embeddings, a graph DB, an LLM extractor, a "second observer agent" - claude-mem [24], mcp-memory-service [25] and Mem0 [17] already ship those, with paid tiers.

## 9. What NOT to build

1. **Not a vector-first store.** Productized memory benchmarks below plain long context [14][45]; Cursor explicitly disclaims codebase embeddings [29]; Letta ships MemFS with **no** vector index by default [39].
2. **Not a new memory file format.** `AGENTS.md` is read by a dozen tools [2][5][6][7][8][13].
3. **Not agent-written durable behavioural rules.** Copilot's caveat [12] and Claude Code's measured failure [18]. Rules -> instructions + a hook that can block; memory -> facts with citations.
4. **Not offline curation before read-time verification.** GitHub evaluated and rejected it at scale [10].
5. **Not an unbounded always-loaded memory file.** Claude Code caps at 200 lines/25 KB and Anthropic calls always-loaded files a per-request cost [5][27]; Cursor says <500 lines [6].
6. **Not memory a human cannot review.** If it cannot be read, diffed, corrected and deleted in the app, do not ship it - the strongest signal in the survey.
7. **Not any memory vendor's benchmark table.** LoCoMo is retrieval from synthetic conversation, not the coding job [16][17].
8. **Not a "knowledge graph" without bi-temporal validity and episode provenance** - the only parts that earn Graphiti's complexity [41]; a flat entity/relation store with substring search is worse than markdown+grep [43].
9. **Not a second background model call "to take notes"** unless measured to beat the tokens it saves [24].
10. **Not a competitor claim without checking its current source.** Aider has no `/remember` [33][34]; Cursor's Memories page now redirects to Rules [28][29].

---

## Full Citation List

[1] opencode.ai/docs/llms.txt - [2] .../docs/instructions/ + /docs/rules/ - [3] .../docs/skills/ - [4] .../docs/build/plugins/server/ - [5] code.claude.com/docs/en/memory - [6] cursor.com/docs/rules - [7] docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions - [8] docs.cline.bot/prompting/cline-memory-bank - [9] docs.continue.dev/customize/deep-dives/rules - [10] github.blog/.../building-an-agentic-memory-system-for-github-copilot/
[11] github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default.../ - [12] docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory - [13] agents.md - [14] Fredo `research/35-agent-memory-architectures.md` - [15] arxiv.org/abs/2504.19413 - [16] letta.com/blog/benchmarking-ai-agent-memory - [17] github.com/mem0ai/mem0 - [18] github.com/anthropics/claude-code/issues/105867 - [19] .../issues/102836 - [20] .../docs/compaction/
[21] .../docs/references/ - [22] .../docs/snapshots/ - [23] .../docs/warming/ - [24] github.com/thedotmack/claude-mem - [25] github.com/doobidoo/mcp-memory-service - [26] github.com/anomalyco/opencode/pull/58823 - [27] code.claude.com/docs/en/costs - [28] cursor.com/changelog/1-0 - [29] cursor.com/docs/agent/tools/search
[31] aider.chat/2023/10/22/repomap.html - [32] aider.chat/docs/usage/conventions.html - [33] github.com/Aider-AI/aider/blob/main/aider/commands.py - [34] aider.chat/docs/usage/commands.html - [35] docs.letta.com/configuration/memory - [36] github.com/RooCodeInc/Roo-Code - [37] github.com/mem0ai/mem0 - [38] arxiv.org/abs/2310.08560 - [39] docs.letta.com/concepts/memfs - [40] github.com/getzep/graphiti
[41] arxiv.org/abs/2501.13956 - [42] github.com/basicmachines-co/basic-memory - [43] github.com/modelcontextprotocol/servers (src/memory) - [44] modelcontextprotocol/servers - [45] arxiv.org/abs/2507.05257 - [46] Fredo `AGENTS.md`, `.opencode/skills/telemetry-query/SKILL.md`

**Verified absences:** no OpenCode memory docs page; no Aider `/remember` (`commands.py` on `main`); no first-party `cline/memory-bank` repo (404); no standalone Cursor "Memories"/"codebase indexing" page (both 308); Roo memory-bank docs 404.
