# Fredo — Architecture Overview

## What Fredo Is

Fredo is a **cross-platform desktop application** that serves as an AI-native operations platform. It pairs a Rust backend (Tauri v2) with a reactive React UI. The system is designed from the ground up to work with AI agents through three integration paths:

1. **Agent hooks** — CLI-based event injection via the `fredo` binary
2. **OTLP receivers** — native gRPC/HTTP collectors that ingest telemetry from OpenCode and any OTLP-compatible tool
3. **MCP server** — a 27-tool Model Context Protocol server that agents can call directly (stdio or HTTP transport)

Events from all sources flow into a unified `StreamEvent` bus, and the React UI reacts in real time.

---

## Design Philosophy

### Feature-Based Autonomy

Both the Rust backend and the React UI are organized around **autonomous feature modules**. Each feature owns its entire vertical slice — models, business logic, state, and presentation. No feature reaches into another feature's internals. Shared platform services (events, storage, IPC, OTLP) live in `infrastructure/` (Rust) or `shared/` (TypeScript) and are consumed by features, never owned by them.

### Reactive UI — Streams, Not Polls

The UI does not call the backend to ask for data. Instead, it **listens to a stream of typed events** and reacts. Every feature declares which `toolName` values it cares about via `eventFilters`. When a matching event arrives, the feature's component re-renders with the new data.

### Agent Alignment

Fredo accepts events from three sources, all unified into the same `StreamEvent` format:

| Source | Mechanism | EventSource |
|--------|-----------|-------------|
| Agent hooks | `fredo` binary via IPC socket | `Hook` |
| OTLP gRPC | `127.0.0.1:4317` (OpenCode) | `OtlpGrpc` |
| OTLP HTTP | `127.0.0.1:4318` (OpenCode) | `OtlpHttp` |

The `StreamEvent` struct carries `source` and optional `otlp` fields for attribution.

---

## Event Flow

```
┌─────────────────────────────────────────────────────────┐
│                    Event Sources                         │
│                                                          │
│  Agent Hook ──→ IPC Socket ──→ CliCommand dispatch       │
│  OTLP gRPC ──→ :4317 ──→ protobuf → StreamEvent mapping  │
│  OTLP HTTP ──→ :4318 ──→ JSON/protobuf → StreamEvent     │
│  MCP Server ──→ stdio/HTTP ──→ tool execution            │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
              emit_stream_event()
                         │
          app_handle.emit("fredo-stream-event", StreamEvent)
                         │
                         ▼
              Webview — TauriAdapter.onMessage()
                         │
              AppProvider → StreamContext.addEvent()
                         │
              useReducer dispatch → React re-render
                         │
              Feature component (eventFilters match toolName)
                         │
              renders updated data
```

When the user interacts with the UI directly (e.g. clicking a button), the flow uses `adapterBridge.invoke(command, args)` → Tauri IPC command → Rust feature handler → emit event → same reactive path.

---

## Rust Backend — Feature Modules

