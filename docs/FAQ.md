# Fredo — Frequently Asked Questions

## General

### What is Fredo?
Fredo is an AI-native desktop operations platform. It packages a Rust backend (Tauri v2) and a reactive React UI into a single cross-platform desktop app. AI agents (Copilot CLI, Claude CLI, or any tool that calls the `fredo` binary) emit events into the running app in real time — the UI reacts to those events without any polling. It also includes an MCP server with 27 tools, OTLP telemetry receivers, and an on-device LLM companion.

### Who is Fredo for?
Infrastructure engineers and AI practitioners who want a single desktop app that surfaces real-time cluster state, observability data, and work items while AI agents are running operations in the background.

### How does Fredo relate to AI agents?
Fredo integrates with agents through three paths:
1. **Agent hooks** — the `fredo` binary is called from agent hook scripts (PreToolUse / PostToolUse)
2. **OTLP telemetry** — agents send spans to `127.0.0.1:4317` (gRPC) or `127.0.0.1:4318` (HTTP)
3. **MCP server** — agents call `fredo mcp` (stdio) or connect to `fredo mcp --sse` (HTTP) and use any of the 27 tools

---

## Development

### How do I start developing?

```bash
# Rust + Tauri hot reload
pnpm dev:tauri

# UI only (faster, no Rust rebuild)
pnpm --filter @fredo/ui dev
```

See `docs/tauri/SETUP.md` for full prerequisites.

### What are the prerequisites?
- Rust toolchain (1.75+) with `rustup`
- Node.js 18+ and pnpm 8+
- Tauri CLI v2 (`cargo install tauri-cli`)
- Windows: WebView2 (bundled with Windows 10+)
- macOS: Xcode Command Line Tools

### How do I add a new UI feature?

1. Create `apps/ui/src/features/<name>/`
2. Add `<Name>Feature.tsx` extending `FredoFeatureClass` — set `id`, `label`, `icon`, `showable`, `eventFilters`, and `render()`
3. Add `index.ts` that calls `registerFeature(new <Name>Feature())`
4. Import `'./<name>'` in `allFeatures.ts`

The feature appears in the navigation grid if `showable = true`. Set `eventFilters` to the `toolName` values the feature should react to.

### How do I add a new Rust feature?

1. Create `src-tauri/src/features/<name>/` with `mod.rs`, `commands.rs`, and any `models.rs` / `service.rs` / `state.rs` needed
2. Implement `DesktopCapable` (and/or `CliCapable`) in `mod.rs`
3. Register the feature's Tauri state and command handlers in `lib.rs` → `AppRuntime`
4. Re-export the module in `features/mod.rs`

### How do I add a new MCP tool?

1. Create `src-tauri/src/features/mcp/<category>/mod.rs`
2. Define the tool using `rmcp` macros with name, description, and input schema
3. Register the tool in `features/mcp/server.rs`
4. If credentials are needed, document the required `AppStore` keys

### How do I test the event flow end-to-end in dev mode?

In the browser console of the running Vite dev server, use the exposed `DevAdapter`:

```javascript
window.__devAdapter.emit({
  toolName: 'my_tool',
  sessionId: 'dev',
  state: 'Response',
  response: { /* ... */ },
  timestamp: new Date().toISOString()
})
```

This bypasses Tauri and feeds a synthetic `StreamEvent` directly into `StreamContext`.

### Why does the UI not have a REST API client?

By design. The UI is reactive — it reads events from `StreamContext`. When a user action needs to invoke a backend operation (e.g. clicking "Start Diagram"), it calls `adapterBridge.invoke(command, args)`, which goes through the `HostAdapter` to the Rust backend as a Tauri IPC command. The result comes back as a `StreamEvent`, not as a function return value.

---

## OTLP

### How do I configure my agent to send OTLP to Fredo?

**Claude Code:**
```bash
claude setting set env OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317
claude setting set env OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

**Copilot CLI:**
```bash
# Windows
setx OTEL_EXPORTER_OTLP_ENDPOINT "http://127.0.0.1:4318"
setx OTEL_EXPORTER_OTLP_PROTOCOL "http/protobuf"

# Unix
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Or use the Setup Wizard in Fredo's UI to configure automatically.

### What OTLP data does Fredo ingest?
- **Spans**: Mapped to `StreamEvent` records and displayed in the Mission Monitor
- **Metrics**: Received but dropped (no UI consumer yet)
- **Logs**: Received but dropped (no UI consumer yet)

### Why are my chat spans not showing up individually?
`chat` child spans are cached and their content is attached to the parent `invoke_agent` node. This prevents the graph from being flooded with individual chat events. The full chat content is visible in the FocusWindow for the parent node.

