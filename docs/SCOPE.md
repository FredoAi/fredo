# Fredo — Project Scope

## In Scope

### Desktop Application (`apps/tauri`)

- **Tauri 2** cross-platform desktop app for Windows, macOS, and Linux
- **`fredo` CLI** bundled with the installer, added to system PATH on install
- Single binary: GUI mode (no args) and CLI mode (with args) using the same executable
- Local IPC socket (named pipe on Windows, Unix socket on macOS/Linux) bridging CLI/agent hooks → Rust backend → Tauri webview
- **OTLP receivers** — gRPC (`:4317`) and HTTP (`:4318`) local collectors for agent telemetry; spans are transformed into `FredoEvent` records via `OpenCodeAdapter`

### Frontend (`apps/ui`)

- **`@fredo/ui`** shared React library — runs unchanged in the Tauri webview
- **`HostAdapter` interface** as the portability contract; `TauriAdapter` and `DevAdapter` provided
- **`FredoFeatureClass`** abstract base class — the unit of UI feature organization
- **`StreamContext`** — `useReducer`-based reactive event bus; all feature data derives from the event log
- **Communication layer & feature contracts** — `FredoEvent` canonical event shape propagated via `"fredo-stream-event"` IPC channel; features declare event interests via `eventFilters` (legacy) or `eventSubscriptions` (`EventContract` / `SubscriptionDelivery` lifecycle)
- Feature modules (active, showable): home, diagram, run-cli, query-viewer, my-workitems, settings, mission-monitor, browser-preview, docs-viewer, github-viewer, optimizely, model-storage
- Feature modules (active, hidden): setup, dev-mode, theming
- **FredoCompanion** — shared animated sprite with LLM personality, jokes, and Tic-Tac-Toe game
- **Mission Monitor** — real-time agent activity graph (ReactFlow) with FocusWindow and session history

### Rust Feature Modules

- **terminal** — PTY-based AI CLI terminal (OpenCode)
- **llm** — In-process llama.cpp inference via vendored `llama-cpp-2`
- **settings** — Persistent KV store (SQLite via `AppStore`)
- **setup** — CLI tool detection, PATH management, OTel configuration
- **screenshot** — Screen capture via `xcap` (multi-monitor aware)

### Agent Integration

- `fredo` binary callable from AI agent hook scripts (PreToolUse / PostToolUse)
- IPC socket accepts `OpenCodePlugin` `CliCommand` payloads; `OpenCodeAdapter` transforms the payload into `FredoEvent` records which are emitted via `EventBus`
- OTLP receivers ingest telemetry from OpenCode and any OTLP-compatible tool
- Agent activity visible in real time in the Mission Monitor

### Infrastructure

- GitHub Actions CI: TypeScript type check, Rust build, multi-platform Tauri installer build on tag push

## Out of Scope (Current Phase)

- Authentication and user management
- Cloud / production deployment of the desktop app
- Tauri mobile (iOS / Android) targets
- Headless / CI mode for the Rust backend (GUI required for IPC socket)
- OTLP metrics and logs ingestion (received but dropped — no UI consumer)

## Future Scope

1. **OTLP metrics/logs UI** — build UI features to consume metrics and logs from the OTLP receivers
2. **Credential management** — OS keychain integration for kubeconfig, PAT tokens, and connection strings
3. **MCP server implementation** — native Rust MCP server with tool exposure (not yet built)
4. **Auto-update** — Tauri updater plugin for in-app updates
5. **Multi-cluster support** — switch between Kubernetes contexts via CLI flag or settings panel
6. **Headless mode** — run the Rust backend + IPC socket without a GUI window (useful in CI or Docker)
7. **McpCapable trait** — a capability trait skeleton exists (`DesktopCapable`, `CliCapable`) but no MCP implementation is built yet
8. **Additional agent adapters** — new `CommAdapter` implementations for ClaudeCode, Cursor, and other AI coding agents
9. **Subscription engine** — reactive `EventSubscription` delivery system for the `Init → Update → End` lifecycle defined in `EventContract`
10. **Plugin ecosystem** — third-party feature development framework

## Archived (No Longer Active)

| Component | Superseded by |
|-----------|--------------|
| `apps/browser-extension` | `apps/tauri` |
| `apps/vscode-extension` | `apps/tauri` |
| `apps/tools-mcp` (Node.js MCP/SSE backend, Redis Streams, PostgreSQL) | Not yet reimplemented in Rust |
| `apps/ai-sidecar` (Node.js AI CLI sidecar) | PTY-based `terminal` feature |
| `apps/marketplace-plugin` | Original OpenCode plugin | `apps/marketplace-plugin` (OpenCode) |
| UI: agents, chatbot, embeddings, memory, telemetry | Consolidated into Mission Monitor |

Full documentation for archived components is in `docs/archive/`.
