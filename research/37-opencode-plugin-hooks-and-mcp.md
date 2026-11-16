# Research Report: Short-Term and Long-Term Memory for a Coding Agent via OpenCode Plugin Hooks and MCP

**Agent:** Research Analyst (OpenCode plugin surface + MCP protocol + Fredo tree)
**Date:** 2026-11-12
**Scope:** How an OpenCode coding agent can (a) be fed short-term memory at prompt time and (b) query long-term memory on demand, using only mechanisms Fredo can ship. **[L]** = read locally/in full (SDK `.d.ts`, plugin `src`, Rust IPC/setup/lib, capabilities; the v1.15.5 source archive from `codeload.github.com/anomalyco/opencode/zip/refs/tags/v1.15.5` with every `plugin.trigger` site enumerated). **[D]** = official docs/spec (opencode.ai/docs, modelcontextprotocol.io 2025-11-25, Anthropic engineering, OWASP). **[I]** = inference. No SEO blogs.

---

## Executive Summary (Top 8 Findings)

1. **The installed surface is V1; the website documents V2.** Fredo pins `@opencode-ai/plugin` **1.15.5** [L] - the V1 `(input, output) => Promise<void>` object - while the docs describe V2 `Plugin.define({ id, setup(ctx) })` and state **"V1 plugin implementations do not run in V2"** [D]. Every contract below is from the v1.15.5 source.
2. **`experimental.chat.system.transform` fires per *model request*, not per user prompt** (`session/llm.ts:127`) [L]: a 5-15 tool-call turn fires it 5-15 times, plus once for title generation and once for compaction, and at `agent/agent.ts:394` with **no `sessionID`** [L]. The dominant cost fact.
3. **It has no turn identity, so retrieval must be triggered elsewhere** - it sees only `{ sessionID?, model }` [L], while `chat.message` receives `messageID` and fires **once per user prompt** [L]. Shape: *retrieve at `chat.message`, inject from `system.transform` out of a module-scoped cache keyed by `sessionID`.*
4. **`experimental.session.compacting` is the memory-write hook:** `{ sessionID }` -> `{ context[]; prompt? }`, `context` appended **after** the summary template, `prompt` replacing it (`compaction.ts:396-407`) [L]. It does **not** supply the transcript - capture comes from `chat.message`, `experimental.text.complete`, `tool.execute.after`.
5. **`chat.message` writes durably; `messages.transform` is ephemeral** (`prompt.ts:1070` pre-persist vs in-memory lists at `:1418` / `compaction.ts:405`) [L].
6. **MCP tool definitions cost context every request, and 1.15.5 has no Code Mode.** Measured: 18 built-in description files = **16,327 B ~= 4,082 tokens** (~227/tool) [L]; Anthropic measures **150,000 -> 2,000 tokens (-98.7%)** with progressive disclosure [D]. V2 defaults `codemode: true`, but **that field is absent from the 1.15.5 schema** [L] - so N MCP tools are N native definitions forever.
7. **A plugin tool beats MCP for reads because it is the only surface with `sessionID`** (`ToolContext` also carries `messageID`, `agent`, `directory`, `worktree`, `abort`, `ask()`) [L]. MCP calls carry **no session correlation** in 1.15.5; `_meta["ai.opencode/sessionID"]` is V2-only [L][D].
8. **Both surfaces are local processes reachable by any local process.** MCP: local servers **SHOULD use stdio**; if HTTP, **MUST** validate `Origin`, **SHOULD** bind `127.0.0.1`, **SHOULD** require a token or restricted UDS/IPC [D]. Fredo already does this (`\\.\pipe\fredo-ipc`, `0o600`, `ipc.rs:112-121`) [L]. Retrieved memory is attacker-influenceable text in the system prompt (AgentPoison >80% ASR at <0.1% poison) - label it data, never instructions [D].

---
## 1. Ground Truth and the Version Fault Line

