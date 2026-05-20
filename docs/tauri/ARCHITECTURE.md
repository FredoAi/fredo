# Fredo Desktop App — Architecture

## Rust Module Map

```
src-tauri/src/
├── main.rs                       — binary entry; routes to GUI or CLI based on args
├── lib.rs                        — AppRuntime composition root; wires features → Tauri builder
├── runtime/
│   ├── mod.rs                    — AppRuntime struct (explicit composition root)
│   └── capability.rs             — DesktopCapable, CliCapable, McpCapable traits
├── features/
│   ├── mod.rs                    — re-exports all feature modules
│   ├── mcp/                      — MCP server (27 tools)
│   │   ├── mod.rs                — McpFeature (CliCapable + McpCapable)
│   │   ├── server.rs             — rmcp server, stdio + Streamable HTTP transports
│   │   ├── runner.rs             — transport dispatch (stdio vs HTTP)
│   │   ├── kubectl/              — 12 k8s tools via kube crate
│   │   ├── k8s/                  — infrastructure graph (snapshot, stream)
│   │   ├── jira/                 — Jira REST API (3 tools)
│   │   ├── azdo/                 — Azure DevOps REST API (2 tools)
│   │   ├── optimizely/           — Feature flags (2 tools)
│   │   ├── observability/        — SQL queries against PostgreSQL (3 tools)
│   │   ├── code_execute/         — Sandboxed code execution (1 tool)
│   │   ├── fredo_ui/             — Emit StreamEvents to UI (3 tools)
│   │   └── tools_doc/            — Tool documentation registry (2 tools)
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
│   │   └── commands.rs           — get_plugin_source_path, check_cli_installations, install_plugin, check_fredo_in_path, add_fredo_to_path, check_otel_configured, configure_otel
│   ├── screenshot/
│   │   ├── mod.rs                — ScreenshotFeature (DesktopCapable)
│   │   └── commands.rs           — capture_screen_region
├── infrastructure/
│   ├── mod.rs
│   ├── events/
│   │   └── mod.rs                — StreamEvent, EventSource, OtlpPayload, EventState, emit_stream_event()
│   ├── storage/
│   │   └── mod.rs                — AppStore (SQLite KV store)
│   ├── ipc.rs                    — local socket server, CliCommand dispatch, CliResponse, send_cli_command()
│   ├── cli/
│   │   ├── mod.rs                — clap Cli root; run() + build_ipc_command()
│   │   └── commands/
│   │       ├── mod.rs            — re-exports
│   │       └── hook.rs           — HookArgs (PreToolUse, PostToolUse, etc.)
│   └── otlp/
│       ├── mod.rs                — OtlpState (trace→conversation correlation map)
│       ├── grpc.rs               — gRPC receiver (:4317) — tonic + opentelemetry-proto
│       ├── http.rs               — HTTP receiver (:4318) — axum server
│       └── mapping.rs            — protobuf → StreamEvent mapping (two-pass algorithm)
└── utils/
    └── error.rs                  — anyhow re-exports
```

## Architectural Style

The backend follows a **feature-based modular architecture**:

- **Feature modules are autonomous** — each owns its models, service logic, state, and command handlers (Tauri or MCP). No feature imports from another feature.
- **`AppRuntime`** is the explicit composition root. `lib.rs` registers all features' state and lists their command handlers in `generate_handler!`. Adding a feature = implement the capability trait + register in `AppRuntime`.
- **Capability traits** (`DesktopCapable`, `CliCapable`, `McpCapable`) declare what interfaces a feature exposes at the type level.
- **Infrastructure** provides shared platform services (storage, events, IPC socket, OTLP receivers) consumed by features — it does not own business logic.

### Why Feature-Based for Agent Use

Each feature maps directly to a tool or capability an AI agent can invoke. The agent calls `fredo <hook>` (CLI mode), the IPC socket routes the `CliCommand` to the matching feature handler, the feature emits one or more `StreamEvent` records, and the UI reacts. The feature boundary means an agent can reason about and invoke one capability without side-effecting any other.

