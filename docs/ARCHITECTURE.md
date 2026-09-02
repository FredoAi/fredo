# Fredo — Architecture Overview

## What Fredo Is

Fredo is a **cross-platform desktop application** for working with AI coding agents. Built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend), it ingests agent telemetry and lifecycle events, normalizes them into canonical objects, and renders them as reactive UI features in real time.

Agents integrate through two paths:

1. **OpenCode OTLP plugin** — the `fredo-opencode-plugin` exports OTLP metrics, logs, and traces directly to the gRPC receiver (`:4317`) using the OpenTelemetry SDK
2. **OTLP receivers** — native gRPC/HTTP collectors that ingest OpenTelemetry spans from OpenCode and compatible tools

OTLP telemetry is persisted **raw on receipt** (spans, metrics, and logs — no span dropped, Spec #2449) and then classified by the **RTDB ingest classifier** into typed SQLite rows (`chat_rows` / `tool_use_rows` / `agent_session_rows`) that stream to the frontend as row deliveries over the `"fredo-stream-event"` IPC channel (Spec #2788 — the RTDB is the ONLY delivery path; the v1 contract-engine pipeline was deleted in P5.1). The React UI reacts in real time — no polling.

---

## Design Philosophy

### Feature-Based Autonomy

Both the Rust backend and the React UI are organized around **autonomous feature modules**. Each feature owns its entire vertical slice — models, business logic, state, and presentation. No feature reaches into another feature's internals. Shared platform services (communication layer, storage, IPC, OTLP) live in `infrastructure/` (Rust) or `shared/` (TypeScript) and are consumed by features, never owned by them.

### Reactive UI — Rows, Not Polls

The UI does not call the backend to ask for data. Instead, it **subscribes to a typed row query** via `useEventRows(eventType, args, options)` and reacts. The backend registers the subscription, drains the persisted snapshot as full-row `insert` envelopes (the replay leg, terminated by a per-query `replayCompleteQueryId` settle marker), and streams live patches (`insert`/`update`/`remove`) as they land. Features derive their display state from the module-scoped row store — Spec #2788 P4.1.

### Agent Alignment

Fredo accepts events from two sources. Hook/CLI input is unified into the canonical `FredoEvent` wire format (the `fredo emit` CLI contract and classifier input); OTLP input flows straight into the raw-span store and the row classifier. Both converge on the same RTDB row store:

| Source | Mechanism | Transport |
|--------|-----------|-----------|
| OpenCode OTLP plugin | `fredo-opencode-plugin` exports OTLP directly to `127.0.0.1:4317` | `OtlpGrpc` |
| OTLP gRPC | `127.0.0.1:4317` (OpenCode spans) | `OtlpGrpc` |
| OTLP HTTP | `127.0.0.1:4318` (OpenCode spans) | `OtlpHttp` |
| `fredo emit` CLI | Named-pipe `CliCommand::EmitEvent` → `InternalAdapter` enrich → row classifier | `Hook` |

---

## Communication Layer (`infrastructure/comm/`)

The `comm` module holds the canonical wire types and the single IPC emitter. Since Spec #2788 P5.1 it is deliberately small — the v1 contract engine (ECE), the OpenCode/Hook adapter, and the OTLP→ECE adapter were deleted; the RTDB row pipeline (`infrastructure/rtdb/`) is the only delivery path.

### Core Types

- **`FredoEvent`** — the `fredo emit` CLI wire format and classifier input: `id`, `eventType` (ToolUse | AgentSession | Chat | Infrastructure | Ui | Custom), `state` (Init | Update | Response | Error), `provider` (OpenCode | ClaudeCode | Internal), `transport` (Hook | OtlpGrpc | OtlpHttp | WebSocket | HttpPost | Internal), `sessionId`, `correlationId`, `toolName`, `payload`, `error`, `metadata`, `timestamp`. Serialized as camelCase. **Demoted, not deleted** (P5.1): FredoEvent no longer crosses IPC to the webview.
- **`EventBus`** — emits RTDB `RowDeliveryBatch` envelopes on the `"fredo-stream-event"` Tauri IPC channel via `emit_row_delivery_batch` (the ONLY sanctioned RTDB emission path). Registered as Tauri state in `lib.rs`.
- **`CommAdapter`** trait — retained and implemented by `InternalAdapter` (the `fredo emit` enrichment).

### Adapters

```
infrastructure/comm/adapters/
├── internal.rs            — InternalAdapter: enriches CLI events with server-side defaults
├── parent_prompt_cache.rs — bounded parent-prompt cache helpers (shared with the row classifier)
```

The pure GenAI-attribute extraction helpers the v1 OTLP adapter carried (registry constants, `resolve_op_name`, `otlp_attrs_to_map`, `otlp_attrs_to_payload`, `extract_messages_text`, `req_11_event_state_from_span`, `is_subagent_span`, `TurnTokenDerivation`) were **relocated verbatim to `infrastructure/rtdb/attrs.rs`** — one shared extract-rule implementation for the live classifier and the canonical backfill (NFR-6).

---

## Event Flow

```
┌─────────────────────────────────────────────────────────┐
│                    Event Sources                         │
│                                                          │
│  OTLP gRPC    ──→ :4317 ──→ protobuf parse              │
│  OTLP HTTP    ──→ :4318 ──→ JSON/protobuf parse         │
│  fredo emit   ──→ IPC Socket ──→ CliCommand dispatch     │
└───────────────┬──────────────────────────┬──────────────┘
                │                          │
                ▼                          ▼
   Raw ingestion on receipt      RTDB ingest classifier
   (otlp/raw.rs →                (rtdb/ingest.rs — shared
   telemetry_spans/metrics/      helpers in rtdb/attrs.rs;
   logs; zero dropped,           correlation maps + relationship
   independent of delivery)      registry re-keying)
                │                          │
                │                          ▼
                │                  Vec<RowUpsert> → Rtdb
                │                  (merge rules → durable seq
                │                   → subscriptions)
                │                          │
                │              FlushLoop (~5 ms cadence)
                │                          │
                │        EventBus.emit_row_delivery_batch()
                │                          │
                │    app_handle.emit("fredo-stream-event", RowDeliveryBatch)
                │                          │
                ▼                          ▼
                        Webview — TauriAdapter.onMessage()
                                   │
                        AppProvider (isRowDeliveryBatch /
                        isRowDelivery discrimination)
                                   │
                  StreamContext row store (module-scoped,
                  spread-merge + seq guards + epoch bumps)
                                   │
                        useEventRows(eventType, args)
                                   │
                           feature UI re-render
```

When the user interacts with the UI directly (e.g. clicking a button), the flow uses `adapterBridge.invoke(command, args)` → Tauri IPC command → Rust feature handler; the resulting rows flow back through the same subscription path.

Only `RowDelivery`/`RowDeliveryBatch` envelopes cross IPC — raw `FredoEvent` never does (it is the CLI wire format only). The **ingest classifier** (`rtdb/ingest.rs`) maps every span/event onto canonical row upserts unconditionally, never gated by subscriptions (R-4a) — that is what makes replay work. Merge rules (KeepFirst / LastNonZero / LastWins, `rtdb/merge.rs`) keep init-time data intact across patches; the per-key durable `seq` (`rtdb/store.rs`) guards against stale patches. `telemetry_spans` is never touched by RTDB code (`rtdb/store.rs` asserts the invariant).

### Replay + Live Boundary (P2.3, F-33 fix)

`subscribe_events` is an async command: it registers the live subscriptions FIRST, returns immediately, and hands the snapshot SELECT to `tauri::async_runtime::spawn_blocking` — the replay leg is a background drain (NFR-1). The drain's final ≤512-row chunk of each query carries the per-query `replayCompleteQueryId` settle marker (an empty terminal envelope when nothing remained pending); `useEventRows.ready` resolves on the marker, never on subscribe resolution alone. Batches are chunked at `RTDB_MAX_EMISSION_BATCH = 512` rows per IPC envelope. `flushMs: 0` bypasses coalescing and emits one envelope per patch (AC1-c timing).

### Known limitation (E-2788-r3-1)

With Mission Monitor open on a very large corpus (~42k rows), sustained live agent traffic re-triggers per-batch derivations in the renderer and can intermittently saturate the webview (DOM/console probes time out during bursts; quick evals slip through). The main thread and backend stay healthy throughout, all drains recover, and the coalescing guarantees one envelope per drained chunk — this is webview-side row application under dense live traffic, documented as a known limitation for a possible post-spec follow-up.

### Parent-Child Compositing — Cross-Session Merging (Specs #523/#2768, row-native in #2788)

Parent-child session merging happens in the **ingest classifier's relationship registry** (row pipeline), not in any adapter. Registration sources (ported from the ECE, `rtdb/ingest.rs`): the OTel span-link `parent.session_id` attribute (primary) and the `session.parent_id` attribute (fallback), with the internal `build`/`plan` tool-execution-agent exclusion (AGENTS.md #509 rule) applied at registration.

- **`child_to_parent` / `parent_to_children`** maps (capped at 10,000 entries, oldest-first eviction) mirror the deleted ECE registry.
- When a child→parent relationship registers, the child's EXISTING rows are COPIED under the parent key (session_id = parent, correlation_id = the child's own per-turn id) carrying the `parent_session_id` + `composited_child_session_id` stamps; every LATER child row also gets a parent-keyed copy while the relationship is registered. **`kind: remove` is ONLY ever emitted for retention eviction — a re-key NEVER removes rows.**