**Local [L]:** `install_plugin` copies a **flat** `~/.config/opencode/plugins/fredo.js` (*"No config registration needed - local plugins are auto-loaded from the directory"* - `setup/commands.rs:114-126, 373, 386`) and writes only the three `OPENCODE_*` OTEL vars via `setx`; **no `mcp` block exists today**. **Fault line [D]:** migrate-v1 maps both prime hooks away from `experimental.*`. **Failure posture [I]** from `plugin/index.ts:265-277`: `trigger` does `if (!fn) continue`, so a hook removed by a future OpenCode is a **silent no-op** - memory injection degrades to "nothing happens", never "the session breaks" (make this an invariant).

---

## 2. Short-Term Memory

### 2.1 `experimental.chat.system.transform`

Contract [L]: `(input: { sessionID?: string; model: Model }, output: { system: string[] }) => Promise<void>`. In `llm.ts:112-137` OpenCode joins the agent/provider prompt plus instructions into `system[0]`, captures `header = system[0]`, triggers the hook on `{ system }`, then re-joins anything appended after position 0 so the 2-part prompt-cache structure survives. `output.system` is the *full* array, so appending is safe and replacing index 0 blows the cache.

**Can** append (extra `role:"system"` messages, `llm.ts:154-165); **cannot** inject messages (use `messages.transform`), modify the user message (`chat.message`), or suppress a turn (only throw). **Ordering:** cumulative on the *same* `output` object in plugin load order (`plugin/index.ts:265-277`), matching V2's "later hooks see changes made by earlier hooks" [D]. **Stability:** experimental - *"may change, break, or be removed in any release without notice"* [D]; renamed in V2.

**Cache effect [I]:** `applyCaching` marks system `slice(0,2)` as ephemeral cache points (`transform.ts:338-357`) [L]; `header` is preserved so the prefix still caches, but the appended block lands in system #2 and is rewritten each turn - keep it small, stable, and never above index 0.

### 2.2 `chat.message` vs `messages.transform`; blocking

`chat.message`: `input { sessionID, agent?, model?, messageID?, variant? }`, `output { message, parts }` [L]. Order (`prompt.ts:1058-1118`): resolve parts -> **hook** -> image normalise -> persist, so mutations are durable; it does **not** fire for compaction or title generation. `messages.transform`: `input {}`, `output { messages[] }` [L], every agent-loop step (`prompt.ts:1418`) and on the compaction clone (`compaction.ts:405`). `Part` supports `synthetic`/`ignored` (`message-v2.ts:100-102`); `toModelMessagesEffect` drops `ignored` but **keeps synthetic text** (`:703`). Use it for message-form memory or pre-send scrubbing.

**Blocking:** no typed rejection on any V1 hook - `trigger` awaits the callback (`plugin/index.ts:269`) and a throw propagates. That is the sanctioned pattern for `tool.execute.before` (the V2 guide's `.env` example) [D] but the wrong failure mode for memory. **Never throw from a memory hook.**

---
## 3. Memory Write - `experimental.session.compacting`

Contract (the only hook with inline doc comments) [L]: `(input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void>`. Then `nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })`, where `buildPrompt = [anchor, SUMMARY_TEMPLATE, ...context].join("\n\n")` (`:123-137`) [L]. The summariser runs with `tools: {}` and `system: []` (`:447-457`), so there are **no retrieval tools inside compaction** - anything it needs must be injected here.

**Use [I]:** flush salient facts to long-term storage at the moment the transcript is destroyed, and inject top-k stored memories as `context` so the summary preserves them; fires once per compaction, so it is cheap. **Capture points** (`input` is only `sessionID`): `chat.message` (user text), `experimental.text.complete` (mutable `text`, `processor.ts:657-666`), `tool.execute.after` (mutable `{ title, output, metadata }`, `session/tools.ts:103-108`) [L].

---
## 4. Long-Term Read - MCP vs Plugin Tool

### 4.1 MCP config - the docs describe a shape 1.15.5 lacks

Pinned schema (`config/mcp.ts`) [L]: `Local = { type:"local", command:string[], environment?, enabled?, timeout? }`; `Remote = { type:"remote", url:string, headers?, oauth?, enabled?, timeout? }`, nested **directly** under `mcp` (`config.ts:208-217`). So `mcp: { "<name>": { type:"local", command:[...] } }` - `enabled` (not `disabled`), **no** `codemode`, **no** `cwd`, **no** `servers` wrapper, **no** per-server `protocol`; default request timeout is `experimental.mcp_timeout` = **5000 ms** [L]. The website's `disabled`/`codemode`/`servers`/`protocol` are V2 [D].

**Can Fredo ship `fredo mcp-memory`? Yes** - `type:"local"` takes a command spawned over `StdioClientTransport` (`mcp/index.ts:274-290`); `environment` injects `FREDO_CLI_PIPE`, `FREDO_ENV_ID`, and a per-server token [L]. Wire protocol: `initialize` -> `initialized`, then `tools/list` / `tools/call` over newline-delimited JSON-RPC 2.0 on stdout, stderr reserved for logs; OpenCode's default `legacy` handshake negotiates revisions up to **2025-11-25** [D].

### 4.2 What 1.15.5 denies an MCP server

**No session correlation** - `convertMcpTool` calls `client.callTool({ name, arguments })` only (`mcp/index.ts:162-180`); no `ai.opencode` string exists in `opencode/src` except an unrelated managed-policy table. **No Code Mode** (`codemode` absent), so all N tools are native definitions. **Flattened names** `sanitize(client)+"_"+sanitize(tool)` (`:111,684`). **No server instructions surfaced** - zero `instructions` hits in `mcp/index.ts` despite the website's `<mcp_instructions>` [D], so guidance must live in tool descriptions [L].

### 4.3 Decision

Decisive on four axes [L]: **session identity** (plugin tool yes, MCP no), **deploy** (one automated file refresh vs a config write plus a second binary), **process** (in-process Bun vs a child per directory instance), **failure isolation** (a plugin bug can crash the shared server; an MCP crash kills only the child). Permission UX is `ctx.ask()` vs auto-ask `patterns:["*"]` (`tools.ts:134-136`); cross-client reuse favours MCP [D]; upgrade risk favours neither.
**Recommendation [I]:** one plugin tool (`memory_recall`) for reads - `sessionID` decides it. Offer MCP only if cross-client reuse is a requirement; keep it to **one** tool (~200-500 tokens of definition/request) [L-metric + D].

---
## 5. Transport: Plugin (Bun) to Rust

Ranked [L]: (1) **new loopback HTTP listener** - axum is already a dependency and used (`otlp/http.rs:277-287`), with a per-process bearer token and the port injected via the existing `FREDO_*` mechanism (`env.rs:34-68`); (2) **the existing CLI pipe** - `\\.\pipe\fredo-ipc` / `FREDO_CLI_PIPE`, newline-delimited JSON `CliCommand`/`CliResponse` (`ipc.rs:19-93, 136-165`), owner-only `0o600` on Unix, no new port but a new command variant; (3) **gRPC 4317** - wrong tool, mixes product data with telemetry.

**Do not use `127.0.0.1:9223`** - that is `tauri-plugin-mcp-bridge`, registered **only under `#[cfg(debug_assertions)]`** (`lib.rs:177-186`) and *"inert in a release build: no bridge port is bound and no bridge command exists"* (`docs/ARCHITECTURE.md:981`, `docs/SECURITY.md:157`) [L]. It is a tester's app-automation bridge, not a product data API.

