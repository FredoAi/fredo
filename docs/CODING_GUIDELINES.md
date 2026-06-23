# Fredo — Coding Guidelines

---

## Feature Module Convention

Both the Rust backend and the React UI are organized as **autonomous feature modules**. This is the primary architectural rule.

### Rule: Each feature owns its vertical slice

A feature module owns everything it needs — models, business logic, state, commands (Rust) or components (TypeScript). Features do not import from each other.

```
// ✅ CORRECT — feature uses shared infrastructure
use crate::infrastructure::comm::{FredoEvent, EventBus};

// ❌ WRONG — feature imports from another feature
use crate::features::k8s::models::GraphNode;   // forbidden inside terminal/
```

```typescript
// ✅ CORRECT — feature uses shared utils
import { adapterBridge } from '../../shared/utils/adapterBridge';

// ❌ WRONG — feature imports from another feature
import { DiagramState } from '../diagram/types';  // forbidden inside terminal/
```

### Rule: Register in the composition root, nowhere else

**Rust:** Register feature state and command handlers in `lib.rs` → `AppRuntime`. Do not call `manage()` or `generate_handler!` anywhere else.

**TypeScript:** Call `registerFeature(new MyFeature())` in the feature's `index.ts`, then import that `index.ts` (side-effect only) in `allFeatures.ts`. Do not call `registerFeature` anywhere else.

---

## FredoFeatureClass Convention (TypeScript UI)

Every UI feature that appears in the grid or reacts to stream events must extend `FredoFeatureClass`.

```typescript
// ✅ CORRECT
class DiagramFeature extends FredoFeatureClass {
  id = 'diagram';
  label = 'Diagram';
  icon = LuNetwork;
  showable = true;
  eventFilters = ['infrastructure_stream'];   // toolNames this feature reacts to
  render() { return <DiagramPanel />; }
}

// ❌ WRONG — ad-hoc component wired to StreamContext without a feature class
export function DiagramWidget() {
  const events = useStream().events.filter(...);
  // ...
}
```

### `eventFilters` is the only reactive coupling

A feature should only react to `toolName` values in its own `eventFilters`. If a feature needs data from another domain, that data should arrive as a separate `FredoEvent` on a `toolName` owned by this feature — not by reading another feature's events.

**EventFilter types:**

```typescript
// Match by toolName
{ toolName: 'infrastructure_stream' }

// Match by state
{ state: 'Response' }

// Custom predicate
{ custom: (event) => event.transport === 'otlp_grpc' }

// Catch-all (Mission Monitor pattern)
{ custom: () => true }
```

### Features with `showable = false`

Stub features that are not yet implemented should set `showable = false` and `eventFilters = []`. They are registered so they are visible in `featureRegistry` (and to agents) but do not render in the navigation grid.

---

## HostAdapter Pattern (Frontend Portability)

The `HostAdapter` interface decouples the React UI from any host environment.

```typescript
export interface HostAdapter {
  onMessage(handler: (msg: any) => void): () => void;
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  llmChat(messages: LlmMessage[], onToken: (t: string) => void, onDone: () => void): Promise<void>;
}
```

### Rule: Never import `@tauri-apps/api` outside `TauriAdapter.ts`

```typescript
// ✅ CORRECT — invoke Tauri via adapterBridge (works in any host)
import { adapterBridge } from '../../shared/utils/adapterBridge';
await adapterBridge.invoke('save_setting', { key, value });

// ❌ WRONG — direct Tauri API inside a feature
import { invoke } from '@tauri-apps/api/core';   // forbidden outside TauriAdapter.ts
```

### Rule: Never poll — only react

```typescript
// ✅ CORRECT — derive state from StreamContext event log
const events = useStream().events.filter(e => e.toolName === 'infrastructure_stream');

// ❌ WRONG — polling the backend
useEffect(() => {
  const id = setInterval(() => adapterBridge.invoke('get_diagram'), 2000);
  return () => clearInterval(id);
}, []);
```

### Adapter Hierarchy

```
HostAdapter (interface)
├── TauriAdapter   → @tauri-apps/api/event listen()   [production]
└── DevAdapter     → in-memory emitter                [Vite dev server]
```

---

## Rust Feature Conventions

### Capability traits must be implemented explicitly

