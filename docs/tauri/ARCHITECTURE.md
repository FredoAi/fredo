# Fredo Desktop App — Architecture

## Rust Module Map

```
src-tauri/src/
├── main.rs                       — binary entry; routes to GUI or CLI based on args
├── lib.rs                        — AppRuntime composition root; wires features → Tauri builder
├── runtime/
│   ├── mod.rs                    — AppRuntime struct (explicit composition root)
│   └── capability.rs             — DesktopCapable, CliCapable traits
├── features/
│   ├── mod.rs                    — re-exports all feature modules
│   ├── terminal/
│   │   ├── mod.rs                — TerminalFeature (DesktopCapable)
│   │   ├── state.rs              — RunCliState (PTY writer, killer, master, buffer)
│   │   └── commands.rs           — open_run_cli, get_pty_buffer, write_pty_input, resize_pty, close_run_cli
│   ├── llm/
│   │   ├── mod.rs                — LlmFeature (DesktopCapable)
│   │   ├── engine.rs             — LlmEngine (in-process llama.cpp via llama-cpp-2)
│   │   ├── service.rs            — LlmService (async chat, chat_with_image)
│   │   ├── state.rs              — LlmState + LlmLoadingState
│   │   └── commands.rs           — llm_chat, llm_chat_with_image
│   ├── settings/
│   │   ├── mod.rs                — SettingsFeature (DesktopCapable)
│   │   └── commands.rs           — save_setting, get_setting
│   ├── setup/
│   │   ├── mod.rs                — SetupFeature (DesktopCapable)
│   │   └── commands.rs           — check_cli_installations, install_plugin, get_plugin_source_path, check_fredo_in_path, add_fredo_to_path, check_otel_configured, configure_otel, get_setup_plan, check_all_setup, run_setup_step, check_model_files, download_model
│   ├── screenshot/
│       ├── mod.rs                — ScreenshotFeature (DesktopCapable)
│       └── commands.rs           — capture_screen_region
├── infrastructure/
│   ├── mod.rs
│   ├── comm/
│   │   ├── mod.rs                — re-exports FredoEvent, EventBus, CommAdapter, adapters
│   │   ├── event.rs              — FredoEvent, EventType, EventProvider, Transport, EventState, FredoEventBuilder, FredoEventError
│   │   ├── bus.rs                — EventBus (emits FredoEvent on "fredo-stream-event" channel)
│   │   ├── adapter.rs            — CommAdapter trait (name, provider, transform)
│   │   └── adapters/
│   │       ├── mod.rs
│   │       ├── opencode.rs       — OpenCodeAdapter: Hook connector (plugin events) + OTLP connectors (spans)
│   │       └── internal.rs       — InternalAdapter: enriches raw events with server-side defaults
│   ├── storage/
│   │   └── mod.rs                — AppStore (SQLite KV store)
│   ├── ipc.rs                    — local socket server, CliCommand dispatch, CliResponse, send_cli_command()
│   ├── cli/
│   │   ├── mod.rs                — clap Cli root; run() + build_ipc_command()
│   │   └── commands/
│   │       ├── mod.rs            — re-exports
│   │       ├── opencode_plugin.rs — OpenCodePluginArgs (event_type + payload)
│   │       ├── emit.rs           — EmitArgs (FredoEvent CLI emission)
│   │       └── setup.rs          — SetupArgs (local setup operations)
│   └── otlp/
│       ├── mod.rs                — start() spawns gRPC :4317 + HTTP :4318 receivers
│       ├── grpc.rs               — gRPC receiver (:4317) — tonic + opentelemetry-proto
│       └── http.rs               — HTTP receiver (:4318) — axum server
└── utils/
    ├── mod.rs
    ├── error.rs                  — anyhow re-exports
    └── dump.rs                   — event dump helper (~/.fredo/event-dump.jsonl)
```

## Architectural Style

The backend follows a **feature-based modular architecture**:

- **Feature modules are autonomous** — each owns its models, service logic, state, and command handlers. No feature imports from another feature.
- **`AppRuntime`** is the explicit composition root. `lib.rs` registers all features' state and lists their command handlers in `generate_handler!`. Adding a feature = implement the capability trait + register in `AppRuntime`.
- **Capability traits** (`DesktopCapable`, `CliCapable`) declare what interfaces a feature exposes at the type level.
- **Infrastructure** provides shared platform services (communication layer, storage, IPC socket, OTLP receivers) consumed by features — it does not own business logic.

### Why Feature-Based for Agent Use

Each feature maps directly to a tool or capability an AI agent can invoke. The agent calls `fredo opencode-plugin <event_type>` (CLI mode), the IPC socket routes the `CliCommand` to `dispatch_opencode_plugin()`, which transforms the payload via `OpenCodeAdapter` into `FredoEvent` records emitted via `EventBus`, and the UI reacts. The feature boundary means an agent can reason about and invoke one capability without side-effecting any other.

## Communication Layer (`infrastructure/comm/`)

The `comm` module is the backbone of the event pipeline:

- **`FredoEvent`** — the canonical event shape (id, eventType, state, provider, transport, sessionId, correlationId, toolName, payload, error, metadata, timestamp). Serialized as camelCase to match frontend conventions.
- **`EventType`** — ToolUse, AgentSession, Chat, Infrastructure, Ui, Custom
- **`EventProvider`** — OpenCode, ClaudeCode, Internal
- **`Transport`** — Hook, OtlpGrpc, OtlpHttp, WebSocket, HttpPost, Internal
- **`EventState`** — Init, Update, Response, Error
- **`FredoEventBuilder`** — fluent builder API for constructing FredoEvents
- **`EventBus`** — emits `FredoEvent` on the `"fredo-stream-event"` Tauri IPC channel to the webview
- **`CommAdapter` trait** — each agent provider gets an adapter that transforms raw input into `Vec<FredoEvent>`:
  - **`OpenCodeAdapter`** — Hook connector (plugin events: PreToolUse → ToolUse/Init, PostToolUse → ToolUse/Response, PostToolUseFailure → ToolUse/Error, lifecycle → AgentSession/Init) + OTLP connectors (spans: invoke_agent → AgentSession, execute_tool → ToolUse). Maintains an internal trace-to-conversation map (`Arc<Mutex<HashMap>>`) for the two-pass correlation algorithm.
  - **`InternalAdapter`** — enriches raw events with server-side defaults (uuid id, RFC3339 timestamp, session_id = "tauri-local") and validates enum fields.

## UI Reactivity — Why the UI Listens, Not Polls

The React UI (`apps/ui`) is **purely reactive**: it never calls the backend to ask for data. Every feature declares `eventFilters` (legacy) or `eventSubscriptions` (new) — patterns that match `toolName`, `state`, or custom fields. When `EventBus::emit()` fires on the Rust side, the event travels:

```
Agent → Adapter.transform() → Vec<FredoEvent>
  → EventBus.emit(event) → app_handle.emit("fredo-stream-event", FredoEvent)
  → TauriAdapter.onMessage()
  → AppProvider → StreamContext.addEvent()
  → useReducer dispatch → React re-render
  → Feature component (eventFilters match toolName or eventSubscriptions assemble contracts)
```

This design means:

- **Agent tool calls surface instantly** — no client polling, no request/response coupling
- **Multiple UI panels can react to the same event** — `toolName` is a broadcast key, not a direct address
- **Features are decoupled from transport** — swapping `TauriAdapter` for a future `McpAdapter` or `ElectronAdapter` requires zero changes to feature code
- **`correlationId`** ties `Init` events (tool call started) to `Response` events (tool call completed), enabling progress indicators and diff views without shared mutable state

### FredoEvent Lifecycle

```
Agent calls tool / OTLP span arrives / CLI emits event
  → Init   event  (input = tool args)         state = 'Init'
  → Update events (streaming partial output)  state = 'Update'  [optional]
  → Response event (final result)             state = 'Response'
  → Error  event  (on failure)                state = 'Error'
```

