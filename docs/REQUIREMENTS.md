# Fredo — Requirements

## Platform Requirements

### Target Operating Systems

| OS | Minimum Version |
|----|----------------|
| Windows | 10 (with WebView2) |
| macOS | 12 Monterey |
| Linux | Ubuntu 22.04 / equivalent glibc |

### Build Requirements

| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| Rust toolchain | 1.75 | Tauri backend compilation |
| Tauri CLI | 2.x | `cargo tauri dev` / `cargo tauri build` |
| Node.js | 18 | UI build toolchain |
| pnpm | 8 | Monorepo package manager |

---

## Functional Requirements

### FR-001: Desktop Application
**Priority**: Critical

The system must be a single cross-platform desktop application installable on Windows, macOS, and Linux.

**Acceptance Criteria**:
- `pnpm build:tauri` produces signed `.msi`, `.dmg`, and `.AppImage` artifacts
- App launches with a Tauri WebView2/WebKit window showing the React UI
- App starts the IPC socket server on launch and tears it down on close
- NSIS installer (Windows) / bundle installer (macOS/Linux) adds `fredo` to system PATH

---

### FR-002: Dual-Mode Binary
**Priority**: Critical

The same `fredo` binary must serve as both the desktop launcher and a CLI tool.

**Acceptance Criteria**:
- `fredo` with no arguments launches the Tauri GUI window
- `fredo <subcommand>` connects to a running app instance via the IPC socket, sends a `CliCommand`, and exits
- When no GUI is running, CLI mode prints a clear error and exits non-zero

---

### FR-003: IPC Socket
**Priority**: Critical

The backend must expose a local IPC socket for CLI and agent hook communication.

**Acceptance Criteria**:
- Named pipe on Windows (`\\.\pipe\fredo-ipc`), Unix socket on macOS/Linux (`/tmp/fredo-ipc.sock`)
- Accepts newline-delimited JSON `CliCommand` messages
- Responds with `{ "ok": true, "data": { ... } }` or `{ "ok": false, "message": "..." }`
- Socket is user-scoped; no network exposure

---

### FR-004: Feature-Based Rust Modules
**Priority**: Critical

Backend business logic must be organized in autonomous feature modules.

**Acceptance Criteria**:
- Each feature lives in `src/features/<name>/` and owns its models, service logic, state, and Tauri command handlers
- Features declare their capabilities via `DesktopCapable` / `CliCapable` / `McpCapable` traits
- `AppRuntime` in `lib.rs` is the explicit composition root; adding a feature requires only registering it there
- No feature imports from another feature's module

---

### FR-005: Stream Events
**Priority**: Critical

The backend must emit typed `StreamEvent` records into the Tauri webview.

**Acceptance Criteria**:
- `infrastructure::events::emit_stream_event()` emits on the `"fredo-stream-event"` Tauri event channel
- Events carry: `toolName`, `sessionId`, `state` (Init / Update / Response / Error), `eventId`, `correlationId`, `timestamp`
- `eventId` is unique per event; `correlationId` links Init → Response pairs
- `TauriAdapter` receives events and feeds them into `StreamContext`

---

### FR-006: Reactive UI Feature Modules
**Priority**: Critical

Every UI feature must be an `FredoFeatureClass` subclass registered in `featureRegistry`.

**Acceptance Criteria**:
- Feature declares `eventFilters: string[]` listing the `toolName` values it reacts to
- Feature re-renders when a matching event arrives in `StreamContext`
- Features with `showable = false` are registered but not shown in the navigation grid
- No feature imports `@tauri-apps/api` directly; all host interaction goes via `adapterBridge` or the `HostAdapter`

---

### FR-007: HostAdapter Portability
**Priority**: High

The UI must be portable across host environments via the `HostAdapter` interface.

**Acceptance Criteria**:
- `TauriAdapter` implements `HostAdapter` using `@tauri-apps/api/event`
- `DevAdapter` implements `HostAdapter` using an in-memory emitter for Vite dev server
- Adding a new host requires only a new `HostAdapter` implementation — zero changes to feature code

---

### FR-008: Persistent Settings
**Priority**: High

User settings must persist across app restarts.

**Acceptance Criteria**:
- `AppStore` stores key-value pairs in SQLite via the `settings` feature
- `save_setting` and `get_setting` Tauri commands are available from the UI
- Settings survive app restarts on the same machine

---

### FR-009: PTY Terminal
**Priority**: High

The app must spawn AI CLI tools (GitHub Copilot CLI, Claude CLI, etc.) in a native PTY.

**Acceptance Criteria**:
- `open_run_cli(provider, work_dir)` resolves the binary, opens a PTY, and spawns the process
- PTY output streams to the UI as `run-cli-output` Tauri events (raw bytes)
- xterm.js terminal renders output in a dedicated `run-cli-terminal` window
- `write_pty_input`, `resize_pty`, and `close_run_cli` commands work correctly

---

### FR-010: Agent Hook Integration
**Priority**: High

The `fredo` binary must be callable from AI agent hook scripts.

**Acceptance Criteria**:
- `fredo agent_hook --event-type PreToolUse --payload '...'` sends an `AgentHook` IPC command
- The running app emits the hook as a `StreamEvent` with appropriate `toolName` and `state`
- The UI can display agent tool call activity in real time

---