```
src-tauri/src/
+-- main.rs                     — dual-mode entry point (GUI vs CLI)
+-- lib.rs                      — AppRuntime composition root
+-- runtime/
|   +-- mod.rs                  — AppRuntime struct
|   +-- capability.rs           — DesktopCapable, CliCapable, McpCapable traits
+-- features/
|   +-- mcp/                    — MCP server (27 tools, stdio + HTTP)
|   |   +-- mod.rs              — McpFeature (CliCapable + McpCapable)
|   |   +-- server.rs           — rmcp server, transport setup
|   |   +-- runner.rs           — stdio vs HTTP dispatch
|   |   +-- kubectl/            — 12 k8s tools (pods, logs, exec, etc.)
|   |   +-- k8s/                — infrastructure graph (snapshot, stream)
|   |   +-- jira/               — Jira REST API (3 tools)
|   |   +-- azdo/               — Azure DevOps (2 tools)
|   |   +-- optimizely/         — Feature flags (2 tools)
|   |   +-- observability/      — SQL queries against PostgreSQL (3 tools)
|   |   +-- code_execute/       — Sandboxed code execution (1 tool)
|   |   +-- fredo_ui/           — Emit StreamEvents to UI (3 tools)
|   |   +-- tools_doc/          — Tool documentation registry (2 tools)
|   +-- terminal/               — PTY-based AI CLI terminal
|   +-- llm/                    — In-process llama.cpp inference
|   |   +-- mod.rs              — LlmFeature
|   |   +-- engine.rs           — LlmEngine (direct llama.cpp bindings)
|   |   +-- service.rs          — LlmService (async chat, image chat)
|   |   +-- state.rs            — LlmState + LlmLoadingState
|   |   +-- commands.rs         — llm_chat Tauri command
|   +-- settings/               — Persistent KV settings (SQLite)
|   +-- setup/                  — CLI detection, PATH management, OTel config
|   +-- screenshot/             — Screen capture (xcap)
+-- infrastructure/
    +-- events/                 — StreamEvent, EventSource, OtlpPayload, emit_stream_event()
    +-- storage/                — AppStore (SQLite KV store)
    +-- ipc.rs                  — local socket server + CliCommand dispatch
    +-- cli/                    — clap CLI root + agent hook commands
    +-- otlp/                   — OTLP receivers
        +-- mod.rs              — OtlpState (trace→conversation correlation)
        +-- grpc.rs             — gRPC receiver (:4317) — tonic + opentelemetry-proto
        +-- http.rs             — HTTP receiver (:4318) — axum
        +-- mapping.rs          — protobuf → StreamEvent mapping
```

### Capability Traits

| Trait | Meaning |
|-------|---------|
| `DesktopCapable` | Feature registers Tauri commands and manages Tauri state |
| `CliCapable` | Feature can be invoked from the `fredo` CLI |
| `McpCapable` | Feature exposes MCP tools via the Model Context Protocol |

### Infrastructure vs Features

| Layer | Contains | Does NOT contain |
|-------|----------|-----------------|
| `features/` | Models, service logic, state, Tauri/MCP commands | Shared platform code |
| `infrastructure/` | StreamEvent, AppStore, IPC socket, CLI parser, OTLP receivers | Business logic |

---

## OTLP Receivers

Fredo implements the OpenTelemetry Protocol as a **local-only collector** — no data leaves the machine.

### gRPC Receiver (`:4317`)
- Implements `TraceService`, `MetricsService`, `LogsService` via `tonic`
- Receives OTLP protobuf from OpenCode and compatible tools
- Spans are mapped to `StreamEvent` records; metrics and logs are dropped at source (no UI consumer)

### HTTP Receiver (`:4318`)
- Axum server handling `POST /v1/traces`, `/v1/metrics`, `/v1/logs`
- Accepts both protobuf (`application/x-protobuf`) and JSON (`application/json`)
- Includes `/health` and `/v1/test` diagnostic endpoints

### Trace→Conversation Correlation
The `OtlpState` maintains a `HashMap<String, String>` mapping trace IDs to conversation/session IDs. This is a **two-pass algorithm**:
- **Pass 1**: Build the trace→conversation map from `gen_ai.conversation.id` and `session.id` attributes
- **Pass 2**: Emit `StreamEvent` records for `invoke_agent` and `execute_tool` spans only

`chat` child spans arrive in separate HTTP batches and are cached in `chatContentCache` — they are not emitted as individual events but their content is attached to the parent `invoke_agent` node in the Mission Monitor.

---

## MCP Server

The `mcp` feature runs a full MCP server using the `rmcp` framework with **27 tools** across 9 categories:

| Category | Tools | Description |
|----------|-------|-------------|
| **kubectl** | 12 | pods, describe_pod, deployments, services, events, logs, exec, delete_pod, restart_deployment, scale_deployment, rollout_status, top_pods |
| **infrastructure** | 2 | snapshot (static graph), stream (graph + emit to UI) |
| **jira** | 3 | get_issue_details, get_my_issues, create_issue |
| **azdo** | 2 | create_workitem, start_workitem |
| **optimizely** | 2 | get_flags, update_flag |
| **observability** | 3 | logs_query, metrics_query, traces_query (SQL against PostgreSQL via `mcp.db.url`) |
| **code_execute** | 1 | sandboxed code execution (python/js/ts/go/java/r) |
| **fredo_ui** | 3 | alert, stepper, collect_responses (emit StreamEvents to UI) |
| **tools_doc** | 2 | tools_documentation, tool_search |

