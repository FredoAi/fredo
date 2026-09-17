# Fredo — Frequently Asked Questions

## General

### What is Fredo?

Fredo is a desktop platform for working with AI coding agents. It packages a Rust backend (Tauri v2) and a reactive React 19 UI into a single desktop app. Agents send telemetry to local OTLP receivers, which persist every raw span/metric/log on receipt and then classify each one onto canonical SQLite rows. Those rows stream to the UI in real time as row deliveries, and declarative frontend features subscribe to them via `useEventRows` — no polling. Fredo also includes local OTLP receivers (gRPC :4317, HTTP :4318) and a companion backed by a managed out-of-process `llama-server`.

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

The companion runs the model set configured in the Companion setup (`<models_dir>/gemma-4-e2b-it-qat/`); there is no separate in-app model selector.

### Where do I put model files?

For the **Companion**, you usually don't place them manually: the setup wizard's **Model files** step downloads the three required files (model + vision projector + MTP speculative draft) in-app with per-file progress, skip-present, and SHA-256 verification, landing them under `<models_dir>/gemma-4-e2b-it-qat/` (the models directory is configurable via the `models_dir` setting; default `~/fredo-models`). Correctly-sized files dropped there manually are detected by **Re-check**.

To place files manually, drop the correctly-sized GGUFs under `<models_dir>/gemma-4-e2b-it-qat/` — e.g. `~/fredo-models/gemma-4-e2b-it-qat/gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf`.

### Does Fredo run llama.cpp as a subprocess?

Yes. Companion inference is served by a managed **`llama-server`** child process, launched from a generated launch config once setup is complete. Fredo health-checks the server before chatting, streams tokens over the server's HTTP API, and stops the process on exit so no orphan survives. The legacy in-process engine — and its `llama-cpp-2` dependency — is retired.

### Does Fredo support voice input?