---

## MCP Server

### How do I start the MCP server?

```bash
# stdio transport (for agents that spawn the process)
fredo mcp

# HTTP transport (for persistent sessions)
fredo mcp --sse --port 3001
```

### How do I configure credentials for MCP tools?

```bash
# Jira
fredo setting set mcp.jira.base_url "https://your-domain.atlassian.net"
fredo setting set mcp.jira.email "you@example.com"
fredo setting set mcp.jira.api_token "your-token"

# Azure DevOps
fredo setting set mcp.azdo.org_url "https://dev.azure.com/your-org"
fredo setting set mcp.azdo.project "your-project"
fredo setting set mcp.azdo.pat "your-pat"

# Optimizely
fredo setting set mcp.optimizely.project_id "your-project-id"
fredo setting set mcp.optimizely.sdk_key "your-sdk-key"

# PostgreSQL (observability queries)
fredo setting set mcp.db.url "postgresql://user:pass@host:5432/db"

# Code execution sandbox (optional)
fredo setting set mcp.code_sandbox_url "http://localhost:8000"
```

### What tools are available?
Run `fredo mcp` and connect with an MCP client to list all 27 tools. Categories: kubectl (12), infrastructure (2), jira (3), azdo (2), optimizely (2), observability (3), code_execute (1), fredo_ui (3), tools_doc (2).

---

## LLM

### What models does Fredo support?
- **Gemma 4 E2B** (`gemma-4-e2b`) — full vision support via mmproj projector
- **MiniCPM-V 4.6** (`minicpm-v-4-6`) — text-only (vision projector unsupported in current llama.cpp version)

### How do I switch models?
Open Settings in the UI → Model Selector → choose a model. The change takes effect on next app launch.

### Where do I put model files?
Place GGUF files under `apps/tauri/src-tauri/models/<model-name>/`. For example:
```
apps/tauri/src-tauri/models/gemma-e2b-it/gemma-e2b-it-q4_k_m.gguf
```

### Does Fredo run llama.cpp as a subprocess?
No. The LLM engine runs **in-process** via vendored `llama-cpp-2` Rust bindings. No child processes, no HTTP/SSE round-trips.

---

## Architecture

### What is `FredoFeatureClass`?
The TypeScript abstract base class every UI feature extends. It declares the feature's `id`, `label`, `icon`, `showable` flag, `eventFilters` (which `toolName` values trigger re-renders), and `render()` method. It is the TypeScript mirror of Rust's `DesktopCapable` trait.

### What is `featureRegistry`?
A global `Map<string, FredoFeatureClass>` populated at app startup via side-effect imports in `allFeatures.ts`. It mirrors Rust's `AppRuntime` — the explicit list of everything the app knows about.

### What is `StreamContext`?
A React `useReducer`-based store that holds all `StreamEvent` records received in the current session. It is the single source of truth for all feature data. Events are deduplicated by `eventId` and expire after a TTL (default 60 s). Features never mutate events — they derive display state by reading the log.

### What is the `HostAdapter`?
An interface that abstracts the transport between the UI and its host environment. `TauriAdapter` uses `@tauri-apps/api`; `DevAdapter` uses an in-memory emitter. No feature code ever imports `@tauri-apps/api` directly — only `TauriAdapter.ts` is allowed to.

### What does `correlationId` do?
It ties an `Init` event (agent called a tool) to its `Response` event (tool finished). Features use it to show progress indicators or before/after diffs without needing shared mutable state.

### What is the FredoCompanion?
An animated sprite on the Home panel with an LLM-powered personality. Single-click for a joke, double-click to play Tic-Tac-Toe, Ctrl+right-click to teleport to another window. Uses the in-process LLM engine for all interactions.

### How does the Tic-Tac-Toe AI work?
The companion takes a screenshot of the board via `capture_screen_region`, sends it to the LLM with a vision prompt ("reply with single digit 0-8"), and parses the first digit from the response. Falls back to the first empty cell on error.

---

## Builds & Distribution

### How do I build a production installer?

```bash
pnpm build:tauri
```

Produces `.msi` (Windows), `.dmg` (macOS), and `.AppImage` (Linux) in `apps/tauri/src-tauri/target/release/bundle/`.

### How is the `fredo` CLI installed?
The NSIS installer (`nsis/installer-hooks.nsh`) adds the `fredo` binary directory to the system `PATH` on Windows. On macOS/Linux, the bundled binary is symlinked to `/usr/local/bin/fredo` during install.

### What does `fredo` do when no desktop app is running?
CLI mode prints a connection-refused error and exits non-zero. The IPC socket only exists while the GUI is running.