Features declare their surface via traits in `runtime/capability.rs`. Implement only the traits you actually use:

```rust
impl DesktopCapable for K8sFeature {}   // has Tauri commands
impl CliCapable for K8sFeature {}       // reachable from fredo CLI
```

### State belongs in the feature, not in infrastructure

```rust
// ✅ CORRECT — feature owns its own Tauri state
app.manage(Mutex::new(RunCliState::default()));   // in lib.rs, for terminal feature

// ❌ WRONG — infrastructure module holding feature-specific state
// infrastructure/mod.rs should not own RunCliState
```

### Emit events, don't return data

Tauri command handlers should emit `FredoEvent` records rather than returning large payloads. The UI is reactive; it will pick up the event.

```rust
// ✅ CORRECT — emit event via EventBus, return ()
let event = FredoEvent::builder()
    .event_type(EventType::Infrastructure)
    .state(EventState::Response)
    .tool_name("infrastructure_stream".into())
    .payload(serde_json::json!({ "result": data }))
    .build()?;
event_bus.emit(event);
Ok(())

// ❌ AVOID for streaming data — returning a large blob blocks the UI thread
Ok(entire_graph_json)
```

---

## StreamContext Rules (TypeScript)

- **Append-only**: never mutate events after insertion
- **Derive, don't store**: compute display state from the event log in `useMemo`; don't copy events into local `useState`
- **Focused hooks**: create a feature-level hook (e.g. `useAlertEvents`) that filters `StreamContext` rather than exposing raw access to all events

---

## Rust Guidelines (`apps/tauri/src-tauri`)

### Error Handling

Use `anyhow` for application-level errors. Propagate with `?` rather than unwrapping.

```rust
// ✅ CORRECT
pub async fn start_ipc_server(app: AppHandle) -> anyhow::Result<()> {
    let listener = ListenerOptions::new().name(name).create_tokio()?;
    Ok(())
}

// ❌ WRONG — panics in production
let listener = ListenerOptions::new().name(name).create_tokio().unwrap();
```

### Serde Conventions

All types that cross the IPC boundary (Rust ↔ TypeScript) must use `camelCase` to match the TypeScript `FredoEvent` interface:

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]  // toolName, sessionId, eventId
pub struct FredoEvent { ... }
```

Enums that match TypeScript string unions use `PascalCase`:

```rust
#[serde(rename_all = "PascalCase")]  // "Init", "Update", "Response", "Error"
pub enum EventState { Init, Update, Response, Error }
```

### clap Conventions

Use the `derive` feature for all CLI types. Keep `Args` structs small and focused.

```rust
#[derive(Parser)]
#[command(name = "fredo", version, about)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}
```

### Async Runtime

The Tauri app uses `tokio` (full features). **Always use `tauri::async_runtime::spawn`** — never `tokio::spawn` (panics with "no reactor" in the Tauri runtime). Never block the Tauri setup closure — move blocking work into spawned tasks:

```rust
// ✅ CORRECT
.setup(|app| {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move { start_ipc_server(handle).await });
    Ok(())
})

// ❌ WRONG — tokio::spawn panics in Tauri runtime
tokio::spawn(async move { start_ipc_server(handle).await });
```

### Event Emission

Always emit via `EventBus` from `infrastructure::comm::bus` rather than calling `app.emit()` directly. This ensures consistent delivery over the `"fredo-stream-event"` IPC channel.

```rust
// ✅ CORRECT — emit through EventBus
let event = adapter.transform(transport, payload).await?;
for e in events {
    event_bus.emit(e);
}

// ❌ WRONG — bypasses canonical event pipeline
app_handle.emit("fredo-stream-event", &event)?;
```

### LLM Engine Conventions

The `LlmEngine` runs in-process — never spawn `llama-server` as a child process.

```rust
// ✅ CORRECT — use LlmEngine directly
let engine = LlmEngine::load(&model_path)?;
let tokens = engine.generate(&prompt, &mut sampler).await?;