### FR-011: OTLP Receivers
**Priority**: High

The backend must implement local OTLP collectors for agent telemetry ingestion.

**Acceptance Criteria**:
- gRPC receiver on `127.0.0.1:4317` implements `TraceService`, `MetricsService`, `LogsService` via tonic
- HTTP receiver on `127.0.0.1:4318` accepts `POST /v1/traces`, `/v1/metrics`, `/v1/logs` in protobuf and JSON
- OTLP spans are mapped to `StreamEvent` records with `source: OtlpGrpc` or `OtlpHttp`
- Trace-to-conversation correlation works across separate HTTP batches
- `chat` child spans are cached and attached to parent `invoke_agent` nodes
- Metrics and logs are received but dropped at source (no UI consumer)

---

### FR-012: MCP Server
**Priority**: High

The backend must expose a Model Context Protocol server with tools for external agents.

**Acceptance Criteria**:
- `fredo mcp` starts MCP server in stdio transport mode
- `fredo mcp --sse --port 3001` starts MCP server in Streamable HTTP mode
- 27 tools available across 9 categories (kubectl, infrastructure, jira, azdo, optimizely, observability, code_execute, fredo_ui, tools_doc)
- Tools requiring external services read credentials from `AppStore` settings
- MCP tool execution emits `StreamEvent` records visible in the Mission Monitor

---

### FR-013: In-Process LLM Engine
**Priority**: High

The app must run llama.cpp inference directly in-process — no child processes.

**Acceptance Criteria**:
- `LlmEngine` loads GGUF models via vendored `llama-cpp-2` bindings
- `load_with_vision()` supports multimodal models with mmproj projector
- `generate()` streams tokens via `mpsc::unbounded_channel` → `spawn_blocking` → Tauri events
- Model selection persisted in SQLite (`llm_model` key), takes effect on next launch
- At least two models supported: Gemma 4 E2B (vision ✓) and MiniCPM-V 4.6 (text-only fallback)

---

### FR-014: Screenshot Capture
**Priority**: Medium

The app must capture screen regions as base64 PNG for vision-based features.

**Acceptance Criteria**:
- `capture_screen_region(x, y, width, height)` returns base64-encoded PNG
- Multi-monitor aware — captures from the correct physical display
- Used by Tic-Tac-Toe AI companion to "see" the board state

---

### FR-015: Mission Monitor
**Priority**: High

The UI must display real-time agent activity as an interactive graph.

**Acceptance Criteria**:
- ReactFlow graph built from `StreamEvent` records via pure `buildGraphFromEvents()` function
- Supports both hook-based and OTLP event sources
- Chat span caching: content attached to parent `invoke_agent` nodes
- UserPromptNode auto-injected before first `invoke_agent` if not yet emitted
- Thread management: main thread + subagent threads with separate positioning
- FocusWindow: slide-in panel showing all related events for a node
- Session history persisted in localStorage (max 50 sessions, auto-prune)
- OTLP source badges in dev mode (hook = amber, gRPC/HTTP = tomato-orange)

---

### FR-016: FredoCompanion
**Priority**: Medium

The Home panel must include an animated AI companion sprite.

**Acceptance Criteria**:
- Animated spritesheet (6-col × 4-row, 80×80px per frame) with idle, talk, teleport states
- LLM-powered personality: tells jokes on single-click, plays Tic-Tac-Toe on double-click
- Token-by-token streaming with `<end_of_turn>`/`<start_of_turn>` stripping
- Cross-window teleport via Tauri global `companion-teleport` events
- Ctrl+right-click to teleport companion to another window

---

### FR-017: Setup Wizard OTel Configuration
**Priority**: Medium

The setup wizard must configure OTLP environment variables for AI agents.

**Acceptance Criteria**:
- `check_otel_configured` detects existing OTel configuration
- `configure_otel` writes OTEL env vars for Claude Code (`~/.claude/settings.json`)
- For Copilot CLI: `setx` on Windows, shell rc file append on Unix (with sentinel for idempotency)
- OTLP endpoints: `127.0.0.1:4317` (gRPC) and `127.0.0.1:4318` (HTTP)

---

## Non-Functional Requirements

### NFR-001: Startup Time
**Priority**: Medium

`pnpm dev:tauri` must produce a working UI in under 60 seconds on a development machine with a warm Rust build cache.

### NFR-002: IPC Latency
**Priority**: Medium

Time from CLI `fredo <command>` invocation to `StreamEvent` appearing in the UI must be under 200 ms on localhost.

### NFR-003: Type Safety
**Priority**: High

- TypeScript strict mode must be enabled; `any` types are avoided at the system boundary
- Rust commands use strongly-typed `serde` structs for all IPC inputs and outputs

### NFR-004: Security
**Priority**: High

- IPC socket is user-scoped; no authentication is required because the socket path is only accessible to the current OS user
- Tauri capabilities (`capabilities/default.json`) follow least-privilege: only the permissions actually used are declared
- No credentials or secrets are stored in plaintext; OS keychain integration is planned for future phases

### NFR-005: Monorepo Hygiene
**Priority**: Medium

- `pnpm --filter @fredo/ui build` must produce zero TypeScript errors
- `cargo build` in `apps/tauri/src-tauri/` must produce zero warnings
- CI enforces both checks on every push to `main`