### Transports
- **stdio**: `fredo mcp` — agents spawn the process and communicate via stdin/stdout
- **Streamable HTTP**: `fredo mcp --sse --port 3001` — SSE-based transport with `LocalSessionManager`

### Credentials
Tools requiring external services read credentials from `AppStore` settings (SQLite KV store). Configure via the Settings panel in the UI:

| Tool Group | Required Settings |
|-----------|-------------------|
| jira | `mcp.jira.base_url`, `mcp.jira.email`, `mcp.jira.api_token` |
| azdo | `mcp.azdo.org_url`, `mcp.azdo.project`, `mcp.azdo.pat` |
| optimizely | `mcp.optimizely.project_id`, `mcp.optimizely.sdk_key` |
| observability | `mcp.db.url` |
| kubectl | kubeconfig at default location or `KUBECONFIG` env var |
| code_execute | `mcp.code_sandbox_url` (default: `http://localhost:8000`) |

---

## In-Process LLM Engine

The LLM feature runs **llama.cpp directly in-process** via vendored `llama-cpp-2` Rust bindings — no child processes, no HTTP/SSE round-trips.

### LlmEngine
- `load()` — text-only GGUF model loading
- `load_with_vision()` — multimodal loading with mmproj projector
- `generate()` — autoregressive token generation with greedy+dist sampler
- `generate_with_image()` — decodes PNG/JPEG, resizes to 448×448, creates `MtmdBitmap`, tokenizes with media markers

### Supported Models
| Model | Vision | Notes |
|-------|--------|-------|
| Gemma 4 E2B (`gemma-4-e2b`) | ✅ | Full vision support via mmproj |
| MiniCPM-V 4.6 (`minicpm-v-4-6`) | ⚠️ | Vision projector unsupported in current llama.cpp version; falls back to text-only |

Model selection is persisted in SQLite (`llm_model` key) and takes effect on next launch. The `ModelSelector` component in Settings allows switching.

### Token Streaming
`LlmService.chat_async()` and `chat_with_image_async()` stream tokens via `mpsc::unbounded_channel` → `tokio::task::spawn_blocking` → Tauri `app.emit("llm-token")` / `app.emit("llm-done")`.

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
|   +-- diagram/                    — Kubernetes infrastructure diagram (ReactFlow)
|   +-- run-cli/                    — xterm.js terminal (PTY output)
|   +-- query-viewer/               — SQL query result display (multi-instance)
|   +-- my-workitems/               — Azure DevOps work items
|   +-- settings/                   — Settings panel + ModelSelector
|   +-- setup/                      — SetupWizard (OTel config, CLI detection)
|   +-- mission-monitor/            — Real-time agent activity graph
|   +-- dev-mode/                   — Dev tools + SpatiotemporalManifold
|   +-- browser-preview/            — Web page preview panel
|   +-- docs-viewer/                — Documentation viewer
|   +-- github-viewer/              — GitHub repository browser
|   +-- optimizely/                 — Feature flag management
|   +-- theming/                    — Theme customization
+-- shared/
    +-- contexts/StreamContext.tsx  — useReducer event bus; StreamEvent store
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
| home | ✅ | — | Navigation grid, alert handling, FredoCompanion |
| diagram | ✅ | infrastructure_stream | K8s infrastructure visualization (ReactFlow) |
| run-cli | ✅ | [] | xterm.js terminal (PTY output from Rust) |
| query-viewer | ✅ | (dynamic) | SQL query result display (multi-instance) |
| my-workitems | ✅ | azdo_create_work_item | Azure DevOps work items |
| settings | ✅ | — | App settings + model selection |
| setup | ❌ | — | OTel configuration, CLI detection |
| mission-monitor | ✅ | catch-all (all events) | Real-time agent activity graph |
| dev-mode | ❌ | — | Dev tools, OTLP event inspector, SpatiotemporalManifold |
| browser-preview | ✅ | — | Web page preview panel |
| docs-viewer | ✅ | — | Documentation viewer |
| github-viewer | ✅ | — | GitHub repository browser |
| optimizely | ✅ | — | Optimizely feature flag management |
| theming | ❌ | — | Theme customization (hidden from grid) |

### FredoFeatureClass

Every UI feature extends `FredoFeatureClass`:

```typescript
abstract class FredoFeatureClass {
  // Required
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly icon: IconType;
  abstract readonly eventFilters: EventFilter[];
  abstract processEvent(event: StreamEvent): void;
  abstract render(props?): ReactElement;

  // Defaults (overridable)
  readonly gridConfig: GridItemConfig;   // { closable, maximizable }
  readonly showable: boolean = true;
  readonly isMultiWindow: boolean = false;
  readonly hasSettings: boolean = false;
  renderSettings?(): ReactElement;

  // Lifecycle hooks (optional)
  onMount?(): void | Promise<void>;
  onUnmount?(): void | Promise<void>;
}
```

`eventFilters` is the key field for reactivity. When a `StreamEvent` arrives matching a feature's filters, `processEvent()` is called and the feature re-renders. Features with `showable: false` are registered but do not appear in the navigation grid.

### StreamContext — the Event Bus

`StreamContext` is a `useReducer`-based store holding all `StreamEvent` records. **Append-only during a session** (with TTL-based expiry). Events are **never mutated** after insertion — the UI derives display state from the event log.

### StreamEvent Shape

```typescript
interface StreamEvent {
  toolName: string;
  sessionId: string;
  state: 'Init' | 'Update' | 'Response' | 'Error';
  source?: 'hook' | 'otlpGrpc' | 'otlpHttp';  // camelCase (Rust serializes with rename_all)
  otlp?: { signal: 'Span' | 'Metric' | 'Log'; attributes: Record<string, any> };
  input?: any;
  response?: any;
  data?: any;
  timestamp: string;
  eventId?: string;
  correlationId?: string;
  error?: { message: string; code?: string; stack?: string; details?: any };
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

- **Graph builder**: Pure function `buildGraphFromEvents()` — processes `StreamEvent` records into nodes and edges
- **Chat span caching**: `chat` child spans cached, content attached to parent `invoke_agent` nodes
- **UserPromptNode injection**: Auto-injects prompt node before first `invoke_agent` if not yet emitted
- **Thread management**: Main thread + subagent threads with separate x/y positioning
- **Node types**: userPrompt, toolUse, fileChanged, agentResponse, subagent, task
- **FocusWindow**: Slide-in panel showing all related events for a node with collapsible JSON payloads
- **Session History**: localStorage persistence (max 50 sessions, auto-prune), collapsible left sidebar
- **OTLP source badges**: hook (amber), gRPC/HTTP (tomato-orange) in dev mode

---

## Agent Integration Points

| Integration | How it works |
|-------------|-------------|
| **Agent hook scripts** | OpenCode calls `fredo <hook-args>` on PreToolUse / PostToolUse. The `fredo` binary runs in CLI mode, connects to the IPC socket, sends a `CliCommand`, and exits. |
| **OTLP telemetry** | Configure OpenCode to send OTLP to `127.0.0.1:4317` (gRPC) or `127.0.0.1:4318` (HTTP). Fredo maps spans to `StreamEvent` records in real time. |
| **MCP server** | Run `fredo mcp` (stdio) or `fredo mcp --sse --port 3001` (HTTP). Agents connect and call any of the 27 tools directly. |
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
| `apps/tools-mcp` | Node.js MCP/SSE backend (Redis Streams) | Rust MCP feature in `apps/tauri` |
| `apps/ai-sidecar` | Node.js AI CLI sidecar | PTY-based `terminal` feature |
| `apps/marketplace-plugin` | Original Copilot/Claude plugin | `apps/marketplace-plugin` (OpenCode) |
| UI: agents, chatbot, embeddings, memory, telemetry | Stub features | Consolidated into Mission Monitor + MCP |

---

## Further Reading

| Document | Contents |
|----------|----------|
| [docs/tauri/ARCHITECTURE.md](tauri/ARCHITECTURE.md) | Full Rust module map, IPC protocol, OTLP, MCP, LLM engine internals |
| [docs/tauri/CLI_GUIDE.md](tauri/CLI_GUIDE.md) | Fredo CLI commands, MCP server, OTLP setup |
| [docs/tauri/SETUP.md](tauri/SETUP.md) | Local development setup, model configuration |
| [docs/CODING_GUIDELINES.md](CODING_GUIDELINES.md) | Code conventions for Rust and TypeScript |