---

## 6. Latency and Failure Budget

No published hook-latency numbers exist; the rest is inference bounded by measured facts. The **unavoidable multiplier** [L] is `prompt.ts:1248`'s `while (true)`: each step runs `messages.transform` -> `handle.process` -> `llm.stream` -> `system.transform`.


- Retrieve once at `chat.message`; inject from a cache in `system.transform` (map lookup) - turning N-x network into 1-x + N-x reads.
- Cap retrieval at **~100-150 ms** with `AbortSignal.timeout` and **fail open** - inject nothing (or a stale block), log once; `abort`/`signal` is the documented plugin idiom [D].
- Never inherit the MCP default (**5000 ms**/request [L]); bound payloads to **~300-800 tokens** - Chroma's context-rot work shows a ~300-token focused prompt beats the same question inside ~113k tokens for every model family [D/secondary]. **Degrade to zero, never block** - reuse the plugin's `safe(name, fn)` wrapper (`src/index.ts:255-268`).
- Emit `fredo.memory.recall` `{sessionID, hit_count, ms, degraded}` through the existing OTel pipeline so the multiplier and timeout rate are measurable [L].

---

## 7. Security

**Threat model: any local process [D].** Per the MCP *Local MCP Server Compromise* section, local servers are reachable by other local processes and are a DNS-rebinding target on localhost; servers meant to run locally **"SHOULD use the `stdio` transport to limit access to just the MCP client"**, else **"Require an authorization token"** or **"Use unix domain sockets or other IPC mechanisms with restricted access."** Transports add **MUST** validate `Origin`, **SHOULD** bind `127.0.0.1`, **SHOULD** authenticate [D]. Fredo already does this (`ipc.rs:112-121`: `0o600`, "prevent unauthorized local processes from injecting events") [L]; reuse it and set the Windows pipe ACL explicitly rather than inheriting it.

