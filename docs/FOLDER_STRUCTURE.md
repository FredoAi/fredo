# Fredo — Folder Structure

## Active Applications

```
apps/
+-- tauri/                          # Fredo desktop app (Tauri 2 + React)
|   +-- src/
|   |   +-- main.tsx                # React entry — mounts UI with TauriAdapter
|   +-- src-tauri/
|   |   +-- src/
|   |   |   +-- main.rs             # Binary entry: CLI or GUI dispatch
|   |   |   +-- lib.rs              # AppRuntime composition root
|   |   |   +-- runtime/
|   |   |   |   +-- mod.rs          # AppRuntime struct
|   |   |   |   +-- capability.rs   # DesktopCapable, CliCapable, McpCapable traits
|   |   |   +-- features/
|   |   |   |   +-- mod.rs          # re-exports all feature modules
|   |   |   |   +-- mcp/            # MCP server (27 tools)
|   |   |   |   |   +-- mod.rs      # McpFeature (CliCapable + McpCapable)
|   |   |   |   |   +-- server.rs   # rmcp server, stdio + HTTP transports
|   |   |   |   |   +-- runner.rs   # transport dispatch
|   |   |   |   |   +-- kubectl/    # 12 k8s tools via kube crate
|   |   |   |   |   +-- k8s/        # infrastructure graph (snapshot, stream)
|   |   |   |   |   +-- jira/       # Jira REST API (3 tools)
|   |   |   |   |   +-- azdo/       # Azure DevOps (2 tools)
|   |   |   |   |   +-- optimizely/ # Feature flags (2 tools)
|   |   |   |   |   +-- observability/ # SQL against PostgreSQL (3 tools)
|   |   |   |   |   +-- code_execute/  # Sandboxed code execution (1 tool)
|   |   |   |   |   +-- fredo_ui/   # Emit StreamEvents to UI (3 tools)
|   |   |   |   |   +-- tools_doc/  # Tool documentation registry (2 tools)
|   |   |   |   +-- terminal/       # PTY-based AI CLI terminal
|   |   |   |   |   +-- mod.rs      # TerminalFeature
|   |   |   |   |   +-- state.rs    # RunCliState (PTY writer, buffer)
|   |   |   |   |   +-- commands.rs # open_run_cli, get_pty_buffer, write_pty_input, ...
|   |   |   |   +-- llm/            # In-process llama.cpp inference
|   |   |   |   |   +-- mod.rs      # LlmFeature
|   |   |   |   |   +-- engine.rs   # LlmEngine (direct llama.cpp bindings)
|   |   |   |   |   +-- service.rs  # LlmService (async chat, chat_with_image)
|   |   |   |   |   +-- state.rs    # LlmState + LlmLoadingState
|   |   |   |   |   +-- commands.rs # llm_chat, llm_chat_with_image
|   |   |   |   +-- settings/       # Persistent KV settings
|   |   |   |   |   +-- mod.rs      # SettingsFeature
|   |   |   |   |   +-- commands.rs # save_setting, get_setting
|   |   |   |   +-- setup/          # CLI detection, PATH management, OTel config
|   |   |   |   |   +-- mod.rs      # SetupFeature
|   |   |   |   |   +-- commands.rs # get_plugin_source_path, check_cli_installations, install_plugin, check_fredo_in_path, add_fredo_to_path, check_otel_configured, configure_otel
|   |   |   |   +-- screenshot/     # Screen capture (xcap)
|   |   |   |   |   +-- mod.rs      # ScreenshotFeature
|   |   |   |   |   +-- commands.rs # capture_screen_region
|   |   |   +-- infrastructure/
|   |   |   |   +-- events/mod.rs   # StreamEvent, EventSource, OtlpPayload, emit_stream_event()
|   |   |   |   +-- storage/mod.rs  # AppStore (SQLite KV store)
|   |   |   |   +-- ipc.rs          # Local socket server + CliCommand dispatch
|   |   |   |   +-- cli/            # clap CLI root + agent hook commands
|   |   |   |   +-- otlp/           # OTLP receivers
|   |   |   |       +-- mod.rs      # OtlpState (trace→conversation correlation)
|   |   |   |       +-- grpc.rs     # gRPC receiver (:4317)
|   |   |   |       +-- http.rs     # HTTP receiver (:4318)
|   |   |   |       +-- mapping.rs  # protobuf → StreamEvent mapping
|   |   |   +-- utils/
|   |   |       +-- error.rs        # anyhow re-exports
|   |   +-- Cargo.toml
|   |   +-- tauri.conf.json
|   |   +-- capabilities/
|   |   |   +-- default.json        # Tauri IPC permissions
|   |   +-- nsis/
|   |       +-- installer-hooks.nsh # Adds fredo to system PATH on install
|   +-- vite.config.ts
|   +-- index.html
|   +-- package.json
|
+-- ui/                             # @fredo/ui — shared React frontend library
|   +-- src/
|       +-- app/
|       |   +-- adapters/
|       |   |   +-- HostAdapter.ts  # Interface: onMessage + invoke + llmChat + llmChatWithImage
|       |   |   +-- DevAdapter.ts   # In-memory emitter for Vite dev server
|       |   |   +-- TauriAdapter.ts # @tauri-apps/api via dynamic imports
|       |   +-- providers/
|       |       +-- AppProvider.tsx # Wires adapter -> StreamContext; registers adapterBridge
|       +-- features/
|       |   +-- featureRegistry.ts  # registerFeature() — mirrors Rust AppRuntime
|       |   +-- allFeatures.ts      # Vite glob auto-discovery: `import.meta.glob`
|       |   +-- home/               # Home panel + AlertHandler + FredoCompanion
|       |   +-- diagram/            # Kubernetes infrastructure diagram (ReactFlow)
|       |   +-- run-cli/            # xterm.js terminal (PTY output)
|       |   +-- query-viewer/       # SQL query result display (multi-instance)
|       |   +-- my-workitems/       # Azure DevOps work items
|       |   +-- settings/           # Settings panel + ModelSelector
|       |   +-- setup/              # SetupWizard (OTel config, CLI detection)
|       |   +-- mission-monitor/    # Real-time agent activity graph
|       |   |   +-- MissionMonitorFeature.tsx
|       |   |   +-- components/     # FocusWindow, SessionHistoryDrawer, node types
|       |   |   +-- hooks/          # useMissionMonitor, useSessionHistory
|       |   |   +-- lib/            # sessionStorage.ts (localStorage persistence)
|       |   |   +-- types.ts        # NodeEventSnapshot, MonitorNodeData
|       |   +-- dev-mode/           # Dev tools + SpatiotemporalManifold
|       |   +-- browser-preview/    # Web page preview panel
|       |   +-- docs-viewer/        # Documentation viewer
|       |   +-- github-viewer/      # GitHub repository browser
|       |   +-- optimizely/         # Feature flag management
|       |   +-- theming/            # Theme customization
|       +-- shared/
|           +-- contexts/
|           |   +-- StreamContext.tsx  # useReducer event bus; StreamEvent store
|           +-- utils/
|           |   +-- adapterBridge.ts  # Non-React singleton for FredoFeatureClass -> invoke()
|           +-- components/
|               +-- companion/
|                   +-- FredoCompanion.tsx  # Animated sprite + LLM personality
|                   +-- SpeechBubble.tsx    # Positionable bubble with game slot
|                   +-- features/
|                       +-- tictactoe/      # Tic-Tac-Toe game (vision-based AI)
|
+-- marketplace-plugin/             # Plugin descriptor for OpenCode
+-- code-sandbox/                   # Python code execution sandbox service
+-- tools-mcp_DEPRECATED/           # Archived Node.js MCP backend (not active)
```

