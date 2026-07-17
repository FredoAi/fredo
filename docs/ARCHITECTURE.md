# Fredo — Architecture Overview

## What Fredo Is

Fredo is a **cross-platform desktop application** for working with AI coding agents. Built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend), it ingests agent telemetry and lifecycle events, normalizes them into canonical objects, and renders them as reactive UI features in real time.

Agents integrate through two paths:

1. **OpenCode OTLP plugin** — the `fredo-opencode-plugin` exports OTLP metrics, logs, and traces directly to the gRPC receiver (`:4317`) using the OpenTelemetry SDK
2. **OTLP receivers** — native gRPC/HTTP collectors that ingest OpenTelemetry spans from OpenCode and compatible tools

Events flow through a **communication layer** (`infrastructure/comm/`) where adapters normalize raw input into `FredoEvent` objects. The React UI reacts in real time — no polling.

---

## Design Philosophy

### Feature-Based Autonomy

Both the Rust backend and the React UI are organized around **autonomous feature modules**. Each feature owns its entire vertical slice — models, business logic, state, and presentation. No feature reaches into another feature's internals. Shared platform services (communication layer, storage, IPC, OTLP) live in `infrastructure/` (Rust) or `shared/` (TypeScript) and are consumed by features, never owned by them.

### Reactive UI — Streams, Not Polls

The UI does not call the backend to ask for data. Instead, it **listens to a stream of typed events** and reacts. Every feature declares which events it cares about via `eventContracts: EventContractDeclaration[]`, registered at mount with `registerEventContracts()`. When a matching `ContractDelivery` arrives, the feature's `handleDelivery()` method re-renders with the new data.

### Agent Alignment

Fredo accepts events from two sources, unified into the canonical `FredoEvent` format:

| Source | Mechanism | Transport |
|--------|-----------|-----------|
| OpenCode OTLP plugin | `fredo-opencode-plugin` exports OTLP directly to `127.0.0.1:4317` | `OtlpGrpc` |
| OTLP gRPC | `127.0.0.1:4317` (OpenCode spans) | `OtlpGrpc` |
| OTLP HTTP | `127.0.0.1:4318` (OpenCode spans) | `OtlpHttp` |

---

## Communication Layer (`infrastructure/comm/`)

The `comm` module is the backbone of the event pipeline.

### Core Types

- **`FredoEvent`** — the canonical event shape: `id`, `eventType` (ToolUse | AgentSession | Chat | Infrastructure | Ui | Custom), `state` (Init | Update | Response | Error), `provider` (OpenCode | ClaudeCode | Internal), `transport` (Hook | OtlpGrpc | OtlpHttp | WebSocket | HttpPost | Internal), `sessionId`, `correlationId`, `toolName`, `payload`, `error`, `metadata`, `timestamp`. Serialized as camelCase for frontend consumption.
- **`EventBus`** — emits `FredoEvent` on the `"fredo-stream-event"` Tauri IPC channel to the webview. Registered as Tauri state in `lib.rs`.
- **`CommAdapter`** trait — each agent provider gets an adapter that transforms raw input into `Vec<FredoEvent>`.

### Adapters & Connectors

**Adapters** are per-agent-provider. **Connectors** are per-transport within an adapter.

```
infrastructure/comm/adapters/
├── opencode.rs    — OpenCodeAdapter: Hook connector (plugin events) + OTLP connectors (spans)
├── internal.rs    — InternalAdapter: enriches raw events with server-side defaults
```

