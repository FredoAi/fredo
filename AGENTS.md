# Fredo

Desktop platform for working with AI coding agents. Built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend). Agent telemetry flows through the **RTDB row pipeline** — an ingest classifier maps OTLP spans and CLI events onto typed SQLite rows that stream to the webview and feed declarative frontend features via `useEventRows` subscriptions.

> **Pipeline agents:** all agents in the agentic pipeline follow the **common rules** in `docs/agentic-pipeline/common-rules.md` (research, shared references usage, citing sources, cross-cutting behavior) in addition to the universal rules below. The shared agent-editable references live in `docs/agentic-pipeline/playbooks/references.md`.

## Architecture Concepts

### Communication Layer (`infrastructure/comm/`)

The `comm` module holds the canonical wire types and the single IPC emitter:

- **`FredoEvent`** — the `fredo emit` CLI wire format (id, eventType, state, provider, transport, sessionId, correlationId, toolName, payload, error, metadata, timestamp). Serialized as camelCase. DEMOTED in Spec #2788 P5.1: the CLI wire format + classifier input — it never crosses IPC to the webview.
- **`EventBus`** — emits RTDB `RowDeliveryBatch` envelopes on the `"fredo-stream-event"` Tauri IPC channel via `emit_row_delivery_batch` (the ONLY sanctioned RTDB emission path).
- **`CommAdapter`** trait — implemented by `InternalAdapter` (the `fredo emit` enrichment).

### RTDB Row Store (`infrastructure/rtdb/`)

