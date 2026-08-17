# GenAI Telemetry Reference — What Fredo Receives

Ground truth of the GenAI telemetry Fredo actually receives from opencode (via the fredo plugin → OTLP → `fredo.db`), organized by signal type. Every table is grounded in live data from the `telemetry_spans`, `telemetry_metrics`, and `telemetry_logs` tables (query via `.opencode/skills/telemetry-query/telemetry-query.ps1`), cross-referenced against the [OTel GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai/).

> **Reading this doc:** "Property" is the key name as it appears in the JSON attributes. "Path" is where it lives in the payload (top-level `attributes_json` or nested). "Available in Fredo?" is ✅ if Fredo stores/receives it today, ⚠️ if present but non-conformant to the OTel registry, and ❌ if not received.

---

## 1. Spans (`telemetry_spans`)

### 1.1 Span types actually received

| span_name | event_type | span_kind | Notes |
|-----------|-----------|-----------|-------|
| `fredo.llm` | `chat` | CLIENT | The LLM inference operation (dominant). |
| `chat.chat` / `chat` | `chat` | INTERNAL | Chat conversation spans. |
| `fredo.tool.<tool>` | `tool_use` | INTERNAL | Per-tool execution spans (`bash`, `edit`, `read`, `glob`, `grep`, `skill`, `task`, `write`, `webfetch`, `todowrite`, `question`, tauri_* tools, …). |
| `fredo.session` / `agent_session.session` | `agent_session` | INTERNAL | Agent/session lifecycle spans. |
| `tool_use.<Tool>` | `tool_use` | SERVER | Server-kind tool span (legacy/mock path). |

**Naming:** tool spans use `fredo.tool.<tool_name>` (lowercase) from the adapter's `tool_name`; the raw opencode `tool_use.<Tool>` (PascalCase) is the SERVER-kind path.

### 1.2 Span attributes actually received

**Conformant OTel GenAI attributes (registry names):**

| Property | Path | Description | Available in Fredo? |
|----------|------|-------------|---------------------|
| `gen_ai.operation.name` | top-level | Operation name (`chat`, `execute_tool`, `invoke_agent`). | ✅ |
| `gen_ai.provider.name` | top-level | Provider (`deepseek`, `openai`, …). | ✅ |
| `gen_ai.request.model` | top-level | Model requested. | ✅ |
| `gen_ai.response.model` | top-level | Model that responded. | ✅ |
| `gen_ai.response.finish_reasons` | top-level | Array of finish reasons. | ✅ |
| `gen_ai.conversation.id` | top-level | Conversation/session ID. | ✅ |
| `gen_ai.usage.input_tokens` | top-level | Input token count. | ✅ |
| `gen_ai.usage.output_tokens` | top-level | Output token count. | ✅ |
| `gen_ai.usage.cache_read.input_tokens` | top-level | Cached-input tokens read. | ✅ |
| `gen_ai.usage.reasoning.output_tokens` | top-level | Reasoning tokens. | ✅ |
| `gen_ai.agent.name` | top-level | Subagent name (agent spans). | ✅ |
| `gen_ai.tool.name` | top-level | Tool name. | ✅ |
| `gen_ai.tool.call.id` | top-level | Tool call ID. | ✅ |
| `gen_ai.tool.call.arguments` | top-level | Tool arguments. | ✅ |
| `gen_ai.tool.call.result` | top-level | Tool result payload. | ✅ |

**Non-conformant / legacy keys (renamed to registry names):**