## Archived Applications

Kept in the repository for historical reference. Not built by default.

```
apps/
+-- browser-extension/    # Chrome extension (superseded by apps/tauri)
+-- vscode-extension/     # VS Code extension (superseded by apps/tauri)
+-- copilot-plugin/       # Original Copilot CLI plugin (superseded by marketplace-plugin/OpenCode)
```

See `docs/archive/` for documentation on these components.

## Documentation Structure

```
docs/
+-- ARCHITECTURE.md         # System design: feature-based modules, reactive UI, OTLP, MCP, LLM
+-- FOLDER_STRUCTURE.md     # This file
+-- CODING_GUIDELINES.md    # Code conventions for Rust and TypeScript
+-- REQUIREMENTS.md         # Functional and non-functional requirements
+-- SCOPE.md                # What is and isn't in scope
+-- PROJECT_GOALS.md        # Product goals and success criteria
+-- CI_CD.md                # GitHub Actions pipeline
+-- SECURITY.md             # Security model, IPC surface, OTLP, MCP
+-- FAQ.md                  # Common questions
+-- tauri/
|   +-- ARCHITECTURE.md     # Detailed Rust module map, OTLP, MCP, LLM engine internals
|   +-- CLI_GUIDE.md        # Fredo CLI commands, MCP server, OTLP setup
|   +-- SETUP.md            # Local development setup, model configuration
+-- archive/                # Documentation for removed components
```

## Key Conventions

- **Feature modules** are the unit of organization in both Rust (`features/<name>/`) and TypeScript (`features/<name>/`). Each owns its full vertical slice.
- **`infrastructure/`** (Rust) and **`shared/`** (TypeScript) contain platform services consumed by features — never business logic.
- **`AppRuntime`** (Rust) and **`featureRegistry`** (TypeScript) are the composition roots. Every feature must register there.
- **`HostAdapter`** is the only place that imports `@tauri-apps/api`. All other UI code uses `adapterBridge.invoke()` or `StreamContext`.
- **MCP tools** live under `features/mcp/<category>/` — each category is its own autonomous module.
- **OTLP infrastructure** lives under `infrastructure/otlp/` — shared platform service, not a feature.