The production event pipeline (Spec #2788):

- **`ingest.rs`** — the IngestClassifier: maps every OTLP span / CLI event onto zero or more canonical row upserts, UNCONDITIONALLY (never gated by subscriptions — that is what makes replay work). Owns the correlation maps + the parent-child relationship registry (both capped at 10,000 entries, oldest-first eviction).
- **`attrs.rs`** — the pure GenAI-attribute extract helpers + registry constants (relocated verbatim from the deleted v1 adapter) — ONE shared extract-rule implementation for the live classifier and the canonical backfill (NFR-6).
- **`store.rs` / `cache.rs`** — SQLite-authoritative rows (`chat_rows` / `tool_use_rows` / `agent_session_rows` in fredo.db) behind an LRU cache + ~30 ms write-behind queue; never touches `telemetry_spans`.
- **`flush.rs`** — coalescing windows (~5 ms), `RTDB_MAX_EMISSION_BATCH = 512` chunking, per-query `replayCompleteQueryId` settle markers.
- **`commands.rs`** — `subscribe_events` (async; register-before-snapshot, background `spawn_blocking` replay drain — F-33) / `unsubscribe_events`.
- **`backfill.rs`** — one-shot canonical backfill of pre-cutover history from `telemetry_spans` (strictly READ-ONLY), gated by the `rtdb.backfill.completed` marker.
- **`query/`** — the GraphQL-inspired typed query language (`chat(sessionId = "s1") { userMessage }`) with hard-named validation errors.

### Event Flow (unidirectional)

```
Agent (OTLP) → OTLP receivers (raw persist on receipt → telemetry_spans/metrics/logs)
             → IngestClassifier (rtdb/ingest.rs) → RowUpserts → Rtdb (merge → durable seq
             → subscriptions) → FlushLoop → EventBus.emit_row_delivery_batch()
             → Tauri IPC "fredo-stream-event" (RowDeliveryBatch only)
             → TauriAdapter.onMessage() → AppProvider → StreamContext row store
             → useEventRows(eventType, args) → features
```

`fredo emit` → named pipe → `CliCommand::EmitEvent` → `InternalAdapter::enrich` → `classifier.ingest_event` → same row path. Raw `FredoEvent` never crosses IPC to the webview — only `RowDelivery`/`RowDeliveryBatch` envelopes do.

### Feature Row Subscriptions

Features read live agent activity through **`useEventRows(eventType, args, options)`** (`shared/hooks/useEventRows.ts`):

- `rows` — the typed partition map; `epoch` — a monotonic counter that advances only on real mutations (memo/effect off the primitive, never map identity or size); `ready` — resolves on the backend's per-query replay-completion marker, never on subscribe resolution alone.
- Merge semantics in the module-scoped store (`StreamContext.tsx`): `insert` = full-row set with spread-merge (init-time fields survive); `update` = `{ ...row, ...patch }` with seq-guarded stale-patch drops; `remove` = only ever retention eviction. No TTL, no cap on live rows — replay replaces hydration.
- The backend filters per-query by the declared args; the partition map is shared per event type, so arg-scoped consumers filter their own rows client-side (epoch-keyed memo) — the documented consumer-side pattern (`stepper-probe`).
- The v1 per-feature contract-delivery machinery (contract declarations, delivery routing, defensive payload fallbacks) was deleted in Spec #2788 P5.1 — do not re-introduce fallback extraction paths; the classifier's canonical projection is the contract.

## Project Structure

```
apps/
├── tauri/src-tauri/src/     # Rust backend
│   ├── main.rs              # dual-mode entry (GUI vs CLI dispatch)
│   ├── lib.rs               # AppRuntime composition root; registers EventBus, commands, state
│   ├── features/            # autonomous feature modules (no cross-feature imports)
│   ├── infrastructure/      # shared platform services
│   │   ├── comm/            # canonical wire types (FredoEvent CLI wire) + EventBus (row-batch emitter)
│   │   ├── rtdb/            # RTDB row store (Spec #2788): classifier, rows, merge, cache, flush, query, backfill
│   │   ├── storage/         # AppStore (SQLite KV) + FeatureStore (typed feature-level SQLite)
│   │   ├── ipc.rs           # local socket server + CliCommand dispatch
│   │   ├── cli/             # clap CLI parser
│   │   └── otlp/            # OTLP receivers (gRPC :4317, HTTP :4318)
│   ├── runtime/             # AppRuntime + capability traits (DesktopCapable, CliCapable)
│   └── utils/               # stateless helpers (errors, event dump)
└── ui/src/                  # React frontend
    ├── app/                 # adapters, providers, routes, theme
    ├── features/            # grid-based features (FredoFeatureClass)
    └── shared/              # classes (EventSubscription row wire types, types), contexts (StreamContext row store), hooks (useEventRows)
```

## Key Commands

- `cargo build` — build from `apps/tauri/src-tauri/`
- `pnpm dev:tauri` — run dev server (Vite on port 5174)
- `pnpm --filter @fredo/ui build` — build UI library, verify TypeScript
- `pnpm dev:ui` — start Vite dev server

## Universal Rules

### Backend (Rust/Tauri)
- Never create follow-up backlog issues from within a spec. The pipeline loops until all ACs pass. If an AC is blocked by infrastructure or architectural constraints, loop back to Phase 2 (Architect) and redesign the spec scope to include those fixes. The human alone abandons a spec.
- No cross-feature imports — features never import from other features
- Always use `tauri::async_runtime::spawn` — never `tokio::spawn` (panics with "no reactor")
- Register new commands in `lib.rs` → `AppRuntime`
- Zero warnings — do not suppress with `#[allow(...)]`
- Row-pipeline code goes in `infrastructure/rtdb/` — one module per concern (ingest, merge, flush, query); `comm/` stays minimal (wire types + EventBus)
- New `Transport` variants added in `infrastructure/comm/event.rs`
- Emit to the webview ONLY via `EventBus.emit_row_delivery_batch` — never call `app_handle.emit()` for row deliveries directly
- Serde: structs crossing IPC use `#[serde(rename_all = "camelCase")]`; enums use `#[serde(rename_all = "PascalCase")]`
- clap: use `#[derive(Parser)]`; keep `Args` structs small and focused
- Error handling: use `anyhow::Result`; propagate with `?`, never `unwrap()`
- State belongs in the feature module, not in `infrastructure/`
- Emit events via `EventBus`, never call `app_handle.emit()` directly
- MCP bridge binds to `127.0.0.1:9223` (localhost only, pinned in `lib.rs`) — deterministic, no port scanning
- OTLP receivers bind to `127.0.0.1:4317` (gRPC) and `127.0.0.1:4318` (HTTP); only spans reach the UI, metrics/logs dropped
- **OTel GenAI semantic conventions are the source of truth** for all `gen_ai.*` emission from `apps/opencode-plugin` (spans, agent spans, events, exceptions, metrics). Reference: https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai/ (files: `gen-ai-spans.md`, `gen-ai-agent-spans.md`, `gen-ai-events.md`, `gen-ai-exceptions.md`, `gen-ai-metrics.md`). Any attribute emitted under `gen_ai.*` MUST match a key defined in that registry; a convention the spec renamed (e.g. legacy `gen_ai.system` → `gen_ai.provider.name`) MUST be emitted under its current spec name. Deviations require a PO-amended acceptance criterion — triage may never silently substitute an AC's observable key.
- LlmEngine runs in-process — never spawn `llama-server` subprocess

### Frontend (React/TypeScript)
- All grid features extend `FredoFeatureClass`
- Never statically import `@tauri-apps/api` — only dynamic imports in `TauriAdapter.ts`
- Use `adapterBridge.invoke()` for Tauri commands from non-React code
- Use `crypto.randomUUID()` — no `uuid` package installed
- Register features via `registerFeature()` in `index.ts`
- Never edit `Home.tsx` to add features — it calls `getFeatures()` automatically
- All public API consumed by `apps/tauri` must be exported from `src/index.ts`
- Features read live agent activity via `useEventRows(eventType, args, options)` — typed RTDB row queries with replay + live patches; `ready` resolves on the backend's per-query replay-completion marker, never on subscribe resolution alone
- The row store is module-scoped (`StreamContext.tsx`): `insert` spread-merges so init-time fields survive, `update` carries seq-guarded stale-patch drops, `remove` is only ever retention eviction. Do not bypass these semantics.
- The backend filters per-query by declared args, but the partition map is shared per event type — arg-scoped consumers filter their own rows client-side (epoch-keyed memo)
- StreamContext carries only the connection flag + the row store — derive display state via `useMemo`/`useSyncExternalStore` off the row-store epoch, never poll the backend
- **Persistence across mount/unmount:** React refs (`useRef`) reset on every component mount — do NOT use them to track state that must survive component close/reopen cycles (e.g. deleted session IDs, user preferences). Use module-scoped state (module-level `Map`/`Set`, FeatureStore SQLite, or `AppStore`) instead.
- **SQLite FeatureStore upserts:** Use `featureStoreUpdate` (atomic UPDATE) to modify existing rows. Never use `featureStoreDelete` + `featureStoreInsert` as an upsert — the delete+insert window allows concurrent operations to interleave.
- **Ordered async persistence:** When persisting multiple items where order or completeness matters (e.g., delivery events before updating delivery count), use `await` inside the loop, not fire-and-forget. Wrap in an async IIFE if inside a non-async effect.
- **Row patch merging is never full replacement:** update patches carry partial content. The store spread-merges (`{ ...row, ...patch }`) — init-time data (user message, session metadata) survives through subsequent patches. Never reintroduce code that replaces whole row objects from a patch.
- **ReactFlow edges second-pass:** When building ReactFlow graphs, build all nodes first (pass 1), then build all edges (pass 2) referencing the complete node set via `Set<string>`. Never create edges interleaved with node creation — `nodeOrder` may reorder entries across graph rebuilds, causing parent-existence checks to fail when children appear before parents.
- **ReactFlow `selectNodesOnDrag` default (v11):** ReactFlow v11 sets `selectNodesOnDrag: true` by default — nodes only enter `.selected` state on drag, not on click. To enable click-to-select (standard UX), explicitly add `selectNodesOnDrag={false}` to the `<ReactFlow>` component. Spec #440 bug: nodes required drag to select; fixed in PR #455 by adding `selectNodesOnDrag={false}` to `MissionMonitorPanel.tsx:171`.
- **Parent-child compositing — cross-session merging (Spec #523, row-native since #2788):** the ingest classifier's relationship registry (`rtdb/ingest.rs`) composites child-session rows under the parent key — child rows are COPIED under the parent sessionId carrying the `parentSessionId` + `compositedChildSessionId` stamps; a re-key NEVER removes rows (only retention eviction emits `kind: remove`). **Always solve data transformations at the right architectural layer — delivery/row-level compositing is more robust than event-level rewriting when timing gaps exist.** The relationship registry is capped at 10,000 entries with oldest-first eviction. Frontend ownership of a task dispatch derives PRIMARILY from the correlationId's session prefix (`<sessionId>_<counter>`), with `compositedChildSessionId` only as the guarded fallback for non-prefixed (legacy/mock) corrIds — the classifier preserves the FIRST stamp across multi-hop re-keys (first-wins).
- **Subagent agent-name filter (Spec #509 cycle 2, retained in #523):** the classifier MUST check the agent name to exclude internal OpenCode tool-execution agent sessions (`build`, `plan`) when registering child→parent relationships. These sessions are spawned internally by OpenCode to execute tool calls in sub-sessions and are NOT user-requested @-subagent dispatches. Without this filter, spurious relationships create spurious SubagentNodes for every tool execution (11+ nodes instead of 1). The frontend belt-and-suspenders check in `useMissionMonitor.ts` remains as-is for additional safety. **Always verify agent identity when registering relationship metadata — not all child sessions are user-requested subagents.**
- **useEffect re-render loops (Bug #523 cycle 1):** Never depend on array `.length` or newly-created object references in `useEffect` / `useMemo` dependencies when those values change on every render. Using a length that increments per applied delivery as a dependency triggers a state update (`setState` inside the effect) → re-render → new `.length` → effect runs again → infinite loop. Fix pattern: use a monotonic epoch counter that only advances when meaningful data changes (the row store's `epoch` advances only on real mutations — consume it). Derive display state via `useMemo` instead of `useEffect` + `setState`. This pattern also applies to inline object/array creation in JSX props — extract to stable refs or `useMemo`. Spec #275 had 3 separate re-render loops; Bug #523 cycle 1 had StreamStatus.tsx "Maximum update depth exceeded" from `useEffect(() => {...}, [isConnected, events.length])`.
- **Mock vs real event payload mismatch:** `fredo emit` mock events and real opencode agent events have DIFFERENT payload structures. NEVER assume mock payload fields exist in real events. Key differences: user prompt is in `chat.message` `output.message.parts[0].text` (not `UserPromptSubmit` `properties.text`), token counts are in `info.tokens.input/output` (not `turnInputTokens`/`turnOutputTokens`), parent-child relationships are in `tool_response.metadata.parentSessionId` (not `properties.info.parentID`), and `session.next.tool.*` events do NOT exist in real opencode. Always verify extraction paths against the telemetry database (`telemetry_spans` table) via `.opencode/skills/telemetry-query/telemetry-query.ps1` — use real paths with mock fallbacks, not the reverse.
- **Classifier extraction: one shared rule implementation (NFR-6):** the live ingest classifier and the canonical backfill MUST share the SAME extract helpers (`rtdb/attrs.rs`) so re-derivation is byte-comparable with live derivation. Never duplicate an extraction path in backfill code.
- **Contract-Trust Cleanup:** When upstream normalization (classifier projections, row merge rules) makes frontend defensive extraction code obsolete, schedule a follow-up cleanup spec to remove it. Do NOT leave fallback code coexisting with upstream normalization — the dual-system pattern creates maintenance debt where neither path is authoritative and both must be maintained. The positive rule: once the row store guarantees a field exists at a known path, use a single direct extraction path — zero `??` fallback chains, zero multi-path lookups, zero text filtering. Spec #568 demonstrated this: after upstream normalization injected typed fields, the cleanup round safely removed -706 lines of dead fallback code (30+ `??` fallback paths, 185-line `filterSubagentOutput` function, 5 deprecated multi-path extraction functions) with zero bugs. Follow-up cleanup must NOT be an afterthought — for any spec that normalizes data paths, catalog now-obsolete frontend fallback extraction paths and either include them in the same spec or create a backlog item.

### Chakra UI v3
- v3 only — use `disabled` not `isDisabled`, `loading` not `isLoading`, `colorPalette` not `colorScheme`
- **All colors come from the theming feature — never hardcode hex/rgba.** The color flow: Chakra semantic tokens (`bg.*`, `fg.*`, `accent.*`, `status.*`, `border.*` in `apps/ui/src/app/theme/system.ts`) → CSS variables (`--body-bg`, `--card-bg`, `--text-primary`, `--accent-primary`, `--status-*`, set by `ThemeProvider`) → user theme (light/dark + accent via the theming feature). Components read a token (`bg="bg.surface"`) or its var (`bg="var(--card-bg)"`), never a raw value. The theming feature must be able to restyle every surface by changing only its token definitions.
- **Tint/hover variants use `color-mix` via the shared `tint()` helper** (`apps/ui/src/shared/utils/colorTint.ts`): `tint('var(--accent-primary)', 22)` → `color-mix(in srgb, var(--accent-primary) 22%, transparent)` — NOT `rgba(147,51,234,0.2)` (a hardcoded alpha purple that ignores the user's accent choice). **NEVER alpha-append onto a var() reference** — `var(--accent-primary)22` is INVALID CSS: var() substitution splices tokens without re-lexing, so the appended digits stay a separate token and the browser drops the whole declaration at computed-value time (#2770 round 5: this silently killed the Mission Monitor stripe/borders everywhere it was used). Alpha-append is valid ONLY on literal hex strings (e.g. `` `${'#a855f7'}28` `` — JS concatenation yields a valid 8-digit hex before CSS parsing). `color-mix()` computes live from the var at paint time, so user accent/theme overrides re-tint every surface with zero extra code; Chromium 111+ (WebView2 evergreen).
- **Token-first:** a color with no token must be ADDED to the theming feature before it is used — a semantic token in `system.ts` mapped to a CSS var with light + dark values in the theme. No one-off inline colors in components.
- Allowed literals: `transparent`, `inherit`, `currentColor`, `none`, and non-UI-chrome data/art palettes (terminal ANSI colors, 3D canvas particles) — migrate even those to theme vars where feasible.
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
- Run `rust-script .opencode/scripts/pipeline-state.rs --action prune` periodically to remove leftover local `feat/` branches (legacy) and prune orphaned worktrees (idempotent; a state-machine action like all pipeline writes). It never touches `spec/*` — spec branches are kept as the evidence record. To inspect stale branches read-only first, use `git branch --merged main`.
- Before creating a new spec, verify: `git branch --show-current` returns `main`. If not, check out main first.
- Pipeline state is tracked by the state machine (`.opencode/scripts/pipeline-state.rs`); its per-issue event log lives in `.opencode/state/issues/*.jsonl`. Before starting new work, run `--action health` and read `docs/agentic-pipeline/playbooks/references.md` to avoid repeating past failures.
- **All temporal/scratch files for a spec/issue live under `.opencode/tmp/<issue>/`** (gitignored) — one folder per issue, never in the repo. The triage A2A working file is `.opencode/tmp/<issue>/triage.md`; any other throwaway artifacts for that issue (drafts, reports, dumps, screenshots) go in the same folder.
- **Durable per-feature test suites live under `.opencode/tests/<feature>/`** (version-controlled, NOT scratch) — one folder per **feature domain** (e.g. `mission-monitor`), not per issue, so they accumulate across specs. Four files per feature: `functional.md`, `regression.md`, `exploratory.md`, `smoke.md` (conventions in `.opencode/tests/README.md`). QA Expert seeds them at triage; Tester executes + expands them (exploratory findings promote to functional); persisted to `main` via the state machine's `tests-commit --issue <N> --feature <name>` action. Test files are never committed directly by agents — `tests-commit` is the only writer.
- **After modifying any pipeline script, run `powershell -File .opencode/scripts/test-scripts.ps1`** — all tests must pass (count varies; the script reports total/passed/failed/skipped). This catches broken `gh` CLI flags, syntax errors, and API contract changes. **The harness runs fully offline** against a mock GitHub (`FREDO_MOCK_GH=1` routes every `gh`/`git` call through `mock_gh`/`mock_git` in `pipeline-state.rs` to a throwaway `%TEMP%/fredo-mock-repo-*` JSON store) — a validation run never creates real GitHub issues/PRs/spec-branches.
- **Never Grep the installed plugin path (`~\.config\opencode\plugins\fredo.js`)** — the Grep tool stalls on the `~` home-dir path on Windows (observed #2770 rounds 3-4; two tester rounds lost). Verify plugin currency with `Get-FileHash` vs `apps/opencode-plugin/dist/index.js` + `Select-String -LiteralPath` with **bundle-form** anchors — see G-084 in `.opencode/skills/dev-environment/SKILL.md`.
- **Retry state is derived, not self-reported.** The state-machine context block surfaces `Attempt: round N (RETRY — completing missed ACs)` + `Retry reason:` from the event log's failed `audit.verdict` events, so re-dispatched agents know they are completing missed ACs (not re-doing the feature or reposting prior content). The SI's `audit-record --reason` is the retry context every restarted agent reads — write it as the missed-AC list.
- **Retry rounds are machine-stamped on the GitHub timeline.** The state machine derives the round and stamps it on retry-relevant comments (`## Decision` restart reads `restart → <phase> (round N)`; `## Development Summary`/`## Tests Runs`/`## SI Summary` post as `(round N)`) — agents never write the round themselves. The **round-aware verification guard** enforces it: evidence carrying the current round is required, so a stale round-1 PASS can never clear a round-2 audit (`latest_evidence_comment` parses `(round N)` from the `## Tests Runs` header; untagged evidence counts as round 1).
- **Pipeline errors auto-log** to `.opencode/state/script-errors.jsonl` via `log_error()` inside `pipeline-state.rs`. Agents never call the logger directly — every failed state-machine action writes a JSONL entry automatically. Surface error counts during retrospective via `--action health`.
- **Exploratory performance audits (Spec #498 pattern):** For performance/audit specs where root causes are unknown upfront, the Architect should extend the Research Phase (Step 1b) to include: (a) actual code profiling with Chrome DevTools Performance tab + Rust memory profiling tools, (b) internet research on framework-specific memory/performance best practices (Tauri, React, ReactFlow), (c) concrete Before/After metrics for each identified leak, and (d) a Domain Model that cites file:line for every unbounded structure found. Only AFTER profiling data is collected should EARS requirements be written and capsules decomposed. This approach (vs. prescriptive requirement-first design) achieved 4/4 capsules first-pass, 0 bugs, 0 retries on Spec #498.