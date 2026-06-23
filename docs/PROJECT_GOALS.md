# Fredo — Project Goals

## Primary Objective

Fredo is a **desktop platform for working with AI coding agents**. It gives practitioners a native app to watch agents work in real time, interact through a companion interface, and orchestrate operations through agent integrations. It ingests agent telemetry via OTLP and normalizes events from multiple agent providers through a typed adapter layer. As a secondary capability, it also serves as a cross-platform desktop infrastructure operations tool — putting Kubernetes management, observability data, and Azure DevOps work items into a single React UI, driven by a CLI that any developer can use from any terminal.

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
- Local gRPC (`:4317`) and HTTP (`:4318`) OTLP receivers ingest OpenTelemetry spans from coding agents
- Real-time mapping of agent spans to UI-visible `FredoEvent` objects
- Trace-to-conversation correlation across HTTP batches

### 7. Agent Adapter Platform
- A communication layer (`infrastructure/comm/`) normalizes events from multiple agent providers (OpenCode, ClaudeCode) into canonical `FredoEvent` objects
- Adaptors with per-transport connectors (Hook, OTLP gRPC, OTLP HTTP) transform raw input into typed events consumed declaratively by frontend features
- New agent providers get a new adapter file; new transports get a new `Transport` variant — no feature rewrites required

### 8. On-Device AI Companion
- In-process llama.cpp inference — no external services
- Vision-capable models (Gemma 4 E2B, MiniCPM-V 4.6)
- Animated companion sprite with personality, jokes, and games

## Success Criteria

1. `pnpm dev:tauri` starts the desktop app with a working UI in under 60 seconds on a clean machine
2. `fredo hook PreToolUse --payload '{...}'` emits a StreamEvent visible in the Mission Monitor
3. `pnpm build:tauri` produces signed `.msi`, `.dmg`, `.AppImage`, and `.deb` artifacts
4. `fredo --help` is available immediately after OS install
5. OTLP spans from OpenCode appear in the Mission Monitor within 200ms
6. Events from a new agent provider can be ingested by adding a single adapter file under `infrastructure/comm/adapters/`
7. LLM model loads in-process and streams tokens to the UI

## Long-term Vision

Fredo becomes the standard desktop platform for working with AI coding agents — where practitioners watch their agents work in real time, interact through a companion interface, and orchestrate operations through agent integrations. The adapter platform grows to support any agent provider, while the event subscription system (`EventContracts`, `FredoFeatureClass.eventSubscriptions`) lets features declaratively assemble raw telemetry into structured contracts via an Init → Update → End lifecycle. As a secondary capability, it also becomes the default local operations terminal for infrastructure engineers — a single app that surfaces real-time cluster state, observability data, and ticketing without switching tools or opening a browser.