Yes — an **opt-in, on-device** voice-input feature (**Settings → Companion → Voice input**; default off). Speech is transcribed locally by a bundled `sherpa-onnx` streaming engine and **no audio or transcript ever leaves your machine** — the only network use is the one-time model download (four files, ~72.7 MB) through the same download + SHA-256 verify path as the companion models. The **Voice input model** step lives in the Companion setup wizard and is **optional and non-gating**: installing or removing it never blocks companion chat. To dictate, focus the launcher's search bar while it is **empty** and **hold Space** (#2882) — listening starts after a short hold and continues only while Space is held; releasing finalizes the recognized words into the bar as ordinary editable text. A quick tap of Space is an ordinary space character, and so is any Space typed into a bar that already contains text; with voice input disabled or its model not installed, holding Space captures nothing, surfaces no error, and an ordinary space lands. While listening, live partials render into the launcher command bar and stay editable, and the bar's cue (the `Listening` chip and placeholder, announced as text) indicates the capture for its whole duration. On release the transcript waits in the bar as editable text, and **Enter sends a dictated transcript to Fredo** — never to an app, even after you edit it so that it spells an app name. The optional **Send voice transcripts automatically** toggle (Settings → Companion → Voice input, default off) submits on release instead of waiting for Enter. Cancel (Escape or the bar's cancel control) discards the utterance and never sends or launches, and a dictated turn is sent exactly once. Separately, **Ctrl+Space** brings the launcher command bar to the front and focuses its search field — nothing else: it never starts or stops listening, and it never closes the bar.

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

An animated sprite on the Home panel with an LLM-powered personality. Single-click for a joke, double-click to play Tic-Tac-Toe, Ctrl+right-click to teleport to another window. Uses the managed out-of-process `llama-server` for all interactions. Fredo expresses distinct moods on both the companion and the launcher mascot: `thinking` while an LLM response is pending, `joking` while a joke streams, `happy` after a joke or a Tic-Tac-Toe outcome, and `playful` at rest (a bounded beat that always returns to idle; reduced motion is respected).

The launcher's desktop mascot and the companion are **the same Fredo**, with one home: the **desktop centre seat**. Turning the companion ON does not move him — it activates his AI/companion role **in place** on the centre slot, and turning it off returns that same seat to the decorative mascot. **Ctrl+right-click teleport is the only relocation mechanism**; while Fredo is away (teleported within the window, or hosted in the terminal window) the centre seat shows an **empty-seat placeholder of the same 80×100 size**, so the launcher and command bar never shift. After an idle period with no interaction (default 60 s, configurable in **Settings → Companion**) Fredo auto-returns to the seat. Any interaction resets the timer, and an open Tic-Tac-Toe, an active joke stream, or a reply you are reading (the pointer over it or keyboard focus inside it, #2883) keeps him out while in use; auto-return never turns off your "Show Fredo Companion" preference. Each turn-on also shows a short welcome bubble (~4 s, `At your service. How can I help?`) above the seat. Whatever he is saying — the welcome, a joke, or a reply — the message surface **never covers Fredo**: it is placed **above him or beside him** (never over him) with a fixed **14 px** gap from his 80×100 footprint, and that gap holds as the message grows, for every message kind.

### How do I talk to Fredo from the launcher?

Turn the companion ON, then type in the launcher command bar. The bar is **multiline** (#2883): a long query wraps onto more lines instead of running out of sight — it grows to five lines, then scrolls internally — and the Enter hint and the collapse control always stay clear of your text. **Shift+Enter** starts a new line while `Enter` keeps the action the hint names. The hint in the bar always states which of its two actions Enter will take. If the query names an app — case-insensitively, either as a prefix of that app's displayed name (`set` → **Settings**, `Mission Mon` → **Mission Monitor**) or as a whole word inside it (`Miss`, `monitor` → **Mission Monitor**) — Enter opens that app, whatever the companion is doing (present, away, off, or replying); when several apps match, the top-ranked result opens. Any other query is sent to Fredo and the reply streams into the surface near his seat (above it by default, beside it when the window is short). That surface **grows with the answer** — up to the width of the bar and the room available in the window, never covering the command bar — and **scrolls** when the answer is longer than that, so every part of it can be read. It also **never covers Fredo himself** (#2886): the card is anchored to his measured avatar footprint with a fixed **14 px** gap on the side facing him, so the gap stays the same from a one-line answer to a full scrolling reply; it is placed above him or to one of his sides (never over him), it never covers the app tiles — which stay visible and clickable while you read — and when the window is genuinely too small to fit both a usable card and that gap it **shrinks and scrolls** rather than growing over him. Enter never matches a fragment of a sentence: `Missing all the time` is sent to Fredo although it contains `Miss`. A **dictated** transcript is always Fredo's — Enter sends it to Fredo even after you edit it, and it never opens an app. Each message is independent — there is no chat history. A reply stays while you are reading it: it does not disappear while the pointer is over it or keyboard focus is inside it — even if its dismiss countdown had already started — and it closes only after you leave it (a short two-second grace). If you scroll back into a reply that is still arriving, your place stays put; a **Newest** control appears to jump back to the latest text. While Fredo is replying, the bar shows `Fredo is replying…` and its input is read-only until the reply finishes. If the model isn't ready or errors, you get a short readable message instead of a raw error. When the companion is off (or away), the bar is the app filter/launcher it always was, and Enter still opens the app a typed query names; text that names no app has nowhere to go and stays in the bar.

### How do I get the companion ready to use?

Open **Settings → Companion**. If the runtime is not fully set up, the panel shows a guided setup wizard (instead of the normal companion controls) that checks its prerequisites independently: the **llama.cpp runtime** (`llama-server` availability) and the required **model files**. The llama.cpp step offers a one-click `winget install llama.cpp` and re-checks readiness automatically — no app restart — and shows an actionable message if `winget` is unavailable or the install fails. The **Model files** step lists the three required files individually, downloads them in-app with per-file progress (skipping files already present), resumes an interrupted transfer, and names exactly which file(s) are missing. Once all prerequisites read as satisfied, the normal companion controls appear. See the [Setup Guide](SETUP.md#companion-setup).

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
