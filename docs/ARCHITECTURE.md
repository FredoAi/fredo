# Fredo — Architecture Overview

## What Fredo Is

Fredo is a **cross-platform desktop application** for working with AI coding agents. Built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend), it ingests agent telemetry and lifecycle events, normalizes them into canonical objects, and renders them as reactive UI features in real time.

Agents integrate through two paths:

1. **OpenCode OTLP plugin** — the `fredo-opencode-plugin` exports OTLP metrics, logs, and traces directly to the gRPC receiver (`:4317`) using the OpenTelemetry SDK
2. **OTLP receivers** — native gRPC/HTTP collectors that ingest OpenTelemetry spans from OpenCode and compatible tools

OTLP telemetry is persisted **raw on receipt** (spans, metrics, and logs — no span dropped) and then classified by the **RTDB ingest classifier** into typed SQLite rows (`chat_rows` / `tool_use_rows` / `agent_session_rows`) that stream to the frontend as row deliveries over the `"fredo-stream-event"` IPC channel (the RTDB is the only delivery path; the v1 contract-engine pipeline was deleted). The React UI reacts in real time — no polling.

---

## Design Philosophy

### Feature-Based Autonomy

Both the Rust backend and the React UI are organized around **autonomous feature modules**. Each feature owns its entire vertical slice — models, business logic, state, and presentation. No feature reaches into another feature's internals. Shared platform services (communication layer, storage, IPC, OTLP) live in `infrastructure/` (Rust) or `shared/` (TypeScript) and are consumed by features, never owned by them.

### Reactive UI — Rows, Not Polls

The UI does not call the backend to ask for data. Instead, it **subscribes to a typed row query** via `useEventRows(eventType, args, options)` and reacts. The backend registers the subscription, drains the persisted snapshot as full-row `insert` envelopes (the replay leg, terminated by a per-query `replayCompleteQueryId` settle marker), and streams live patches (`insert`/`update`/`remove`) as they land. Features derive their display state from the module-scoped row store.

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

The `comm` module holds the canonical wire types and the single IPC emitter. Since the RTDB row pipeline became the only delivery path it is deliberately small — the v1 contract engine (ECE), the OpenCode/Hook adapter, and the OTLP→ECE adapter were deleted; the RTDB row pipeline (`infrastructure/rtdb/`) is the only delivery path.

### Core Types

- **`FredoEvent`** — the `fredo emit` CLI wire format and classifier input: `id`, `eventType` (ToolUse | AgentSession | Chat | Infrastructure | Ui | Custom), `state` (Init | Update | Response | Error), `provider` (OpenCode | ClaudeCode | CopilotCli | Internal), `transport` (Hook | OtlpGrpc | OtlpHttp | WebSocket | HttpPost | Internal), `sessionId`, `correlationId`, `toolName`, `payload`, `error`, `metadata`, `timestamp`. Serialized as camelCase. **Demoted, not deleted**: FredoEvent no longer crosses IPC to the webview.
- **`EventBus`** — the single emitter for the `"fredo-stream-event"` Tauri IPC channel. It carries TWO envelope families: RTDB `RowDeliveryBatch` envelopes via `emit_row_delivery_batch` (the ONLY sanctioned RTDB emission path) and feature-data `FeatureDeliveryBatch` envelopes (`{"featureBatch": …}`) via `emit_feature_delivery_batch`. Registered as Tauri state in `lib.rs`.
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

No raw `FredoEvent` crosses IPC (it is the CLI wire format only); the `"fredo-stream-event"` channel carries only projected envelope families — RTDB `RowDelivery`/`RowDeliveryBatch` and feature-data `FeatureDeliveryBatch`. The **ingest classifier** (`rtdb/ingest.rs`) maps every span/event onto canonical row upserts unconditionally, never gated by subscriptions (R-4a) — that is what makes replay work. Merge rules (KeepFirst / LastNonZero / LastWins, `rtdb/merge.rs`) keep init-time data intact across patches; the per-key durable `seq` (`rtdb/store.rs`) guards against stale patches. `telemetry_spans` is never touched by RTDB code (`rtdb/store.rs` asserts the invariant).

### Replay + Live Boundary (P2.3, F-33 fix)

`subscribe_events` is an async command: it registers the live subscriptions FIRST, returns immediately, and hands the snapshot SELECT to `tauri::async_runtime::spawn_blocking` — the replay leg is a background drain (NFR-1). The drain's final ≤512-row chunk of each query carries the per-query `replayCompleteQueryId` settle marker (an empty terminal envelope when nothing remained pending); `useEventRows.ready` resolves on the marker, never on subscribe resolution alone. Batches are chunked at `RTDB_MAX_EMISSION_BATCH = 512` rows per IPC envelope. `flushMs: 0` bypasses coalescing and emits one envelope per patch (AC1-c timing).

### Feature-Owned Data Layer (`infrastructure/feature_data/`)

A feature declares, on the frontend, the data structure it owns plus the source mapping onto already-captured canonical activity (or a closed `sessionRollup` aggregate over it). The backend materializes the declared tables idempotently on every launch, owns the writes, and persists them in the SAME `fredo.db` as `feature_<sanitized featureId>_<table>` (declaration metadata in `feature_data_tables`, deletion tombstones in `feature_data_tombstones`).

- **Materialization is schema-aware.** A same-named table that is not declaration-shaped is quarantined under a `__legacy_<timestamp>` name (never dropped) and the declared schema is created; additive column changes are applied in place, and a column removal/retype is refused with a hard named error. Declarations and their rows survive restarts; a one-time read-only projection backfill seeds a new declared table from canonical history (marker-gated, per-table, set only on success).
- **Projection is unconditional.** A canonical row upsert updates the declared rows whether or not a feature UI, read, or watch is open (`R-4.2`). A row-sourced projection costs O(rows of its source); an aggregate recomputes once per distinct group, not once per input row.
- **Read/watch/write surface.** `feature_data_declare` (idempotent), `feature_data_read` (rows + the scope `version` + the resolved retention bound), `feature_data_watch` (table / record / query scope, optional field narrowing, optional atomic initial snapshot), `feature_data_unwatch` (per watch), `feature_data_write` (feature-owned columns only; an unchanged value is a silent no-op), `feature_data_delete` (tombstoned, never resurrected). Failures reject with hard named errors that the consumer hooks surface verbatim.
- **Notifications** ride the existing `"fredo-stream-event"` channel as `FeatureDeliveryBatch` (`{"featureBatch": …}`) and are discriminated in `AppProvider` BEFORE the RTDB validators. A notification carries the table, the record key, the change kind (`insert`/`update`/`remove`), the changed field names, their current values, and the version at which the change was applied; a removal carries no value. Declared-table retention evicts oldest-first and emits a removal per evicted row. Every read/watch/write is validated against the requesting `featureId` — one feature never observes another's data.

### Known limitation

With Mission Monitor open on a very large corpus (~42k rows), sustained live agent traffic re-triggers per-batch derivations in the renderer and can intermittently saturate the webview (DOM/console probes time out during bursts; quick evals slip through). The main thread and backend stay healthy throughout, and the coalescing guarantees one envelope per drained chunk. Drains typically recover, but at least one ≥13-minute non-recovering webview wedge was observed under an actively-streaming agent during verification — this is webview-side row application under dense live traffic, documented as a known limitation for a possible follow-up.

### Parent-Child Compositing — Cross-Session Merging

Parent-child session merging happens in the **ingest classifier's relationship registry** (row pipeline), not in any adapter. Registration sources (ported from the ECE, `rtdb/ingest.rs`): the OTel span-link `parent.session_id` attribute (primary) and the `session.parent_id` attribute (fallback), with the internal tool-execution-agent exclusion (`build`/`plan`) applied at registration.

- **`child_to_parent` / `parent_to_children`** maps (capped at 10,000 entries, oldest-first eviction) mirror the deleted ECE registry.
- When a child→parent relationship registers, the child's EXISTING rows are COPIED under the parent key (session_id = parent, correlation_id = the child's own per-turn id) carrying the `parent_session_id` + `composited_child_session_id` stamps; every LATER child row also gets a parent-keyed copy while the relationship is registered. **`kind: remove` is ONLY ever emitted for retention eviction — a re-key NEVER removes rows.**

**Join rule:** consumers that join child activity must NEVER key by the re-keyed composite key — keying by the composite key orphans every child tool call (the `⚠ N unattributed` chip defect). **Ownership derivation:** a row can be re-keyed MORE THAN ONCE (multi-hop delegation chains), so ownership of a task dispatch derives PRIMARILY from the correlationId's session prefix (`<sessionId>_<counter>` — every real OTLP corrId carries it), using `compositedChildSessionId` ONLY as the guarded fallback for non-prefixed (legacy/mock) corrIds. The classifier preserves the FIRST `compositedChildSessionId` stamp across re-keys (first-wins — the event's true owner).

---

## RTDB Row Store

SQLite-authoritative typed rows behind an LRU cache — the production event pipeline.

### Row types + queries