`StreamContext` deduplicates by `eventId` and expires events after a TTL (default 60 s). All events for a session are retained in memory — the UI derives its display state by reading the event log, never by mutating it.

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

### CliResponse Schema

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "message": "error description" }
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

### Event Type Allowlist

Only these event types are accepted over the IPC socket (`ALLOWED_EVENT_TYPES`):
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `chat.message`, `message.updated`, `message.part.updated`, `message.part.delta`, `message.removed`, `message.part.removed`, `permission.asked`, `permission.replied`, `file.edited`, `command.executed`, `session.created`, `session.updated`, `session.deleted`, `session.status`, `session.error`, `session.idle`, `session.next.tool.called`, `session.next.tool.success`, `session.next.tool.failed`, `session.next.text.delta`, `session.next.text.started`, `session.next.text.ended`, `session.next.step.started`, `session.next.step.ended`, `session.next.agent.switched`.

Payloads exceeding 1 MB are rejected.

## CLI Interface

The `fredo` binary exposes these subcommands:

| Subcommand | Description |
|-----------|-------------|
| `fredo opencode-plugin <event_type>` | Forward an OpenCode plugin event (used by the OpenCode plugin) |
| `fredo emit` | Emit a FredoEvent into the running application |
| `fredo setup` | Check or perform Fredo setup operations (PATH, plugin, model, OTEL) |

Setup commands (`fredo setup`) run locally without requiring the desktop app to be running. All other commands connect to the local IPC socket and require the Fredo app to be active.

## FredoEvent Constants

Events emitted via `EventBus::emit()` on the `"fredo-stream-event"` channel:

| eventType | Triggered by | UI Feature |
|-----------|-------------|------------|
| `tool_use` | OpenCode plugin hook (PreToolUse/PostToolUse) or OTLP span (execute_tool) | Various (eventFilters match toolName) |
| `agent_session` | IPC OpenCodePlugin (lifecycle events) or OTLP span (invoke_agent) | Mission Monitor |
| `ui` | CLI `fredo emit` with Ui event type | Home (toast, wizard, prompt) |

### Tauri Events (not FredoEvents)

These are emitted via `app.emit()` directly, not through `EventBus`:

| Event | Direction | Description |
|-------|-----------|-------------|
| `llm-token` | Rust → UI | Single LLM token (streaming) |
| `llm-done` | Rust → UI | LLM generation complete |
| `run-cli-output` | Rust → UI | Raw PTY bytes (`number[]`) |
| `run-cli-exited` | Rust → UI | PTY process exit notification |
| `companion-teleport` | Rust → UI (all windows) | Cross-window companion teleport |

## Terminal Feature (PTY)

The `terminal` feature spawns OpenCode in a native PTY and streams its output to a dedicated xterm.js terminal window.

### Rust Commands (`features/terminal/commands.rs`)

| Command | Description |
|---------|-------------|
| `open_run_cli(work_dir)` | Resolves binary via `where`, opens PTY, spawns child process, starts reader task, opens `run-cli-terminal` WebviewWindow |
| `get_pty_buffer()` | Returns buffered PTY output bytes for replay on terminal mount |
| `write_pty_input(data)` | Writes keyboard input to PTY writer |
| `resize_pty(rows, cols)` | Calls `master.resize(PtySize{rows, cols})` for proper terminal sizing |
| `close_run_cli()` | Kills child process, releases PTY, closes window |

### PTY State (`features/terminal/state.rs` — `RunCliState`)

Managed as a Tauri `State<Mutex<RunCliState>>`:

```rust
pub struct RunCliState {
    pub writer: Option<Box<dyn Write + Send>>,
    pub killer: Option<Box<dyn portable_pty::Child + Send>>,
    pub master: Option<Box<dyn portable_pty::MasterPty + Send>>, // kept alive to prevent SIGHUP
    pub correlation_id: Option<String>,
    pub output_buffer: Arc<Mutex<Vec<u8>>>,  // replay buffer for late-mounting terminal
}
```