## UI Reactivity — Why the UI Listens, Not Polls

The React UI (`apps/ui`) is **purely reactive**: it never calls the backend to ask for data. Every feature declares `eventFilters` — a list of `toolName` values it cares about. When `emit_stream_event()` fires on the Rust side, the event travels:

```
Rust feature handler / OTLP receiver / MCP tool
  -> infrastructure::events::emit_stream_event()
  -> app_handle.emit("fredo-stream-event", StreamEvent)
  -> TauriAdapter.onMessage()
  -> AppProvider -> StreamContext.addEvent()
  -> useReducer dispatch -> React re-render
  -> Feature component (eventFilters matches toolName)
```

This design means:

- **Agent tool calls surface instantly** — no client polling, no request/response coupling
- **Multiple UI panels can react to the same event** — `toolName` is a broadcast key, not a direct address
- **Features are decoupled from transport** — swapping `TauriAdapter` for a future `McpAdapter` or `ElectronAdapter` requires zero changes to feature code
- **`correlationId`** ties `Init` events (tool call started) to `Response` events (tool call completed), enabling progress indicators and diff views without shared mutable state

### StreamEvent Lifecycle

```
Agent calls tool / OTLP span arrives / MCP tool executes
  -> Init   event  (input = tool args)         state = 'Init'
  -> Update events (streaming partial output)  state = 'Update'  [optional]
  -> Response event (final result)             state = 'Response'
  -> Error  event  (on failure)                state = 'Error'
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

```json
// agent_hook (forwarded from OpenCode plugin hook scripts)
{ "type": "agent_hook", "event_type": "PreToolUse", "payload": { ... } }
```

### CliResponse Schema

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "message": "error description" }
```

## StreamEvent Constants

Event names emitted via `app_handle.emit("fredo-stream-event", ...)`:

| toolName | Triggered by | UI Feature |
|----------|-------------|------------|
| `infrastructure_stream` | `start_k8s_diagram` command | Diagram |
| `agent_session` | IPC `AgentHook` (generic lifecycle events) | Mission Monitor |
| `<mcp_tool_name>` | MCP tool execution (PreToolUse / PostToolUse) | Mission Monitor |
| `fredo_ui_alert` | `fredo_ui_alert` MCP tool | Home (toast) |
| `fredo_ui_stepper` | `fredo_ui_stepper` MCP tool | Home (wizard) |
| `fredo_ui_collect_responses` | `fredo_ui_collect_responses` MCP tool | Home (prompt) |

### Tauri Events (not StreamEvents)

These are emitted via `app.emit()` directly, not through `emit_stream_event()`:

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

On startup, `lib.rs` reads `llm_model` from `AppStore`, resolves GGUF + mmproj paths from `resource_dir` (bundled) or `CARGO_MANIFEST_DIR` (dev), and loads the model in a `spawn_blocking` task. `LlmLoadingState` uses `AtomicBool` for the loading indicator.

## Screenshot Feature

`features/screenshot/commands.rs`: `capture_screen_region(x, y, width, height)` — uses `xcap` crate to capture physical screen pixels, crop, encode as PNG, return base64 string. Multi-monitor aware. Used by the Tic-Tac-Toe AI companion to "see" the board.

## MCP Server Architecture

The `mcp` feature implements a full MCP server via the `rmcp` framework.

### Transports

| Transport | Command | Use case |
|-----------|---------|----------|
| stdio | `fredo mcp` | Agents spawn the process directly |
| Streamable HTTP | `fredo mcp --sse --port 3001` | Remote agents, persistent sessions |

### Server Structure