Three canonical tables in `fredo.db` — `chat_rows`, `tool_use_rows`, `agent_session_rows` — one row per composite key `(session_id, correlation_id)` with a durable per-key monotonic `seq`. The **RTDB query language** (`rtdb/query.rs`) is GraphQL-inspired: `chat(sessionId = "s1") { userMessage, promptTokens }` — typed root per row type, typed-column args with SQL pushdown, hard-named validation errors (typos and type mismatches are rejected, never silently empty). `subscribe_events`/`unsubscribe_events` register/unregister queries; every query gets a unique `queryId`. Every row carries a **`provider`** attribution derived from the OTLP resource identity `service.name` (`fredo-opencode-plugin` → `open_code`, `copilot-cli` → `copilot_cli`, else the documented `unknown` fallback — never the model provider carried by `telemetry_spans.provider`), resolved by ONE shared rule (`rtdb/attrs.rs::resolve_provider_token`) used by both the live classifier and a one-shot re-derivation pass (`rtdb/backfill.rs`, gated by its own marker under an independent key) that upgrades a pre-existing migration-defaulted row **in place at the row's own `(session_id, correlation_id)`** — it never re-mints a key, so it creates no parallel rows. The column is appended by an idempotent migration as `provider TEXT NOT NULL DEFAULT 'unknown'`.