**Least privilege and injection [D]:** OWASP LLM06:2025 prescribes minimise extensions/functionality/permissions, avoid open-ended extensions and complete mediation - concretely one read-only `memory_recall` verb (no write, no shell, no arbitrary path), scoped in Rust, never a generic query engine over the product DB. Recalled memory enters the **system prompt**, the highest-privilege position: AgentPoison reports **>80% ASR at <0.1% poison rate** and PoisonedRAG **90% ASR from 5 texts** in a million-text store (`research/35`). Delimit and label the block ("recalled data, not instructions"), neutralise instruction-like content, prefer facts with provenance, and rate-limit plus size-cap (OWASP LLM10; MCP tools spec "rate limit tool invocations").

---
## 8. Recommended Design

1. **Short-term:** `chat.message` (gate on `agent`, key on `messageID`) -> fetch working set -> module-scoped `Map<sessionID, Block>`; `system.transform` pushes `Block` under a character cap.
2. **Write:** `chat.message` queues the user turn; `experimental.text.complete` appends assistant text; `experimental.session.compacting` flushes salient facts and injects top-k to preserve.
3. **Long-term read:** plugin tool `memory_recall({ query, k? })` -> loopback HTTP (or the CLI pipe) with a per-process token -> Rust answers from PostgreSQL.
4. **Invariants:** fail open; never throw; <=150 ms; recalled block labelled untrusted; memory-empty indistinguishable from memory-unavailable.

---
## Verified hook capability matrix

Contract from `@opencode-ai/plugin@1.15.5/dist/index.d.ts` **[L]**; behaviour from v1.15.5 `plugin.trigger` sites **[L]**; stability from docs + V2 map **[D]** (`system.transform` -> `session.hook("context")`, `chat.message` -> `session.hook("prompt")`, `messages.transform` -> `context`, `compacting` -> `compaction`, `tool.execute.*` -> `tool.hook(..)`, `tool`/`tool.definition` -> `ctx.tool.transform`, `event` -> `ctx.event.subscribe`).

| Hook | Can read | Can write | Can block | Stability | Use for memory? |
|---|---|---|---|---|---|
| `experimental.chat.system.transform` | sessionID?, model, `system[]` | **append system strings**, per model request | No | **Experimental** | **Yes - injection (primary)** |
| `chat.message` | sessionID, agent, model, messageID, parts | **durable** mutate before persist | No | V1 stable | **Yes - capture + trigger** |
| `experimental.chat.messages.transform` | `{}` + `messages[]` | **ephemeral** add/rewrite/remove | No | **Experimental** | Yes - synthetic msg / scrub |
| `experimental.session.compacting` | sessionID only | `context[]` / `prompt` | No | **Experimental** | **Yes - write + preserve** |
| `experimental.compaction.autocontinue` | full turn context | `enabled` | **Yes** | **Experimental**, no V2 equivalent | No |
| `tool.execute.after` | tool, sessionID, callID, args | `{title,output,metadata}` | No | V1 stable | Yes - capture outcomes |
| `tool.execute.before` | tool, sessionID, callID | `args` | **Yes** (throw aborts) | V1 stable | No |
| `experimental.text.complete` | sessionID, messageID, partID | streamed `text` | No | **Experimental**, no V2 equivalent | Yes - capture assistant text |
| `tool` (registration) | - (`sessionID` at call) | tool list | n/a | V1 stable | **Yes - long-term read** |
| `event` | full event stream | - | No | V1 stable | Yes - passive capture |
| `permission.ask` | `Permission` | `ask`/`deny`/`allow` | **Yes** | Declared but **never triggered in v1.15.5** - non-functional on the pin **[L]** | No |