**Join rule (Spec #2768 round 2; revised #2770 round 6, restated for rows):** consumers that join child activity must NEVER key by the re-keyed composite key — keying by the composite key orphans every child tool call (the round-1 `⚠ N unattributed` chip defect). **Ownership derivation:** a row can be re-keyed MORE THAN ONCE (multi-hop delegation chains), so ownership of a task dispatch derives PRIMARILY from the correlationId's session prefix (`<sessionId>_<counter>` — every real OTLP corrId carries it), using `compositedChildSessionId` ONLY as the guarded fallback for non-prefixed (legacy/mock) corrIds. The classifier preserves the FIRST `compositedChildSessionId` stamp across re-keys (first-wins — the event's true owner).

---

## RTDB Row Store (Spec #2788)

SQLite-authoritative typed rows behind an LRU cache — the production event pipeline.

### Row types + queries

Three canonical tables in `fredo.db` — `chat_rows`, `tool_use_rows`, `agent_session_rows` — one row per composite key `(session_id, correlation_id)` with a durable per-key monotonic `seq`. The **RTDB query language** (`rtdb/query.rs`) is GraphQL-inspired: `chat(sessionId = "s1") { userMessage, promptTokens }` — typed root per row type, typed-column args with SQL pushdown, hard-named validation errors (typos and type mismatches are rejected, never silently empty). `subscribe_events`/`unsubscribe_events` register/unregister queries; every query gets a unique `queryId`.

### Retained machinery (do NOT remove)

- **`kind: remove` retention-eviction deliveries** (R-2d) — the ONLY remove producer: retention prune routes removals to matching subscribers.
- **`rtdb.backfill.completed` marker** (`rtdb/backfill.rs`) — one-shot canonical backfill of pre-cutover history from `telemetry_spans` (strictly READ-ONLY) through the SAME classifier; idempotent re-merges skip the write.
- **`ready` + `replayCompleteQueryId` settle** (`useEventRows.ts`, `EventSubscription.ts`, `StreamContext.tsx`) — the deterministic replay-settle contract.
- **Drain registry + background replay drain** (`rtdb/commands.rs`) — register-before-snapshot, no gap, no lost update.
- **Retention knobs** (`rtdb/cache.rs`) — AppStore KV keys (`rtdb.retention_days` / `rtdb.max_rows`), startup prune + writer-task re-prune.
- **`emit_row_delivery_batch`** (`comm/bus.rs`) — the ONLY sanctioned RTDB emission path.

### Bounded state (NFR-2)

Classifier correlation/relationship maps capped at 10,000 entries (oldest-first eviction, `MAP_CAPACITY`); emission batches chunked at `RTDB_MAX_EMISSION_BATCH = 512`; the FE row-mutation debug log capped at 512 entries with oldest-first eviction.

---

## Rust Backend — Feature Modules

```
src-tauri/src/
+-- main.rs                     — dual-mode entry point (GUI vs CLI)
+-- lib.rs                      — AppRuntime composition root; registers EventBus, commands, state
+-- runtime/
|   +-- mod.rs                  — AppRuntime struct
|   +-- capability.rs           — DesktopCapable, CliCapable traits
+-- features/
|   +-- terminal/               — PTY-based AI CLI terminal
|   |   +-- mod.rs              — TerminalFeature (DesktopCapable)
|   |   +-- state.rs            — RunCliState (PTY writer, buffer, killer)
|   |   +-- commands.rs         — open_run_cli, get_pty_buffer, write_pty_input, resize_pty, close_run_cli
|   +-- llm/                    — In-process llama.cpp inference
|   |   +-- mod.rs              — LlmFeature (DesktopCapable)
|   |   +-- engine.rs           — LlmEngine (direct llama.cpp bindings via llama-cpp-2)
|   |   +-- service.rs          — LlmService (async chat, chat_with_image)
|   |   +-- state.rs            — LlmState + LlmLoadingState
|   |   +-- commands.rs         — llm_chat, llm_chat_with_image
|   +-- settings/               — Persistent KV settings (SQLite)
|   |   +-- mod.rs              — SettingsFeature
|   |   +-- commands.rs         — save_setting, get_setting
|   +-- setup/                  — CLI detection, PATH management, OTel config, model download
|   |   +-- mod.rs              — SetupFeature
|   |   +-- commands.rs         — check_cli_installations, install_plugin, check_fredo_in_path, add_fredo_to_path, check_otel_configured, configure_otel, get_setup_plan, check_all_setup, run_setup_step, check_model_files, download_model
|   +-- screenshot/             — Screen capture (xcap)
|       +-- mod.rs              — ScreenshotFeature
|       +-- commands.rs         — capture_screen_region
|   +-- telemetry/              — Telemetry Tauri commands
|       +-- mod.rs              — TelemetryFeature (DesktopCapable)
|       +-- commands.rs         — telemetry_get_stats, telemetry_purge, telemetry_toggle, telemetry_metrics_toggle, telemetry_logging_toggle, telemetry_logging_set_level
+-- infrastructure/
    +-- comm/                   — Canonical wire types + the single IPC emitter
    |   +-- mod.rs              — re-exports: FredoEvent, EventBus, CommAdapter, InternalAdapter
    |   +-- event.rs            — FredoEvent (CLI wire format), EventType, EventProvider, Transport, EventState
    |   +-- bus.rs              — EventBus (emit_row_delivery_batch — the ONLY RTDB emission path)
    |   +-- adapter.rs          — CommAdapter trait
    |   +-- adapters/
    |       +-- mod.rs
    |       +-- internal.rs     — InternalAdapter (fredo emit enrichment)
    |       +-- parent_prompt_cache.rs — bounded parent-prompt cache helpers
    +-- rtdb/                   — RTDB row store (Spec #2788) — the production event pipeline
    |   +-- attrs.rs            — pure GenAI-attribute helpers + registry constants (relocated from the deleted v1 adapter)
    |   +-- rows.rs             — ChatRow / ToolUseRow / AgentSessionRow + field tables
    |   +-- merge.rs            — KeepFirst / LastNonZero / LastWins merge rules
    |   +-- store.rs            — RtdbStore (SQLite; never touches telemetry_spans)
    |   +-- cache.rs            — LRU row cache + write-behind queue + retention knobs
    |   +-- project.rs          — RowDelivery / RowDeliveryBatch projection
    |   +-- query/              — the RTDB query language (parse + schema validation)
    |   +-- subscriptions.rs    — SubscriptionRegistry
    |   +-- flush.rs            — FlushLoop (coalescing windows, 512-row chunking, replay settle markers)
    |   +-- commands.rs         — Rtdb orchestrator + subscribe_events/unsubscribe_events
    |   +-- ingest.rs           — IngestClassifier (spans/events → row upserts; relationship registry)
    |   +-- backfill.rs         — canonical backfill from telemetry_spans (read-only)
    +-- storage/
    |   +-- mod.rs              — AppStore (SQLite KV store) + FeatureStore
    |   +-- feature_store.rs    — FeatureStore (typed feature-level SQLite)
    |   +-- span_store.rs       — SpanStore (telemetry span persistence)
    +-- telemetry/              — Telemetry tracing + metrics + logging (Spec #396 + #407 + #408)
    |   +-- mod.rs              — SpanCollector + SpanBuffer
    |   +-- metrics_collector.rs — MetricCollector
    |   +-- log.rs              — LogCollector + LogBuffer + LogBridgeLayer
    +-- ipc.rs                  — local socket server + CliCommand dispatch
    +-- cli/                    — clap CLI parser
    |   +-- mod.rs              — Cli root; run() + build_ipc_command()
    |   +-- commands/
    |       +-- mod.rs
    |       +-- emit.rs         — emit event command
    |       +-- setup.rs        — setup subcommand
    +-- otlp/                   — OTLP receivers
        +-- mod.rs              — OtlpState (trace→session correlation)
        +-- ingest.rs           — raw span/metric/log → telemetry_* mapping, persisted on receipt
        +-- raw.rs              — raw OTLP persistence helpers (SpanStore::insert_raw_spans)
        +-- grpc.rs             — gRPC receiver (:4317)
        +-- http.rs             — HTTP receiver (:4318)
+-- utils/
    +-- mod.rs                  — utils module root
    +-- error.rs                — anyhow re-exports

```

### Capability Traits

| Trait | Meaning |
|-------|---------|
| `DesktopCapable` | Feature registers Tauri commands and manages Tauri state |
| `CliCapable` | Feature can be invoked from the `fredo` CLI |

### FeatureStore — Typed Feature-Level SQLite

The `FeatureStore` (spec #339, `infrastructure/storage/feature_store.rs`) provides a generic, typed-column SQLite database for any feature. Each feature gets namespaced tables (`feature_{featureId}_*`) with column types TEXT, INTEGER, REAL, or BLOB. Cross-feature isolation is enforced — a feature cannot access tables belonging to another feature.

**Tauri commands** (registered in `lib.rs`):
| Command | Description |
|---------|-------------|
| `feature_store_ensure_table` | Create a namespaced table with typed columns |
| `feature_store_insert` | Insert rows; returns count |
| `feature_store_query` | Query rows with optional WHERE, ORDER BY, LIMIT |
| `feature_store_update` | Update matching rows; returns count |
| `feature_store_delete` | Delete matching rows; returns count |

**Frontend client**: `shared/lib/featureStore.ts` wraps each command via `adapterBridge.invoke()`.

The FeatureStore opens its own connection (WAL mode) to the same `fredo.db` file used by `AppStore`. No cross-store data sharing is required.

**Idempotency**: `feature_store_insert` uses `INSERT OR IGNORE` (spec #369). Duplicate inserts with the same unique key silently succeed without UNIQUE constraint errors. This guarantees delivery-level idempotency when the ECE re-delivers events.

### Infrastructure vs Features

| Layer | Contains | Does NOT contain |
|-------|----------|-----------------|
| `features/` | Models, service logic, state, Tauri command handlers | Shared platform code |
| `infrastructure/` | FredoEvent (CLI wire), EventBus, CommAdapter, RTDB row store + ingest classifier, AppStore, FeatureStore, IPC socket, CLI parser, OTLP receivers | Business logic |

---

## OTLP Receivers

Fredo implements the OpenTelemetry Protocol as a **local-only collector** — no data leaves the machine.

### gRPC Receiver (`:4317`)
- Implements `TraceService`, `MetricsService`, `LogsService` via `tonic`
- Receives OTLP protobuf from OpenCode
- **Raw ingestion on receipt** (Spec #2449): every span/metric/log in each export is persisted via `otlp/raw.rs` → `SpanStore::insert_raw_spans`, before and independent of row classification — no span dropped (R1/R2). Row classification runs the RTDB ingest classifier (`rtdb/ingest.rs`) on the same export. Metrics and logs are persisted to `telemetry_metrics`/`telemetry_logs` on both legs.

### HTTP Receiver (`:4318`)
- Axum server handling `POST /v1/traces`, `/v1/metrics`, `/v1/logs`
- Accepts both protobuf (`application/x-protobuf`) and JSON (`application/json`)
- Includes `/health` diagnostic endpoint
- Same raw-ingestion-on-receipt behavior as the gRPC leg

### Trace→Session Correlation
The RTDB ingest classifier (`rtdb/ingest.rs`) maintains the correlation maps (ported from the deleted v1 adapter, same caps and eviction semantics) and processes them during OTLP span classification:

- **`trace_to_session`**: Built from `gen_ai.conversation.id` and `session.id` span attributes during span processing
- **`session_to_parent`**: Built from OTel span links (`parent.session_id` link attribute, Spec #633 REQ-6) as the primary path, with fallback to `session.parent_id` span attributes for backward compatibility (Spec #615, Spec #633 REQ-9). Supports order-independent parent-child detection regardless of OTLP batch arrival order.
- **`session_to_correlation`**: Maps session IDs to correlation IDs so `correlation_id === session_id` for pure-OTLP sessions (Spec #612), with the per-turn counter (REQ-639) and the ST9 span→correlation reuse guard

`chat` child-span content lands in the canonical chat rows; the Mission Monitor derives its graph from them.

---

## Telemetry Metrics (Spec #407)

The `telemetry` module (`infrastructure/telemetry/`) collects OpenTelemetry-compatible metrics from the **non-OTLP (CLI/Hook) event stream**, parallel to span tracing.

> **Spec #2449 (R10, no double-write):** raw OTLP telemetry is persisted **directly by the receivers on receipt** (`otlp/ingest.rs` → `SpanStore`). The OTLP feeding of `SpanCollector`/`MetricCollector` was removed from both receivers — no signal is ever written twice. The collector structs remain alive as the backing Tauri state for `telemetry_toggle`/`telemetry_metrics_toggle` and keep observing the remaining (non-OTLP) dispatch points.

### MetricCollector

Observes the non-OTLP FredoEvent stream. Derives:

| Metric | Type | Description |
|--------|------|-------------|
| `span_count` | Counter | Incremented on span completion (Response/Error), labeled with `span_name` + `status` (`ok`/`error`) |
| `events_received` | Counter | Incremented on every Init event, labeled with `event_type` + `transport` |
| `orphan_spans` | Counter | Incremented by sweep count from SpanCollector's orphan sweep |
| `active_sessions` | Gauge | Snapshot of unique active session IDs (Init state, not yet completed) at flush time |
| `span_duration_ms` | Histogram | Span duration recorded on completion, bucketed: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] ms |

### MetricCollection
The `MetricCollector` buffers aggregated metrics in-memory. Counters accumulate; histogram buckets accumulate; gauge values are snapshotted. Pre-aggregated `MetricPoint` rows are flushed to SQLite at configurable intervals (default 60s, configurable via `tracing.metrics_aggregation_s` setting). Flush writes one row per metric label combination — no per-event DB writes.

### SpanStore Extension

- **`telemetry_metrics` table**: `id`, `metric_name`, `metric_type` (counter/gauge/histogram), `labels_json`, `value`, `timestamp` (RFC3339), `aggregation_window_s`. Index on `(metric_name, timestamp)`.
- **`insert_metrics()`**: Batch-inserts pre-aggregated `MetricPoint` rows in a single transaction.
- **Retention + purge**: `delete_expired()` and `purge_all()` cover both `telemetry_spans` and `telemetry_metrics`.

### Settings

| AppStore Key | Type | Default | Description |
|-------------|------|---------|-------------|
| `tracing.enabled` | bool | `true` | Master span collection toggle (Phase 1) |
| `tracing.metrics_enabled` | bool | `true` | Metric collection toggle — cached in `AtomicBool` |
| `tracing.metrics_aggregation_s` | int | `60` | Flush interval; settable in UI (10s/30s/60s/120s/300s) |

### UI

The `TelemetrySettings` component (`apps/ui/src/features/home/components/settings/TelemetrySettings.tsx`) includes a Metrics section below the Tracing section: enable/disable Switch, aggregation window dropdown selector, and metric storage stats (point count + estimated bytes).

### Background Flush Task

A background async task in `lib.rs` runs `MetricCollector.flush_if_needed()` at a 1-second tick. The collector tracks elapsed time since last flush via `Instant` and writes only when the configured aggregation window has elapsed. On shutdown, `flush_all()` drains remaining buffered metrics before the DB connection closes.

---

## Telemetry Logging (Spec #408)

The `telemetry` module also collects structured logs from the Rust backend via the `tracing` crate ecosystem, replacing ad-hoc `eprintln!`/`println!` calls.

### LogCollector

Observes `tracing` events through a custom `LogBridgeLayer` implementing `tracing_subscriber::Layer<S>`. Converts `tracing::Event` records into `LogRecord` structs (level, target, message, attributes_json, trace_id, span_id, session_id, timestamp). Buffered in a `LogBuffer` (Mutex-protected Vec) that flushes to SQLite at 5-second intervals or when 500 records accumulate.

### LogBridgeLayer

A custom `tracing_subscriber::Layer` registered on the global `tracing_subscriber::Registry` alongside `fmt::Layer` (console). Converts `tracing` events (from `info!`, `warn!`, `error!`, `debug!`, `trace!` macros) into `LogRecord` structs and routes them to the shared `LogCollector`. Initialized in `lib.rs` before any code path that emits tracing macros — the subscriber uses `set_global_default` (one-time initialization).

### telemetry_logs Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-increment primary key |
| `timestamp` | TEXT | RFC3339 timestamp of the log event |
| `level` | TEXT | Log level: TRACE, DEBUG, INFO, WARN, ERROR |
| `target` | TEXT | Module path emitting the log |
| `message` | TEXT | Log message text |
| `attributes_json` | TEXT | Structured key=value attributes as JSON |
| `trace_id` | TEXT | Active span's trace ID (null if outside span context) |
| `span_id` | TEXT | Active span's span ID (null if outside span context) |
| `session_id` | TEXT | Session identifier (reserved for future use) |

Indexes: `idx_logs_timestamp`, `idx_logs_level`, `idx_logs_trace_id`, `idx_logs_session_id`.

### Settings

| AppStore Key | Type | Default | Description |
|-------------|------|---------|-------------|
| `tracing.logging_enabled` | bool | `true` | Master log collection toggle — cached in `AtomicBool` |
| `tracing.logging_level` | string | `INFO` | Minimum log level filter (TRACE/DEBUG/INFO/WARN/ERROR) |

### UI

The `TelemetrySettings` component includes a Logging section between Metrics and Retention: enable/disable toggle and minimum log level dropdown selector. Storage stats display includes log entry count and estimated storage bytes.

### Migration Scope

~80 `eprintln!`/`println!` calls across 16 production files replaced with appropriate `tracing` macros using structured `key=value` attributes. Test-code calls (e.g., `features/llm/engine.rs:533`) are excluded.

### Background Flush Task

A background async task in `lib.rs` runs `LogCollector.flush_if_needed()` at a 1-second tick. The collector tracks elapsed time since last flush via `Instant` and writes only when the 5-second window has elapsed or 500 records accumulate. On shutdown, `flush_all()` drains remaining buffered logs before the DB connection closes. Retention cleanup (based on `tracing.retention_days`) covers `telemetry_logs` alongside `telemetry_spans` and `telemetry_metrics`.

---

## In-Process LLM Engine

The `llm` feature runs **llama.cpp directly in-process** via vendored `llama-cpp-2` Rust bindings — no child processes, no HTTP/SSE round-trips.

### LlmEngine
- `load()` — text-only GGUF model loading
- `load_with_vision()` — multimodal loading with mmproj projector
- `generate()` — autoregressive token generation with greedy+dist sampler
- `generate_with_image()` — decodes PNG/JPEG, resizes to 448×448, creates `MtmdBitmap`, tokenizes with media markers

### Token Streaming
`LlmService.chat_async()` and `chat_with_image_async()` stream tokens via `mpsc::unbounded_channel` → `tokio::task::spawn_blocking` → Tauri `app.emit("llm-token")` / `app.emit("llm-done")`.

### Supported Models
| Model | Vision | Notes |
|-------|--------|-------|
| Gemma 4 E2B (`gemma-4-e2b`) | ✓ | Full vision support via mmproj |
| MiniCPM-V 4.6 (`minicpm-v-4-6`) | ⚠️ | Vision projector unsupported in current llama.cpp; falls back to text-only |

---

## React UI — Reactive Feature Modules

```
apps/ui/src/
+-- app/
|   +-- adapters/
|   |   +-- HostAdapter.ts          — interface: onMessage, invoke, llmChat, llmChatWithImage
|   |   +-- TauriAdapter.ts         — @tauri-apps/api via dynamic imports
|   |   +-- DevAdapter.ts           — in-memory emitter + mock LLM
|   +-- providers/
|       +-- AppProvider.tsx         — wires adapter → StreamContext; registers adapterBridge
+-- features/
|   +-- featureRegistry.ts          — global feature registry (mirrors AppRuntime)
|   +-- allFeatures.ts              — Vite glob auto-discovery: `import.meta.glob('./*/index.ts', { eager: true })`
|   +-- home/                       — Home panel + AlertHandler + FredoCompanion
|   +-- diagram/                    — Infrastructure diagram (ReactFlow)
|   +-- run-cli/                    — xterm.js terminal (PTY output)
|   +-- query-viewer/               — SQL query result display (multi-instance)
|   +-- my-workitems/               — Azure DevOps work items
|   +-- settings/                   — Settings panel + ModelSelector
|   +-- setup/                      — SetupWizard (OTel config, CLI detection)
|   +-- mission-monitor/            — Real-time agent activity graph
|   +-- dev-mode/                   — Dev tools + OTLP inspector
|   +-- browser-preview/            — Web page preview panel
|   +-- docs-viewer/                — Documentation viewer
|   +-- github-viewer/              — GitHub repository browser
|   +-- optimizely/                 — Feature flag management
|   +-- theming/                    — Theme customization
|   +-- model-storage/              — Model file management
+-- shared/
    +-- contexts/StreamContext.tsx  — connection status + the module-scoped RTDB row store
    +-- hooks/useEventRows.ts       — the typed row-subscription hook (replay + live patches)
    +-- classes/
    |   +-- FredoFeatureClass.ts    — abstract base class for grid features
    |   +-- EventSubscription.ts    — RTDB row wire types (RowDelivery / RowDeliveryBatch)
    |   +-- types.ts                — GridItemConfig
    +-- utils/adapterBridge.ts      — non-React singleton for feature → invoke()
    +-- components/
        +-- companion/
            +-- FredoCompanion.tsx  — Animated sprite + LLM companion
            +-- SpeechBubble.tsx    — Positionable bubble with game slot
            +-- features/
                +-- tictactoe/      — Tic-Tac-Toe game (vision-based AI)
```

### Active UI Features

| Feature | showable | Data source | Description |
|---------|----------|-------------|-------------|
| home | ✓ | — | Navigation grid, FredoCompanion |
| diagram | ✓ | — | Infrastructure visualization (ReactFlow; REST snapshot) |
| run-cli | ✓ | — | xterm.js terminal (PTY output from Rust) |
| query-viewer | ✓ | (dynamic) | SQL query result display (multi-instance) |
| my-workitems | ✓ | — | Azure DevOps work items |
| settings | ✓ | — | App settings + model selection |
| setup | ✗ | — | OTel configuration, CLI detection |
| mission-monitor | ✓ | RTDB Chat/ToolUse rows | Row-driven agent activity graph (ReactFlow; height-aware chat chain, recursive per-subagent delegation tree with per-subagent tool ownership) |
| dev-mode | ✗ | RTDB row-mutation log | Dev tools + live row-mutation inspector |
| browser-preview | ✓ | — | Web page preview panel |
| docs-viewer | ✓ | — | Documentation viewer |
| github-viewer | ✓ | — | GitHub repository browser |
| optimizely | ✓ | — | Optimizely feature flag management |
| theming | ✗ | — | Theme customization (hidden from grid) |
| model-storage | ✓ | — | Model file management |

### FredoFeatureClass

Every UI feature extends `FredoFeatureClass`:

```typescript
abstract class FredoFeatureClass<TProps = {}> {
  // Required
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly icon: IconType;
  abstract render(props?: TProps): ReactElement;

  // Optional
  readonly gridConfig: GridItemConfig;   // { closable, maximizable }
  readonly showable: boolean = true;
  readonly isMultiWindow: boolean = false;
  readonly hasSettings: boolean = false;
  renderSettings?(): ReactElement;

  // Lifecycle hooks
  onMount?(): void | Promise<void>;
  onUnmount?(): void | Promise<void>;
}
```

### Row Subscriptions (Spec #2788)

Features read live agent activity through the **RTDB row store** — a GraphQL-inspired typed query system over the canonical rows:

- **`useEventRows(eventType, args, options)`** (`shared/hooks/useEventRows.ts`) — subscribes one typed row query (`'Chat' | 'ToolUse' | 'AgentSession'` root, typed-column args with SQL pushdown). Returns `rows` (the partition map), a monotonic `epoch` (advances only on real mutations — memo/effect off the primitive, never on map identity), `ready` (resolves on the backend's per-query `replayCompleteQueryId` settle marker, never on subscribe resolution alone), and `error`. `options.replay: true` restores the persisted snapshot as full-row inserts before live patches flow.
- **Merge semantics** (module-scoped store, `StreamContext.tsx`): `insert` = full-row set with spread-merge so init-time fields are never wiped; `update` = `{ ...row, ...patch }` with seq-guarded stale-patch drops; `remove` = delete key (only ever retention eviction). No TTL, no cap on live rows — replay replaces hydration.
- **Consumer-side filtering**: the backend filters per-query by the declared args, but the partition map is shared per event type — arg-scoped consumers filter their own rows client-side (epoch-keyed memo), the documented extraction pattern (`stepper-probe`).
- **Row subscriptions** — features consume typed RTDB rows via `useEventRows` (the only feature-facing data contract; the v1 contract machinery was deleted in Spec #2788 P5.1).

### StreamContext — connection status + the row store

`StreamContext` carries only the Tauri IPC connection flag; the RTDB row store is module-scoped (survives feature mount/unmount cycles per the AGENTS.md persistence rule). Row deliveries routed by AppProvider are applied with the semantics above; a bounded (512-entry) row-mutation log feeds the debug surfaces (Dev Mode's live stream viewer, StreamStatus's activity LED).

### FredoEvent Shape

```typescript
interface FredoEvent {
  id: string;
  eventType: 'ToolUse' | 'AgentSession' | 'Chat' | 'Infrastructure' | 'Ui' | 'Custom';
  state: 'Init' | 'Update' | 'Response' | 'Error';
  provider: 'opencode' | 'claudeCode' | 'internal';
  transport: 'hook' | 'otlpGrpc' | 'otlpHttp' | 'webSocket' | 'httpPost' | 'internal';
  sessionId: string;
  correlationId?: string;
  toolName?: string;
  payload?: any;
  error?: { message: string; code?: string; details?: any };
  metadata?: any;
  timestamp: string;
}
```

### HostAdapter — Swappable Transport

```
HostAdapter (interface)
├── TauriAdapter   → @tauri-apps/api via dynamic imports  [production]
└── DevAdapter     → in-memory emitter + mock LLM         [Vite dev server]

Methods: onMessage(), invoke(), llmChat(), llmChatWithImage()
```

The `adapterBridge` singleton allows non-React code (e.g. `FredoFeatureClass` methods) to call `invoke()`, `llmChat()`, and `llmChatWithImage()`.

---

## FredoCompanion

The animated companion sprite on the Home panel:

- **Spritesheet**: 6-col × 4-row at 80×80px per frame
- **States**: idle (loop), talk (loop), teleport-out (one-shot), teleport-in (one-shot)
- **Personality**: "friendly robot who loves programming, tells jokes, plays Tic-Tac-Toe"
- **Jokes**: 20 topics (recursion, git, CSS, regex, etc.)
- **Streaming**: Token-by-token accumulation with `<end_of_turn>`/`<start_of_turn>` stripping
- **Cross-window teleport**: Tauri global `companion-teleport` events broadcast to all webview windows
- **Interaction**: Single-click → joke; double-click → Tic-Tac-Toe; Ctrl+right-click → teleport

### Tic-Tac-Toe
- Player = X, Companion = O
- **Vision-based AI**: screenshot of board → `capture_screen_region` → LLM vision prompt → parse digit 0-8
- **Fallback**: first empty cell on error/invalid response
- Embedded in `SpeechBubble` component (208×268px fixed dimensions)

---

## Mission Monitor

The row-driven agent activity graph (ReactFlow). Since Spec #2788 P4.2/P5.1, Mission Monitor derives its entire graph from typed RTDB rows — no v1 deliveries exist anywhere.

- **Data source**: `useEventRows('Chat', {}, { replay: true })` + `useEventRows('ToolUse', ...)` — the module-scoped row store (replay restores the full persisted snapshot as full-row inserts, settled by the per-query `replayCompleteQueryId` marker; live patches continue on the same path). `ready` (settle-gated) parks the sidebar's loading state until the snapshot drain completes.
- **Graph builder**: `useMissionMonitor()` → `lib/rowDerivation.ts` — derives ReactFlow nodes/edges from ALL typed chat/tool rows (cross-session, not filtered by sessionId) so the selected session's chat chain is complete. `insert` creates nodes, `update` merges metadata (spread-merge; init-time data survives), `end`-state rows set final status. Since Spec #2745, `task` dispatches split out of the tool-association path into SubagentNode state (keyed by task correlationId, gated by the `build`/`plan` internal-agent exclusion) — the SubagentNode is the dispatch's sole representation. **Embedded chat tools (Spec #2764)**: resolved non-task tool calls attach to the anchor chat node's payload (`AgentNodePayload.tools`, deterministically `byStartTimeThenCorrId`-ordered, payload reference replaced only on content change) instead of creating a companion node; the standalone ToolsNode class was deleted with no stub. **Transitional-turn suppression (Spec #2750)**: completed chat nodes with an empty `agentReply` (a transitional tool-call turn) are suppressed at EMISSION (builder state kept intact, NFR-5) and the chat chain, SubagentNode edges, and companion-column layout re-anchor to the nearest visible chat node. `agentThinking` is never rendered as the RESPONSE body (loading dots/`—` instead).
- **Node types**: Agent (Chat) and SubagentNode (Spec #2745 — revived, driven from the parent's `task` row + the classifier's parent-child compositing stamps, NOT from subagent chat rows). The standalone ToolsNode was removed by Spec #2764: `ToolsNode.tsx` deleted, `tools` removed from `GraphNodeType`/`GraphEdgeType`, `ToolsNodePayload` gone, `NODE_TYPES.toolsNode` registration removed, ChatNode's tools-only `source-right` handle removed — chat tool calls now render inside the chat node as an embedded `── TOOLS (N) ──` accordion (SubagentNode's #2762 pattern: `nowheel` box, uncontrolled Accordion, shared `ToolCallAccordionItem` extracted to its own module), hidden entirely when the chat has no tool calls (Spec #2766: the embedded section renders in the subagent-consistent reading order USER → (THINKING) → TOOLS → RESPONSE — the conditional TOOLS block moved before RESPONSE, with the divider riding the conditional so a no-tool chat renders no orphaned divider — mirroring SubagentNode's instructions → tools → output). The dead ToolNode/FileNode machinery was deleted in Spec #2745: `ToolNode.tsx`, `FileNode.tsx`, `BaseMonitorNode.tsx` removed, `toolNodes`/`fileNodes` state and builder branches gone, `tool`/`file` `GraphNodeType` variants + payload interfaces removed, `GRAPH_NODE_BORDER_COLORS` tool/file entries removed.
- **Tool call details (Spec #2764)**: double-clicking ANY part of an embedded tool accordion item — collapsed trigger OR expanded info content — opens the scoped tool-call detail view (`DetailOpenTarget { kind: 'tool-call' }` → `ToolCallDetailView`: Status/Duration/Input/Output) via `stopPropagation` on the whole `Accordion.Item`, so ReactFlow's `onNodeDoubleClick` never selects/navigates the parent chat node. Single-click still toggles only the item's expansion. Missing call details degrade to safe absent-states (`—` Input/Output rows, "No call details were captured for this tool call." hint, Unknown-tool header fallback). The same shared-component fix applies identically to subagent-embedded tools.
- **Recursive delegation tree (Spec #2762)**: tool ownership and nesting extend to every depth of the delegation chain. Tools a subagent invoked attach to THAT subagent's own embedded tools section (never the root chat node) — the child session's tool spans are owned by the subagent, and when parent and subagent invoke the same tool name each occurrence renders under its own invoker. Nesting is recursive: a subagent's own `task` dispatches render sub-subagent SubagentNodes, producing readable multi-level chains (chat → subagent → sub-subagent). The OTLP adapter propagates the `parentSessionId` relationship for child-session tool spans so the `build`/`plan` internal-agent exclusion and per-subagent ownership hold at every depth (internal tool-execution sessions never render as SubagentNodes; only real `task` children do). The Chain layout extends its companion-column arithmetic to nested levels (`layout.ts`), and the SQLite persistence layer restores full nested trees across app restart.
- **SubagentNode payload extraction** (Spec #2745 ST-4/ST-5): the node displays subagent identity from the `task` delivery payload + ECE relationship metadata — canonical keys projected by the OTLP adapter from the plugin's child-completion flat attrs on the parent task span: `childSessionId` (`child_session_id`), `childAgent` (`child_agent`), `childTokens` (`child_total_tokens`), `childCost` (`child_total_cost_usd`), `childMessages` (`child_total_messages`), plus the per-family token breakdown `childInputTokens`/`childCacheReadTokens`/`childReasoningTokens`/`childOutputTokens`. The five-way Token Usage row (INPUT/CACHE/REASONING/OUTPUT/TOTAL) mirrors the chat-node display; TOTAL = sum of the four families when the breakdown is present, else falls back to aggregate `childTokens`. Instruction/output text extraction follows the lifecycle-aware priorities (instruction preserved from INIT across UPDATE/END merges).
- **Edge types**: a `calls` edge connects each SubagentNode to its parent ChatNode (`EDGE_STYLES.calls`). The SubagentNode companion column renders RIGHT of the chat chain (Spec #2766 mirrored Spec #2745's original LEFT-side grammar into the slot Spec #2764 freed when the standalone tools column was removed: `SUBAGENT_CHAIN_X = +564`, lanes step further rightward per nesting level; the edge/handle contract flipped in lockstep — parent `source-right` → child `target-left`, ChatNode's dead `source-left` handle removed). No Tool→File `reads`/`writes` edges — the non-chat tool/file node classes were removed in Spec #2745.
- **Detail Panel**: Slide-in panel on node click, shows type/ID/token counts/timestamps/duration plus an Estimated Cost row for node targets (Spec #2750 — the panel's cost row reads the same `payload.costUsd` as the node's own cost row, byte-identical `$X.XXXX` formatting, absent-state `—` preserved; SubagentNodes already carry their per-node cost under Child Usage). No node-level status badge or Status row renders for node targets since Spec #2750 (the per-tool success/error outcome indicators inside a tool call remain). Hides on background click or Escape. Since Spec #2723, Start/End are read from telemetry-derived payload fields (`startTime`/`endTime`, RFC3339 UTC injected by the adapter from the span's `startTimeUnixNano`/`endTimeUnixNano`) with delivery-timestamp fallback for spans lacking an end — displayed via `toLocaleTimeString()` (display format unchanged).
- **Session token bar** (Spec #2717, moved to top by Spec #2723; header strip removed by Spec #2748): a compact flex strip at the TOP of the Mission Monitor main view — the **first (top) row of the panel**, above the canvas (never an overlay, `flex-shrink: 0` sibling) — shows the **selected session's** token usage as six figures — `In:`/`Ca:`/`Re:`/`Ou:` parent-only, plus `SUBAGENTS` (Σ of the session's subagent token totals from the parent's `task`-span child fields, last-wins per composite key, `build`/`plan` internal agents excluded, per-family-breakdown-else-aggregate per the SubagentNode rule) and `TOTAL` = parent five-way + SUBAGENTS (full labels in every `aria-label`) — right-aligned. Cache = `cacheReadTokens` only, cache write carried but never summed. Hidden when no session is selected. The five parent categories render on every chat node as a compact single-line right-aligned row (display-only k-format like `1.2k`/`85k`, full comma values in aria-labels) and in the DetailPanel (five-way labeled rows, unchanged). Session totals are derived from the session's chat rows via `computeSessionTokenTotals()` (per-composite-key last-wins dedupe — Σ per-node == session figure by construction; composited child-session rows excluded) plus the SUBAGENTS figure via `computeSubagentTokenTotals()` (`lib/sessionMeta.ts`). **ESTIMATED COST (Spec #2750)** is subagent-inclusive: the bar's single combined figure = parent Σ `cost_usd` (last-wins chat keys, composited-child-excluded) + Σ `childCost` over qualifying task keys (`computeSubagentCostTotals`, same task-keyed last-wins + build/plan-excluded rules as the SUBAGENTS tokens — the two subagent figures share the collection pass and cannot drift); no-subagent sessions sum `+0` so the figure is byte-unchanged; per-node cost rows are never re-based; the `title`/`aria-label` reads `Estimated cost (parent + subagents)`. Since Spec #2734, `computeSessionTokenTotals()` also runs a **warn-only reconciliation guard**: Σ per-node `cacheReadTokens` is compared against the last chat row's preserved raw cumulative `gen_ai.usage.cache_read.input_tokens` flat attribute (rawJson long-tail) — a mismatch logs a `console.warn` (diagnostic only, never a silent correction — the classifier owns correctness) and the guard stays silent when the invariant holds or the session read no cache.
- **Node layout (Spec #2723)**: chat chain positions are height-aware — `y = prev.y + (prev.height ?? 320) + 28` (measured ReactFlow heights, `CHAIN_GAP = 28`, `DEFAULT_NODE_HEIGHT = 320`), replacing the fixed 260px spacing that structurally guaranteed collisions with variable-height content nodes. Height changes reflow the chain incrementally (O(N) chain-only, signature-gated; no full-graph re-layout per delivery); d3 force remains only for non-agent residue with rectangular de-overlap as belt-and-suspenders. Chain stays vertical, oldest-at-top.
- **Layout (Spec #2760 — Force removed, Chain is the ONLY layout)**: Mission Monitor renders exactly one layout — the deterministic Chain layout described above. The floating `LayoutModeToggle` segmented control (`data-testid="mm-layout-toggle"`), the `LayoutMode` type + `LAYOUT_MODE_KEY` persisted setting (`Fredo_mm_layout_mode`), the `CanvasProps.layoutMode` threading, the hook's `layoutMode`/`viewportBounds` options, and the entire live d3-force simulation engine (`buildForceSimulation`/`createLiveForceSimulation`, the #2756 anchor layer `computeExchangeAnchors` + the `FORCE_*`/`ANCHOR_*`/`VIEWPORT_BOUNDS` constants) were all deleted. A stale stored `Fredo_mm_layout_mode` value (`'force'`, or corrupt variants) is INERT by construction: the feature performs ZERO reads and ZERO writes of the key (the panel's `usePersistedSetting` consumer was the only reader), so every session — fresh open, close/reopen, or app restart — renders Chain with no crash, no blank graph, and no error surface. No preference UI, no write-back normalization, and no replacement badge/label exist (removal, not redesign). `computeForceLayout` + the `d3-force` dependency RETAIN their frozen Chain-residue role (non-agent residue positions in the Chain branch). The prior-art chain-parity goldens (`layout.chain-parity.test.ts`) pass UNMODIFIED — Chain remained byte-identical through the Force era (#2752/#2754/#2756/#2758) and its removal.
- **Force layout history (removed by Spec #2760)**: a physics-simulated Force layout existed through Specs #2752 (introduced) → #2754 (hybrid) → #2756 (Bostock disjoint rework) → #2758 (structural disjoint rework), with Chain mode byte-identical throughout (formula-derived parity tests against the closed-form chain constants, not pixel fixtures). Both Force reworks were rejected by the human reviewer on visual outcome, so the mode was removed entirely rather than reworked a third time — see the Layout bullet above for what survives.
- **Live-session selection follow (Spec #2758)**: when a NEW session id first appears in the live row store while the panel is open, selection follows it automatically unless the user has explicitly picked a session this lifetime (first render seeds known ids so mount-time/parked traffic never steals focus; explicit picks burn follow-pending ids; programmatic follow does not flip the user-picked flag).
- **Session History**: Derived from the replayed RTDB Chat rows merged with the persisted FeatureStore snapshot (spec #339; names + retention fallback — the rows are authoritative for every session they hold). The persisted snapshot is deduplicated by `sessionId` (last entry wins for metadata) before merging. Auto-collapsing sidebar (icon-only on mouse leave after 300ms delay), session search/filter matches the display Name OR the sessionId (Spec #2750 — case-insensitive substring over `customName ?? derivedName ?? label`, the exact string the row renders; a single filter pass keeps the exactly-once dual-match edge; the search input UI itself is unchanged), caps at 50 persisted sessions. **Session naming (Spec #2748)**: each row shows a Name line — the session's FIRST (earliest-timestamp) non-empty chat-row `userMessage`, whitespace-normalized and truncated to ~40 chars, else the timestamp label fallback — with the session's start date-time below. A hover/`:focus-within`-revealed edit button opens an inline rename field (keyboard-operable: Tab-reachable, Enter saves, Escape cancels, blur commits, focus returns); a saved custom name persists to the `session_names` FeatureStore table (featureId `mission-monitor`, `session_id` PK, `custom_name` authoritative over `derived_name`, atomic `featureStoreUpdate`, never delete+insert) and wins over the derived name across panel close/reopen and app restart until renamed or the session is deleted. **Deletion tombstones (Spec #2788 P4.3)**: deleting a session records a durable `deleted_sessions` tombstone so RTDB replay can never resurrect it after an app restart (the guard extends to discovered child keys). **Node status chrome (Spec #2748)**: Agent/Subagent nodes render plain neutral theme-token styling — no status text/badges, no status-driven borders, glow, handles, or minimap coloring (MiniMap `nodeColor` returns a single neutral token; canvas chrome tokenized; the top header strip `Mission Monitor · <date> · <sessionId>` is removed). Mission Monitor is a fixed dark surface — no light/dark theme toggle exists (PO-confirmed).

---

## Performance Guardrails (Spec #498)

All subsystems have bounded growth — preventing the progressive degradation (sluggish → UI freeze) observed after 2-4+ hours of use.

| Subsystem | Bound | Mechanism |
|-----------|-------|-----------|
| RTDB classifier correlation maps (9) | 10,000 entries each | Oldest-first eviction (`MAP_CAPACITY`, `rtdb/ingest.rs`) |
| RTDB relationship registry `child_to_parent`/`parent_to_children` | 10,000 entries | Oldest-first eviction (Spec #523) |
| RTDB emission batch | 512 rows | `RTDB_MAX_EMISSION_BATCH` chunking (`rtdb/flush.rs`) |
| RTDB replay drain | Background (`spawn_blocking`) | Never blocks the main thread (F-33) |
| FE row-mutation debug log | 512 entries | Oldest-first eviction (`StreamContext.tsx`) |
| FE replay-drain marker buffer | 256 markers | Oldest-first eviction (`StreamContext.tsx`) |
| Mission Monitor graph rebuild | O(N_new) per batch | Incremental node/edge updates (was O(N_total)) |
| Mission Monitor persisted sessions | 50 sessions | Oldest pruned (`persistence.ts`) |
| SpanCollector `session_span_stack` | Cleaned on completion | `span_id` popped on Response/Error lifecycle |
| RunCliState `output_buffer` | 10 MB | Oldest data truncated when cap exceeded |

**Rust backend bounds** are in `apps/tauri/src-tauri/src/`:
- `infrastructure/rtdb/ingest.rs` — correlation + relationship map caps with oldest-first eviction at every write site
- `infrastructure/rtdb/cache.rs` — LRU row cache + bounded write-behind queue
- `infrastructure/telemetry/mod.rs` — Span stack pop on completion
- `features/terminal/state.rs` — Output buffer cap

**Frontend bounds** are in `apps/ui/src/`:
- `shared/contexts/StreamContext.tsx` — bounded row-mutation log + replay-drain registry
- `features/mission-monitor/lib/graph.ts` — Map/Set caps
- `features/mission-monitor/hooks/useMissionMonitor.ts` — Incremental graph updates

---

## Agent Integration Points

| Integration | How it works |
|-------------|-------------|
| **OpenCode OTLP plugin** | The `fredo-opencode-plugin` exports OTLP metrics, logs, and traces directly to `127.0.0.1:4317` (gRPC) via the OpenTelemetry SDK. Replaces the previous CLI-based `fredo opencode-plugin` event forwarding. |
| **OTLP telemetry** | Configure OpenCode to send OTLP to `127.0.0.1:4317` (gRPC) or `127.0.0.1:4318` (HTTP). Fredo persists every raw span/metric/log on receipt — provider-agnostic, no span dropped — and classifies spans into RTDB rows via the ingest classifier (`rtdb/ingest.rs`), which resolves the canonical op by `gen_ai.operation.name` (`run_agent`/`chat`/`execute_tool`, helpers in `rtdb/attrs.rs`) with generic heuristics and derives row state from `endTimeUnixNano` (present → Response, absent → Init). Raw span names (`fredo.session`, `fredo.llm`, `fredo.tool.*`, or any provider's) are preserved as received in `telemetry_spans`. |
| **`fredo emit` CLI** | Named-pipe `CliCommand::EmitEvent` → `InternalAdapter::enrich` → RTDB row classifier. Payload-shape conventions in `.opencode/skills/fredo-cli-events/SKILL.md`. |
| **Terminal feature** | The `terminal` feature spawns OpenCode in a native PTY. PTY output streams as `run-cli-output` Tauri events. |
| **LLM feature** | In-process llama.cpp inference. `llm_chat` Tauri command accepts messages and streams tokens. |

### Classifier Row-State Mapping

The ingest classifier derives each row's `state` from span timing (helpers relocated to `rtdb/attrs.rs`): `endTimeUnixNano` present → `Response`, absent → `Init`; session (`run_agent`) spans always stay `Init` (REQ-609). Token deltas (`promptTokens`, `cacheReadTokens`) are per-turn DELTAS against the classifier's session-cumulative baselines (Specs #2711/#2723/#2734 semantics, ported verbatim into `rtdb/ingest.rs::derive_turn_tokens` — clamped ≥ 0 with baseline reset on compaction/out-of-order; `cacheReadTokens` is injected ONLY as the derived per-turn delta, never the raw cumulative). Subagent-session markers (`is_subagent`, `agent.type`) are preserved in the row payload; the payload projector (`otlp_attrs_to_payload`) injects the canonical fields (`userMessage`, `agentReply`, `promptTokens`, `completionTokens`, `reasoningTokens`, `childSessionId`/`childTokens`/… ) so the frontend reads one canonical path (contract-trust rule — no multi-path fallbacks). The plugin emits `is_subagent`/`agent.type` on the parent's task span and child-completion flat attrs (`child_session_id`, `child_total_tokens`, …) — the projector maps them onto camelCase keys.

---

## Dual-Mode Binary

The `fredo` binary detects its mode at startup:

```rust
if std::env::args().len() > 1 {
    // CLI: parse clap args -> connect to IPC socket -> send CliCommand -> exit
} else {
    // GUI: launch Tauri window + start IPC socket server + OTLP receivers
}
```

The same installed binary is both the desktop launcher and the `fredo` CLI in PATH.

---

## IPC Protocol

The local socket accepts newline-delimited JSON. Each message is a `CliCommand`.

### Socket Path

| OS | Path |
|----|------|
| Windows | `\\.\pipe\fredo-ipc` |
| macOS / Linux | `/tmp/fredo-ipc.sock` |

### CliCommand Schema

```jsonc
// Generic FredoEvent emission
{ "type": "emit_event", "event": { "id": "...", "eventType": "tool_use", ... } }
```

### IPC Dispatch Flow

```
CLI client (fredo emit ...)
  → connect to local socket
  → send CliCommand JSON
  → dispatch_command()
      └── EmitEvent → dispatch_emit_event()
            → InternalAdapter::enrich(event)  (stamp defaults)
            → IngestClassifierState::ingest_event(&enriched)  (RTDB rows)
```

---

## Tauri Capabilities

Defined in `capabilities/default.json`:

| Permission | Why required |
|-----------|-------------|
| `core:default` | Standard window management |
| `core:event:allow-listen` | Webview subscribes to Tauri events (fredo-stream-event, llm-token, etc.) |
| `core:event:allow-emit` | Rust backend emits events to webview |
| `core:window:allow-create` | Backend opens new WebviewWindow (run-cli-terminal) |
| `core:window:allow-close` | Backend closes the terminal window |
| `core:window:allow-start-dragging` | Window drag support |
| `core:window:allow-set-title` | Dynamic window title updates |
| `shell:allow-open` | Open external URLs in system browser |
| `shell:allow-spawn` | Spawn child processes (PTY terminal) |
| `shell:allow-execute` | Execute shell commands (PTY terminal) |

---

## Tauri Commands

All commands registered in `generate_handler![]` in `lib.rs`:

| Command | Feature | Description |
|---------|---------|-------------|
| `subscribe_events` | rtdb | Register RTDB row queries (async; registers live subs, returns queryIds, drains the snapshot in the background — F-33) |
| `unsubscribe_events` | rtdb | Unregister queries; discards pending deliveries (no post-unsubscribe emission) |
| `save_setting` / `get_setting` | settings | Persist/retrieve KV settings from AppStore |
| `open_run_cli` | terminal | Resolve binary, open PTY, spawn child |
| `get_pty_buffer` | terminal | Return buffered PTY output |
| `write_pty_input` | terminal | Write keyboard input to PTY |
| `resize_pty` | terminal | Resize PTY to new rows/cols |
| `close_run_cli` | terminal | Kill child, release PTY, close window |
| `check_cli_installations` | setup | Check if `opencode` is on PATH |
| `install_plugin` | setup | Install OpenCode plugin |
| `get_plugin_source_path` | setup | Return bundled plugin source path |
| `check_fredo_in_path` | setup | Check if `fredo` is on PATH |
| `add_fredo_to_path` | setup | Add Fredo to system PATH |
| `check_otel_configured` | setup | Check OTLP exporter config |
| `configure_otel` | setup | Write OTLP exporter config |
| `get_setup_plan` | setup | List pending setup steps |
| `check_all_setup` | setup | Run all setup checks |
| `run_setup_step` | setup | Execute a single setup step |
| `check_model_files` | setup | Check local model file existence |
| `download_model` | setup | Download model GGUF + mmproj |
| `llm_chat` | llm | Chat with in-process LLM (streams tokens) |
| `llm_chat_with_image` | llm | Chat with image (multimodal) |
| `capture_screen_region` | screenshot | Capture screen region as base64 PNG |
| `feature_store_ensure_table` | storage | Create a typed-column feature namespaced table |
| `feature_store_insert` | storage | Insert rows into a feature namespaced table |
| `feature_store_query` | storage | Query rows with optional WHERE/ORDER BY/LIMIT |
| `feature_store_update` | storage | Update rows matching WHERE clause |
| `feature_store_delete` | storage | Delete rows matching WHERE clause |
| `telemetry_get_stats` | telemetry | Return span count, metric point count, log count, and storage bytes |
| `telemetry_purge` | telemetry | Delete all rows from telemetry_spans, telemetry_metrics, and telemetry_logs |
| `telemetry_toggle` | telemetry | Enable/disable span collection via AppStore `tracing.enabled` |
| `telemetry_metrics_toggle` | telemetry | Enable/disable metric collection via AppStore `tracing.metrics_enabled` |
| `telemetry_logging_toggle` | telemetry | Enable/disable log collection via AppStore `tracing.logging_enabled` |
| `telemetry_logging_set_level` | telemetry | Set minimum log level filter via AppStore `tracing.logging_level` |

---

## Startup Sequence

1. Initialize `AppStore` (SQLite KV store) — managed via `app.manage()`
2. Read `llm_model` setting, resolve model paths
3. Spawn `LlmEngine` loading in `spawn_blocking` task
4. Initialize `RunCliState` (PTY terminal) — managed via `app.manage()`
5. Manage `EventBus` (the single `"fredo-stream-event"` emitter)
6. Open `RtdbStore`, build the LRU cache + registry + FlushLoop, manage `Rtdb` + the ingest classifier, spawn the flush task (~5 ms) and the write-behind task (~30 ms), set retention defaults + startup prune, spawn the canonical backfill (read-only over `telemetry_spans`; one-shot completion marker)
7. Start IPC socket server (`tauri::async_runtime::spawn`)
8. Start OTLP receivers (gRPC :4317 + HTTP :4318)
9. Register all Tauri command handlers via `generate_handler![]`
10. Launch Tauri webview window

---

## Archived Components

| Component | Was | Replaced by |
|-----------|-----|-------------|
| `apps/browser-extension` | Chrome extension host | `apps/tauri` |
| `apps/vscode-extension` | VS Code webview host | `apps/tauri` |
| `apps/tools-mcp` | Node.js MCP/SSE backend (Redis Streams) | Not yet reimplemented |
| `apps/ai-sidecar` | Node.js AI CLI sidecar | PTY-based `terminal` feature |
| `apps/marketplace-plugin` | Original hook-based OpenCode plugin | OTLP-based ingest classifier (`rtdb/`) |
| UI: agents, chatbot, embeddings, memory, telemetry | Stub features | Consolidated into Mission Monitor |

---

## Further Reading

| Document | Contents |
|----------|----------|
| [docs/SETUP.md](SETUP.md) | Local development setup, model configuration |
| [docs/CLI_GUIDE.md](CLI_GUIDE.md) | Fredo CLI commands, OTLP setup |
| [docs/SECURITY.md](SECURITY.md) | Security model, capabilities, input handling |