**Key implementation notes:**
- `try_clone_reader()` is called **before** `spawn_command()` — required for Windows ConPTY ordering
- `master` is stored in state to prevent SIGHUP when it goes out of scope
- Reader task starts **before** the window opens to avoid output loss
- The webview window uses label `"run-cli-terminal"` with route `?view=terminal`

### Tauri Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `run-cli-output` | Rust → UI | Raw PTY bytes (`number[]`) |
| `run-cli-exited` | Rust → UI | Process exit notification |

## LLM Feature — In-Process Engine

The `llm` feature runs **llama.cpp directly in-process** via vendored `llama-cpp-2` Rust bindings. No child processes, no HTTP/SSE round-trips.

### LlmEngine (`features/llm/engine.rs`)

| Method | Description |
|--------|-------------|
| `load()` | Text-only GGUF model loading |
| `load_with_vision()` | Multimodal loading with mmproj projector |
| `generate()` | Autoregressive token generation with greedy+dist sampler |
| `generate_with_image()` | Decodes PNG/JPEG, resizes to 448×448, creates `MtmdBitmap`, tokenizes with media markers |

### LlmService (`features/llm/service.rs`)

Wraps `LlmEngine` in `Arc<Mutex<>>`. Exposes:
- `chat_async(messages)` — streams tokens via `mpsc::unbounded_channel` → `spawn_blocking` → `app.emit("llm-token")` / `app.emit("llm-done")`
- `chat_with_image_async(messages, image_path)` — same flow with vision input

### Model Loading

On startup, `lib.rs` reads `llm_model` from `AppStore`, resolves GGUF + mmproj paths from `models_dir` (configured) or `resource_dir` (bundled) or `CARGO_MANIFEST_DIR` (dev), and loads the model in a `spawn_blocking` task. `LlmLoadingState` uses `AtomicBool` for the loading indicator.

## Screenshot Feature

`features/screenshot/commands.rs`: `capture_screen_region(x, y, width, height)` — uses `xcap` crate to capture physical screen pixels, crop, encode as PNG, return base64 string. Multi-monitor aware. Used by the Tic-Tac-Toe AI companion to "see" the board.

## OTLP Receiver Architecture

OTLP receivers transform telemetry from OpenCode into FredoEvents via `OpenCodeAdapter`, then emit them through `EventBus`. Both use the same adapter pattern — the two-pass trace-to-conversation correlation algorithm lives inside `OpenCodeAdapter`, not in a separate `mapping.rs`.

### gRPC Receiver (`infrastructure/otlp/grpc.rs`)

- Listens on `127.0.0.1:4317`
- Implements `TraceService`, `MetricsService`, `LogsService` via `tonic`
- Each exported batch is mapped to `FredoEvent` via `OpenCodeAdapter::transform(Transport::OtlpGrpc, payload)`
- Spans containing `gen_ai.operation.name == "execute_tool"` → ToolUse events; `"invoke_agent"` → AgentSession events
- Metrics and Logs services acknowledge but produce no events (no UI consumers)

### HTTP Receiver (`infrastructure/otlp/http.rs`)

- Listens on `127.0.0.1:4318`
- Axum server handling `POST /v1/traces`, `/v1/metrics`, `/v1/logs`
- Accepts both protobuf and JSON OTLP payloads
- Maps each resource span to FredoEvents via `OpenCodeAdapter::transform(Transport::OtlpHttp, payload)`
- Includes `/health` and `/v1/test` diagnostic endpoints

### Two-Pass Correlation (inside OpenCodeAdapter)

The `OpenCodeAdapter` holds internal state (`Arc<Mutex<HashMap<String, String>>>`) mapping trace IDs to session IDs:

1. **Pass 1**: Extract `gen_ai.conversation.id` → `session.id` from span attributes; store in the trace→session HashMap
2. **Pass 2**: Look up session ID for each span and emit the appropriate FredoEvent

