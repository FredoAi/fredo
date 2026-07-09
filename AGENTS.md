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
│   │   ├── storage/         # AppStore (SQLite KV) + FeatureStore (typed feature-level SQLite)
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
- MCP bridge binds to `127.0.0.1:9223` (localhost only, pinned in `lib.rs`) — deterministic, no port scanning
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
- **ECE filtering fields (Spec #382):** `EventContractDeclaration` supports optional `transports?: string[]` and `eventTypes?: string[]` fields. These filter events at the ContractEngine level — only events whose `transport` and `eventType` match the declared values reach the feature. Backward-compatible: omitting these fields means "match all." Transport names use snake_case (`hook`, `otlp_grpc`, `otlp_http`); event type names also use snake_case (`chat`, `tool_use`, `agent_session`). Use these filters to prevent duplicate nodes from dual-transport (Hook + OTLP) events and to exclude streaming delta events (`message.part.updated`, `message.updated`) from node-creation contracts.
- StreamContext: append-only deliveries, derive display state via `useMemo`, never poll the backend
- **Persistence across mount/unmount:** React refs (`useRef`) reset on every component mount — do NOT use them to track state that must survive component close/reopen cycles (e.g. deleted session IDs, user preferences). Use module-scoped state (module-level `Map`/`Set`, FeatureStore SQLite, or `AppStore`) instead.
- **SQLite FeatureStore upserts:** Use `featureStoreUpdate` (atomic UPDATE) to modify existing rows. Never use `featureStoreDelete` + `featureStoreInsert` as an upsert — the delete+insert window allows concurrent operations to interleave.
- **Ordered async persistence:** When persisting multiple items where order or completeness matters (e.g., delivery events before updating delivery count), use `await` inside the loop, not fire-and-forget. Wrap in an async IIFE if inside a non-async effect.
- **Non-idempotent content merging on ECE updates:** When processing ECE lifecycle deliveries (Init → Update → End), update deliveries carry partial content. Never replace entire state objects — spread-merge: `state.payload = { ...state.payload, ...delivery.payload }`. Init-time data (user message, session metadata) must survive through subsequent update deliveries. Full replacement wipes prior lifecycle data.
- **OTLP payload dual-path extraction:** When the same frontend component consumes events from both Hook (nested `{info: {}, part: {}}`) and OTLP (flat `{gen_ai.usage.*}`) transports, always extract fields from BOTH possible paths with fallback: `(p.info?.turnInputTokens as number) ?? (p['gen_ai.usage.input_tokens'] as number) ?? 0`. Never assume a single path works for all delivery lifecycles (init vs end payloads may differ). Note: as of Spec #473, Mission Monitor contracts only subscribe to Hook transport (`transports: ['hook']`), so dual-path extraction no longer applies to Mission Monitor — this rule applies only to features that explicitly subscribe to OTLP transports.
- **ReactFlow edges second-pass:** When building ReactFlow graphs, build all nodes first (pass 1), then build all edges (pass 2) referencing the complete node set via `Set<string>`. Never create edges interleaved with node creation — `nodeOrder` may reorder entries across graph rebuilds, causing parent-existence checks to fail when children appear before parents.
- **ReactFlow `selectNodesOnDrag` default (v11):** ReactFlow v11 sets `selectNodesOnDrag: true` by default — nodes only enter `.selected` state on drag, not on click. To enable click-to-select (standard UX), explicitly add `selectNodesOnDrag={false}` to the `<ReactFlow>` component. Spec #440 bug: nodes required drag to select; fixed in PR #455 by adding `selectNodesOnDrag={false}` to `MissionMonitorPanel.tsx:171`.
- **ECE compositing — cross-session parent-child merging (Spec #523):** The ECE (Event Contract Engine) handles parent-child session merging generically via a relationship registry, not at the adapter level. Adapters emit real sessionIds with relationship metadata (`metadata: {relationship: {type: "parent-child", parentSessionId: "<parent>", childSessionId: "<child>"}}`); the ECE composites child session events into the parent's delivery stream. This supersedes the Spec #509 adapter-level sessionId rewrite approach which failed because PostToolUse `task` events fire AFTER `session.created` — the timing gap made sessionId rewriting impossible. The ECE approach works because it composites at the delivery level, not the event level. **Always solve data transformations at the right architectural layer — delivery-level compositing (ECE) is more robust than event-level rewriting (adapter) when timing gaps exist.** The relationship registry (`EngineInner.child_to_parent`, `parent_to_children`) is capped at 10,000 entries with oldest-first eviction. When a relationship is registered, existing child buffers are re-keyed to the parent sessionId (emitting both a `timedOut: true` "end" delivery for the child key and an "update" delivery for the parent key). New child events are composited into the parent's composite key space. The frontend detection pattern (`deliveryCorrelationId(d) !== deliverySessionId(d)`) continues to work unchanged. Composited deliveries include `compositedChildSessionId` in the delivery payload for debugging. **Bug #523 cycle 1:** late relationship metadata (PostToolUse task arriving after child session.created) required emitting BOTH end + update deliveries during re-keying so the frontend could clean up child sessions from the sidebar. **Bug #523 cycle 2:** The OpenCodeAdapter required `parentSessionId` in `tool_response.metadata` to emit relationship metadata, but real opencode PostToolUse `task` events only emit `sessionId` (not `parentSessionId`). The adapter now falls back to the event's own `session_id` as the parent — PostToolUse hooks fire in the parent session context so `session_id` is always the parent. **Adapter fallback pattern:** when an expected metadata field is absent from real events, fall back to event-level context (e.g., `session_id`, `correlation_id`) rather than silently failing. **Guardrails:** (1) `childSessionId` must be non-empty — empty child rejected. (2) Self-referencing relationships (`child == parent`) must be rejected — a session cannot be its own parent.
- **Subagent agent-name filter (Spec #509 cycle 2, retained in #523):** When the adapter detects a parent-child relationship via PostToolUse `task` events, it MUST check the tool name to exclude internal OpenCode tool-execution agent sessions (`build`, `plan`). These sessions are spawned internally by OpenCode to execute tool calls in sub-sessions and are NOT user-requested @-subagent dispatches. Without this filter, the adapter emits spurious relationship metadata for internal tool sessions, causing the ECE to create spurious SubagentNodes for every tool execution (11+ nodes instead of 1). The adapter-level PostToolUse `task` handler only emits relationship metadata for the `task` tool (not `build`/`plan` internal agents). The frontend belt-and-suspenders check in `useMissionMonitor.ts` remains as-is for additional safety. **Always verify agent identity when emitting relationship metadata — not all child sessions are user-requested subagents.**
- **useEffect re-render loops (Bug #523 cycle 1):** Never depend on array `.length` or newly-created object references in `useEffect` / `useMemo` dependencies when those values change on every render. The `events.length` or `deliveries.length` from `useStream()` increments on every ADD_DELIVERY dispatch — using it as a dependency triggers a state update (`setState` inside the effect) → re-render → new `.length` → effect runs again → infinite loop. Fix pattern: use a monotonic epoch counter that only advances when meaningful data changes (e.g., when the latest delivery timestamp differs from the previous). Derive display state via `useMemo` instead of `useEffect` + `setState`. This pattern also applies to inline object/array creation in JSX props — extract to stable refs or `useMemo`. Spec #275 had 3 separate re-render loops; Bug #523 cycle 1 had StreamStatus.tsx "Maximum update depth exceeded" from `useEffect(() => {...}, [isConnected, events.length])`.
- **Mock vs real event payload mismatch:** `fredo emit` mock events and real opencode agent events have DIFFERENT payload structures. NEVER assume mock payload fields exist in real events. Key differences: user prompt is in `chat.message` `output.message.parts[0].text` (not `UserPromptSubmit` `properties.text`), token counts are in `info.tokens.input/output` (not `turnInputTokens`/`turnOutputTokens`), parent-child relationships are in `tool_response.metadata.sessionId` (the child session) — `parentSessionId` is NOT always present in real opencode events; the adapter falls back to the event's own `session_id` as the parent (Bug #523 cycle 2), and `session.next.tool.*` events do NOT exist in real opencode. Always verify extraction paths against the telemetry database (`telemetry_spans` table) via `.opencode/skills/telemetry-query/telemetry-query.ps1` — use real paths with mock fallbacks, not the reverse.

- **Adapter field-presence fallback (Bug #523 cycle 2):** When adapter code extracts fields from agent event payloads, never assume that optional metadata fields are present. Real agent events frequently omit fields present in mock/test payloads. Pattern: chain `.filter(|s| !s.is_empty())` for extracted fields and `.or(Some(fallback))` for missing parent/owner fields. The fallback should use event-level context (e.g., `session_id`, `correlation_id`) — PostToolUse hooks fire in the parent session context, so `session_id` is always the parent when `parentSessionId` is missing. **Always add guardrails for extracted IDs: (1) empty value check, (2) self-referencing check.** Spec #265 fictional events, Spec #509 `properties.info.parentID`, and Bug #523 cycle 2 `parentSessionId` all failed because adapter code expected fields that real events don't emit. This is a 3-spec/bug recurring pattern.

### Chakra UI v3
- v3 only — use `disabled` not `isDisabled`, `loading` not `isLoading`, `colorPalette` not `colorScheme`
- Always use theme CSS variables — never hardcode hex/rgba colors
- Compound components: `<Tabs.Root>`, `<Dialog.Root>`, `<Field.Root>`
- **`NativeSelect` component:** `NativeSelect.Root` + `NativeSelect.Field` + `NativeSelect.Indicator` render a native HTML `<select>` element that does NOT inherit Chakra theme tokens (`--card-bg`, `--text-primary`, `--border-color`). The result is unstyled browser-default dropdowns that don't adapt to Fredo's theme. Prefer `<chakra.select>` with explicit CSS variable props (`bg`, `borderColor`, `color`, `_hover`, `_focus`, `_disabled`) for dropdowns that must match the application theme. Spec #431 fix (PR #437): replaced 3 NativeSelect usages with `chakra.select` + CSS variable props.
- **Global CSS + `colorPalette` interaction:** The global CSS rule in `apps/ui/src/app/theme/system.ts` (`button[data-variant="outline"]: { borderColor: 'var(--border-color)' }`) overrides Chakra's native border coloring for ALL outline buttons. This means `variant="outline" colorPalette="red"` on a `<Button>` will NOT produce red borders — the border will always be `var(--border-color)`. When you need a specific status color on a button, prefer `variant="solid"` with explicit `bg` + `color` CSS variables (e.g. `bg="var(--status-error)" color="white"`), or verify the outline variant renders correctly across BOTH light and dark themes. Spec #431 bug: purge button used `variant="outline" colorPalette="red"` — red text on neutral border was hard to see in both themes (fixed in PR #437).

### Settings UI Hierarchy (Spec #396)
- **The main settings dialog** is `apps/ui/src/features/home/components/ProfileSettingsModal.tsx` — a sidebar-nav modal with static sections (Companion, Appearance, Fredo Setup) plus auto-discovered feature-level sections via `hasSettings`.
- **`SettingsPanel.tsx`** is a **legacy tab-based component** — do NOT target it for new settings. The settings dialog uses `ProfileSettingsModal`, NOT `SettingsPanel`.
- When the Architect's spec **forbidden_changes** lists `ProfileSettingsModal.tsx`, that is a signal that the settings modal shell must not be modified — but the feature's settings content must be wired INTO it. The Architect MUST include the wiring in the capsule that creates the settings UI component (add nav item + content section to ProfileSettingsModal).

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
- **Exploratory performance audits (Spec #498 pattern):** For performance/audit specs where root causes are unknown upfront, the Architect should extend the Research Phase (Step 1b) to include: (a) actual code profiling with Chrome DevTools Performance tab + Rust memory profiling tools, (b) internet research on framework-specific memory/performance best practices (Tauri, React, ReactFlow), (c) concrete Before/After metrics for each identified leak, and (d) a Domain Model that cites file:line for every unbounded structure found. Only AFTER profiling data is collected should EARS requirements be written and capsules decomposed. This approach (vs. prescriptive requirement-first design) achieved 4/4 capsules first-pass, 0 bugs, 0 retries on Spec #498.