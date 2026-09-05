# Fredo — Frequently Asked Questions

## General

### What is Fredo?

Fredo is a desktop platform for working with AI coding agents. It packages a Rust backend (Tauri v2) and a reactive React 19 UI into a single desktop app. Agents send telemetry to local OTLP receivers, which persist every raw span/metric/log on receipt and then classify each one onto canonical SQLite rows. Those rows stream to the UI in real time as row deliveries, and declarative frontend features subscribe to them via `useEventRows` — no polling. Fredo also includes local OTLP receivers (gRPC :4317, HTTP :4318) and an in-process LLM companion.

### Is this a commercial product?

No. Fredo is a personal project the maintainer uses to learn and experiment with AI. There is no SLA, no dedicated support, and the internals/APIs can change without notice. It is openly licensed and contributions are welcome, but expectations are modest.

### Who is Fredo for?

Developers and AI practitioners who want a single desktop app that surfaces real-time agent activity — chat, tool calls, and nested subagent delegation — while AI agents are running work in the background. It is built to be tinkered with, not to be a supported enterprise product.

### How does Fredo relate to AI agents?

Agents integrate through two paths:

1. **OpenCode OTLP plugin** — the `fredo-opencode-plugin` exports OTLP metrics, logs, and traces directly to the gRPC receiver (`127.0.0.1:4317`) using the OpenTelemetry SDK.
2. **OTLP receivers** — native gRPC/HTTP collectors that ingest OpenTelemetry spans from OpenCode and compatible tools.

Raw telemetry is persisted on receipt and then classified by the **RTDB ingest classifier** into canonical SQLite rows (`chat_rows` / `tool_use_rows` / `agent_session_rows`) that stream to the frontend as row deliveries. The `fredo` CLI can also inject CLI events through the same classifier path.

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
- Node.js 20+ and pnpm 8+
- Tauri CLI v2 (`cargo install tauri-cli`)
- Windows: WebView2 (bundled with Windows 10+)
- macOS: Xcode Command Line Tools

### How do I add a new UI feature?

1. Create `apps/ui/src/features/<name>/`
2. Add `<Name>Feature.tsx` extending `FredoFeatureClass` — set `id`, `name`, `icon`, `showable`, and `render()`
3. Add `index.ts` that calls `registerFeature(new <Name>Feature())`
4. The feature is auto-discovered by `allFeatures.ts` via `import.meta.glob` — no manual import needed

The feature appears in the navigation grid if `showable = true`. To consume live agent activity, subscribe to the RTDB row store with `useEventRows(eventType, args, options)` inside `render()` — see the docs below.

### How do I add a new Rust feature?

1. Create `src-tauri/src/features/<name>/` with `mod.rs`, `commands.rs`, and any `models.rs` / `service.rs` / `state.rs` needed
2. Implement `DesktopCapable` (and/or `CliCapable`) in `mod.rs`
3. Register the feature's Tauri state and command handlers in `lib.rs` → `AppRuntime`
4. Re-export the module in `features/mod.rs`

### How do I test the event flow end-to-end in dev mode?

Use the `fredo emit` CLI command to inject synthetic events through the real pipeline (IPC socket → InternalAdapter → RTDB ingest classifier → row deliveries):

```bash
fredo emit --event-type chat --state init --provider open-code --session-id e2e-test --correlation-id e2e-1 --file ./payload.json
```

Events flow through the same pipeline as real events and surface in the UI as row deliveries. For full recipes (payload shapes, event types, transports), see `.opencode/skills/fredo-cli-events/SKILL.md`.

> ⚠️ **CLI arg casing**: state must be lowercase (`init`, not `Init`) and provider must be hyphenated (`open-code`, not `open_code`). Wrong casing silently fails.

### Why does the UI not have a REST API client?

By design. The UI is reactive — it subscribes to row deliveries via `useEventRows` and reacts, it never polls. When a user action needs to invoke a backend operation (e.g. clicking "Start Diagram"), it calls `adapterBridge.invoke(command, args)`, which goes through the `HostAdapter` to the Rust backend as a Tauri IPC command.

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

OTLP spans are received by the OTLP receivers (`infrastructure/otlp/`), persisted raw on receipt, and classified into canonical rows by the RTDB ingest classifier (`infrastructure/rtdb/ingest.rs`) — the row pipeline is the only delivery path.

### What OTLP data does Fredo ingest?

- **Spans**: Persisted raw on receipt (`telemetry_spans`) AND classified into rows for the Mission Monitor — zero dropped.
- **Metrics** (external OTLP): Persisted on receipt to `telemetry_metrics` on both the gRPC and HTTP legs.
- **Logs** (external OTLP): Persisted on receipt to `telemetry_logs` on both the gRPC and HTTP legs.

Fredo also collects its own internal metrics and structured logs from the Rust backend via the `tracing` crate ecosystem. All `info!`, `warn!`, `error!`, `debug!`, and `trace!` macros in the Rust backend are captured by a `LogBridgeLayer` and persisted to the `telemetry_logs` table. Internal metrics (span count, events received, active sessions, span duration) are collected by `MetricCollector` and persisted to `telemetry_metrics`. Log level and enable/disable are configurable in Settings → Telemetry.

### Why are my chat spans not showing up individually?