// ❌ WRONG — do not spawn llama-server subprocess
let child = Command::new("llama-server").spawn()?;
```

**Token streaming:** Use `mpsc::unbounded_channel` + `spawn_blocking` to avoid blocking the Tauri event loop:

```rust
// ✅ CORRECT
let (tx, mut rx) = mpsc::unbounded_channel::<String>();
tokio::task::spawn_blocking(move || {
    for token in engine.generate(&messages) {
        tx.send(token).ok();
    }
});
```

**Vision models:** Check mmproj projector availability before loading:

```rust
// ✅ CORRECT — handle missing projector gracefully
if mmproj_path.exists() {
    engine.load_with_vision(&model_path, &mmproj_path)?;
} else {
    log::warn!("mmproj projector not found, falling back to text-only");
    engine.load(&model_path)?;
}
```

### CommAdapter Conventions

New agent-provider adapters live in `infrastructure/comm/adapters/` — one file per agent provider. Each adapter implements the `CommAdapter` trait:

```rust
#[async_trait]
pub trait CommAdapter: Send + Sync + 'static {
    fn name(&self) -> &str;
    fn provider(&self) -> EventProvider;
    async fn transform(&self, transport: Transport, raw: serde_json::Value) -> Result<Vec<FredoEvent>>;
}
```

- **`OpenCodeAdapter`** handles `Transport::Hook` (plugin events), `Transport::OtlpGrpc`, and `Transport::OtlpHttp` (OTLP spans).
- **`InternalAdapter`** enriches raw events with server-side defaults.
- New agent providers get a new adapter file; new transports get a new `Transport` variant added in `infrastructure/comm/event.rs`.
- Adapters consume `AppHandle` via `EventBus` from Tauri state.

### OTLP Receiver Conventions

OTLP receivers (`infrastructure/otlp/`) accept protobuf payloads on gRPC (:4317) and HTTP (:4318). Spans are extracted and passed to the appropriate adapter's `transform()`:

```rust
// ✅ CORRECT — extract spans, delegate to adapter
let adapter = OpenCodeAdapter::new(app_handle.clone());
let events = adapter.transform(Transport::OtlpGrpc, span_json).await?;
for event in events {
    event_bus.emit(event);
}
```

**Signal filtering:** Only spans reach the UI; metrics and logs are dropped:

```rust
// ✅ CORRECT — drop metrics and logs at source
match signal_type {
    SignalType::Span => {
        let events = adapter.transform(transport, payload).await?;
        for event in events {
            event_bus.emit(event);
        }
    }
    SignalType::Metric | SignalType::Log => {
        log::debug!("Dropping {:?} — no UI consumer", signal_type);
    }
}
```

### Screenshot Feature Conventions

The `capture_screen_region` command returns base64-encoded PNG. Use for vision-based features:

```rust
// ✅ CORRECT — capture and encode
let png_bytes = capture_screen_region(x, y, width, height)?;
let base64 = BASE64.encode(&png_bytes);
Ok(base64)
```

### Event Provider & Transport Attribution

`FredoEvent` carries a `provider` field (`EventProvider`) and a `transport` field (`Transport`) for attribution:

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventProvider {
    OpenCode,
    ClaudeCode,
    Internal,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Hook,
    OtlpGrpc,
    OtlpHttp,
    WebSocket,
    HttpPost,
    Internal,
}
```

```rust
// ✅ CORRECT — set provider and transport based on event origin
let event = FredoEvent::builder()
    .provider(EventProvider::OpenCode)
    .transport(Transport::OtlpGrpc)
    .tool_name("invoke_agent".into())
    .build()?;
```

---

## EventSubscription Conventions (TypeScript)

Feature contracts extend `EventContract` with a unique `name`. Contracts assemble raw `FredoEvent` records into typed objects delivered via an **Init → Update → End** lifecycle (Spec #252).

```typescript
// ✅ CORRECT — contract with unique name
class ChatNodeContract extends EventContract {
  name = 'ChatNode';

  init(event: FredoEvent): ChatNode | null { ... }
  update(node: ChatNode, event: FredoEvent): ChatNode { ... }
  end(node: ChatNode, event: FredoEvent): void { ... }
}
```

Features declare subscriptions in their `eventSubscriptions` array. **A feature must not use both `eventSubscriptions` and `eventFilters` for the same events:**

```typescript
class ChatFeature extends FredoFeatureClass {
  eventSubscriptions = [new ChatNodeContract()];
  // Do NOT also list matching toolNames in eventFilters for ChatNode events
}
```
