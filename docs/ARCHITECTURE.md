# Fredo — Architecture Overview

## What Fredo Is

Fredo is a **cross-platform desktop application** for working with AI coding agents. Built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend), it ingests agent telemetry and lifecycle events, normalizes them into canonical objects, and renders them as reactive UI features in real time.

Agents integrate through two paths:

1. **Agent plugin hooks** — the `fredo opencode-plugin` CLI sends hook events (PreToolUse, PostToolUse, etc.) via the IPC socket
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
| Agent plugin hooks | `fredo opencode-plugin` CLI via IPC socket | `Hook` |
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
- `OpenCodeAdapter::transform(Transport::OtlpGrpc, payload)` — maps OTLP spans (gen_ai.operation.name) into FredoEvents; trace-to-session correlation via internal HashMap
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
    +-- telemetry/              — Telemetry tracing + metrics (Spec #396 + #407)
    |   +-- mod.rs              — SpanCollector + SpanBuffer + MetricCollector + MetricBuffer
    +-- ipc.rs                  — local socket server + CliCommand dispatch
    +-- cli/                    — clap CLI parser
    |   +-- mod.rs              — Cli root; run() + build_ipc_command()
    |   +-- commands/
    |       +-- mod.rs
    |       +-- emit.rs         — emit event command
    |       +-- opencode_plugin.rs — opencode-plugin hook forwarding
    |       +-- setup.rs        — setup subcommand
    +-- otlp/                   — OTLP receivers
        +-- mod.rs              — OtlpState (trace→session correlation)
        +-- grpc.rs             — gRPC receiver (:4317)
        +-- http.rs             — HTTP receiver (:4318)
+-- utils/
    +-- error.rs                — anyhow re-exports
    +-- dump.rs                 — event dump persistence
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

The `TelemetrySettings` component (`apps/ui/src/features/home/components/settings/TelemetrySettings.tsx`) includes a Metrics section below the Tracing section: enable/disable Switch, aggregation window NativeSelect, and metric storage stats (point count + estimated bytes).

### Background Flush Task

A background async task in `lib.rs` runs `MetricCollector.flush_if_needed()` at a 1-second tick. The collector tracks elapsed time since last flush via `Instant` and writes only when the configured aggregation window has elapsed. On shutdown, `flush_all()` drains remaining buffered metrics before the DB connection closes.

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

- **Data source**: `StreamContext.deliveries` (append-only `ContractDelivery[]`) via the `chat-node` ECE contract — `streamFields: ['payload', 'state']`, `transports: ['hook', 'otlp_grpc', 'otlp_http']`, `eventTypes: ['chat']`, composite key `(sessionId, correlationId)`, `completeWhen: "state === 'Response'"`. Additional contracts (`tool-use-lifecycle`, `subagent-lifecycle`) use `transports: ['hook']`, `eventTypes: ['tool_use']` to exclude OTLP duplicates and `message.*` streaming noise (Spec #382).
- **Graph builder**: `useDeliveryGraph()` — derives ReactFlow nodes/edges from `ContractDelivery` payloads. Lifecycle mapping: `init` creates nodes, `update` modifies metadata, `end` sets final status (`complete`/`error`)
- **Node types**: Agent, Subagent, Tool, File — each with distinct visual styles (Token/status-aware, Chakra v3 retro-futuristic)
- **Edge types**: `parent` (dashed indigo, Agent→Subagent), `calls` (solid accent, Agent/Subagent→Tool), `reads`/`writes` (dotted muted, Tool→File)
- **Detail Panel**: Slide-in panel on node click, shows type/ID/status/token counts/timestamps/duration. Hides on background click or Escape
- **Session History**: Derived from SQLite-persisted deliveries merged with live StreamContext data (spec #339). Auto-collapsing sidebar (icon-only on mouse leave after 300ms delay), session search/filter by ID substring, caps at 50 sessions / 500 events per session

---

## Agent Integration Points

| Integration | How it works |
|-------------|-------------|
| **Agent plugin hooks** | OpenCode calls `fredo opencode-plugin <event_type>` on PreToolUse / PostToolUse. The `fredo` binary runs in CLI mode, connects to the IPC socket, sends a `CliCommand`, and exits. The `OpenCodeAdapter` transforms the payload into `FredoEvent` records. |
| **OTLP telemetry** | Configure OpenCode to send OTLP to `127.0.0.1:4317` (gRPC) or `127.0.0.1:4318` (HTTP). Fredo maps spans to `FredoEvent` records via `OpenCodeAdapter` in real time. |
| **Terminal feature** | The `terminal` feature spawns OpenCode in a native PTY. PTY output streams as `run-cli-output` Tauri events. |
| **LLM feature** | In-process llama.cpp inference. `llm_chat` Tauri command accepts messages and streams tokens. |

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
// OpenCode plugin event (forwarded from OpenCode plugin hook scripts)
{ "type": "open_code_plugin", "event_type": "PreToolUse", "payload": { ... } }

// Generic FredoEvent emission
{ "type": "emit_event", "event": { "id": "...", "eventType": "tool_use", ... } }
```

### IPC Dispatch Flow

```
CLI client (fredo opencode-plugin <event_type> --payload '...')
  → connect to local socket
  → send CliCommand JSON
  → dispatch_command()
      ├── OpenCodePlugin → dispatch_opencode_plugin()
      │     → validate event_type against ALLOWED_EVENT_TYPES
      │     → validate payload ≤ 1 MB
      │     → append to event-dump.jsonl
      │     → OpenCodeAdapter::transform(Transport::Hook, payload)
      │     → EventBus::emit() for each FredoEvent
      │
      └── EmitEvent → dispatch_emit_event()
            → InternalAdapter::enrich(event)  (stamp defaults)
            → EventBus::emit(enriched)
```

Payloads exceeding 1 MB are rejected. See `infrastructure/ipc.rs` for the full allowlist.

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