- `OpenCodeAdapter::transform(Transport::Hook, payload)` — maps PreToolUse/PostToolUse/PostToolUseFailure/... plugin hooks into FredoEvents
- `OpenCodeAdapter::transform(Transport::OtlpGrpc, payload)` — maps OTLP spans into FredoEvents; stores `session_id` in `session_to_correlation` map (Spec #612) so `correlation_id === session_id` for pure-OTLP sessions, preventing the frontend's `correlationId !== sessionId` subagent check from misclassifying them.
  - **Spec #601** — recognizes `fredo.session` → `"session"` (AgentSession), `fredo.llm` → `"chat"` (Chat), `fredo.tool.<name>` → `"tool.<name>"` (ToolUse). Falls back to `span.type` attribute and legacy `gen_ai.operation.name`. Unrecognized spans are dropped with `tracing::debug!`.
  - **EventState from timing** — `endTimeUnixNano` present → `EventState::Response` (span complete), absent → `EventState::Init` (span in progress).
  - **Claude Code attributes** — prefers `session.id`, `input_tokens`, `output_tokens`, `model` over legacy `gen_ai.conversation.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.model`.
- New agent providers get a new adapter file; new transports get a new `Transport` variant in `event.rs`

---

## Event Flow

```
┌─────────────────────────────────────────────────────────┐
│                    Event Sources                         │
│                                                          │
│  Agent Plugin ──→ IPC Socket ──→ CliCommand dispatch     │
│  OTLP gRPC    ──→ :4317 ──→ protobuf parse              │
│  OTLP HTTP    ──→ :4318 ──→ JSON/protobuf parse         │
│  fredo emit   ──→ IPC Socket ──→ CliCommand dispatch     │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
              Adapter.transform(transport, payload)
                         │
                    Vec<FredoEvent>
                         │
              ContractEngine.req_2_3_process()
                         │
                Vec<SubscriptionDelivery>
                         │
              EventBus.emit_delivery(batch)
                         │
    app_handle.emit("fredo-stream-event", SubscriptionDelivery)
                         │
                         ▼
              Webview — TauriAdapter.onMessage()
                         │
       detect contractName+lifecycle → addDelivery()
                         │
              AppProvider → StreamContext.addDelivery()
                         │
              useReducer dispatch → React re-render
                         │
        Feature component (matched via eventContracts)
                         │
              feature.handleDelivery(delivery)
                         │
              renders updated data
```

When the user interacts with the UI directly (e.g. clicking a button), the flow uses `adapterBridge.invoke(command, args)` → Tauri IPC command → Rust feature handler → `ContractEngine.req_2_3_process()` → same reactive path.

Raw `FredoEvent` never crosses IPC — only `SubscriptionDelivery` does. The `ContractEngine` buffers events by composite key, evaluates `completeWhen` conditions, and delivers assembled payloads via Init → Update → End lifecycle. When `completeWhen` fires on the first matching event for a composite key, both `init` and `end` deliveries are emitted in order — the engine guarantees init-before-end regardless of when `completeWhen` fires (fixed spec #369).

### ECE Compositing — Cross-Session Parent-Child Merging (Spec #523)

The ECE (Event Contract Engine) handles parent-child session merging generically via a **relationship registry**, enabling subagent aggregation without adapter-level sessionId rewriting.

#### Relationship Metadata Convention

Adapters detect parent-child relationships (e.g., PostToolUse `task` events with `tool_response.metadata.sessionId` + `parentSessionId`) and attach relationship metadata to the FredoEvent:

```json
{
  "metadata": {
    "relationship": {
      "type": "parent-child",
      "parentSessionId": "<parent>",
      "childSessionId": "<child>"
    }
  }
}
```

Adapters **never rewrite sessionIds** — they preserve real sessionIds and annotate with relationship metadata. This makes subagent merging adapter-agnostic for future providers (Copilot, Claude Code, etc.).

#### Relationship Registry

`EngineInner` holds two maps (`infrastructure/comm/contract/engine.rs`):
- **`child_to_parent: HashMap<String, String>`** — child→parent session ID mappings (capped at 10,000 entries, oldest-first eviction)
- **`parent_to_children: HashMap<String, Vec<String>>`** — reverse lookup for cleanup

When `do_process()` detects `metadata.relationship.type === "parent-child"`, it calls `register_relationship(parent, child)` BEFORE iterating contracts. This ensures the mapping exists before any child events are processed (forward compositing).

#### Cross-Session Compositing

In `process_for_contract()`, if an event's `sessionId` is a registered child, the ECE substitutes the parent's `sessionId` in the composite key before buffer lookup. Child events are buffered under the parent session's key space, while preserving the child's `correlationId`. The frontend continues to detect subagents via `deliveryCorrelationId(d) !== deliverySessionId(d)`.

When a relationship is registered AFTER child events already have buffers (late-relationship), existing child buffers are re-keyed to the parent sessionId and **"init" lifecycle deliveries** are emitted with `compositedChildSessionId` in the delivery payload. The frontend's Mission Monitor (`useMissionMonitor.ts`) creates graph nodes (SubagentNode) ONLY on `lifecycle: "init"` deliveries — `"update"` deliveries are for metadata-only modifications to existing nodes. Bug #523 cycle 3: the initial implementation emitted `"update"` for re-keyed deliveries, causing SubagentNodes to never be created. The fix (commit 5c03926) changed it to `"init"`. **When designing ECE lifecycle behavior, always verify what lifecycle the frontend consumer expects — the consumer contract (init = create, update = modify) is the source of truth, not the ECE designer's assumption.** The test `late_relationship_rekeys_existing_buffers` originally asserted `"update"` — it codified the same lifecycle misunderstanding. The test now asserts `"init"`.

> **#593 deactivation:** As of commit 85518f8, SubagentNode creation in the Mission Monitor frontend is deactivated — all non-chat node code paths return early. The ECE relationship registry still operates and emits composited deliveries, but the frontend no longer acts on them to create SubagentNodes. This ensures the ECE infrastructure is ready for future re-activation without backend changes.

#### Why ECE Compositing Instead of Adapter Rewriting

Spec #509 attempted adapter-level sessionId rewriting but failed because PostToolUse `task` events fire AFTER `session.created` — the timing gap made rewriting impossible (the sessionId is already set when the rewrite information arrives). ECE compositing works because it composites at the **delivery level**, not the event level — it doesn't need to see events before they exist. This is a recurring Fredo design principle: when timing gaps exist, solve data transformations at the delivery/compositing layer (ECE), not the event-level layer (adapter).

---

## ECE Compositing — Cross-Session Merging (Spec #523)

The Event Contract Engine includes a **relationship registry** for parent-child session compositing, enabling adapter-agnostic subagent merging. Instead of rewriting sessionIds at the adapter level (Spec #509's approach, which failed due to timing gaps), adapters emit real sessionIds with relationship metadata and the ECE handles cross-session compositing generically.

### Relationship Metadata Convention

When an adapter detects a parent-child session relationship, it attaches relationship metadata to the FredoEvent:

```json
{
  "metadata": {
    "relationship": {
      "type": "parent-child",
      "parentSessionId": "<parent-uuid>",
      "childSessionId": "<child-uuid>"
    }
  }
}
```

Adapters never rewrite sessionIds — they preserve real sessionIds and annotate with relationship metadata. New adapters (Copilot, Claude Code, etc.) follow this same convention.

### Relationship Registry

`EngineInner` (`contract/engine.rs`) maintains two maps:
- `child_to_parent: HashMap<String, String>` — child→parent session ID mappings (capped at 10,000 entries, oldest-first eviction)
- `parent_to_children: HashMap<String, Vec<String>>` — reverse lookup for cleanup

The `do_process()` method detects relationship metadata before contract processing and calls `register_relationship()`. This method:
1. Stores the mapping
2. **Re-keys existing child buffers:** If child events were already processed before the relationship arrived, existing buffers are moved to use the parent sessionId in their composite key
3. Emits TWO deliveries for late relationships: a `timedOut: true` "end" delivery with the old (child) key (so the frontend can clean up the child session from the sidebar) AND an **"init"** delivery with the new (parent) key. The "init" lifecycle triggers SubagentNode creation in the frontend (deactivated as of #593 — see deactivation note in §ECE Compositing above); subsequent child events arrive as "update" deliveries on the existing buffer.

### Cross-Session Compositing

In `process_for_contract()`, after building composite key values: if the event's `sessionId` is a known child, the parent's sessionId is substituted in the composite key before buffer lookup. The event itself retains its real sessionId — only the ECE key is affected. Child events are thus buffered under the parent's composite key space.

### Frontend Detection

The pattern `deliveryCorrelationId(d) !== deliverySessionId(d)` continues to work unchanged (the ECE still composites child sessions into parent delivery streams). Composited deliveries include `compositedChildSessionId` in the delivery payload for debugging. The Mission Monitor frontend currently ignores this pattern as of #593 — non-chat node creation is deactivated, so the subagent detection path in `useMissionMonitor.ts` returns early.

### Architectural Rationale

Spec #509 attempted adapter-level sessionId rewriting but PostToolUse `task` events carrying the parent-child mapping fire AFTER `session.created` — the timing gap made rewriting impossible. Delivery-level compositing (ECE) succeeds where event-level rewriting (adapter) fails because cross-session compositing doesn't need to see events before they exist.

**Principle:** Always solve data transformations at the right architectural layer — delivery-level compositing (ECE) is more robust than event-level rewriting (adapter) when timing gaps exist.

---

## Rust Backend — Feature Modules

```
src-tauri/src/
+-- main.rs                     — dual-mode entry point (GUI vs CLI)
+-- lib.rs                      — AppRuntime composition root; registers EventBus, commands, state
+-- runtime/
|   +-- mod.rs                  — AppRuntime struct
|   +-- capability.rs           — DesktopCapable, CliCapable traits
+-- features/
|   +-- terminal/               — PTY-based AI CLI terminal
|   |   +-- mod.rs              — TerminalFeature (DesktopCapable)
|   |   +-- state.rs            — RunCliState (PTY writer, buffer, killer)
|   |   +-- commands.rs         — open_run_cli, get_pty_buffer, write_pty_input, resize_pty, close_run_cli
|   +-- llm/                    — In-process llama.cpp inference
|   |   +-- mod.rs              — LlmFeature (DesktopCapable)
|   |   +-- engine.rs           — LlmEngine (direct llama.cpp bindings via llama-cpp-2)
|   |   +-- service.rs          — LlmService (async chat, chat_with_image)
|   |   +-- state.rs            — LlmState + LlmLoadingState
|   |   +-- commands.rs         — llm_chat, llm_chat_with_image
|   +-- settings/               — Persistent KV settings (SQLite)
|   |   +-- mod.rs              — SettingsFeature
|   |   +-- commands.rs         — save_setting, get_setting
|   +-- setup/                  — CLI detection, PATH management, OTel config, model download
|   |   +-- mod.rs              — SetupFeature
|   |   +-- commands.rs         — check_cli_installations, install_plugin, check_fredo_in_path, add_fredo_to_path, check_otel_configured, configure_otel, get_setup_plan, check_all_setup, run_setup_step, check_model_files, download_model
|   +-- screenshot/             — Screen capture (xcap)
|       +-- mod.rs              — ScreenshotFeature
|       +-- commands.rs         — capture_screen_region
+-- infrastructure/
    +-- comm/                   — Communication layer
    |   +-- mod.rs              — re-exports: FredoEvent, EventBus, CommAdapter
    |   +-- event.rs            — FredoEvent, EventType, EventProvider, Transport, EventState, FredoEventBuilder
    |   +-- bus.rs              — EventBus (emits on "fredo-stream-event")
    |   +-- adapter.rs          — CommAdapter trait
    |   +-- adapters/
    |       +-- mod.rs
    |       +-- opencode.rs     — OpenCodeAdapter (Hook + OTLP connectors)
    |       +-- internal.rs     — InternalAdapter (server-side defaults)
    +-- storage/
    |   +-- mod.rs              — AppStore (SQLite KV store) + FeatureStore
    |   +-- feature_store.rs    — FeatureStore (typed feature-level SQLite)
    |   +-- span_store.rs       — SpanStore (telemetry span persistence)
    +-- telemetry/              — Telemetry tracing + metrics + logging (Spec #396 + #407 + #408)
    |   +-- mod.rs              — SpanCollector + SpanBuffer + MetricCollector + MetricBuffer + LogCollector + LogBuffer + LogBridgeLayer
    +-- ipc.rs                  — local socket server + CliCommand dispatch
    +-- cli/                    — clap CLI parser
    |   +-- mod.rs              — Cli root; run() + build_ipc_command()
    |   +-- commands/
    |       +-- mod.rs
    |       +-- emit.rs         — emit event command
    |       +-- setup.rs        — setup subcommand
    +-- otlp/                   — OTLP receivers
        +-- mod.rs              — OtlpState (trace→session correlation)
        +-- grpc.rs             — gRPC receiver (:4317)
        +-- http.rs             — HTTP receiver (:4318)
+-- utils/
    +-- error.rs                — anyhow re-exports

```

### Capability Traits

| Trait | Meaning |
|-------|---------|
| `DesktopCapable` | Feature registers Tauri commands and manages Tauri state |
| `CliCapable` | Feature can be invoked from the `fredo` CLI |

### FeatureStore — Typed Feature-Level SQLite

The `FeatureStore` (spec #339, `infrastructure/storage/feature_store.rs`) provides a generic, typed-column SQLite database for any feature. Each feature gets namespaced tables (`feature_{featureId}_*`) with column types TEXT, INTEGER, REAL, or BLOB. Cross-feature isolation is enforced — a feature cannot access tables belonging to another feature.

**Tauri commands** (registered in `lib.rs`):
| Command | Description |
|---------|-------------|
| `feature_store_ensure_table` | Create a namespaced table with typed columns |
| `feature_store_insert` | Insert rows; returns count |
| `feature_store_query` | Query rows with optional WHERE, ORDER BY, LIMIT |
| `feature_store_update` | Update matching rows; returns count |
| `feature_store_delete` | Delete matching rows; returns count |

**Frontend client**: `shared/lib/featureStore.ts` wraps each command via `adapterBridge.invoke()`.

The FeatureStore opens its own connection (WAL mode) to the same `fredo.db` file used by `AppStore`. No cross-store data sharing is required.

**Idempotency**: `feature_store_insert` uses `INSERT OR IGNORE` (spec #369). Duplicate inserts with the same unique key silently succeed without UNIQUE constraint errors. This guarantees delivery-level idempotency when the ECE re-delivers events.

### Infrastructure vs Features

| Layer | Contains | Does NOT contain |
|-------|----------|-----------------|
| `features/` | Models, service logic, state, Tauri command handlers | Shared platform code |
| `infrastructure/` | FredoEvent, EventBus, CommAdapter, AppStore, FeatureStore, IPC socket, CLI parser, OTLP receivers | Business logic |

---

## OTLP Receivers

Fredo implements the OpenTelemetry Protocol as a **local-only collector** — no data leaves the machine.

### gRPC Receiver (`:4317`)
- Implements `TraceService`, `MetricsService`, `LogsService` via `tonic`
- Receives OTLP protobuf from OpenCode
- Spans are transformed via `OpenCodeAdapter::transform(Transport::OtlpGrpc, ...)`; metrics and logs are dropped (no UI consumer)

### HTTP Receiver (`:4318`)
- Axum server handling `POST /v1/traces`, `/v1/metrics`, `/v1/logs`
- Accepts both protobuf (`application/x-protobuf`) and JSON (`application/json`)
- Includes `/health` and `/v1/test` diagnostic endpoints

### Trace→Session Correlation
The `OtlpState` maintains a `HashMap<String, String>` mapping trace IDs to session IDs. This is a two-pass algorithm implemented directly in the OTLP receivers and `OpenCodeAdapter::transform_otlp()`:

- **Pass 1**: Build the trace→session map from `gen_ai.conversation.id` and `session.id` span attributes
- **Pass 2**: Emit `FredoEvent` records for relevant spans only

`chat` child spans arrive in separate HTTP batches and are cached — their content is attached to parent `invoke_agent` nodes in the Mission Monitor.

---

## Telemetry Metrics (Spec #407)

The `telemetry` module (`infrastructure/telemetry/`) also collects OpenTelemetry-compatible metrics from the FredoEvent stream, parallel to span tracing.

### MetricCollector

Observes the same FredoEvent stream as `SpanCollector` at all 4 dispatch points (ipc.rs, grpc.rs, http.rs). Derives:

| Metric | Type | Description |
|--------|------|-------------|
| `span_count` | Counter | Incremented on span completion (Response/Error), labeled with `span_name` + `status` (`ok`/`error`) |
| `events_received` | Counter | Incremented on every Init event, labeled with `event_type` + `transport` |
| `orphan_spans` | Counter | Incremented by sweep count from SpanCollector's orphan sweep |
| `active_sessions` | Gauge | Snapshot of unique active session IDs (Init state, not yet completed) at flush time |
| `span_duration_ms` | Histogram | Span duration recorded on completion, bucketed: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] ms |

### MetricBuffer

In-memory aggregation buffer. Counters accumulate; histogram buckets accumulate; gauge values are snapshotted. Flushes pre-aggregated `MetricPoint` rows to SQLite at configurable intervals (default 60s, configurable via `tracing.metrics_aggregation_s` setting). Flush writes one row per metric label combination — no per-event DB writes.

### SpanStore Extension

- **`telemetry_metrics` table**: `id`, `metric_name`, `metric_type` (counter/gauge/histogram), `labels_json`, `value`, `timestamp` (RFC3339), `aggregation_window_s`. Index on `(metric_name, timestamp)`.
- **`insert_metrics()`**: Batch-inserts pre-aggregated `MetricPoint` rows in a single transaction.
- **Retention + purge**: `delete_expired()` and `purge_all()` cover both `telemetry_spans` and `telemetry_metrics`.

### Settings

| AppStore Key | Type | Default | Description |
|-------------|------|---------|-------------|
| `tracing.enabled` | bool | `true` | Master span collection toggle (Phase 1) |
| `tracing.metrics_enabled` | bool | `true` | Metric collection toggle — cached in `AtomicBool` |
| `tracing.metrics_aggregation_s` | int | `60` | Flush interval; settable in UI (10s/30s/60s/120s/300s) |

### UI

The `TelemetrySettings` component (`apps/ui/src/features/home/components/settings/TelemetrySettings.tsx`) includes a Metrics section below the Tracing section: enable/disable Switch, aggregation window dropdown selector, and metric storage stats (point count + estimated bytes).

### Background Flush Task

A background async task in `lib.rs` runs `MetricCollector.flush_if_needed()` at a 1-second tick. The collector tracks elapsed time since last flush via `Instant` and writes only when the configured aggregation window has elapsed. On shutdown, `flush_all()` drains remaining buffered metrics before the DB connection closes.

---

## Telemetry Logging (Spec #408)

The `telemetry` module also collects structured logs from the Rust backend via the `tracing` crate ecosystem, replacing ad-hoc `eprintln!`/`println!` calls.

### LogCollector

Observes `tracing` events through a custom `LogBridgeLayer` implementing `tracing_subscriber::Layer<S>`. Converts `tracing::Event` records into `LogRecord` structs (level, target, message, attributes_json, trace_id, span_id, session_id, timestamp). Buffered in a `LogBuffer` (Mutex-protected Vec) that flushes to SQLite at 5-second intervals or when 500 records accumulate.

### LogBridgeLayer

A custom `tracing_subscriber::Layer` registered on the global `tracing_subscriber::Registry` alongside `fmt::Layer` (console). Converts `tracing` events (from `info!`, `warn!`, `error!`, `debug!`, `trace!` macros) into `LogRecord` structs and routes them to the shared `LogCollector`. Initialized in `lib.rs` before any code path that emits tracing macros — the subscriber uses `set_global_default` (one-time initialization).

### telemetry_logs Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `timestamp` | TEXT | RFC3339 timestamp of the log event |
| `level` | TEXT | Log level: TRACE, DEBUG, INFO, WARN, ERROR |
| `target` | TEXT | Module path emitting the log |
| `message` | TEXT | Log message text |
| `attributes_json` | TEXT | Structured key=value attributes as JSON |
| `trace_id` | TEXT | Active span's trace ID (null if outside span context) |
| `span_id` | TEXT | Active span's span ID (null if outside span context) |
| `session_id` | TEXT | Session identifier (reserved for future use) |

Indexes: `idx_logs_timestamp`, `idx_logs_level`, `idx_logs_trace_id`, `idx_logs_session_id`.

### Settings

| AppStore Key | Type | Default | Description |
|-------------|------|---------|-------------|
| `tracing.logging_enabled` | bool | `true` | Master log collection toggle — cached in `AtomicBool` |
| `tracing.logging_level` | string | `INFO` | Minimum log level filter (TRACE/DEBUG/INFO/WARN/ERROR) |

### UI

The `TelemetrySettings` component includes a Logging section between Metrics and Retention: enable/disable toggle and minimum log level dropdown selector. Storage stats display includes log entry count and estimated storage bytes.

### Migration Scope

~80 `eprintln!`/`println!` calls across 16 production files replaced with appropriate `tracing` macros using structured `key=value` attributes. Test-code calls (e.g., `features/llm/engine.rs:533`) are excluded.

### Background Flush Task

A background async task in `lib.rs` runs `LogCollector.flush_if_needed()` at a 1-second tick. The collector tracks elapsed time since last flush via `Instant` and writes only when the 5-second window has elapsed or 500 records accumulate. On shutdown, `flush_all()` drains remaining buffered logs before the DB connection closes. Retention cleanup (based on `tracing.retention_days`) covers `telemetry_logs` alongside `telemetry_spans` and `telemetry_metrics`.

---

## In-Process LLM Engine

The `llm` feature runs **llama.cpp directly in-process** via vendored `llama-cpp-2` Rust bindings — no child processes, no HTTP/SSE round-trips.

### LlmEngine
- `load()` — text-only GGUF model loading
- `load_with_vision()` — multimodal loading with mmproj projector
- `generate()` — autoregressive token generation with greedy+dist sampler
- `generate_with_image()` — decodes PNG/JPEG, resizes to 448×448, creates `MtmdBitmap`, tokenizes with media markers

### Token Streaming
`LlmService.chat_async()` and `chat_with_image_async()` stream tokens via `mpsc::unbounded_channel` → `tokio::task::spawn_blocking` → Tauri `app.emit("llm-token")` / `app.emit("llm-done")`.

### Supported Models
| Model | Vision | Notes |
|-------|--------|-------|
| Gemma 4 E2B (`gemma-4-e2b`) | ✓ | Full vision support via mmproj |
| MiniCPM-V 4.6 (`minicpm-v-4-6`) | ⚠️ | Vision projector unsupported in current llama.cpp; falls back to text-only |

---

## React UI — Reactive Feature Modules

```
apps/ui/src/
+-- app/
|   +-- adapters/
|   |   +-- HostAdapter.ts          — interface: onMessage, invoke, llmChat, llmChatWithImage
|   |   +-- TauriAdapter.ts         — @tauri-apps/api via dynamic imports
|   |   +-- DevAdapter.ts           — in-memory emitter + mock LLM
|   +-- providers/
|       +-- AppProvider.tsx         — wires adapter → StreamContext; registers adapterBridge
+-- features/
|   +-- featureRegistry.ts          — global feature registry (mirrors AppRuntime)
|   +-- allFeatures.ts              — Vite glob auto-discovery: `import.meta.glob('./*/index.ts', { eager: true })`
|   +-- home/                       — Home panel + AlertHandler + FredoCompanion
|   +-- diagram/                    — Infrastructure diagram (ReactFlow)
|   +-- run-cli/                    — xterm.js terminal (PTY output)
|   +-- query-viewer/               — SQL query result display (multi-instance)
|   +-- my-workitems/               — Azure DevOps work items
|   +-- settings/                   — Settings panel + ModelSelector
|   +-- setup/                      — SetupWizard (OTel config, CLI detection)
|   +-- mission-monitor/            — Real-time agent activity graph
|   +-- dev-mode/                   — Dev tools + OTLP inspector
|   +-- browser-preview/            — Web page preview panel
|   +-- docs-viewer/                — Documentation viewer
|   +-- github-viewer/              — GitHub repository browser
|   +-- optimizely/                 — Feature flag management
|   +-- theming/                    — Theme customization
|   +-- model-storage/              — Model file management
+-- shared/
    +-- contexts/StreamContext.tsx  — useReducer event bus; FredoEvent store
    +-- classes/
    |   +-- FredoFeatureClass.ts    — abstract base class for grid features
    |   +-- EventSubscription.ts    — typed subscription types (EventContract, SubscriptionDelivery)
    |   +-- types.ts                — EventFilter, GridItemConfig
    +-- utils/adapterBridge.ts      — non-React singleton for feature → invoke()
    +-- components/
        +-- companion/
            +-- FredoCompanion.tsx  — Animated sprite + LLM companion
            +-- SpeechBubble.tsx    — Positionable bubble with game slot
            +-- features/
                +-- tictactoe/      — Tic-Tac-Toe game (vision-based AI)
```

### Active UI Features

| Feature | showable | contracts | Description |
|---------|----------|---------------|-------------|
| home | ✓ | — | Navigation grid, alert handling, FredoCompanion |
| diagram | ✓ | infrastructure_stream | Infrastructure visualization (ReactFlow) |
| run-cli | ✓ | [] | xterm.js terminal (PTY output from Rust) |
| query-viewer | ✓ | (dynamic) | SQL query result display (multi-instance) |
| my-workitems | ✓ | azdo_create_work_item | Azure DevOps work items |
| settings | ✓ | — | App settings + model selection |
| setup | ✗ | — | OTel configuration, CLI detection |
| mission-monitor | ✓ | chat-node (ECE contract) | Delivery-driven agent activity graph with force-directed layout (d3-force) |
| dev-mode | ✗ | — | Dev tools, OTLP event inspector |
| browser-preview | ✓ | — | Web page preview panel |
| docs-viewer | ✓ | — | Documentation viewer |
| github-viewer | ✓ | — | GitHub repository browser |
| optimizely | ✓ | — | Optimizely feature flag management |
| theming | ✗ | — | Theme customization (hidden from grid) |
| model-storage | ✓ | — | Model file management |

### FredoFeatureClass

Every UI feature extends `FredoFeatureClass`:

```typescript
abstract class FredoFeatureClass<TProps = {}> {
  // Required
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly icon: IconType;
  abstract render(props?: TProps): ReactElement;

  // Event Contract Engine (post-Spec #311)
  readonly eventContracts: EventContractDeclaration[] = [];
  handleDelivery(_delivery: ContractDelivery): void {}  // default no-op

  // Optional
  readonly gridConfig: GridItemConfig;   // { closable, maximizable }
  readonly showable: boolean = true;
  readonly isMultiWindow: boolean = false;
  readonly hasSettings: boolean = false;
  renderSettings?(): ReactElement;

  // Lifecycle hooks
  onMount?(): void | Promise<void>;
  onUnmount?(): void | Promise<void>;
}
```

### Feature Contracts

Features declare what events they need through the **Event Contract Engine (ECE)** — a GraphQL-inspired query system:

- **`eventContracts`** — `EventContractDeclaration[]` on `FredoFeatureClass`. Declares streamFields, deferredFields, composite key, completeWhen condition, timeout, and optional filtering fields (`providers`, `transports`, `eventTypes`). Registered with the Rust ECE engine via `registerEventContracts()` IPC call.
- **`handleDelivery(delivery: ContractDelivery)`** — called for every `SubscriptionDelivery` matching the feature's registered contracts. Delivers via Init → Update → End lifecycle.
- **ECE filtering**: Contracts can declare `providers`, `transports`, and `eventTypes` to filter events at the ContractEngine level (Specs #311, #382). Only events matching ALL declared filters reach the feature. Filtering by `transports` (snake_case: `hook`, `otlp_grpc`, `otlp_http`) prevents duplicate nodes from dual-transport events (Hook + OTLP). Filtering by `eventTypes` (snake_case: `chat`, `tool_use`, `agent_session`) excludes streaming delta events from node-creation contracts. Backward-compatible — omitting a filter matches all.
- **Legacy `eventFilters`** (removed from migrating features in Spec #311) — previously used for simple toolName/state/custom matchers. Kept only in non-migrating features (setup, run-cli, query-viewer, model-storage).
- **Legacy `eventSubscriptions`** (Spec #252) — typed subscriptions removed in Spec #311. Replaced by ECE contracts.

### StreamContext — the Event Bus

`StreamContext` is a `useReducer`-based store holding all `ContractDelivery` records. **Append-only during a session** (with TTL-based expiry). Deliveries are **never mutated** after insertion — the UI derives display state from the delivery log. Raw `FredoEvent` objects no longer cross IPC to the frontend — only `SubscriptionDelivery` does.

**Performance bounds (Spec #498, #509):** `deliveries[]` is capped at **5,000 entries** — oldest evicted when cap exceeded (REQ-1). Deliveries older than **5 minutes (300s)** are removed during the cleanup sweep every 10 seconds (REQ-2). OpenCodeAdapter child→parent session map capped at **10,000 entries** with oldest-first eviction; agent-name filter excludes internal tool-execution sessions (build, plan) (Spec #509 REQ-1, Bug #509 cycle 2). `childToParentSession` Map and `processedMappingIds` Set removed (Spec #509 REQ-11 — session merge now handled at adapter level).

### FredoEvent Shape

```typescript
interface FredoEvent {
  id: string;
  eventType: 'ToolUse' | 'AgentSession' | 'Chat' | 'Infrastructure' | 'Ui' | 'Custom';
  state: 'Init' | 'Update' | 'Response' | 'Error';
  provider: 'opencode' | 'claudeCode' | 'internal';
  transport: 'hook' | 'otlpGrpc' | 'otlpHttp' | 'webSocket' | 'httpPost' | 'internal';
  sessionId: string;
  correlationId?: string;
  toolName?: string;
  payload?: any;
  error?: { message: string; code?: string; details?: any };
  metadata?: any;
  timestamp: string;
}
```

### HostAdapter — Swappable Transport

```
HostAdapter (interface)
├── TauriAdapter   → @tauri-apps/api via dynamic imports  [production]
└── DevAdapter     → in-memory emitter + mock LLM         [Vite dev server]

Methods: onMessage(), invoke(), llmChat(), llmChatWithImage()
```

The `adapterBridge` singleton allows non-React code (e.g. `FredoFeatureClass` methods) to call `invoke()`, `llmChat()`, and `llmChatWithImage()`.

---

## FredoCompanion

The animated companion sprite on the Home panel:

- **Spritesheet**: 6-col × 4-row at 80×80px per frame
- **States**: idle (loop), talk (loop), teleport-out (one-shot), teleport-in (one-shot)
- **Personality**: "friendly robot who loves programming, tells jokes, plays Tic-Tac-Toe"
- **Jokes**: 20 topics (recursion, git, CSS, regex, etc.)
- **Streaming**: Token-by-token accumulation with `<end_of_turn>`/`<start_of_turn>` stripping
- **Cross-window teleport**: Tauri global `companion-teleport` events broadcast to all webview windows
- **Interaction**: Single-click → joke; double-click → Tic-Tac-Toe; Ctrl+right-click → teleport

### Tic-Tac-Toe
- Player = X, Companion = O
- **Vision-based AI**: screenshot of board → `capture_screen_region` → LLM vision prompt → parse digit 0-8
- **Fallback**: first empty cell on error/invalid response
- Embedded in `SpeechBubble` component (208×268px fixed dimensions)

---

## Mission Monitor

The delivery-driven agent activity graph (ReactFlow). Post-Spec #318, Mission Monitor consumes `ContractDelivery` objects exclusively from `StreamContext.deliveries` — no `FredoEvent`, no `localStorage`, no `buildGraphFromEvents()`.

- **Data source**: `StreamContext.deliveries` (append-only `ContractDelivery[]`) via the `chat-node` ECE contract — `streamFields: ['payload', 'state']`, `transports: ['hook', 'otlp_grpc', 'otlp_http']` (as of Spec #601, includes OTLP transports alongside Hook to capture direct OTLP plugin exports), `eventTypes: ['chat', 'agent_session']`, composite key `(sessionId, correlationId)`, `completeWhen: "state === 'Response'"`. As of #593, only the `chat-node` contract is active — `tool-use-lifecycle` and `custom-event` contracts were deactivated in commit 85518f8 (previously reactivated in PR #599). The subagent-lifecycle contract name exists as a helper in `contract.ts` but is not registered as a feature contract — subagent lifecycle handling within the `chat-node` handler (Spec #523 correlationId/sessionId comparison) is also deactivated.
- **Graph builder**: `useDeliveryGraph()` — derives ReactFlow nodes/edges from `ContractDelivery` payloads. Lifecycle mapping: `init` creates nodes, `update` modifies metadata, `end` sets final status (`complete`/`error`)
- **Node types (as of #593)**: Agent (Chat) only — Subagent, Tool, and File node creation deactivated in commit 85518f8. SubagentNode, ToolNode, and FileNode components and styling remain defined for potential future re-activation.
- **Edge types (as of #593)**: No edges currently created — `parent` (Agent→Subagent), `calls` (Agent/Subagent→Tool), and `reads`/`writes` (Tool→File) edge definitions remain but are unused as non-chat nodes are deactivated.
- **Detail Panel**: Slide-in panel on node click, shows type/ID/status/token counts/timestamps/duration. Hides on background click or Escape
- **Session History**: Derived from SQLite-persisted deliveries merged with live StreamContext data (spec #339). Auto-collapsing sidebar (icon-only on mouse leave after 300ms delay), session search/filter by ID substring, caps at 50 sessions / 500 events per session

---

## Performance Guardrails (Spec #498)

All seven subsystems now have bounded growth — preventing the progressive degradation (sluggish → UI freeze) observed after 2-4+ hours of use.

| Subsystem | Bound | Mechanism |
|-----------|-------|-----------|
| StreamContext `deliveries[]` | 5,000 entries | Hard cap + oldest eviction on ADD_DELIVERY |
| StreamContext delivery TTL | 300s (5 min) | Cleanup sweep every 10s removes expired deliveries |
| ECE relationship registry `child_to_parent` | 10,000 entries | Oldest-first eviction (pop + insert) — `parent_to_children` cleaned on buffer removal (Spec #523) |
| OpenCodeAdapter `child_to_parent` field | REMOVED | Spec #523 — session merge handled by ECE compositing; adapter emits relationship metadata |
| `childToParentSession` Map | REMOVED | Spec #509 — session merge handled at adapter level (now superseded by Spec #523 ECE) |
| `processedMappingIds` Set | REMOVED | Spec #509 — session merge handled at adapter level (now superseded by Spec #523 ECE) |
| Mission Monitor graph rebuild | O(N_new) per delivery | Incremental node/edge updates (was O(N_total)) |
| Home.tsx `updateWindow()` | 1 call per 200ms per feature | Per-feature throttle coalescing; `handleDelivery()` still called for every event |
| Home.tsx ECE deregistration | On unmount | Stored deregistration function from `registerEventContracts()` called in cleanup |
| ECE completed buffers | 5 min TTL | Sweep removes buffers marked `completed` older than 5 min |
| OpenCodeAdapter `HashMap`s | 10,000 entries each | LRU eviction on `trace_to_session`, `session_to_correlation`, `tool_call_id`, `child_to_parent` (Spec #509) |
| SpanCollector `session_span_stack` | Cleaned on completion | `span_id` popped on Response/Error lifecycle |
| RunCliState `output_buffer` | 10 MB | Oldest data truncated when cap exceeded |

**Rust backend bounds** are in `apps/tauri/src-tauri/src/`:
- `infrastructure/comm/contract/engine.rs:416-449` — ECE sweep completed buffer cleanup
- `infrastructure/comm/contract/engine.rs:649-710` — ECE relationship registry (child_to_parent + parent_to_children) with 10K cap + eviction + re-keying (Spec #523)
- `infrastructure/comm/adapters/opencode.rs:56-73` — Adapter `HashMap` field declarations (`trace_to_session`, `session_to_correlation`, `tool_call_id`; parent-child merge removed per Spec #523) — 10K cap + eviction at each write site within the file
- `infrastructure/telemetry/mod.rs:272-319` — Span stack pop on completion
- `features/terminal/state.rs` — Output buffer cap

**Frontend bounds** are in `apps/ui/src/`:
- `shared/contexts/StreamContext.tsx:196-233` — Delivery cap + TTL expiry
- `features/mission-monitor/lib/contract.ts` — Map/Set caps
- `features/mission-monitor/hooks/useMissionMonitor.ts:995-1229` — Incremental graph updates
- `features/home/components/Home.tsx:132-148` — Throttled `updateWindow()` + deregistration cleanup

---

## Agent Integration Points

| Integration | How it works |
|-------------|-------------|
| **OpenCode OTLP plugin** | The `fredo-opencode-plugin` exports OTLP metrics, logs, and traces directly to `127.0.0.1:4317` (gRPC) via the OpenTelemetry SDK. Replaces the previous CLI-based `fredo opencode-plugin` event forwarding. |
| **OTLP telemetry** | Configure OpenCode to send OTLP to `127.0.0.1:4317` (gRPC) or `127.0.0.1:4318` (HTTP). Fredo maps spans to `FredoEvent` records via `OpenCodeAdapter` in real time. The adapter now recognizes `fredo.session`, `fredo.llm`, and `fredo.tool.*` span names and determines EventState from `endTimeUnixNano` (present → Response, absent → Init). |
| **Terminal feature** | The `terminal` feature spawns OpenCode in a native PTY. PTY output streams as `run-cli-output` Tauri events. |
| **LLM feature** | In-process llama.cpp inference. `llm_chat` Tauri command accepts messages and streams tokens. |

### OpenCodeAdapter Event-to-State Mapping

The adapter (`infrastructure/comm/adapters/opencode.rs`) maps raw Hook events to `FredoEvent` records with specific `EventType` and `EventState` values. These states are consumed by the ECE to determine delivery lifecycle (Init → Update → End). **The adapter's `EventState` assignment for each event type MUST align with the ECE contract's `completeWhen` condition.**

Key mappings (as of Bug #586 fix):

| Hook event_type | EventType | EventState | Sub-role check | Notes |
|----------------|-----------|------------|---------------|-------|
| `UserPromptSubmit` | Chat | Init | — | Starts a turn |
| `chat.message` (user) | Chat | Init | `output.message.role === "user"` | User message starts turn; does NOT trigger `completeWhen` |
| `chat.message` (assistant) | Chat | Response | `output.message.role === "assistant"` | Assistant response ends turn; triggers `completeWhen` |
| `message.updated` / `message.part.updated` / `message.part.delta` | Chat | Update | — | Streaming deltas during response |
| `SessionStart` / `session.created` | AgentSession | Init | — | Agent session start |
| `session.updated` (no output) | AgentSession | Update | — | Intermediate session update (e.g., during agent thinking phase); does not trigger `completeWhen` |
| `session.updated` (with output) | AgentSession | Response | `properties.output` is non-empty | Agent output complete; triggers `completeWhen` to deliver accumulated response to frontend. See `normalize_agent_payload` for extraction paths. |
| `SessionEnd` / `session.deleted` / `session.next.*.ended` | AgentSession | Response | — | Session end; triggers `completeWhen` |
| `PreToolUse` | ToolUse | Init | — | Tool execution start |
| `PostToolUse` | ToolUse | Response | — | Tool execution end; carries parent-child relationship metadata |

**Critical rule:** Multi-role events (like `chat.message`) MUST NOT use a single `EventState` for all roles. If a `chat.message` with `role: "user"` were mapped to `EventState::Response`, the ECE `chat-node` contract's `completeWhen: "state === 'Response'"` would fire BEFORE the agent's streaming response — and all subsequent Update deliveries would be silently discarded (Bug #586).

**Adapter payload normalization** (`normalize_agent_payload()`, line 1266) injects typed fields (`userMessage`, `agentReply`, `agentThinking`, `promptTokens`, `completionTokens`) alongside the raw event. Different event types have different payload nesting: `chat.message` has `output.message.parts[0].text` at the top level; `session.updated` nests `output` under `properties` (i.e., `properties.output.message.parts[0].text`). Extraction code MUST test against BOTH event types — a path that works for one may silently return empty for the other. Add `tracing::debug!` logging with raw event keys to surface extraction failures at runtime.

**Guards (PR #600):** Empty scalar strings (`""`) for `userMessage`, `agentReply`, and `agentThinking` are NEVER inserted into the payload object. Without this guard, a `session.updated` event that resolves `userMessage` to `""` would inject the empty string into the payload, and the ECE's deep-merge (JSON object merge) would replace the Init-time `userMessage` from `chat.message` (user) with an empty string. The guard follows the existing `if let Some(a)` pattern used for `agent`/`model` fields — only non-empty strings are inserted.

**Multi-part output handling (`find_text_part()`, PR #598):** DeepSeek and other reasoning models produce multi-part outputs where the `parts` array contains BOTH `type="thinking"` (reasoning) AND `type="text"` (actual response) entries. `find_text_part()` iterates the parts array to find the first `type="text"` part (with fallback for models that don't set part type). Never use `arr.first()` when extracting text from multi-part outputs — it blindly picks `parts[0]` which is the thinking/reasoning text for these models.

**Role guards (PR #597):** `userMessage` extraction from `properties.output` checks `role === "user"` before extracting — `session.updated` events carry agent output that would otherwise overwrite the user's prompt with agent response text. `properties.info.title` is NOT used as a `userMessage` fallback — session titles are not user messages.

---

## Dual-Mode Binary

The `fredo` binary detects its mode at startup:

```rust
if std::env::args().len() > 1 {
    // CLI: parse clap args -> connect to IPC socket -> send CliCommand -> exit
} else {
    // GUI: launch Tauri window + start IPC socket server + OTLP receivers
}
```

The same installed binary is both the desktop launcher and the `fredo` CLI in PATH.

---

## IPC Protocol

The local socket accepts newline-delimited JSON. Each message is a `CliCommand`.

### Socket Path

| OS | Path |
|----|------|
| Windows | `\\.\pipe\fredo-ipc` |
| macOS / Linux | `/tmp/fredo-ipc.sock` |

### CliCommand Schema

```jsonc
// Generic FredoEvent emission
{ "type": "emit_event", "event": { "id": "...", "eventType": "tool_use", ... } }
```

### IPC Dispatch Flow

```
CLI client (fredo emit ...)
  → connect to local socket
  → send CliCommand JSON
  → dispatch_command()
      └── EmitEvent → dispatch_emit_event()
            → InternalAdapter::enrich(event)  (stamp defaults)
            → EventBus::emit(enriched)
```

---

## Tauri Capabilities

Defined in `capabilities/default.json`:

| Permission | Why required |
|-----------|-------------|
| `core:default` | Standard window management |
| `core:event:allow-listen` | Webview subscribes to Tauri events (fredo-stream-event, llm-token, etc.) |
| `core:event:allow-emit` | Rust backend emits events to webview |
| `core:window:allow-create` | Backend opens new WebviewWindow (run-cli-terminal) |
| `core:window:allow-close` | Backend closes the terminal window |
| `core:window:allow-start-dragging` | Window drag support |
| `core:window:allow-set-title` | Dynamic window title updates |
| `shell:allow-open` | Open external URLs in system browser |
| `shell:allow-spawn` | Spawn child processes (PTY terminal) |
| `shell:allow-execute` | Execute shell commands (PTY terminal) |

---

## Tauri Commands (22 total)

All commands registered in `generate_handler![]` in `lib.rs`:

| Command | Feature | Description |
|---------|---------|-------------|
| `save_setting` / `get_setting` | settings | Persist/retrieve KV settings from AppStore |
| `open_run_cli` | terminal | Resolve binary, open PTY, spawn child |
| `get_pty_buffer` | terminal | Return buffered PTY output |
| `write_pty_input` | terminal | Write keyboard input to PTY |
| `resize_pty` | terminal | Resize PTY to new rows/cols |
| `close_run_cli` | terminal | Kill child, release PTY, close window |
| `check_cli_installations` | setup | Check if `opencode` is on PATH |
| `install_plugin` | setup | Install OpenCode plugin |
| `get_plugin_source_path` | setup | Return bundled plugin source path |
| `check_fredo_in_path` | setup | Check if `fredo` is on PATH |
| `add_fredo_to_path` | setup | Add Fredo to system PATH |
| `check_otel_configured` | setup | Check OTLP exporter config |
| `configure_otel` | setup | Write OTLP exporter config |
| `get_setup_plan` | setup | List pending setup steps |
| `check_all_setup` | setup | Run all setup checks |
| `run_setup_step` | setup | Execute a single setup step |
| `check_model_files` | setup | Check local model file existence |
| `download_model` | setup | Download model GGUF + mmproj |
| `llm_chat` | llm | Chat with in-process LLM (streams tokens) |
| `llm_chat_with_image` | llm | Chat with image (multimodal) |
| `capture_screen_region` | screenshot | Capture screen region as base64 PNG |
| `feature_store_ensure_table` | storage | Create a typed-column feature namespaced table |
| `feature_store_insert` | storage | Insert rows into a feature namespaced table |
| `feature_store_query` | storage | Query rows with optional WHERE/ORDER BY/LIMIT |
| `feature_store_update` | storage | Update rows matching WHERE clause |
| `feature_store_delete` | storage | Delete rows matching WHERE clause |
| `telemetry_get_stats` | telemetry | Return span count, metric point count, and storage bytes from telemetry_spans + telemetry_metrics |
| `telemetry_purge` | telemetry | Delete all rows from telemetry_spans AND telemetry_metrics |
| `telemetry_toggle` | telemetry | Enable/disable span collection via AppStore `tracing.enabled` |
| `telemetry_metrics_toggle` | telemetry | Enable/disable metric collection via AppStore `tracing.metrics_enabled` |
| `telemetry_logging_toggle` | telemetry | Enable/disable log collection via AppStore `tracing.logging_enabled` |
| `telemetry_logging_set_level` | telemetry | Set minimum log level filter via AppStore `tracing.logging_level` |
| `telemetry_get_log_stats` | telemetry | Return log count and estimated storage bytes from telemetry_logs |

---

## Startup Sequence

1. Initialize `AppStore` (SQLite KV store) — managed via `app.manage()`
2. Read `llm_model` setting, resolve model paths
3. Spawn `LlmEngine` loading in `spawn_blocking` task
4. Initialize `RunCliState` (PTY terminal) — managed via `app.manage()`
5. Start IPC socket server (`tokio::spawn`)
6. Start OTLP receivers (gRPC :4317 + HTTP :4318, each in `tokio::spawn`)
7. Register all Tauri command handlers via `generate_handler![]`
8. Launch Tauri webview window

---

## Archived Components

| Component | Was | Replaced by |
|-----------|-----|-------------|
| `apps/browser-extension` | Chrome extension host | `apps/tauri` |
| `apps/vscode-extension` | VS Code webview host | `apps/tauri` |
| `apps/tools-mcp` | Node.js MCP/SSE backend (Redis Streams) | Not yet reimplemented |
| `apps/ai-sidecar` | Node.js AI CLI sidecar | PTY-based `terminal` feature |
| `apps/marketplace-plugin` | Original OpenCode plugin | `apps/marketplace-plugin` (OpenCode) |
| UI: agents, chatbot, embeddings, memory, telemetry | Stub features | Consolidated into Mission Monitor |

---

## Further Reading

| Document | Contents |
|----------|----------|
| [docs/SETUP.md](SETUP.md) | Local development setup, model configuration |
| [docs/CLI_GUIDE.md](CLI_GUIDE.md) | Fredo CLI commands, OTLP setup |
| [docs/SECURITY.md](SECURITY.md) | Security model, capabilities, input handling |