Remaining hooks, none useful for memory [L]: `config`, `chat.params`, `chat.headers`, `shell.env`, `command.execute.before`, `tool.definition`. Two caveats: do not build memory policy on `permission.ask`; and `system.transform` also fires from `agent/agent.ts:394` with **only** `{ model }`, so handlers must tolerate `sessionID === undefined`.

---
## Full Citation List

**Local, read in full [L]:** (1) `apps/opencode-plugin/node_modules/@opencode-ai/plugin/dist/index.d.ts:1-316` (`Plugin`, 19 hook signatures, `compacting` doc :270-282); `dist/tool.d.ts` (`ToolContext`); `package.json` (pin `1.15.5`); `src/index.ts:255-268`. (2) `apps/tauri/src-tauri/src/`: `infrastructure/ipc.rs:19-93,112-121,136-165`; `infrastructure/env.rs:34-68`; `applications/setup/commands.rs:114-150,373,386`; `lib.rs:177-186`; `capabilities/mcp-bridge-dev.json`; `docs/ARCHITECTURE.md:981`; `docs/SECURITY.md:143-157`. (3) measured `packages/opencode/src/tool/*.txt` (18 files, 16,327 B). (4) `research/35`, `research/36`.

**OpenCode v1.15.5 source [L]:** (5) `plugin/index.ts:152-176,265-277`; `session/{llm.ts:112-137,170,190; prompt.ts:1070,1248,1418,1592; compaction.ts:123-137,396-407,447-457,490-534; processor.ts:657-666; tools.ts:76-160; message-v2.ts:100-102,703}`; `config/{mcp.ts,config.ts:208-217}`; `mcp/index.ts:111,154-180,274-290,684`; `provider/transform.ts:338-357`; `agent/agent.ts:394`; `packages/opencode/package.json` (`@modelcontextprotocol/sdk 1.27.1`); tag `v1.19.5` (`plugin/{index,shared}.ts`, `core/src/config/mcp.ts`).

**Official docs and spec [D]:** (6) opencode.ai/docs build/plugins (V2 context API, `session.hook`, transforms). (7) /build/plugins/migrate-v1 (**"V1 plugin implementations do not run in V2"**; V1->V2 hook map). (8) /plugins/, /config/, /compaction/. (9) /mcp-servers/ ("MCP tools consume model context"; local `command`/`environment`/`cwd`; remote Streamable HTTP + OAuth; `codemode`; `_meta["ai.opencode/sessionID"]`; server instructions; timeouts; protocol `legacy`/`auto`/`2026-07-28`). (10) MCP spec 2025-11-25: /basic/lifecycle, /server/tools, /basic/transports (stdio; Streamable HTTP - Origin MUST, 127.0.0.1 SHOULD, auth SHOULD), /basic/security_best_practices (**Local MCP Server Compromise**). (11) Anthropic: *Writing effective tools for agents*, *Code execution with MCP*, *Effective context engineering for AI agents*. (12) Cloudflare, *Code Mode*. (13) OWASP LLM06:2025. (14) AgentPoison, PoisonedRAG, Chroma context-rot, LongMemEval, MemGPT (arXiv:2310.08560).

**Explicit gaps:** (a) no primary measurement of `plugin.trigger` overhead - the N-x multiplier is established from source, the millisecond cost is not; measure before fixing a timeout. (b) Windows named-pipe default ACLs for Tauri are undocumented in our tree - verify before relying on the pipe as a security boundary. (c) V1->V2 port effort is unestimated; the guide implies a rewrite, not a rename.