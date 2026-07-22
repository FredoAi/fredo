# Fredo — Frequently Asked Questions

## General

### What is Fredo?
Fredo is a desktop platform for working with AI coding agents. It packages a Rust backend (Tauri v2) and a reactive React 19 UI into a single cross-platform desktop app. Agents communicate via adapters through a backend communication layer that normalizes raw events into canonical `FredoEvent` objects consumed by declarative frontend features. It also includes OTLP telemetry receivers (gRPC :4317, HTTP :4318) and an in-process LLM companion.

### Who is Fredo for?
Infrastructure engineers and AI practitioners who want a single desktop app that surfaces real-time cluster state, observability data, and work items while AI agents are running operations in the background.

### How does Fredo relate to AI agents?
Fredo integrates with agents through two paths:

1. **OpenCode OTLP plugin** — the `fredo-opencode-plugin` exports OTLP metrics, logs, and traces directly to the gRPC receiver (`127.0.0.1:4317`) via the OpenTelemetry SDK, replacing the previous CLI-based event forwarding
2. **OTLP telemetry** — agents send spans to `127.0.0.1:4317` (gRPC) or `127.0.0.1:4318` (HTTP)

Both paths flow through adapters that transform raw payloads into `FredoEvent` objects.

---

## Development

### How do I start developing?

```bash
# Rust + Tauri hot reload
pnpm dev:tauri

# UI only (faster, no Rust rebuild)
pnpm --filter @fredo/ui dev
```

See `docs/SETUP.md` for full prerequisites.

### What are the prerequisites?
- Rust toolchain (1.75+) with `rustup`
- Node.js 18+ and pnpm 8+
- Tauri CLI v2 (`cargo install tauri-cli`)
- Windows: WebView2 (bundled with Windows 10+)
- macOS: Xcode Command Line Tools

### How do I add a new UI feature?

1. Create `apps/ui/src/features/<name>/`
2. Add `<Name>Feature.tsx` extending `FredoFeatureClass` — set `id`, `name`, `icon`, `showable`, `eventContracts`, `handleDelivery()`, and `render()`
3. Add `index.ts` that calls `registerFeature(new <Name>Feature())`
4. The feature is auto-discovered by `allFeatures.ts` via `import.meta.glob` — no manual import needed

The feature appears in the navigation grid if `showable = true`. Set `eventContracts` to an array of `EventContractDeclaration` objects that declare which events the feature subscribes to. The Rust ECE engine buffers matching events and delivers `ContractDelivery` objects via the `handleDelivery` method. Contracts must be registered via `registerEventContracts()` at mount — they are NOT auto-registered. **ECE `streamFields` must use 2-level paths** (e.g. `['payload', 'state']`); 3-level paths silently strip sub-fields in the ContractEngine.

### How do I add a new Rust feature?

1. Create `src-tauri/src/features/<name>/` with `mod.rs`, `commands.rs`, and any `models.rs` / `service.rs` / `state.rs` needed
2. Implement `DesktopCapable` (and/or `CliCapable`) in `mod.rs`
3. Register the feature's Tauri state and command handlers in `lib.rs` → `AppRuntime`
4. Re-export the module in `features/mod.rs`

### How do I test the event flow end-to-end in dev mode?

Use the `fredo emit` CLI command to inject synthetic events through the real pipeline (IPC socket → InternalAdapter → ContractEngine → SubscriptionDelivery):

```bash
fredo emit --event-type chat --state init --provider open-code --session-id e2e-test --correlation-id e2e-1 --file ./payload.json
```

Or use the `e2e-inject.ps1` helper script which handles BOM stripping and argument validation:

```powershell
powershell -File .opencode/scripts/e2e-inject.ps1 -EventType chat -State init -ToolName assistant -Provider open-code -SessionId e2e-test-1 -CorrelationId e2e-corr-1 -PayloadFile .opencode/tmp/e2e-payload.json
```

Events flow through the same pipeline as real events and surface in the UI via `ContractDelivery`. See `.opencode/skills/fredo-e2e-events/SKILL.md` for full recipes.

> ⚠️ **CLI arg casing**: state must be lowercase (`init`, not `Init`) and provider must be hyphenated (`open-code`, not `open_code`). Wrong casing silently fails.

### Why does the UI not have a REST API client?

By design. The UI is reactive — it reads events from `StreamContext`. When a user action needs to invoke a backend operation (e.g. clicking "Start Diagram"), it calls `adapterBridge.invoke(command, args)`, which goes through the `HostAdapter` to the Rust backend as a Tauri IPC command. The result comes back as a `FredoEvent`, not as a function return value.