```
features/mcp/
├── mod.rs              — McpFeature struct, tool registration
├── server.rs           — rmcp server setup, Resource/Tool/Prompt definitions
├── runner.rs           — stdio vs HTTP transport dispatch
├── kubectl/            — 12 tools: kube crate for K8s operations
├── k8s/                — infrastructure graph (snapshot, stream)
├── jira/               — 3 tools: Jira REST API via reqwest
├── azdo/               — 2 tools: Azure DevOps REST API
├── optimizely/         — 2 tools: feature flag management
├── observability/      — 3 tools: SQL against PostgreSQL (SELECT-only validation)
├── code_execute/       — 1 tool: sandboxed code execution
├── fredo_ui/           — 3 tools: alert, stepper, collect_responses
└── tools_doc/          — 2 tools: tool documentation registry
```

### Credential Configuration

Tools requiring external services read credentials from `AppStore`:

| Tool Group | Required Settings |
|-----------|-------------------|
| jira | `mcp.jira.base_url`, `mcp.jira.email`, `mcp.jira.api_token` |
| azdo | `mcp.azdo.org_url`, `mcp.azdo.project`, `mcp.azdo.pat` |
| optimizely | `mcp.optimizely.project_id`, `mcp.optimizely.sdk_key` |
| observability | `mcp.db.url` |
| kubectl | kubeconfig at default location or `KUBECONFIG` env var |
| code_execute | `mcp.code_sandbox_url` (default: `http://localhost:8000`) |

## OTLP Receiver Architecture

### gRPC Receiver (`infrastructure/otlp/grpc.rs`)

- Listens on `127.0.0.1:4317`
- Implements `TraceService`, `MetricsService`, `LogsService` via `tonic`
- Receives OTLP protobuf from OpenCode and compatible tools

### HTTP Receiver (`infrastructure/otlp/http.rs`)

- Listens on `127.0.0.1:4318`
- Axum server handling `POST /v1/traces`, `/v1/metrics`, `/v1/logs`
- Accepts both protobuf and JSON formats
- Includes `/health` and `/v1/test` diagnostic endpoints

### OTLP → StreamEvent Mapping (`infrastructure/otlp/mapping.rs`)

**Two-pass algorithm:**
1. **Pass 1**: Build trace→conversation map from `gen_ai.conversation.id` and `session.id` attributes
2. **Pass 2**: Emit `StreamEvent` records for `invoke_agent` and `execute_tool` spans only

**Signal handling:**
- **Spans**: Mapped to `StreamEvent` with `source: OtlpGrpc` or `OtlpHttp`
- **Metrics**: Dropped at source (no UI consumer)
- **Logs**: Dropped at source (no UI consumer)

**Operation normalization:**
`normalize_op_name()` canonicalizes operations: `chat`, `invoke_agent`, `execute_tool`, `permission`, `elicitation`

**Session ID extraction:**
`session_id_from_attrs()` extracts from `gen_ai.conversation.id` → `session.id` → UUID fallback

### OtlpState

`Arc<Mutex<HashMap<String, String>>>` mapping trace IDs to session IDs. Persists across HTTP batches so spans arriving separately are still grouped into the same session.

## Tauri Capabilities

Defined in `capabilities/default.json`. Required permissions:

| Permission | Why required |
|-----------|-------------|
| `core:default` | Standard window management (resize, minimize, etc.) |
| `core:event:allow-listen` | Webview subscribes to Tauri events |
| `core:event:allow-emit` | Rust backend emits events to webview |
| `core:window:allow-create` | Backend can open new WebviewWindow (run-cli-terminal) |
| `core:window:allow-close` | Backend can close the terminal window |
| `core:window:allow-start-dragging` | Window drag support |
| `core:window:allow-set-title` | Dynamic window title updates |
| `shell:allow-open` | Open external URLs in system browser |
| `shell:allow-spawn` | Spawn child processes (PTY terminal) |
| `shell:allow-execute` | Execute shell commands (PTY terminal) |

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
5. Start IPC socket server (`tokio::spawn`)
6. Start OTLP receivers via `infrastructure::otlp::start()` (gRPC :4317 + HTTP :4318, each in `tokio::spawn`)
7. Register all Tauri command handlers via `generate_handler![]`
8. Launch Tauri webview window
