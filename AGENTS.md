# Fredo

Desktop platform for working with AI coding agents. Built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend). Agents communicate via adapters through a backend communication layer that normalizes raw events into canonical `FredoEvent` objects consumed by declarative frontend features.

## Architecture Concepts

### Communication Layer (`infrastructure/comm/`)

The `comm` module is the backbone of the event pipeline. It defines:

- **`FredoEvent`** — the canonical event shape (id, eventType, state, provider, transport, sessionId, correlationId, toolName, payload, error, metadata, timestamp). Serialized as camelCase to match frontend conventions.
- **`EventBus`** — emits `FredoEvent` on the `"fredo-stream-event"` Tauri IPC channel to the webview.
- **`CommAdapter`** trait — each agent provider gets an adapter that transforms raw input into `Vec<FredoEvent>`.

### Adapters & Connectors

**Adapters** are per-agent-provider (OpenCode, ClaudeCode, Internal). **Connectors** are per-transport within an adapter (Hook, OTLP gRPC, OTLP HTTP).

```
infrastructure/comm/adapters/
├── opencode.rs    — OpenCodeAdapter: Hook connector (plugin events) + OTLP connectors (spans)
├── internal.rs    — InternalAdapter: enriches raw events with server-side defaults
```

- `OpenCodeAdapter::transform(Transport::Hook, payload)` — maps PreToolUse/PostToolUse/... plugin hooks into FredoEvents
- `OpenCodeAdapter::transform(Transport::OtlpGrpc, payload)` — maps OTLP spans (gen_ai.operation.name) into FredoEvents
- New agent providers get a new adapter file; new transports get a new `Transport` variant

### Event Flow (unidirectional)

```
Agent → Adapter.transform() → Vec<FredoEvent> → ContractEngine.req_2_3_process()
  → Vec<SubscriptionDelivery> → EventBus.emit_delivery()
  → Tauri IPC "fredo-stream-event" (SubscriptionDelivery only)
  → TauriAdapter.onMessage() → AppProvider → StreamContext.addDelivery()
  → Features (routed via eventContracts + handleDelivery)
```

Raw `FredoEvent` never crosses IPC to the frontend — only `SubscriptionDelivery` does. The `ContractEngine` buffers events by composite key, evaluates `completeWhen` conditions, and delivers assembled payloads via Init → Update → End lifecycle.

### Feature Contracts

Features declare what events they need through the **Event Contract Engine (ECE)** — a GraphQL-inspired query system:

- **`eventContracts`** — `EventContractDeclaration[]` on `FredoFeatureClass`. Declares streamFields, deferredFields, composite key, completeWhen condition, and timeout. Registered with the Rust ECE engine via `registerEventContracts()` IPC call.
- **`handleDelivery(delivery: ContractDelivery)`** — called for every `SubscriptionDelivery` matching the feature's registered contracts. Delivers via Init → Update → End lifecycle.
- **Legacy `eventFilters`** (removed from migrating features in Spec #311) — previously used for simple toolName/state/custom matchers. Kept only in non-migrating features (setup, run-cli, query-viewer, model-storage).
- **Legacy `eventSubscriptions`** (Spec #252) — typed subscriptions removed in Spec #311. Replaced by ECE contracts.

## Project Structure

```
apps/
├── tauri/src-tauri/src/     # Rust backend
│   ├── main.rs              # dual-mode entry (GUI vs CLI dispatch)
│   ├── lib.rs               # AppRuntime composition root; registers EventBus, commands, state
│   ├── features/            # autonomous feature modules (no cross-feature imports)
│   ├── infrastructure/      # shared platform services
│   │   ├── comm/            # communication layer (FredoEvent, EventBus, CommAdapter, adapters)
│   │   ├── storage/         # AppStore (SQLite KV)
│   │   ├── ipc.rs           # local socket server + CliCommand dispatch
│   │   ├── cli/             # clap CLI parser
│   │   └── otlp/            # OTLP receivers (gRPC :4317, HTTP :4318)
│   ├── runtime/             # AppRuntime + capability traits (DesktopCapable, CliCapable)
│   └── utils/               # stateless helpers (errors, event dump)
└── ui/src/                  # React frontend
    ├── app/                 # adapters, providers, routes, theme
    ├── features/            # grid-based features (FredoFeatureClass)
    └── shared/              # classes (EventSubscription, types), contexts (StreamContext), hooks
```

## Key Commands

- `cargo build` — build from `apps/tauri/src-tauri/`
- `pnpm dev:tauri` — run dev server (Vite on port 5174)
- `pnpm --filter @fredo/ui build` — build UI library, verify TypeScript
- `pnpm dev:ui` — start Vite dev server

## Universal Rules

### Backend (Rust/Tauri)
- No cross-feature imports — features never import from other features
- Always use `tauri::async_runtime::spawn` — never `tokio::spawn` (panics with "no reactor")
- Register new commands in `lib.rs` → `AppRuntime`
- Zero warnings — do not suppress with `#[allow(...)]`
- New adapters go in `infrastructure/comm/adapters/` — one file per agent provider
- New `Transport` variants added in `infrastructure/comm/event.rs`
- Adapters consume `AppHandle` via `EventBus` from Tauri state
- Serde: structs crossing IPC use `#[serde(rename_all = "camelCase")]`; enums use `#[serde(rename_all = "PascalCase")]`
- clap: use `#[derive(Parser)]`; keep `Args` structs small and focused
- Error handling: use `anyhow::Result`; propagate with `?`, never `unwrap()`
- State belongs in the feature module, not in `infrastructure/`
- Emit events via `EventBus`, never call `app_handle.emit()` directly
- OTLP receivers bind to `127.0.0.1:4317` (gRPC) and `127.0.0.1:4318` (HTTP); only spans reach the UI, metrics/logs dropped
- LlmEngine runs in-process — never spawn `llama-server` subprocess

### Frontend (React/TypeScript)
- All grid features extend `FredoFeatureClass`
- Never statically import `@tauri-apps/api` — only dynamic imports in `TauriAdapter.ts`
- Use `adapterBridge.invoke()` for Tauri commands from non-React code
- Use `crypto.randomUUID()` — no `uuid` package installed
- Register features via `registerFeature()` in `index.ts`
- Never edit `Home.tsx` to add features — it calls `getFeatures()` automatically
- All public API consumed by `apps/tauri` must be exported from `src/index.ts`
- Features declare event contracts via `eventContracts: EventContractDeclaration[]` and handle deliveries via `handleDelivery(delivery: ContractDelivery)` — no more `eventFilters` or `eventSubscriptions`
- `registerEventContracts()` must be called at mount to wire contracts with the Rust ECE engine — eventContracts are NOT auto-registered
- ECE `streamFields` must use 2-level paths only (e.g. `['payload', 'state']`) — 3-level paths like `['payload.info.text']` silently strip to `{state: ...}` in the ContractEngine. Extract sub-fields in `handleDelivery()`, not via ECE field paths.
- StreamContext: append-only deliveries, derive display state via `useMemo`, never poll the backend

### Chakra UI v3
- v3 only — use `disabled` not `isDisabled`, `loading` not `isLoading`, `colorPalette` not `colorScheme`
- Always use theme CSS variables — never hardcode hex/rgba colors
- Compound components: `<Tabs.Root>`, `<Dialog.Root>`, `<Field.Root>`

## Build Hygiene

- Run `pnpm --filter @fredo/ui build` after UI changes — fix all TypeScript errors
- Run `cargo check` after Rust changes — zero warnings
- Run `pnpm dev:ui` from repo root for Vite dev server

## SDD Pipeline Hygiene

- **Always work from `main`** — never start a new spec from a spec branch. After a spec completes or is abandoned, check out `main` and clean stale branches.
- Run `powershell -File .opencode/scripts/clean-stale-branches.ps1 -DryRun` periodically to find orphaned branches.
- Before creating a new spec, verify: `git branch --show-current` returns `main`. If not, check out main first.
- Pipeline state is tracked in `.opencode/metrics.json` and `.opencode/IMPROVEMENTS.md`. Read both before starting new work to avoid repeating past failures.
- **After modifying any pipeline script, run `powershell -File .opencode/scripts/test-scripts.ps1`** — all tests must pass (count varies; the script reports total/passed/failed/skipped). This catches broken `gh` CLI flags, syntax errors, and API contract changes.
- **Pipeline scripts auto-log failures** to `.opencode/state/script-errors.jsonl` via `.opencode/scripts/_Common.ps1`. Agents never call the logger directly — every nonzero exit from a wrapped script writes a JSONL entry automatically. `retro-append.ps1` surfaces spec-scoped error counts during retrospective.