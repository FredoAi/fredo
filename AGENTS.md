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
Agent → Adapter.transform() → Vec<FredoEvent> → EventBus.emit()
  → Tauri IPC "fredo-stream-event"
  → TauriAdapter.onMessage() → AppProvider → StreamContext
  → Features (matched via eventFilters or eventSubscriptions)
```

### Feature Contracts

Features declare what events they need through one of two mechanisms:

- **`eventFilters`** (legacy) — simple toolName/state/custom matchers on raw FredoEvents
- **`eventSubscriptions`** (Spec #252) — typed subscriptions that assemble raw events into contract objects delivered via Init → Update → End lifecycle. Contracts extend `EventContract` (e.g. `ChatNodeContract`). Features using subscriptions should not also use eventFilters for the same events.

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

### Frontend (React/TypeScript)
- All grid features extend `FredoFeatureClass`
- Never statically import `@tauri-apps/api` — only dynamic imports in `TauriAdapter.ts`
- Use `adapterBridge.invoke()` for Tauri commands from non-React code
- Use `crypto.randomUUID()` — no `uuid` package installed
- Register features via `registerFeature()` in `index.ts`
- Never edit `Home.tsx` to add features — it calls `getFeatures()` automatically
- All public API consumed by `apps/tauri` must be exported from `src/index.ts`
- Feature contracts extend `EventContract` with a unique `name`; declared in `shared/classes/EventSubscription.ts`
- Features use `eventSubscriptions` (new) or `eventFilters` (legacy) — not both for the same events

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