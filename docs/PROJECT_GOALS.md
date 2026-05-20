# Fredo — Project Goals

## Primary Objective

Fredo is a **cross-platform desktop infrastructure operations tool** that puts Kubernetes management, observability data, and Azure DevOps work items into a single React UI, driven by a CLI that any developer can use from any terminal. It also serves as an **AI agent operations platform** — ingesting agent telemetry via OTLP, exposing 27 MCP tools, and running an on-device LLM for companion interactions.

## Core Goals

### 1. Desktop-First, CLI-Driven
- Single installable desktop app (Windows, macOS, Linux) that requires no browser or editor extensions
- `fredo` CLI available in PATH immediately after install
- CLI commands emit stream events into the running UI in real time

### 2. Composable CLI
- Every UI feature is reachable from the terminal: `fredo logs`, `fredo k8s pods`, `fredo azdo story`
- Commands are scriptable and composable with other shell tools
- When the app is closed, CLI commands print JSON to stdout

### 3. Portable React UI
- `@fredo/ui` runs in any host via the `HostAdapter` interface
- Adding a new host (web, Electron, etc.) requires only a new adapter — no feature changes
- `DevAdapter` preserves the Vite dev-server workflow with zero Rust dependency

### 4. Rust Reliability
- Tauri IPC replaces fragile SSE-over-HTTP with a native OS-level event bus
- Rust type system validates all CLI commands at the IPC boundary
- Named pipe / Unix socket is user-scoped, secure by default

### 5. Maintainable Monorepo
- One pnpm workspace with explicit package membership
- Clear separation: `apps/tauri` (host), `apps/ui` (frontend)
- GitHub Actions publishes signed installers on tag push

### 6. Agent Telemetry Ingestion (OTLP)
- Local gRPC (`:4317`) and HTTP (`:4318`) OTLP receivers
- Real-time mapping of agent spans to UI-visible events
- Trace-to-conversation correlation across HTTP batches

### 7. MCP Tool Server
- 27 tools across 9 categories (kubectl, infrastructure, jira, azdo, optimizely, observability, code_execute, fredo_ui)
- Both stdio and Streamable HTTP transports
- Credential configuration via settings panel

### 8. On-Device AI Companion
- In-process llama.cpp inference — no external services
- Vision-capable models (Gemma 4 E2B, MiniCPM-V 4.6)
- Animated companion sprite with personality, jokes, and games

## Success Criteria

1. `pnpm dev:tauri` starts the desktop app with a working UI in under 60 seconds on a clean machine
2. `fredo hook PreToolUse --payload '{...}'` emits a StreamEvent visible in the Mission Monitor
3. `pnpm build:tauri` produces signed `.msi`, `.dmg`, `.AppImage`, and `.deb` artifacts
4. `fredo --help` is available immediately after OS install
5. Adding a new MCP tool requires only: a `#[tool]` function in `features/mcp/<category>/`
6. OTLP spans from OpenCode appear in the Mission Monitor within 200ms
7. `fredo mcp` starts the MCP server and agents can call tools via stdio
8. LLM model loads in-process and streams tokens to the UI

## Long-term Vision

Fredo becomes the standard local operations terminal for infrastructure engineers — a single app that surfaces real-time cluster state, observability data, and ticketing without switching tools or opening a browser. It also becomes the default agent display layer — where AI practitioners watch their agents work in real time, interact with them through a companion interface, and orchestrate operations through MCP tools.