| Property | Path | Description | Registry replacement | Available in Fredo? |
|----------|------|-------------|----------------------|---------------------|
| `gen_ai.prompt` | top-level | User instruction text. | `gen_ai.input.messages` (JSON-string message array) | ❌ Renamed (Spec #2680) — new data emits `gen_ai.input.messages`; maps to `userMessage` |
| `gen_ai.response.body` | top-level | Agent reply text. | `gen_ai.output.messages` (JSON-string message array) | ❌ Renamed (Spec #2680) — new data emits `gen_ai.output.messages`; maps to `agentReply` |

**Fredo-native / enriched attributes (added by the adapter, not OTel registry):**

| Property | Path | Description | Available in Fredo? |
|----------|------|-------------|---------------------|
| `service.name` | top-level | `fredo` (resource). | ✅ |
| `session.id` | top-level | Session UUID. | ✅ |
| `session.parent_id` | top-level | Parent session (subagent relationships). | ✅ |
| `os.type` | top-level | `win32`/`linux`/… (resource). | ✅ |
| `app.version` | top-level | Fredo version (resource). | ✅ |
| `agent` | top-level | Agent name (e.g. `build`, `plan`, `tester`). | ✅ |
| `agent.type` | top-level | Agent type (`unknown` etc.). | ✅ |
| `provider` / `model` | top-level | Provider/model shorthand. | ✅ |
| `duration_ms` | top-level | Span duration in ms. | ✅ |
| `input_tokens` / `output_tokens` / `reasoning_tokens` | top-level | Token counts (flat). | ✅ |
| `cache_read_tokens` / `cache_creation_tokens` | top-level | Cache token counts (flat). | ✅ |
| `cost_usd` | top-level | Estimated cost. | ✅ |
| `response_text` / `output` | top-level | Agent reply text (flat). | ✅ |
| `prompt` | top-level | User instruction text (flat). | ✅ |
| `tool_name` / `tool_input` / `tool_call_id` | top-level | Tool details (flat). | ✅ |
| `tool.success` / `tool.error` | top-level | Tool success/error flags. | ✅ |
| `tool.result_size_bytes` | top-level | Tool result size. | ✅ |
| `info` | nested | `{modelID, text, turnInputTokens, turnOutputTokens}` — the raw hook info. | ✅ |
| `part` | nested | `{text, …}` — streamed part payload. | ✅ |
| `userMessage` / `agentReply` | top-level | **Typed fields** the adapter injects (frontend contract — Mission Monitor). | ✅ |
| `promptTokens` / `completionTokens` | top-level | Typed token fields (frontend contract). | ✅ |
| `reasoningTokens` / `cacheReadTokens` / `cacheWriteTokens` | top-level | Canonical token-family fields injected by the OTLP adapter (Spec #2717) — `gen_ai.usage.reasoning.output_tokens` / `cache_read.input_tokens` / `cache_creation.input_tokens`. Display contract: Cache = `cacheReadTokens` only; `cacheWriteTokens` is carried but never summed into any displayed figure or Total. | ✅ |
| `is_subagent` / `instruction` | top-level | Subagent flags + instruction text. | ✅ |
| `child_session_id` / `child_agent` / `child_total_tokens` / `child_total_cost_usd` / `child_total_messages` | top-level | **Child-completion attrs** emitted by the plugin onto the parent's `fredo.tool.task` span when the subagent session completes (Spec #2745) — the canonical child-identity/cost fields the Mission Monitor SubagentNode displays. Projected by the OTLP adapter to camelCase `childSessionId` / `childAgent` / `childTokens` / `childCost` / `childMessages` in the delivery payload (optional — absent when the span lacks them). | ✅ |
| `child_input_tokens` / `child_cache_read_tokens` / `child_reasoning_tokens` / `child_output_tokens` | top-level | **Per-family child token breakdown** (Spec #2745 follow-up) — the four displayed families of the child session's usage, snapshotted onto the parent's `fredo.tool.task` span. Projected by the adapter to `childInputTokens` / `childCacheReadTokens` / `childReasoningTokens` / `childOutputTokens`. | ✅ |
| `total_tokens` / `total_messages` / `total_cost_usd` | top-level | Session totals. | ✅ |
| `qa.marker` | top-level | QA test marker. | ✅ |
| `event_type` / `transport` | top-level | Event type + transport (hook/otlp_*). | ✅ |
| `error` | top-level | Error object (on error spans). | ✅ |

### 1.3 Span lifecycle / status

Spans progress Init → Update → Response/Error. Status: `UNSET` (open), `OK`, `ERROR` (with `status_message`). Latency = `(end_time_ns - start_time_ns)`.

---

## 2. Metrics (`telemetry_metrics`)

### 2.1 OTel GenAI metrics actually received

| Metric | Type | Unit | Attributes (dimension labels) | Available in Fredo? |
|--------|------|------|-------------------------------|---------------------|
| `gen_ai.client.token.usage` | histogram | tokens | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.token.type` (input/output), model | ✅ |
| `gen_ai.client.operation.duration` | histogram | s | `gen_ai.operation.name`, provider, model | ✅ |
| `gen_ai.execute_tool.duration` | histogram | s | tool/operation attrs | ✅ |
| `gen_ai.invoke_agent.duration` | histogram | s | agent/operation attrs | ✅ |

**Not yet emitted (in the registry, applicable to Fredo, not currently received):**

| Metric | Type | Unit | Why applicable | Available in Fredo? |
|--------|------|------|----------------|---------------------|
| `gen_ai.client.operation.time_to_first_chunk` | histogram | s | opencode streams responses — first-chunk latency is meaningful. | ❌ (spec should add) |
| `gen_ai.client.operation.time_per_output_chunk` | histogram | s | Streaming chunk cadence. | ❌ (spec should add) |
| `gen_ai.invoke_agent.inference_calls` | histogram | {inference_call} | Count of inference calls per agent invocation. | ❌ (spec should add) |
| `gen_ai.invoke_agent.tool_calls` | histogram | {tool_call} | Count of tool calls per agent invocation. | ❌ (spec should add) |

**Correctly N/A (in the registry but semantically not Fredo):** `gen_ai.server.request.duration`, `gen_ai.server.time_per_output_token`, `gen_ai.server.time_to_first_token` (Fredo is a client, not a server), `gen_ai.invoke_workflow.duration` (no workflow system).

### 2.2 Fredo-native metrics (not OTel registry)

| Metric | Type | Description | Available in Fredo? |
|--------|------|-------------|---------------------|
| `fredo.token.usage` | counter | Token usage totals. | ✅ |
| `fredo.cost.usage` | counter | Cost totals. | ✅ |
| `fredo.session.count` | counter | Session counts. | ✅ |
| `fredo.tool.duration` | histogram | Tool duration. | ✅ |
| `span_count` | counter | Spans ingested. | ✅ |
| `span_duration_ms` | histogram | Span duration buckets. | ✅ |
| `orphan_spans` | counter | Spans with no parent/attributable session. | ✅ |
| `active_sessions` | gauge | Current active sessions. | ✅ |

---

## 3. Logs / Events (`telemetry_logs`)

### 3.1 What the log records carry

| Attribute | Description | Available in Fredo? |
|-----------|-------------|---------------------|
| `event.name` | Event name (e.g. `gen_ai.client.operation.exception`, `LOG_API_ERROR`). | ✅ |
| `inserted` / `flushed` | Ingestion counters (otlp INFO). | ✅ |
| `session.id` / `session_id` | Session identifier. | ✅ |
| `agent` / `agent.name` / `agent.type` | Agent identity. | ✅ |
| `duration_ms` / `model` / `provider` | Operation context. | ✅ |
| `contract_name` / `correlation_id` | Contract engine context. | ✅ |
| token/cost attrs (`input_tokens`, `output_tokens`, `cost_usd`, …) | Flat token/cost counts. | ✅ |
| `gen_ai.*` attrs (`gen_ai.operation.name`, `gen_ai.usage.*`, …) | OTel-conformant attrs mirrored into logs. | ✅ |

### 3.2 Exceptions — the known gap

| Event | Currently | Registry requirement | Available in Fredo? |
|-------|-----------|----------------------|---------------------|
| `gen_ai.client.operation.exception` | Emitted as a **log record** (`fredo::llm` WARN, severity 13) via `ctx.emitLog`. | MUST be a **span event** (`telemetry_spans.events_json`) with `exception.type`, `exception.message`, `exception.stacktrace`. | ⚠️ Log-only — `events_json` is empty (0 rows). Spec moves it to a span event. |

### 3.3 OTel GenAI events — emitted but as logs, not span events

| Event | Currently | Registry requirement | Available in Fredo? |
|-------|-----------|----------------------|---------------------|
| `gen_ai.client.inference.operation.details` | Emitted as a **log record** (INFO, body = the event name) via `ctx.emitLog` — carries `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.*`, `gen_ai.usage.*`, conversation ID (input/output text lives on the span attributes as `gen_ai.input.messages`/`gen_ai.output.messages`). | MUST be a **span event** capturing request/response details (chat history, parameters). Opt-In. | ⚠️ Log-only — never in `events_json`. Spec moves it to a span event. |
| `gen_ai.evaluation.result` | Not emitted. | Evaluation metric event. | ❌ N/A — Fredo has no evaluation harness. |

---

## 4. Source of truth + how to query

- **Database:** `fredo.db` (`telemetry_spans`, `telemetry_metrics`, `telemetry_logs`).
- **Query tool:** `.opencode/skills/telemetry-query/telemetry-query.ps1` (read-only sqlite3 wrapper).
- **Emission side:** `apps/opencode-plugin/` (fredo plugin) — spans/metrics/logs.
- **Adapter (consumption side):** `apps/tauri/src-tauri/src/infrastructure/comm/adapters/otlp.rs` — maps `gen_ai.input.messages`/`gen_ai.output.messages` (parsed JSON-string message arrays) to `userMessage`/`agentReply` (the frontend contract).
- **Registry (source of truth for `gen_ai.*` names):** OTel GenAI semantic conventions — https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai/

---

## 5. Coverage summary (vs the 5 OTel GenAI docs)

| Doc | Applicable events/metrics | Received today | Spec closes |
|-----|---------------------------|----------------|-------------|
| `gen-ai-spans.md` | Span attributes | 14/16 conformant | Renames `gen_ai.prompt`→`gen_ai.input.messages`, `gen_ai.response.body`→`gen_ai.output.messages` |
| `gen-ai-agent-spans.md` | `gen_ai.agent.name` + agent attrs | ✅ | — |
| `gen-ai-events.md` | `gen_ai.client.inference.operation.details` (opt-in); `gen_ai.evaluation.result` (N/A) | ⚠️ log-only | Move the operation-details event to a span event |
| `gen-ai-exceptions.md` | `gen_ai.client.operation.exception` | ⚠️ log-only | Move to span event |
| `gen-ai-metrics.md` | 12 metrics; 8 applicable to Fredo | 4/8 | Add `time_to_first_chunk`, `time_per_output_chunk`, `invoke_agent.inference_calls`, `invoke_agent.tool_calls` |

**Explicitly out of scope (semantically N/A, must not be fabricated):** `gen_ai.server.*` (3 metrics — Fredo is a client), `gen_ai.invoke_workflow.duration` (no workflow system), `gen_ai.evaluation.result` (no evaluation harness).