The orphaned `contract_events` table (a pre-RTDB v1 data artifact) stays in `fredo.db` — it has zero code references and destructive data cleanup is out of scope; it is left in place.

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
|   |   +-- state.rs            — TerminalState (PTY writer, buffer, killer) + typed CLI/status/error kinds
|   |   +-- commands.rs         — open/spawn/list/IO/close commands, resume/delete, persisted-record events
|   |   +-- persistence.rs      — durable session records (`feature_terminal_sessions`, bounded retention)
|   |   +-- resume.rs           — per-CLI resume argv + bounded (5 s) typed resume outcome
|   |   +-- open_terminal.rs    — `fredo open-terminal` validation + launch-intent dispatch
|   +-- llm_server/             — Out-of-process companion inference (managed `llama-server`)
|   |   +-- mod.rs              — persisted setting keys + launch defaults
|   |   +-- config.rs           — pure launch-config model + generated `.bat` (single argv builder)
|   |   +-- process.rs          — spawn/stop the child process tree + startup orphan sweep
|   |   +-- health.rs           — bounded HTTP `/health` readiness probe
|   |   +-- state.rs            — LlamaServerState + ManagedServer
|   |   +-- commands.rs         — generate_llama_server_config, launch_llama_server, stop_llama_server, get_llama_server_status, llm_chat, llm_chat_with_image, llm_chat_with_status, companion_status_capability
|   |   +-- chat.rs             — chat + vision routing to the server HTTP API
|   +-- settings/               — Persistent KV settings (SQLite)
|   |   +-- mod.rs              — SettingsFeature
|   |   +-- commands.rs         — save_setting, get_setting
|   +-- setup/                  — CLI detection, PATH management, OTel config, three-file model acquisition, Companion readiness + llama.cpp install
|   |   +-- mod.rs              — SetupFeature
|   |   +-- commands.rs         — check_cli_installations, install_plugin, check_fredo_in_path, add_fredo_to_path, check_otel_configured, configure_otel, get_setup_plan, check_all_setup, run_setup_step, check_model_files, download_model, check_companion_readiness, install_llama_cpp
|   |   +-- model_download_state.rs — pure required-file manifest (pinned URLs/sizes/SHA-256), on-disk classifier, complete-iff-all-present aggregator
|   |   +-- model_download.rs   — streamed acquisition engine (HTTP Range resume, streaming SHA-256, bounded retry/backoff)
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
    +-- companion/              — Shared companion runtime helpers (Spec #2857)
    |   +-- resolver.rs         — `llama-server` executable resolution (setting → PATH → winget shim)
    |   +-- models.rs           — required model-file manifest (pinned names/sizes/SHA-256) + on-disk probe
    +-- voice/                  — Local voice capture, model-audio only (Spec #2877; on-device engine removed in #2914): native capture + one bounded clip session
    |   +-- capture.rs          — native cpal (WASAPI) input stream → mono-mix + resample → 16 kHz chunks; env-gated deterministic WAV feed seam (#2887 — absent unless the feed variable is set, and it opens no device)
    |   +-- session.rs          — single app-global session; the worker owns the capture stream and the bounded model-audio clip
    |   +-- state.rs            — `Stt*` IPC wire types (camelCase), incl. the `readyMs` / `phase` / `limitMs` observables and the `MAX_AUDIO_CLIP_MS` bound
    |   +-- commands.rs         — stt_list_devices, stt_start, stt_stop, stt_cancel, stt_status, stt_take_audio_clip
    +-- rtdb/                   — RTDB row store — the production event pipeline
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
    +-- feature_data/           — feature-owned declared tables (declaration → projection → read/watch)
    |   +-- declaration.rs      — declaration model + hard named validation
    |   +-- registry.rs         — persistence, schema-aware materialization, additive migration
    |   +-- store.rs            — FeatureDataStore (metadata + tombstones; own SQLite connection)
    |   +-- projection.rs       — projection engine (row-source + rollup entry points)
    |   +-- session_rollup.rs   — the closed sessionRollup aggregate
    |   +-- watch.rs            — global watch registry (table/record/query + field narrowing)
    |   +-- envelope.rs         — FeatureRowNotification / FeatureDeliveryBatch wire types
    |   +-- backfill.rs         — one-time projection backfill (read-only)
    |   +-- lifecycle.rs        — declared-table retention + tombstone guard
    |   +-- commands.rs         — feature_data_declare/read/watch/unwatch/write/delete
    +-- storage/
    |   +-- mod.rs              — AppStore (SQLite KV store) + FeatureStore
    |   +-- feature_store.rs    — FeatureStore (typed feature-level SQLite)
    |   +-- span_store.rs       — SpanStore (telemetry span persistence)
    +-- telemetry/              — Telemetry tracing + metrics + logging
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

The `FeatureStore` (`infrastructure/storage/feature_store.rs`) provides a generic, typed-column SQLite database for any feature. Each feature gets namespaced tables (`feature_{featureId}_*`) with column types TEXT, INTEGER, REAL, or BLOB. Cross-feature isolation is enforced — a feature cannot access tables belonging to another feature.

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

**Idempotency**: `feature_store_insert` uses `INSERT OR IGNORE`. Duplicate inserts with the same unique key silently succeed without UNIQUE constraint errors. Delivery-level idempotency in the row pipeline is guaranteed by the RTDB durable per-key `seq` (`rtdb/store.rs` `next_seq`, seeded from MAX(seq) in storage — store.rs:628) plus the merge rules (`rtdb/merge.rs`) that drop stale patches — no adapter re-delivers events.

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
- **Raw ingestion on receipt**: every span/metric/log in each export is persisted via `otlp/raw.rs` → `SpanStore::insert_raw_spans`, before and independent of row classification — no span dropped (R1/R2). Row classification runs the RTDB ingest classifier (`rtdb/ingest.rs`) on the same export. Metrics and logs are persisted to `telemetry_metrics`/`telemetry_logs` on both legs.

### HTTP Receiver (`:4318`)
- Axum server handling `POST /v1/traces`, `/v1/metrics`, `/v1/logs`
- Accepts both protobuf (`application/x-protobuf`) and JSON (`application/json`)
- Includes `/health` diagnostic endpoint
- Same raw-ingestion-on-receipt behavior as the gRPC leg

### Trace→Session Correlation
The RTDB ingest classifier (`rtdb/ingest.rs`) maintains the correlation maps (ported from the deleted v1 adapter, same caps and eviction semantics) and processes them during OTLP span classification:

- **`trace_to_session`**: Built from `gen_ai.conversation.id` and `session.id` span attributes during span processing
- **`session_to_parent`**: Built from OTel span links (`parent.session_id` link attribute,  REQ-6) as the primary path, with fallback to `session.parent_id` span attributes for backward compatibility (REQ-9). Supports order-independent parent-child detection regardless of OTLP batch arrival order.
- **`session_to_correlation`**: Maps session IDs to correlation IDs so `correlation_id === session_id` for pure-OTLP sessions, with the per-turn counter (REQ-639) and the ST9 span→correlation reuse guard

`chat` child-span content lands in the canonical chat rows; the Mission Monitor derives its graph from them.

---

## Telemetry Metrics

The `telemetry` module (`infrastructure/telemetry/`) collects OpenTelemetry-compatible metrics from the **non-OTLP (CLI/Hook) event stream**, parallel to span tracing.

> ** (R10, no double-write):** raw OTLP telemetry is persisted **directly by the receivers on receipt** (`otlp/ingest.rs` → `SpanStore`). The OTLP feeding of `SpanCollector`/`MetricCollector` was removed from both receivers — no signal is ever written twice. The collector structs remain alive as the backing Tauri state for `telemetry_toggle`/`telemetry_metrics_toggle` and keep observing the remaining (non-OTLP) dispatch points.

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

## Telemetry Logging

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

## Out-of-Process `llama-server`

Companion inference is served by a managed `llama-server` **child process** — the in-process engine is retired and there is no `llama-cpp-2` dependency. The `llm_server` feature (`features/llm_server/`) owns the runtime; executable resolution and the required model-file manifest live in the shared `infrastructure/companion/` layer, consumed by both `features/setup` (readiness/acquisition) and `features/llm_server` (launch/config).

### Launch Config
`generate_llama_server_config` builds the launch config from persisted settings (executable path, model / vision / MTP paths, host, port, launch parameters) and materializes a runnable `.bat`. There is exactly ONE argv builder (`LlamaServerConfig::to_args`) — the `.bat` text and the spawned process both derive from it, so they can never drift.

### Process Lifecycle
- `launch_llama_server` — generate → resolve the executable → spawn the child (`std::process::Command`, not a Tauri sidecar) → poll the server's `/health` with a bounded timeout → record the managed server. Idempotent when already healthy; ALWAYS resolves (never hangs).
- `stop_llama_server` — kill the process tree and clear the managed state.
- `get_llama_server_status` — the UI/QA poll target (running / healthy / port / PID / last error).
- No orphan survives Fredo: the `RunEvent::Exit` hook calls `stop_llama_server_on_exit`, and a PID-reuse-guarded startup sweep (`process::sweep_orphan`) reclaims a persisted PID after a hard-kill.

### Chat Routing
`llm_chat` and `llm_chat_with_image` preserve the frontend contract (`adapterBridge.llmChat` / `llmChatWithImage`, same argument shapes) but route to the server's OpenAI-compatible streaming API (`POST /v1/chat/completions`, `stream: true`). Each SSE delta emits `llm-token`; `[DONE]` emits `llm-done`; a connection / non-200 / stream error emits an additive `llm-error` line followed by `llm-done`, so the UI never hangs. Sampling parameters are NOT sent per request — the generated launch config is authoritative.

### Model-Audio Turns (#2897)
When voice input is enabled and the installed model accepts audio, a captured utterance becomes that turn's user input. The clip is pulled from the capture session after stop and delivered as the turn's user message through the **same loopback transport** to the managed `llama-server` — an `input_audio` content part, with **no transcript text** accompanying it — and the model's reply streams into the shipped companion conversation exactly like a typed message (the reply is rendered; no transcript of the user's audio is shown). Audio capability is probed through the app's own check, which reports `ready` / `unsupported` / `serverUnavailable` and never infers capability from a model name; when the model is unsupported or the server is unavailable, no audio is transmitted and the UI surfaces the reason. Capture stays bounded by `MAX_AUDIO_CLIP_MS` (~30 s): reaching the bound auto-stops capture, surfaces a visible notice, and delivers the **entire** clip (`at_limit: true`, `truncated: false`). The path adds no network client — it reuses the managed server's loopback endpoint, so the local-only contract is unchanged. Since **#2903** the model-audio turn is skill-aware on the SAME shared path as typed input: it offers the identical companion-skill registry (`open_app`, `close_app`) as OpenAI-style `tools`, routes a validated `llm-skill-call` through the same adapter contract, and the ONE shared app-control hook performs the action and settles the same deterministic reply — so a spoken open/close request actually acts, at parity with the typed/companion path, and the reply never claims an action that was not performed.

### Model-Driven Reply Status (#2918)
The companion reply carries a **model-declared status**. The reply is obtained under one `response_format` JSON-Schema object (`fredo_reply`): `{ reply, status }`, `required`, `additionalProperties:false`, with `status` a closed enum — `happy | playful | joking | thinking | working | listening | idle`. The backend is the ONE parse path (`features/llm_server/status.rs`, `ReplyEnvelopeExtractor`): it forwards ONLY decoded `reply` characters as `llm-token` (so no raw JSON ever crosses IPC and progressive rendering is preserved) and emits the additive **`llm-status`** event (a `string`, always before `llm-done`). Empty content retries exactly once (`STATUS_EMPTY_RETRY_MAX = 1`); malformed output degrades to a plain reply with the default `happy`.

On the pinned managed server a request may not offer `tools` and `response_format` together — the JSON grammar would displace the native tool call. `llm_chat_with_status` therefore separates the concerns: with `offerSkills = true` it runs the shipped tools bodies **with no `response_format`** (so the `open_app` / `close_app` / `llm-skill-call` contract is intact) and, on a content-only prose turn, obtains the status from ONE bounded `{status}` `response_format` pass (`fredo_status`, `STATUS_PASS_TIMEOUT_S = 10`) before `llm-done`; with `offerSkills = false` (joke / tools-free) it uses the single-object `{reply, status}` path. Capability is gated by the EXISTING read-only probe via the pure `response_format_capability(&ResponseFormatProbe)` predicate and the cached `companion_status_capability` command — no new detector. When the structured path is unsupported, the turn degrades to the shipped plain-text reply with the default `happy` and no user-visible error. The structured prompt carries the literal word `json` and an example (never free-text-JSON instructions).

The frontend maps the status through the pure `resolveReplyStatus` seam (`shared/components/companion/fredoReplyStatus.ts`, lenient: unknown/absent heals to `happy`; `talk` / `error` / teleport / `greeting` are not model-emittable) and asserts it **only at the successful reply settle**, held for the existing `HAPPY_HOLD_MS` and then released — never while streaming, teleporting, skill-pending, capturing, or on the error path (G-220: no existing state's sole trigger is masked). `clearTimer()` — the ONE shared hold canceller — releases the turn-scoped status on every path that cancels the hold (teleport, interrupt, new generation, unmount, game), so no status can stick.

### Wizard Step
The Companion setup wizard appends a `serverLaunch` step (after `llamaServer` and `modelFiles`). Its state is composed in `useCompanionReadiness` from `get_llama_server_status`, and its action calls `launch_llama_server`; the backend readiness command stays two-prerequisite.

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
|   +-- terminal/                   — Ghostty terminal (PTY output)
|   +-- query-viewer/               — SQL query result display (multi-instance)
|   +-- my-workitems/               — Azure DevOps work items
|   +-- settings/                   — Settings persistence service (settingsService + SettingsSaveContext)
|   +-- settings-app/               — Settings app (first-class feature; sidebar nav + auto-discovered feature sections + unified Save)
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
    +-- hotkeys/                    — the keyboard contract (registry, engine, sequences, macros, keymap persistence)
    +-- classes/
    |   +-- FredoFeatureClass.ts    — abstract base class for grid features
    |   +-- EventSubscription.ts    — RTDB row wire types (RowDelivery / RowDeliveryBatch)
    |   +-- types.ts                — GridItemConfig
    +-- utils/adapterBridge.ts      — non-React singleton for feature → invoke()
    +-- components/
        +-- fredo-avatar/         — shared FREDO avatar (FredoAvatar.tsx, geometry, sizes, css)
        +-- companion/
            +-- FredoCompanion.tsx  — LLM companion rendering the shared FredoAvatar (sm)
            +-- SpeechBubble.tsx    — Positionable bubble with game slot
            +-- features/
                +-- tictactoe/      — Tic-Tac-Toe game (vision-based AI)
```

### Keyboard & Hotkeys (`shared/hotkeys/`)

A first-class keyboard contract (Spec #2946) lets features **declare** their hotkeys once and have the platform discover, list, rebind and persist them uniformly:

- **Two tiers.** *Fredo* actions (open the launcher, switch windows, open Settings) are app-global; *feature* actions apply only while their feature is focused. A feature contributes actions by overriding the `hotkeys` member on its `FredoFeatureClass` — no per-feature listing code is needed.
- **Engine.** One capture-phase `document` keydown listener (`engine.ts`) classifies the focus context, applies context-aware suppression (text-entry, modal, terminal, native consumers) and dispatches the matched action. `HotkeysProvider` mounts the engine plus the announcer and the which-key / cheat-sheet overlays in BOTH webviews (main and `?view=terminal`); it is mounted in the served entry `apps/tauri/src/main.tsx`.
- **Sequences.** Multi-key sequences and a leader key are supported; while a sequence is pending, a which-key overlay shows the prefix and the currently valid next keys, and an invalid or abandoned sequence resets visibly without acting.
- **Macros.** Named ordered action sequences plus raw keystroke record/replay (confirmation-gated; strokes typed into text-entry fields are never captured).
- **Configuration.** Settings → Hotkeys lists both tiers, supports search/rebind/reset, surfaces conflicts **before** the save takes effect, lists platform-reserved combos as unavailable-with-reason, and offers an opt-in Vim preset (leader = Space, `hjkl`). The keymap is one per-user JSON document under the `fredo.hotkeys.keymap` `AppStore` KV (schema-versioned, total migration to defaults on corruption) so both webviews read one truth.
- **Typing safety.** Bare keys and multi-key sequences are suppressed while a text control has focus; modifier chords remain global; an open modal owns the keyboard; a focused terminal session passes every key (including chords) to the PTY except the single exit-passthrough chord.

Shipped defaults: `Ctrl+Space` (launcher), `Ctrl+Shift+P` (action palette in the launcher command bar), `?` (cheat sheet), `Ctrl+Tab` / `Ctrl+Shift+Tab` and `Ctrl+1..9` (window traversal), `g g` (first window), `Ctrl+Shift+F9` (toggle raw recording), `Ctrl+Shift+F10` (release terminal passthrough).

### Active UI Features

| Feature | showable | Data source | Description |
|---------|----------|-------------|-------------|
| home | ✓ | — | Navigation grid, FredoCompanion |
| diagram | ✓ | — | Infrastructure visualization (ReactFlow; REST snapshot) |
| terminal | ✓ | — | Ghostty terminal (PTY output from Rust) |
| query-viewer | ✓ | (dynamic) | SQL query result display (multi-instance) |
| my-workitems | ✓ | — | Azure DevOps work items |
| settings | ✓ | — | Settings app — Companion, Appearance, Fredo Setup, Telemetry + auto-discovered feature settings (unified Save) |
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

### Row Subscriptions

Features read live agent activity through the **RTDB row store** — a GraphQL-inspired typed query system over the canonical rows:

- **`useEventRows(eventType, args, options)`** (`shared/hooks/useEventRows.ts`) — subscribes one typed row query (`'Chat' | 'ToolUse' | 'AgentSession'` root, typed-column args with SQL pushdown). Returns `rows` (the partition map), a monotonic `epoch` (advances only on real mutations — memo/effect off the primitive, never on map identity), `ready` (resolves on the backend's per-query `replayCompleteQueryId` settle marker, never on subscribe resolution alone), and `error`. `options.replay: true` restores the persisted snapshot as full-row inserts before live patches flow.
- **Merge semantics** (module-scoped store, `StreamContext.tsx`): `insert` = full-row set with spread-merge so init-time fields are never wiped; `update` = `{ ...row, ...patch }` with seq-guarded stale-patch drops; `remove` = delete key (only ever retention eviction). No TTL, no cap on live rows — replay replaces hydration.
- **Consumer-side filtering**: the backend filters per-query by the declared args, but the partition map is shared per event type — arg-scoped consumers filter their own rows client-side (epoch-keyed memo), the documented extraction pattern (`stepper-probe`).
- **Row subscriptions** — features consume typed RTDB rows via `useEventRows` (the only feature-facing data contract; the v1 contract machinery was deleted).

### StreamContext — connection status + the row store

`StreamContext` carries only the Tauri IPC connection flag; the RTDB row store is module-scoped (survives feature mount/unmount cycles per the AGENTS.md persistence rule). Row deliveries routed by AppProvider are applied with the semantics above; a bounded (512-entry) row-mutation log feeds the debug surfaces (Dev Mode's live stream viewer). The former `StreamStatus` bottom-center activity LED was removed in the #2830 consolidation — desktop connection status is now a single top-right status LED in `LauncherChrome` (`home/components/launcher/LauncherChrome.tsx`), which reads the connection flag via the `isOnline` host prop.

### FredoEvent Shape

```typescript
interface FredoEvent {
  id: string;
  eventType: 'ToolUse' | 'AgentSession' | 'Chat' | 'Infrastructure' | 'Ui' | 'Custom';
  state: 'Init' | 'Update' | 'Response' | 'Error';
  provider: 'opencode' | 'claudeCode' | 'copilotCli' | 'internal';
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

## Agentic UI

Fredo defines its own Agentic UI model instead of adopting AG-UI (agent→frontend SSE event
stream: transient, conversation-scoped) or MCP-UI / MCP Apps (tool→sandboxed-iframe widget
linked via `_meta.ui.resourceUri`): both are one-way, present-tense renderings — *what the
agent says* or *what the tool wants to show right now*. Fredo subscribes to *what happened,
durably* — and closes the loop both ways.

### Apps (plugins)

Every UI surface is an **app** — an autonomous `FredoFeatureClass` module (`apps/ui/src/features/*/`,
auto-discovered via `allFeatures.ts`, registered with `registerFeature()`). An app never fetches;
it declares what it cares about and reacts:

- **Reactive subscription** — `useEventRows(eventType, args, options)` over the RTDB row store.
  `replay: true` restores the persisted snapshot as full-row inserts (late-joiners get full state),
  then live `insert`/`update`/`remove` patches keep it fresh. Display state derives via `useMemo`
  off the `epoch` counter (advances only on real mutations), never by polling.
- **Surviving store** — the row store is module-scoped (`StreamContext.tsx`), so app mount/unmount
  cycles never lose state; replay replaces hydration.

### Bidirectional by construction: agent <=> UI <=> human

Communication and interaction are always designed in both directions — no one-way streams,
no dead widgets:

```
agent → UI:    OTLP / fredo emit → classifier → RowDeliveryBatch → row store → re-render
human → agent: UI action → adapterBridge.invoke() → Tauri command → Rust handler → new rows → same subscription path
agent → human → agent: agent acts, UI reacts, human interrupts (select, rename, approve, play),
               that interruption re-enters as rows and becomes agent context
```

Every app is therefore a **typed row subscription + an invoke back-channel**. Mission Monitor is
the reference: the full delegation graph rebuilds from replayed rows after restart, then tracks
live traffic on the identical path — observable, replayable, interruptible.

---

## FredoCompanion

The animated companion on the Home panel renders the **shared `FredoAvatar` component** (size `sm`, 80×100px, derived from the single `FREDO_AVATAR_SPACE` aspect constant):

- **Shared avatar**: `apps/ui/src/shared/components/fredo-avatar/` — `FredoAvatar.tsx` (frozen 58-rect base SVG + additive interior fill + expression overlay), `fredoAvatarGeometry.ts` (canonical rect table + the additive interior-fill bands), `fredoAvatarSizes.ts` (`AVATAR_SM`/`AVATAR_MD`), `fredoAvatarStates.ts` (the single-source status vocabulary), `fredoAvatarResolver.ts` (the one pure display-state resolver), `fredo-avatar.css` (expression-overlay keyframes for the status vocabulary + reduced-motion), `fredoAvatarIdle.css` (the shared consumer-wrapper idle bob + accent glow + per-status motion, reused by both surfaces; `prefers-reduced-motion` suppresses it), and `apps/ui/src/shared/hooks/useFredoRestingCadence.ts` (the shared resting-cadence hook driving the bounded `playful` beat). The launcher renders the same component at `sm` (80×100) and applies the same wrapper motion on its own wrapper (`.fredo-avatar-idle`) — one consistent, alive mascot across both surfaces (#2852). Since **#2917** the shared component also renders an opaque theme-derived interior fill (a semantic token derived from the live accent mixed over the opaque body surface) as a single additive `<path>` painted beneath the 58 base rects, so the head interior and mouth void no longer show the surface behind the figure; since **#2922** the same single `<path>` also tiles the body — torso, bow tie, arms, buttons, hips, legs and feet — so the whole figure reads solid, with only the authored negative space (inter-leg slit, shoulder/neck and armpit notches, between-feet gap) left as background. The fill bands are derived from the canonical rect table and tuck under the opaque rim; the base 58-rect table (and its count-parity guard) stays frozen and byte-identical in every state; the expression overlay stays last and always paints over the fill, and the fill re-tints live with the theme/accent (no reload). The state union is single-sourced and resolved through one pure seam; since **#2918** the companion feeds a model-declared reply status into it (`resolveReplyStatus`, default `happy`, asserted only at the reply settle — see the Out-of-Process `llama-server` section).
- **States (#2854, extended #2917)**: idle (58 base rects + the interior fill), talk (mouth overlay + streaming pulse; also the ambient-message base state), teleport-out (closed-eyes + streak), teleport-in (sparkles), **thinking** (thought dots + bubble trail; while an LLM response is pending), **joking** (wide open laugh + tongue + laugh lines; while a joke streams), **happy** (smile arc + star burst; joke completion, a Tic-Tac-Toe terminal outcome, or a launcher tile open), **playful** (smirk + brow + cheek star; a bounded resting beat — ≈12 s rest → ≈1.8 s beat via `useFredoRestingCadence`), **listening** (a right-cheek level meter while voice capture is live), **working** (a left-cheek conveyor chevron while a skill/tool executes; a bounded ≈900 ms beat so it is observably rendered), **error** (a status-hue frown + down-brows on a failed reply or a non-success skill settle), and **greeting** (a waving hand + raised brows + smile arc for a bounded ≈1.5 s welcome beat, after which the same ambient message falls through to the base `talk` expression). All are expressed via the overlay `<g id="fredo-expression" data-state>` + wrapper-level CSS motion; base rects frozen byte-identical in every state, expression ink is a high-contrast derived theme token, and each transient status returns to rest (a 15 s watchdog guards LLM-bound states). The companion renders all twelve statuses (and since **#2918** the model may select among `happy`/`playful`/`joking`/`thinking`/`working`/`listening`/`idle` for a reply's bounded settle); the launcher mascot renders idle/thinking/happy/playful through the same shared vocabulary.
- **Personality**: "friendly robot who loves programming, tells jokes, plays Tic-Tac-Toe"
- **Jokes**: 20 topics (recursion, git, CSS, regex, etc.)
- **Streaming**: Token-by-token accumulation with `<end_of_turn>`/`<start_of_turn>` stripping
- **Cross-window teleport**: Tauri global `companion-teleport` events broadcast to all webview windows (dev mode — no Tauri host — teleports locally via `startTeleportOut`, guarded `IS_TAURI` branch)
- **Interaction**: Single-click → joke; double-click → Tic-Tac-Toe; Ctrl+right-click → teleport
- **Command-bar chat (#2871)**: while the companion is active (present at the home seat — `isVisible && !isAway`), the launcher command bar doubles as a chat input. The bar's field is **multiline (#2883)**: a query longer than the bar wraps onto additional visible lines inside the field's content box — never under the Enter hint or the collapse/minimize control — growing from its 48 px base height and capped at 108 px (five lines), then scrolling internally; `Shift+Enter` inserts a newline at the caret, while `Enter` keeps exactly the action described here and never inserts a newline. Enter is **smart** (#2882 replaced the exact-full-name rule): a TYPED query is matched as a whole, case-insensitively, against each app's displayed name — a prefix of that name (`set` → Settings) or a whole word / contiguous run of whole words inside it (`Miss`, `monitor` → Mission Monitor) — and a match launches that app **regardless of the companion's state** (present, away, off, or replying), the top-ranked (earliest matching) rendered result winning an ambiguity; any other query is sent to the companion LLM as a **single-shot** message (no transcript/memory) and the streamed reply renders in the companion's `SpeechBubble` **reply surface (#2883)** — a two-tier card: today's **240×120** base tier while the text fits, growing with the arriving reply up to `min(560, available)` wide × `clamp(120, contentHeight, available)` tall and re-evaluated as content arrives (never a fixed box showing only the opening lines). It is placed inside the launcher-measured band (`above` the seat by default, else beside it) so it stays entirely within the window and intersects neither the command bar nor its field. Since **#2886** it also never intersects **Fredo's avatar footprint** or the **app tiles**: the placement is derived in viewport px from the **measured avatar rect** (the `.fredo-companion-avatar` wrapper box — 80×100 at the seat; never the bubble-only `fredo-companion-surface` wrapper, whose in-flow height is 0) plus the band (`barrierTop` = the lower of the command-bar box top and the `#fredo-launcher-grid` resting top, so the tiles are covered by the same barrier), it keeps a bound **`REPLY_AVATAR_CLEARANCE` = 14 px** strip on the placement axis with the **facing edge pinned** at `footprint ± 14` (growth is one-directional and the separation is constant at every size), it ranks `above > right > left` at the seat (`below` is the away overlay's last resort only) **rejecting** any candidate that would intersect the footprint, break the clearance or leave the region, and when no candidate is viable it degrades to the reduced extent + the #2883 scroller (`scrollable`, height first then width — never the separation, floored at `REPLY_MIN_USABLE_W` 160 × `REPLY_MIN_USABLE_H` 48) rather than covering him; `data-reply-placement` exposes the chosen side next to `data-reply-tier`/`data-reply-kind`. The launcher keeps the app tiles mounted and hit-testable for the whole time a message surface is displayed — sending a bar message no longer unmounts the grid — so the tiles stay visible and clickable while a reply, welcome or joke is read. The **away overlay** (`CompanionEntity surface="overlay"`, rendered by `main.tsx` outside `LauncherShell`) ranks the same candidates against the same measured footprint plus the launcher region published through the module-scoped `companionGeometry` registry (the #2870 ST-2c cross-subtree pattern), so a teleported Fredo is never covered and the bar/tiles stay clear there too. A reply longer than the largest surface that fits stops at the cap and scrolls internally — the whole answer stays reachable, with a labelled **Newest** control to return to the newest text when the reader has scrolled back (the reading position otherwise holds as new tokens arrive). A reply being read does not auto-dismiss: the pointer over the surface or keyboard focus inside it cancels a countdown that had already started, and the reply clears only after the pointer/focus leaves (a 2000 ms grace); while protected it also suppresses the companion's idle auto-return. Short content is untouched — a one-line query keeps the 48 px field with no scrollbar and a reply that fits keeps the 240×120 base tier. There is no fragment matching: `Missing all the time` is sent, never launched, and the non-empty non-match `openSelected()` fall-through is retired. The hint chip is label-driven (`showHint = Boolean(hintLabel)`, the `chatAvailable` gate retired) and names Enter's action in every state — open the matched app, send to Fredo, `no match`, or the busy `Fredo is replying…` — derived from the same decision function the handler consumes. The bar shows a busy state (`aria-busy`, read-only input, `Fredo is replying…` hint) for the whole stream, and Enter never starts a second stream (a typed app match still opens its app while a reply is streaming). Dispatch goes through the per-window `CompanionEntity` registry (`askActiveCompanion`), reusing the entity's shared generation core and single-in-flight/stale-token guard; `llm-error` is routed through a typed `onError` channel and mapped to a readable sentence (never the raw backend string). A bar message uses a general chat persona; the single-click joke path keeps its joke persona. With the companion OFF or away, the bar is filter/launch only. Reduced motion keeps the streaming cursor static.
- **Hold-to-dictate into the bar — one speech path, model audio (local transcription removed in #2914; #2882 superseded the #2878 two-surface routing)**: capture is reachable ONLY from the launcher bar: **Ctrl+Space brings the bar to the front and focuses its search field — nothing else** (it never starts or stops a session and never closes the bar; the #2823 non-launcher-text-control pass-through carve-out is retained), and **holding Space in the focused, EMPTY search bar** starts a `launcher`-origin capture after a bounded 200 ms hold. Listening runs only while Space is held, and the bar cue — the `Listening` chip and `Listening…` placeholder plus a polite text announcement — is honest: it appears ONLY while capture is genuinely live, so it indicates the capture for its whole duration and never claims to be listening before it is. A sub-threshold tap writes exactly one ordinary space and never opens the microphone — as does any Space in a non-empty query, or a hold with voice input disabled (no capture, no error). There is exactly ONE speech path: on release (or Stop) the session commits the captured clip and the launcher delivers it **exactly once** to the managed `llama-server` over loopback as that turn's `input_audio` content part — **no transcript of the user's audio is produced or shown** — and the model's reply streams into the companion conversation like a typed message. Capture stays bounded by `MAX_AUDIO_CLIP_MS` (~30 s): reaching the bound auto-stops capture, surfaces a visible notice, and keeps the **entire** clip (`at_limit: true`, `truncated: false`). Cancel (Escape or the bar's cancel control) discards the capture and never dispatches; a session that never went live restores the pre-session text once and never dispatches. The companion-origin capture path is retired with `CompanionListeningBubble`; the bar cue alone indicates capture. The path is opt-in, all-local (loopback only, no egress), and visibly indicated for its whole duration; capture is announced on a polite live region and cued by text, never colour or animation alone.
- **Reply-resilient composing + send disposition (#2892)**: the launcher command bar stays editable WHILE a reply bubble is on screen (streaming or complete) — no reply state sets the field read-only — and the "Fredo is replying…" status (placeholder, `aria-busy`, accent dot, Enter hint) is truthful: it keys on the companion's actual generation (`replyInFlight`), not on the read/hold flag, and it clears at every settle even with the pointer resting on the bubble. Hover/focus on the bubble changes ONLY its hold-open window; the read-held reply still suppresses idle auto-return (the `isInUse` predicate is unchanged). A send while a reply is in flight is never dropped: it is accepted (the bar clears only on an accepted outcome) and, per the **Settings → Companion** disposition (`Fredo_companion_send_during_reply`, default `queue`, or `interrupt`), it either queues FIFO — shown as `Queued — waiting for Fredo…` and auto-dispatched exactly once when the in-flight reply settles — or supersedes the in-flight generation (a logical supersession: the stale callbacks and pending hold timers are invalidated). The reply bubble's leave grace is configurable (`Fredo_companion_reply_leave_grace_ms`, default 2000 ms, clamp 0–60000 ms; the control is shown in seconds), with the shipped hold-open rules otherwise unchanged.
- **Companion app-open skill (#2893)**: the launcher ask path (typed or dictated) is skill-aware — the registered `open_app` skill is offered to the model, and when it selects it the app opens the named feature with the deterministic reply committed first and the open dispatched after a bounded beat (`APP_OPEN_REPLY_BEAT_MS`). The visible reply is deterministic copy (`Opening <App Name>`; unknown ⇒ `I couldn't find "<name>"`; ambiguous ⇒ asks which; failure ⇒ `I couldn't open <name>…`); unknown/ambiguous open nothing, and non-app-open messages keep exactly today's chat behaviour (zero spurious opens). Identity resolution is a single frontend rule (feature `id` or display name, the launcher's whole-query matcher) shared by the CLI and companion paths; execution goes through `fredo open-app`.
- **Model-audio app control (#2903, revises #2897)**: the model-audio turn is skill-aware on the SAME shared app-control path as typed input. The audio request offers the identical companion-skill registry (`open_app` plus `close_app`) as OpenAI-style `tools` (`tool_choice: auto`, `parallel_tool_calls: false`) through one shared request renderer, the audio adapter carries the validated `llm-skill-call` over the additive `onSkillCall` channel, and the ONE shared hook (`useAppOpenRequests`) executes it — open through `fredo open-app`, close through the window store's `closeWindow` (guarded by an open-check) — then settles the deterministic reply. The typed and model-audio paths share the same registry and hook, so app-control coverage and outcomes are identical across both (parity by construction); the model never claims an action it did not perform — the deterministic reply replaces any streamed prose, a skill-pending generation never settles on a raw prose claim, and an unsupported/unrecognized name performs zero actions and says so.
- **Setup gating (#2855)**: **Settings → Companion** renders a setup wizard as its ONLY content until the machine is ready — i.e. a usable `llama-server` is available AND all required model files are present. The wizard reports each prerequisite independently (`checking | missing | installed | error`), offers a one-click `install_llama.cpp` via `winget` with an in-session re-check (no reload), and shows an actionable error (staying not-set-up) when `winget` is unavailable or the install fails. Once both prerequisites are satisfied, the normal Companion controls (toggle + Teleport tip) replace the wizard.
- **Model-file acquisition (#2856)**: the wizard's **Model files** step lists the three required companion files individually — model `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf`, vision `mmproj-BF16.gguf`, and speculative draft `MTP/mtp-gemma-4-E2B-it-Q4_0.gguf` — each with its own state (`missing | downloading | present | error`); the filenames/sizes/SHA-256 are pinned to a fixed Hugging Face revision. The user starts acquisition in-app; the in-flight file shows determinate progress and files already present are skipped; a partial set never reads complete and the summary names exactly the missing/truncated file(s); an interrupted transfer resumes from its persisted offset via HTTP `Range` with a bounded retry, and each file is verified by streaming SHA-256. Files land under `<models_dir>/gemma-4-e2b-it-qat/`. The engine (`model_download.rs` + `model_download_state.rs`) is shared by the `download_model` command and the CLI mirror.
- **Home seat + one Fredo (#2853, re-modelled in #2870)**: the launcher's centre slot is Fredo's **home seat**, rendered unconditionally as an 80×100 (`AVATAR_SM`) slot plus its `mb="4"` margin — the command bar never shifts (the old `!companionPresent` gate that unmounted the slot is removed). `isAway` (a transient, never-persisted `CompanionContext` flag, synced over the existing `companion-presence` broadcast with an `away` field) records whether Fredo is home; the seat renders the shared interactive `CompanionEntity` when the companion is ON and home, the decorative `FredoAvatar` when OFF, and the token-native `EmptySeat` placeholder when away. **Turning the companion ON activates the role in place — it never relocates Fredo, and no bottom-right/corner position state exists.** The interactive body (`CompanionEntity.tsx`) is shared by the seat and the fixed away overlay; **teleport (Ctrl+right-click) is the only relocation mechanism**, and every relocation (TELEPORT/`markAway`) clears any stale auto-hide state so the relocated Fredo is present at its new location. Each OFF→ON turn-on fires `showMessage(WELCOME_TEXT, 4000)` — the `SpeechBubble` welcome bubble, fade-only under `prefers-reduced-motion`. After an idle period with no interaction Fredo auto-returns home — default **60 s**, configurable in **Settings → Companion** (key `Fredo_companion_idle_timeout`, integer seconds, range 5–3600 via `usePersistedSetting`; invalid/cleared/≤0 values fall back to 60, out-of-range values clamp). Any interaction (click/joke, double-click/game, Ctrl+right-click teleport) resets the timer, and an open Tic-Tac-Toe, an active joke stream, or a reply being read (pointer over it or keyboard focus inside it, #2883) *suppresses* the return while in use (continuous-interaction gate). Auto-return is transient — it never rewrites the persisted visibility preference. The idle timer is **host-owned** (`isHosting = away && isInThisWindow`; only the window currently displaying the companion arms it) and transient presence is synced across webview windows via the global `companion-presence` broadcast, so the main-window seat shows the empty placeholder while the companion is hosted in the terminal window and is re-occupied on the host's idle-settle.

### Tic-Tac-Toe
- Player = X, Companion = O
- **Vision-based AI**: screenshot of board → `capture_screen_region` → LLM vision prompt → parse digit 0-8
- **Fallback**: first empty cell on error/invalid response
- Embedded in the `SpeechBubble` component's **game card** (`208×268px` fixed dimensions — a surface distinct from the two-tier text reply, which grows with its content and scrolls, #2883)

---

## Mission Monitor

Mission Monitor is the row-driven agent activity graph (ReactFlow). It derives its entire graph from typed RTDB rows — no v1 deliveries exist anywhere.

- **Data source**: `useEventRows('Chat', {}, { replay: true })` + `useEventRows('ToolUse', ...)` — the module-scoped row store. Replay restores the persisted snapshot as full-row inserts, settled by the per-query `replayCompleteQueryId` marker; live patches continue on the same path. The Mission Monitor replay args are bounded by a mount-stable `now − 7d` recency cutoff (`lib/replayWindow.ts`) and, on a warm reopen (feature remount in the same app session), a module-scoped `updatedAt > watermark` delta arg so the drain returns only rows the surviving store does not hold. The session drawer unlocks **progressively** (#2835 ST-9-R3): `useDeliverySessions` opens its `loaded` gate on row presence (`rows.size > 0`) after the persisted snapshot loads — an oversized multi-batch replay fires ONE early epoch bump at its first row-bearing batch (`StreamContext.tsx`), so the list renders from the first drained rows instead of parking until the drain end. `ready` remains the completeness signal (resolves only on the settle marker); an empty store still parks until the (empty) drain settles, so the true-empty state is unchanged.
- **Graph builder**: `useMissionMonitor()` → `lib/rowDerivation.ts` derives ReactFlow nodes/edges from ALL typed chat/tool rows (cross-session, not filtered by sessionId) so the selected session's chat chain is complete. `insert` creates nodes, `update` merges metadata (spread-merge; init-time data survives), `end`-state rows set final status. `task` dispatches split out of the tool-association path into SubagentNode state (keyed by task correlationId, gated by the `build`/`plan` internal-agent exclusion) — the SubagentNode is the dispatch's sole representation. **Embedded chat tools**: resolved non-task tool calls attach to the anchor chat node's payload (`AgentNodePayload.tools`, deterministically `byStartTimeThenCorrId`-ordered) instead of creating a companion node; the standalone ToolsNode class was deleted. **Transitional-turn suppression**: completed chat nodes with an empty `agentReply` (a transitional tool-call turn) are suppressed at emission (builder state kept intact) and the chain re-anchors to the nearest visible chat node. Row payloads are parsed at most once per row object per session (a module-scoped memo guarded by the raw JSON string, #2893) and the tool-row sort is a plain comparator, so a mount derive over a large corpus no longer blocks the main thread.
- **Node types**: Agent (Chat) and SubagentNode (driven from the parent's `task` row + the classifier's parent-child compositing stamps, not from subagent chat rows). The standalone ToolsNode was removed: chat tool calls render inside the chat node as an embedded `── TOOLS (N) ──` accordion, hidden entirely when the chat has no tool calls. The dead ToolNode/FileNode machinery was removed.
- **Tool call details**: double-clicking any part of an embedded tool accordion item opens the scoped tool-call detail view (`ToolCallDetailView`: Status/Duration/Input/Output) via `stopPropagation`, so ReactFlow's `onNodeDoubleClick` never selects the parent chat node. Single-click still toggles only the item's expansion. Missing call details degrade to safe absent-states.
- **Recursive delegation tree**: tool ownership and nesting extend to every depth of the delegation chain. A subagent's tools attach to that subagent's own embedded tools section (never the root chat node); nested `task` dispatches render sub-subagent nodes, producing readable multi-level chains. The classifier's relationship registry (`rtdb/ingest.rs`) propagates the parent-session relationship, with the `build`/`plan` internal-agent exclusion applied at registration, so per-subagent ownership holds at every depth.
- **SubagentNode payload extraction**: the node displays subagent identity from the parent `task` row's canonical payload keys — projected by the classifier's attr extractors (`rtdb/attrs.rs`) from the plugin's child-completion flat span attrs (`child_session_id` / `child_agent` / `child_total_tokens` / `child_total_cost_usd` / `child_total_messages`) onto `childSessionId` / `childAgent` / `childTokens` / `childCost` / `childMessages`, plus the per-family token breakdown. TOTAL = sum of the four families when the breakdown is present, else falls back to aggregate `childTokens`. Instruction/output text extraction follows lifecycle-aware priorities.
- **Edge types**: a `calls` edge connects each SubagentNode to its parent ChatNode (`EDGE_STYLES.calls`). The SubagentNode companion column renders right of the chat chain, lanes stepping rightward per nesting level. No Tool→File edges — the non-chat tool/file node classes were removed.
- **Detail Panel**: slide-in panel on node click showing type/ID/token counts/timestamps/duration plus an Estimated Cost row for node targets. Hides on background click or Escape. Start/End derive from the row's span-timing fields (`startedAtNs`/`endedAtNs`), converted by the graph builder to RFC3339 `payload.startTime`/`payload.endTime`.
- **Session token bar**: a compact flex strip at the top of the Mission Monitor main view — the first (top) row of the panel, above the canvas — shows the selected session's token usage as six figures (`In:`/`Ca:`/`Re:`/`Ou:` parent-only, plus `SUBAGENTS` and `TOTAL`). Cache = `cacheReadTokens` only. Session totals derive from the session's chat rows via `computeSessionTokenTotals()` plus the SUBAGENTS figure via `computeSubagentTokenTotals()`. **Estimated cost** is subagent-inclusive: parent Σ `cost_usd` + Σ `childCost` over qualifying task keys.
- **Node layout**: chat chain positions are height-aware — `y = prev.y + (prev.height ?? 320) + 28` (measured ReactFlow heights, `CHAIN_GAP = 28`, `DEFAULT_NODE_HEIGHT = 320`). Height changes reflow the chain incrementally. Chain stays vertical, oldest-at-top.
- **Layout**: Mission Monitor renders exactly one deterministic layout — the Chain layout described above. The floating layout-mode toggle, the entire live d3-force simulation engine, and the production-dead `computeForceLayout` residue pass were all removed; the deterministic chain + SubagentNode companion geometry is the only layout. The residue rectangular de-overlap (`resolveRectOverlaps`) is retained for any non-live residue geometry.
- **Live-session selection follow**: when a new session id first appears in the live row store while the panel is open, selection follows it automatically unless the user has explicitly picked a session this lifetime.
- **Session History**: derived from the replayed RTDB Chat rows merged with the persisted FeatureStore snapshot, deduplicated by `sessionId`. Auto-collapsing sidebar, session search/filter, capped at 50 persisted sessions. Each row shows a Name line — the session's first non-empty chat-row `userMessage`, else the timestamp label fallback — with a hover-revealed edit button for an inline rename (persisted to the `session_names` FeatureStore table). **Deletion tombstones**: deleting a session records a durable `deleted_sessions` tombstone so RTDB replay can never resurrect it after an app restart. **Node status chrome**: Agent/Subagent nodes render plain neutral theme-token styling — no status text/badges or status-driven borders.
- **Multi-CLI identity**: the session list sources OpenCode and GitHub Copilot sessions side by side from the closed `sessionRollup` projection, which carries a canonical `provider` fact column (copied verbatim from the canonical chat row via the one shared `resolve_provider_token` rule — never re-derived in the projection). Each session-list row and the selected session's header render a themeable CLI chip (`lib/cliLabel.ts` + `components/CliLabel.tsx`) resolved from that field — semantic tokens only. An absent/unrecognized provider renders an explicit, visually distinct `Unknown CLI` fallback and is never presented as OpenCode. The plain-shell `Terminal` session type is not an agent and is excluded by the renderable-activity qualification (no canonical rows → no rollup row).

---

## Performance Guardrails

All subsystems have bounded growth — preventing the progressive degradation (sluggish → UI freeze) observed after 2-4+ hours of use.

| Subsystem | Bound | Mechanism |
|-----------|-------|-----------|
| RTDB classifier correlation maps (9) | 10,000 entries each | Oldest-first eviction (`MAP_CAPACITY`, `rtdb/ingest.rs`) |
| RTDB relationship registry `child_to_parent`/`parent_to_children` | 10,000 entries | Oldest-first eviction |
| RTDB emission batch | 512 rows | `RTDB_MAX_EMISSION_BATCH` chunking (`rtdb/flush.rs`) |
| RTDB replay drain | Background (`spawn_blocking`) | Never blocks the main thread (F-33) |
| FE row-mutation debug log | 512 entries | Oldest-first eviction (`StreamContext.tsx`) |
| FE replay-drain marker buffer | 256 markers | Oldest-first eviction (`StreamContext.tsx`) |
| Mission Monitor graph rebuild | O(N_new) per batch | Incremental node/edge updates (was O(N_total)) |
| Mission Monitor persisted sessions | 50 sessions | Oldest pruned (`persistence.ts`) |
| SpanCollector `session_span_stack` | Cleaned on completion | `span_id` popped on Response/Error lifecycle |
| TerminalState `output_buffer` | 10 MB | Oldest data truncated when cap exceeded |

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
| **GitHub Copilot CLI OTLP** | The Copilot CLI exports OTLP **HTTP** (plaintext `http://127.0.0.1:4318`; the CLI offers no gRPC) with `OTEL_SERVICE_NAME=copilot-cli` — no Fredo-side configuration. Fredo persists the raw signals and the SAME classifier maps them, attributing `provider = copilot_cli` from the resource `service.name` via the one shared rule. Two Copilot specifics are handled **provider-scoped** (so OpenCode rows stay byte-identical): its `invoke_agent` root is promoted to an agent-session row (an `invoke_agent` span with any other/absent identity still maps to a chat row), and a chat row that *continues* an exchange re-carries that exchange's captured prompt (Copilot splits one turn across two `chat` spans; OpenCode re-emits the prompt on every span). Tool outcome/duration fall back to `error.type` + span timing when the flat OpenCode keys are absent; content is off by default (structural rows only). Enablement + the exact non-silent degradation: `docs/telemetry-reference.md` §4. |
| **`fredo emit` CLI** | Named-pipe `CliCommand::EmitEvent` → `InternalAdapter::enrich` → RTDB row classifier. Payload-shape conventions in `.opencode/skills/fredo-cli-events/SKILL.md`. |
| **`fredo open-app` CLI (#2893)** | Named-pipe `CliCommand::OpenApp` → the app's request registry emits `app-open-request` to the `main` window → the webview resolves the identity with the launcher's whole-query matcher and opens the feature through the home window opener, then confirms the structured outcome. Bounded: 5 s confirmation / 10 s child; an unknown identity opens nothing and exits non-zero; app-not-running keeps the shared exit-2 fallback. Documented in `docs/CLI_GUIDE.md`. |
| **Terminal feature (#2934; extended #2935; reworked #2940; reworked #2942; presentation mode #2947)** | **Presentation mode (#2947):** a Settings → Terminal **Presentation** control persists `terminal_presentation_mode` (`same-window` / `new-window`, default `new-window`) and chooses whether Terminal opens as one of Fredo's in-window apps inside the `main` window or in its own native `terminal` window; every terminal event is routed per-emit to the active host, and a mode change with a live host ends the superseded host through the window-close tree-kill path (records retained → resumable) behind a confirmation. The `terminal` feature hosts **multiple concurrent CLI sessions in one native window** (`terminal`) with a compact vertical session sidebar whose pane stays the dominant surface (live sessions and the persisted **Previous** records share one column), supporting **rename** (the record `title` is the single name source) — the session kinds are **Terminal** (a plain OS shell: PowerShell on Windows, `$SHELL` elsewhere — the default for a new session), **OpenCode** and the **GitHub Copilot CLI**, modelled by one `SessionKind` enum (wire values `shell` / `opencode` / `copilot`) with a Settings default-type control. Session state is a session-keyed map; PTY I/O is session-scoped (`get_pty_buffer` / `write_pty_input` / `resize_pty` take a `sessionId`; `list_terminal_sessions` / `spawn_terminal_session` / `close_terminal_session` / `close_terminal_window`), and output/exits stream as the window-targeted `terminal-output` / `terminal-exited` / `terminal-sessions-changed` events. **Every session is persisted as a record** (`feature_terminal_sessions` in `fredo.db`: session kind (column `cli`: `shell` / `opencode` / `copilot`), working directory, title, created/last-active timestamps, and the optional CLI-native session id — never credentials), bounded at `MAX_RECORDS = 100` with oldest-`last_active_at` eviction. Closing the window terminates every session's process tree (`taskkill /T` on Windows) while **keeping every record**; reopening lists them (`list_persisted_terminal_sessions`) and **resumes** one through the CLI's own mechanism (`resume_terminal_session` — OpenCode `--session <id>` / `--continue`, Copilot `--continue`; a `shell` record reopens a fresh shell in its directory with no CLI-native resume claim) with a typed, bounded (5 s pre-flight) outcome that never substitutes a wrong/partial session; `delete_terminal_session_record` removes only Fredo's record. The **`fredo open-terminal [--cli <shell\|opencode\|copilot>] [--dir <path>]`** command opens (or focuses) the window and delivers a one-shot window `terminal-open-request` intent the webview consumes to start the chosen session kind in the chosen folder (the intent is held in a pending handshake and drained once the webview's listeners register, so a cold `open-terminal` — no window yet — still starts the session) (validation runs before anything opens: unknown CLI → `invalid-cli`, missing dir → `invalid-directory`, malformed → `invalid-argument`, all exit 1; app-not-running keeps the shared exit-2 fallback). Copilot launch resolves the platform launcher (a `.cmd` shim on Windows, run through the command interpreter) and applies the PowerShell-6+ prerequisite gate only to a launcher form that actually executes PowerShell; launch failures surface as typed in-window states. |
| **LLM feature** | Out-of-process companion inference via a managed `llama-server` child process. `llm_chat` / `llm_chat_with_image` route requests to the server's OpenAI-compatible streaming API and stream tokens back. |
| **Companion skills (#2893; extended to model audio #2903)** | `llm_chat_with_skills` (typed) and the model-audio turn (`llm_chat_with_audio`, now skill-aware) offer the provider-agnostic companion-skill registry (`infrastructure/companion/skills.rs`; `open_app`, `close_app`) to the model as OpenAI-style `tools` (`tool_choice: auto`, `parallel_tool_calls: false`) and emit a validated `llm-skill-call` when the model selects one; the ONE shared frontend hook executes it. The managed launch config enables the Jinja chat-template engine (`--jinja`) so the pinned model's native tool-call template is honoured (optional template override available). Raw tool-call JSON is never rendered — the visible reply is deterministic copy. |

### Classifier Row-State Mapping

The ingest classifier derives each row's `state` from span timing (helpers relocated to `rtdb/attrs.rs`): `endTimeUnixNano` present → `Response`, absent → `Init`; session (`run_agent`) spans always stay `Init` (REQ-609). Token deltas (`promptTokens`, `cacheReadTokens`) are per-turn DELTAS against the classifier's session-cumulative baselines (ported verbatim into `rtdb/ingest.rs::derive_turn_tokens` — clamped ≥ 0 with baseline reset on compaction/out-of-order; `cacheReadTokens` is injected ONLY as the derived per-turn delta, never the raw cumulative). Subagent-session markers (`is_subagent`, `agent.type`) are preserved in the row payload; the payload projector (`otlp_attrs_to_payload`) injects the canonical fields (`userMessage`, `agentReply`, `promptTokens`, `completionTokens`, `reasoningTokens`, `childSessionId`/`childTokens`/… ) so the frontend reads one canonical path (contract-trust rule — no multi-path fallbacks). The plugin emits `is_subagent`/`agent.type` on the parent's task span and child-completion flat attrs (`child_session_id`, `child_total_tokens`, …) — the projector maps them onto camelCase keys.

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
// Open a Fredo app/feature by stable id or display name (#2893)
{ "type": "open_app", "identity": "Mission Monitor" }
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

CLI client (fredo open-app ...)
  → connect to local socket
  → send CliCommand JSON ({ "type": "open_app", "identity": "..." })
  → dispatch_command()
      └── OpenApp → dispatch_open_app()
            → emit "app-open-request" to the main window  (bounded 5 s wait)
            → webview resolves the identity and opens via the home window opener
            → confirm_app_open_request(outcome) → CLI prints the machine-readable result
```

---

## Tauri Capabilities

Defined in `capabilities/default.json`:

| Permission | Why required |
|-----------|-------------|
| `core:default` | Standard window management |
| `core:event:allow-listen` | Webview subscribes to Tauri events (fredo-stream-event, llm-token, etc.) |
| `core:event:allow-emit` | Rust backend emits events to webview |
| `core:window:allow-create` | Backend opens new WebviewWindow (terminal) |
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
| `feature_data_declare` | feature_data | Idempotent declare + schema-aware materialization of feature-owned tables (returns per-table revision/created) |
| `feature_data_read` | feature_data | Read current rows for a scope with the scope `version` and the resolved retention bound (rows + version are taken atomically) |
| `feature_data_watch` | feature_data | Register a table/record/query watch with optional field narrowing and an optional atomic initial snapshot; returns the watchId |
| `feature_data_unwatch` | feature_data | Stop the named watches only; every other watch keeps delivering |
| `feature_data_write` | feature_data | Write feature-owned columns on a declared row (an unchanged value is a silent no-op — no version bump, no notification) |
| `feature_data_delete` | feature_data | Delete a declared row and tombstone it (emits a removal; the projection never re-creates it) |
| `save_setting` / `get_setting` | settings | Persist/retrieve KV settings from AppStore |
| `open_terminal_window` | terminal | Resolve binary, open PTY, spawn child |
| `list_terminal_sessions` | terminal | List terminal session status |
| `get_pty_buffer` | terminal | Return buffered PTY output |
| `write_pty_input` | terminal | Write keyboard input to PTY |
| `resize_pty` | terminal | Resize PTY to new rows/cols |
| `close_terminal_window` | terminal | Kill child, release PTY, close window |
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
| `check_model_files` | setup | Report per-file state for the three required model files (legacy `gguf_exists`/`mmproj_exists` fields preserved) |
| `download_model` | setup | Download the three required model files with per-file progress, skip-present, HTTP `Range` resume, and streaming SHA-256 verification |
| `check_companion_readiness` | setup | Report Companion prerequisites (`llama-server` availability + required model files) and overall readiness |
| `install_llama_cpp` | setup | Install llama.cpp via `winget` off the UI thread; returns a structured result (no launch, no model download) |
| `stt_list_devices` | voice | Enumerate cpal input devices, mark the system default, and report the persisted selection |
| `stt_start` / `stt_stop` / `stt_cancel` / `stt_status` | voice | Drive the single app-global model-audio capture session (typed `SttErrorCode` on every failure; a duplicate start is an idempotent `alreadyListening`) |
| `generate_llama_server_config` | llm_server | Build the `llama-server` launch config from persisted settings and materialize the `.bat` |
| `launch_llama_server` | llm_server | Resolve/spawn the managed `llama-server`, poll `/health` until ready (bounded), and record it |
| `stop_llama_server` | llm_server | Stop the managed server and clear its state |
| `get_llama_server_status` | llm_server | Report running/healthy state, port, PID, config/log paths, and last error |
| `llm_chat` | llm_server | Chat via the managed server's streaming API (streams tokens) |
| `llm_chat_with_image` | llm_server | Chat with image (multimodal) via the managed server |
| `llm_chat_with_skills` | llm_server | Skill-aware chat: offers the companion-skill registry as OpenAI-style `tools` and emits a validated `llm-skill-call`; the legacy `llm_chat` path is unchanged |
| `llm_chat_with_status` | llm_server | Companion reply with a model-declared status (#2918): `offerSkills=true` runs the shipped tools bodies (no `response_format`) and adds a bounded `{status}` pass on content-only prose; `offerSkills=false` uses the single `{reply,status}` object; emits the additive `llm-status` before `llm-done` |
| `companion_status_capability` | llm_server | Cached read-only capability verdict `{supported, detail}` reusing the existing `response_format` probe (never opens a window, never writes state) |
| `probe_companion_skills` | llm_server | Read-only Phase-0 diagnostic: probes the managed server's `/props` plus one `tools` and one `response_format` request and returns the raw result (never opens a window, never writes state) |
| `run_open_app_cli` | app_open | Spawn `fredo open-app <identity>` and return its bounded outcome (the companion's execution path reuses the CLI) |
| `confirm_app_open_request` | app_open | Complete a pending `fredo open-app` request from the webview with the structured outcome |
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
2. Manage `LlamaServerState` (the managed out-of-process `llama-server` lifecycle) and run the PID-reuse-guarded startup orphan sweep — no in-process engine load
3. Initialize `TerminalState` (PTY terminal) — managed via `app.manage()`
4. Manage `EventBus` (the single `"fredo-stream-event"` emitter)
5. Open `RtdbStore`, build the LRU cache + registry + FlushLoop, manage `Rtdb` + the ingest classifier, spawn the flush task (~5 ms) and the write-behind task (~30 ms), set retention defaults + startup prune, spawn the canonical backfill (read-only over `telemetry_spans`; one-shot completion marker)
6. Start IPC socket server (`tauri::async_runtime::spawn`)
7. Start OTLP receivers (gRPC :4317 + HTTP :4318)
8. Register all Tauri command handlers via `generate_handler![]`
9. Launch Tauri webview window

---

## Archived Components

| Component | Was | Replaced by |
|-----------|-----|-------------|
| `apps/browser-extension` | Chrome extension host | `apps/tauri` |
| `apps/vscode-extension` | VS Code webview host | `apps/tauri` |
| `apps/tools-mcp` | Node.js MCP/SSE backend (Redis Streams) | Not yet reimplemented |
| `apps/ai-sidecar` | Node.js AI CLI sidecar | PTY-based `terminal` feature |
| `apps/marketplace-plugin` | Original hook-based OpenCode plugin | OTLP-based ingest classifier (`rtdb/`) |
| `features/llm` (in-process `LlmEngine` + `llama-cpp-2`) | Direct in-process llama.cpp bindings requiring a CMake/VS native build | Managed out-of-process `llama-server` (`features/llm_server`) |
| UI: agents, chatbot, embeddings, memory, telemetry | Stub features | Consolidated into Mission Monitor |

---

## Further Reading

| Document | Contents |
|----------|----------|
| [docs/SETUP.md](SETUP.md) | Local development setup, model configuration |
| [docs/CLI_GUIDE.md](CLI_GUIDE.md) | Fredo CLI commands, OTLP setup |
| [docs/SECURITY.md](SECURITY.md) | Security model, capabilities, input handling |
