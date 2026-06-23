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
|   |   |   |   +-- capability.rs   # DesktopCapable, CliCapable traits
|   |   |   +-- features/
|   |   |   |   +-- mod.rs          # re-exports all feature modules
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
|   |   |   |   +-- comm/           # Communication layer — FredoEvent pipeline
|   |   |   |   |   +-- mod.rs      # re-exports FredoEvent, EventBus, CommAdapter
|   |   |   |   |   +-- event.rs    # FredoEvent, EventType, EventProvider, Transport, EventState, FredoEventBuilder
|   |   |   |   |   +-- bus.rs      # EventBus (emits FredoEvent on "fredo-stream-event" IPC channel)
|   |   |   |   |   +-- adapter.rs  # CommAdapter trait (transform raw input → Vec<FredoEvent>)
|   |   |   |   |   +-- adapters/
|   |   |   |   |   |   +-- mod.rs
|   |   |   |   |   |   +-- opencode.rs  # OpenCodeAdapter (Hook + OTLP connectors)
|   |   |   |   |   |   +-- internal.rs  # InternalAdapter (enriches raw events with defaults)
|   |   |   |   |   +-- tests/
|   |   |   |   |       +-- mod.rs
|   |   |   |   |       +-- event_tests.rs
|   |   |   |   |       +-- bus_tests.rs
|   |   |   |   |       +-- adapter_tests.rs
|   |   |   |   |       +-- ipc_tests.rs
|   |   |   |   +-- storage/mod.rs  # AppStore (SQLite KV store)
|   |   |   |   +-- ipc.rs          # Local socket server + CliCommand dispatch
|   |   |   |   +-- cli/            # clap CLI root + agent hook commands
|   |   |   |   +-- otlp/           # OTLP receivers (gRPC :4317, HTTP :4318)
|   |   |   |       +-- mod.rs      # OtlpState (trace→conversation correlation)
|   |   |   |       +-- grpc.rs     # gRPC receiver
|   |   |   |       +-- http.rs     # HTTP receiver
|   |   |   +-- utils/
|   |   |       +-- mod.rs          # re-exports error + dump helpers
|   |   |       +-- error.rs        # anyhow re-exports
|   |   |       +-- dump.rs         # event dump/formatting utilities
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
|       |   +-- model-storage/      # Model file management
|       |   |   +-- ModelStorageFeature.tsx
|       |   |   +-- index.ts
|       |   |   +-- components/     # ModelStorageSettings
|       |   +-- optimizely/         # Feature flag management
|       |   +-- theming/            # Theme customization
|       +-- shared/
|           +-- contexts/
|           |   +-- StreamContext.tsx  # useReducer event bus; FredoEvent stream store
|           +-- classes/
|           |   +-- FredoFeatureClass.ts  # Base class for all grid features
|           |   +-- EventSubscription.ts  # EventContract + typed subscription lifecycle
|           |   +-- types.ts              # Shared TypeScript type definitions
|           |   +-- index.ts              # re-exports all classes
|           +-- utils/
|           |   +-- adapterBridge.ts  # Non-React singleton for FredoFeatureClass -> invoke()
|           +-- components/
|               +-- companion/
|                   +-- FredoCompanion.tsx  # Animated sprite + LLM personality
|                   +-- SpeechBubble.tsx    # Positionable bubble with game slot
|                   +-- features/
|                       +-- tictactoe/      # Tic-Tac-Toe game (vision-based AI)
|
+-- marketplace-plugin/           # Plugin descriptor for OpenCode
+-- code-sandbox/                   # Python code execution sandbox service
+-- tools-mcp_DEPRECATED/           # Archived Node.js MCP backend (not active)
```

## Archived Applications

Kept in the repository for historical reference. Not built by default.

```
apps/
+-- browser-extension/    # Chrome extension (superseded by apps/tauri)
+-- vscode-extension/     # VS Code extension (superseded by apps/tauri)
+-- marketplace-plugin/     # OpenCode CLI plugin integration (superseded by marketplace-plugin/OpenCode)
```

See `docs/archive/` for documentation on these components.

## Documentation Structure

```
docs/
+-- ARCHITECTURE.md         # System design: feature-based modules, reactive UI, OTLP, LLM
+-- FOLDER_STRUCTURE.md     # This file
+-- CODING_GUIDELINES.md    # Code conventions for Rust and TypeScript
+-- REQUIREMENTS.md         # Functional and non-functional requirements
+-- SCOPE.md                # What is and isn't in scope
+-- PROJECT_GOALS.md        # Product goals and success criteria
+-- CI_CD.md                # GitHub Actions pipeline
+-- SECURITY.md             # Security model, IPC surface, OTLP
+-- FAQ.md                  # Common questions
+-- BACKEND_ARCHITECTURE.md # Detailed Rust module map, IPC protocol, OTLP receivers, Tauri commands
+-- CLI_GUIDE.md            # Fredo CLI command reference
+-- SETUP.md                # Local development setup, model configuration
+-- archive/                # Documentation for removed components
```

## Key Conventions

- **Feature modules** are the unit of organization in both Rust (`features/<name>/`) and TypeScript (`features/<name>/`). Each owns its full vertical slice.
- **`infrastructure/`** (Rust) and **`shared/`** (TypeScript) contain platform services consumed by features — never business logic.
- **`AppRuntime`** (Rust) and **`featureRegistry`** (TypeScript) are the composition roots. Every feature must register there.
- **`HostAdapter`** is the only place that imports `@tauri-apps/api`. All other UI code uses `adapterBridge.invoke()` or `StreamContext`.
- **Communication layer adapters** live under `infrastructure/comm/adapters/` — one file per agent provider. Adapters also process OTLP input.
- **OTLP infrastructure** lives under `infrastructure/otlp/` — shared platform service, not a feature.