`chat` child spans are cached and their content is attached to the parent `invoke_agent` row. This prevents the graph from being flooded with individual chat events. The full chat content is visible in the Mission Monitor's chat node / detail panel for the parent.

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

The `comm` module (`infrastructure/comm/`) holds the canonical wire types and the single IPC emitter. Since the RTDB row pipeline became the only delivery path it is deliberately small:

- **`FredoEvent`** — the CLI wire format (`fredo emit`) and classifier input: id, eventType, state, provider, transport, sessionId, correlationId, toolName, payload, error, metadata, timestamp. Serialized as camelCase. It is the CLI wire format and classifier input — it never crosses IPC to the webview.
- **`EventBus`** — emits RTDB `RowDeliveryBatch` envelopes on the `"fredo-stream-event"` Tauri IPC channel via `emit_row_delivery_batch`.
- **`CommAdapter`** trait — implemented by `InternalAdapter` (the `fredo emit` enrichment).

Only `RowDelivery`/`RowDeliveryBatch` envelopes cross IPC; raw `FredoEvent` never does.

### What is the RTDB row pipeline?

The production event pipeline (`infrastructure/rtdb/`):

- **`ingest.rs`** — the IngestClassifier maps every OTLP span / CLI event onto canonical row upserts unconditionally (this is what makes replay work). Owns the correlation maps and the parent-child relationship registry.
- **`attrs.rs`** — the single shared implementation of the GenAI-attribute extract helpers used by both the live classifier and the canonical backfill.
- **`store.rs` / `cache.rs`** — SQLite-authoritative rows (`chat_rows` / `tool_use_rows` / `agent_session_rows`) behind an LRU cache + write-behind queue.
- **`flush.rs`** — coalescing windows, batch chunking, and per-query replay-complete settle markers.
- **`query/`** — the GraphQL-inspired typed query language, e.g. `chat(sessionId = "s1") { userMessage }`.

### What is the Event Flow?

```
Agent (OTLP) → OTLP receivers (raw persist on receipt) → IngestClassifier → RowUpserts
             → Rtdb (merge → durable seq → subscriptions) → FlushLoop → EventBus
             → Tauri IPC "fredo-stream-event" (RowDeliveryBatch) → TauriAdapter
             → AppProvider → StreamContext row store → useEventRows(eventType, args) → features

fredo emit → named pipe → CliCommand::EmitEvent → InternalAdapter → classifier → same rows
```

### What is `FredoFeatureClass`?

The TypeScript abstract base class every grid-based UI feature extends. It declares the feature's `id`, `name`, `icon`, `showable` flag, and `render()` method. Features read live agent activity by subscribing to the RTDB row store with `useEventRows(eventType, args, options)`. Optional properties: `isMultiWindow`, `hasSettings`/`renderSettings()`, `gridConfig`, lifecycle hooks `onMount()`/`onUnmount()`.

### What is `featureRegistry`?

A global `Map<string, FredoFeatureClass>` populated at app startup via side-effect imports in `allFeatures.ts`. It mirrors Rust's `AppRuntime` — the explicit list of everything the app knows about.

### What is `StreamContext`?

StreamContext carries the Tauri IPC connection flag plus the module-scoped RTDB row store. It is the single source of truth for feature data. Row deliveries are applied with these semantics:

- **`insert`** — full-row set with spread-merge so init-time fields survive
- **`update`** — `{ ...row, ...patch }` with seq-guarded stale-patch drops
- **`remove`** — delete key (only ever retention eviction)

The row store is module-scoped, so it survives feature mount/unmount cycles. Features never poll the backend — they derive display state off the row-store `epoch`. Raw `FredoEvent` never crosses IPC to the frontend.

### What is `useEventRows`?

The typed row-subscription hook: `useEventRows(eventType, args, options)` subscribes one typed RTDB query (`'Chat' | 'ToolUse' | 'AgentSession'` root, typed-column args). It returns:

- **`rows`** — the typed partition map
- **`epoch`** — a monotonic counter that advances only on real mutations
- **`ready`** — resolves on the backend's per-query replay-complete settle marker, never on subscribe resolution alone
- **`error`**

`options.replay: true` restores the persisted snapshot as full-row inserts before live patches flow.

### What is the `HostAdapter`?

An interface that abstracts the transport between the UI and its host environment. `TauriAdapter` uses `@tauri-apps/api`; `DevAdapter` uses an in-memory emitter. No feature code ever imports `@tauri-apps/api` directly — only `TauriAdapter.ts` is allowed to.

### What does `correlationId` do?

It ties related rows together within a session (e.g. an `Init` event that started a tool call to its `Response`). Feature ownership of a task dispatch derives from the correlationId's session prefix.

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

Local development builds produce installers for the host OS. **Officially released installers are Windows-only**: the gated `release/stable` pipeline (see [release-process.md](release-process.md)) builds the Windows NSIS `.exe` installer and publishes it to a **draft** GitHub Release, which the maintainer must review and publish. See `docs/SETUP.md` for the artifact locations.

### How is the `fredo` CLI installed?

The Windows NSIS installer (`nsis/installer-hooks.nsh`) adds the `fredo` binary directory to the system `PATH`. The release pipeline ships the Windows installer to a draft GitHub Release.

### What does `fredo` do when no desktop app is running?

CLI mode prints a connection-refused error and exits non-zero. The IPC socket only exists while the GUI is running.
