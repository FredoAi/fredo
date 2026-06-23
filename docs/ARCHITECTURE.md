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

The UI does not call the backend to ask for data. Instead, it **listens to a stream of typed events** and reacts. Every feature declares which events it cares about via `eventFilters` or `eventSubscriptions`. When a matching `FredoEvent` arrives, the feature's component re-renders with the new data.

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
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
              Adapter.transform(transport, payload)
                         │
                    Vec<FredoEvent>
                         │
                    EventBus.emit()
                         │
          app_handle.emit("fredo-stream-event", FredoEvent)
                         │
                         ▼
              Webview — TauriAdapter.onMessage()
                         │
              AppProvider → StreamContext.addEvent()
                         │
              useReducer dispatch → React re-render
                         │
              Feature component (matched via eventFilters
              or eventSubscriptions)
                         │
              renders updated data
```

When the user interacts with the UI directly (e.g. clicking a button), the flow uses `adapterBridge.invoke(command, args)` → Tauri IPC command → Rust feature handler → `EventBus.emit()` → same reactive path.

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
    |   +-- mod.rs              — AppStore (SQLite KV store)
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

### Infrastructure vs Features

| Layer | Contains | Does NOT contain |
|-------|----------|-----------------|
| `features/` | Models, service logic, state, Tauri command handlers | Shared platform code |
| `infrastructure/` | FredoEvent, EventBus, CommAdapter, AppStore, IPC socket, CLI parser, OTLP receivers | Business logic |

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

| Feature | showable | eventFilters | Description |
|---------|----------|-------------|-------------|
| home | ✓ | — | Navigation grid, alert handling, FredoCompanion |
| diagram | ✓ | infrastructure_stream | Infrastructure visualization (ReactFlow) |
| run-cli | ✓ | [] | xterm.js terminal (PTY output from Rust) |
| query-viewer | ✓ | (dynamic) | SQL query result display (multi-instance) |
| my-workitems | ✓ | azdo_create_work_item | Azure DevOps work items |
| settings | ✓ | — | App settings + model selection |
| setup | ✗ | — | OTel configuration, CLI detection |
| mission-monitor | ✓ | catch-all (all events) | Real-time agent activity graph |
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
  abstract readonly eventFilters: EventFilter[];
  abstract processEvent(event: FredoEvent): void;
  abstract render(props?: TProps): ReactElement;

  // Optional
  readonly eventSubscriptions: EventSubscription[] = [];
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

Features declare what events they need through one of two mechanisms:

- **`eventFilters`** — simple toolName/state/custom matchers on raw `FredoEvent` objects. The primary mechanism used in production today.
- **`eventSubscriptions`** (Spec #252) — typed subscriptions that assemble raw events into contract objects delivered via Init → Update → End lifecycle. Contracts extend `EventContract` (e.g. `ChatNodeContract`). The type system and interfaces are defined; the subscription processing engine is not yet built. One feature (`mission-monitor`) declares a subscription; all others use `eventFilters`.

### StreamContext — the Event Bus

`StreamContext` is a `useReducer`-based store holding all `FredoEvent` records. **Append-only during a session** (with TTL-based expiry). Events are **never mutated** after insertion — the UI derives display state from the event log.

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

The real-time agent activity graph (ReactFlow):

- **Graph builder**: Pure function `buildGraphFromEvents()` — processes `FredoEvent` records into nodes and edges
- **Chat span caching**: `chat` child spans cached, content attached to parent `invoke_agent` nodes
- **UserPromptNode injection**: Auto-injects prompt node before first `invoke_agent` if not yet emitted
- **Thread management**: Main thread + subagent threads with separate x/y positioning
- **Node types**: userPrompt, toolUse, fileChanged, agentResponse, subagent, task
- **FocusWindow**: Slide-in panel showing all related events for a node with collapsible JSON payloads
- **Session History**: localStorage persistence (max 50 sessions, auto-prune), collapsible left sidebar

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
| [docs/BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) | Full Rust module map, IPC protocol, OTLP, LLM engine internals |
| [docs/CLI_GUIDE.md](CLI_GUIDE.md) | Fredo CLI commands, OTLP setup |
| [docs/SETUP.md](SETUP.md) | Local development setup, model configuration |
| [docs/CODING_GUIDELINES.md](CODING_GUIDELINES.md) | Code conventions for Rust and TypeScript |