This state persists across gRPC and HTTP batches so spans arriving separately are still grouped into the same session.

## Tauri Capabilities

Defined in `capabilities/default.json`. Required permissions:

| Permission | Why required |
|-----------|-------------|
| `core:default` | Standard window management (resize, minimize, etc.) |
| `core:event:allow-listen` | Webview subscribes to Tauri events (fredo-stream-event, llm-token, etc.) |
| `core:event:allow-emit` | Rust backend emits events to webview |
| `core:window:allow-create` | Backend can open new WebviewWindow (run-cli-terminal) |
| `core:window:allow-close` | Backend can close the terminal window |
| `core:window:allow-start-dragging` | Window drag support |
| `core:window:allow-set-title` | Dynamic window title updates |
| `shell:allow-open` | Open external URLs in system browser |
| `shell:allow-spawn` | Spawn child processes (PTY terminal) |
| `shell:allow-execute` | Execute shell commands (PTY terminal) |
| `mcp-bridge:default` | MCP Bridge plugin for automation/debugging (debug builds only) |

All permissions apply to both `"main"` and `"run-cli-terminal"` windows across Linux, macOS, and Windows.

## Tauri Commands

All 22 commands registered in `generate_handler![]` in `lib.rs`:

| Command | Feature | Description |
|---------|---------|-------------|
| `save_setting` | settings | Persist a key-value setting to AppStore |
| `get_setting` | settings | Retrieve a setting from AppStore |
| `open_run_cli` | terminal | Resolve binary, open PTY, spawn child, open terminal window |
| `get_pty_buffer` | terminal | Return buffered PTY output for terminal replay |
| `write_pty_input` | terminal | Write keyboard input to PTY writer |
| `resize_pty` | terminal | Resize PTY to new rows/cols |
| `close_run_cli` | terminal | Kill child, release PTY, close window |
| `check_cli_installations` | setup | Check if `opencode` is on PATH |
| `install_plugin` | setup | Install OpenCode plugin into target directory |
| `get_plugin_source_path` | setup | Return bundled plugin source path |
| `check_fredo_in_path` | setup | Check if `fredo` is on PATH |
| `add_fredo_to_path` | setup | Add Fredo to system PATH |
| `check_otel_configured` | setup | Check if OTLP exporter is configured in OpenCode settings |
| `configure_otel` | setup | Write OTLP exporter config to OpenCode settings |
| `get_setup_plan` | setup | Return list of pending setup steps |
| `check_all_setup` | setup | Run all setup checks, return status map |
| `run_setup_step` | setup | Execute a single setup step |
| `check_model_files` | setup | Check if local model files exist |
| `download_model` | setup | Download model GGUF + mmproj |
| `llm_chat` | llm | Send chat messages to in-process LLM (streams tokens) |
| `llm_chat_with_image` | llm | Chat with image attachment (multimodal) |
| `capture_screen_region` | screenshot | Capture screen region as base64 PNG |

## Dual-Mode Binary

The `fredo` binary detects its mode at startup:

```rust
if std::env::args().len() > 1 {
    // CLI: parse clap args, connect to IPC socket, send CliCommand, print response
} else {
    // GUI: launch Tauri window + start IPC socket server + OTLP receivers
}
```

The same installed binary is both the desktop launcher and the `fredo` CLI available in PATH.

## Startup Sequence

1. Initialize `AppStore` (SQLite KV store) — managed via `app.manage()`
2. Read `llm_model` setting, resolve model paths
3. Spawn `LlmEngine` loading in `spawn_blocking` task
4. Initialize `RunCliState` (PTY terminal) — managed via `app.manage()`
5. Initialize `EventBus` — managed via `app.manage()`
6. Start IPC socket server (`tauri::async_runtime::spawn`)
7. Start OTLP receivers via `infrastructure::otlp::start()` (gRPC :4317 + HTTP :4318, each in `tauri::async_runtime::spawn`)
8. Register all Tauri command handlers via `generate_handler![]`
9. Launch Tauri webview window