---

## OTLP

### How do I configure my agent to send OTLP to Fredo?

**OpenCode:**
```bash
# Windows
setx OPENCODE_ENABLE_TELEMETRY "1"
setx OPENCODE_OTLP_ENDPOINT "http://127.0.0.1:4317"
setx OPENCODE_OTLP_PROTOCOL "grpc"

# Unix
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT=http://127.0.0.1:4317
export OPENCODE_OTLP_PROTOCOL=grpc
```

Or use the Setup Wizard in Fredo's UI to configure automatically.

OTLP spans are received by the OTLP receivers (`infrastructure/otlp/`) and processed by `OpenCodeAdapter::transform(Transport::OtlpGrpc, payload)`, which maps span data (`gen_ai.operation.name` etc.) into `FredoEvent` objects.

### What OTLP data does Fredo ingest?
- **Spans**: Mapped to `FredoEvent` records and displayed in the Mission Monitor
- **Metrics** (external OTLP): Received but dropped
- **Logs** (external OTLP): Received but dropped

Fredo also collects its own internal metrics and structured logs from the Rust backend via the `tracing` crate ecosystem (Specs #407, #408). All `info!`, `warn!`, `error!`, `debug!`, and `trace!` macros in the Rust backend are captured by a `LogBridgeLayer` and persisted to the `telemetry_logs` table in `fredo.db`. Internal metrics (span count, events received, active sessions, span duration) are collected by `MetricCollector` and persisted to `telemetry_metrics`. Log level and enable/disable are configurable in Settings → Telemetry.

### Why are my chat spans not showing up individually?
`chat` child spans are cached and their content is attached to the parent `invoke_agent` node. This prevents the graph from being flooded with individual chat events. The full chat content is visible in the FocusWindow for the parent node.

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

### What is the Communication Layer?
The `comm` module (`infrastructure/comm/`) is the backbone of the event pipeline. It defines:

- **`FredoEvent`** — the canonical event shape (id, eventType, state, provider, transport, sessionId, correlationId, toolName, payload, error, metadata, timestamp). Serialized as camelCase to match frontend conventions.
- **`EventBus`** — emits `FredoEvent` on the `"fredo-stream-event"` Tauri IPC channel to the webview.
- **`CommAdapter`** trait — each agent provider gets an adapter that transforms raw input into `Vec<FredoEvent>`.

### What are Adapters and Connectors?
**Adapters** are per-agent-provider (OpenCode, ClaudeCode, Internal). **Connectors** are per-transport within an adapter (Hook, OTLP gRPC, OTLP HTTP).

```
infrastructure/comm/adapters/
├── opencode.rs    — OpenCodeAdapter: Hook connector (plugin events) + OTLP connectors (spans)
├── internal.rs    — InternalAdapter: enriches raw events with server-side defaults
```

- `OpenCodeAdapter::transform(Transport::Hook, payload)` — maps PreToolUse/PostToolUse/... plugin hooks into `FredoEvent`
- `OpenCodeAdapter::transform(Transport::OtlpGrpc, payload)` — maps OTLP spans into `FredoEvent`
- New agent providers get a new adapter file; new transports get a new `Transport` variant

### What is `FredoFeatureClass`?
The TypeScript abstract base class every grid-based UI feature extends. It declares the feature's `id`, `name`, `icon`, `showable` flag, and `render()` method. Features subscribe to the event pipeline through the **Event Contract Engine (ECE)**: set `eventContracts` (array of `EventContractDeclaration` objects) and implement `handleDelivery(delivery: ContractDelivery)`. Contracts are registered with the Rust ECE engine via `registerEventContracts()` at mount. Legacy `eventFilters` and `eventSubscriptions` are kept only for non-migrating features (setup, run-cli, query-viewer, model-storage). Optional properties: `isMultiWindow`, `hasSettings`/`renderSettings()`, `gridConfig`, lifecycle hooks `onMount()`/`onUnmount()`.

### What is `featureRegistry`?
A global `Map<string, FredoFeatureClass>` populated at app startup via side-effect imports in `allFeatures.ts`. It mirrors Rust's `AppRuntime` — the explicit list of everything the app knows about.

### What is `StreamContext`?
A React `useReducer`-based store that holds all `ContractDelivery` records received in the current session. It is the single source of truth for all feature data. Deliveries are deduplicated by composite key (e.g. `sessionId + correlationId`). Features never mutate deliveries — they derive display state by reading the append-only delivery log. Raw `FredoEvent` objects never cross IPC to the frontend — only `SubscriptionDelivery` (wrapping `ContractDelivery`) does.

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
