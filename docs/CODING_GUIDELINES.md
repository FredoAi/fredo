# Fredo — Coding Guidelines

---

## Feature Module Convention

Both the Rust backend and the React UI are organized as **autonomous feature modules**. This is the primary architectural rule.

### Rule: Each feature owns its vertical slice

A feature module owns everything it needs — models, business logic, state, commands (Rust) or components (TypeScript). Features do not import from each other.

```
// ✅ CORRECT — feature uses shared infrastructure
use crate::infrastructure::events::emit_stream_event;

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

A feature should only react to `toolName` values in its own `eventFilters`. If a feature needs data from another domain, that data should arrive as a separate `StreamEvent` on a `toolName` owned by this feature — not by reading another feature's events.

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
// McpCapable is a stub — only implement when MCP exposure is real
```

### State belongs in the feature, not in infrastructure

```rust
// ✅ CORRECT — feature owns its own Tauri state
app.manage(Mutex::new(RunCliState::default()));   // in lib.rs, for terminal feature

// ❌ WRONG — infrastructure module holding feature-specific state
// infrastructure/mod.rs should not own RunCliState
```

### Emit events, don't return data

Tauri command handlers should emit `StreamEvent` records rather than returning large payloads. The UI is reactive; it will pick up the event.

```rust
// ✅ CORRECT — emit event, return ()
emit_stream_event(&app_handle, "infrastructure_stream", EventState::Response, ...)?;
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

---

## TypeScript Guidelines (`apps/ui/src`)

### FredoFeatureClass Pattern

Every grid-based feature extends `FredoFeatureClass`. Required members:

```typescript
class MyFeature extends FredoFeatureClass {
  readonly id = 'my-feature';
  readonly name = 'My Feature';
  readonly icon = LuMyIcon;
  readonly eventFilters: EventFilter[] = [
    { toolName: 'my_tool' },
  ];

  processEvent(event: StreamEvent): void {
    // Handle matching events
  }

  render(): ReactElement {
    return <MyPanel />;
  }
}
```

**EventFilter types:**
```typescript
// Match by toolName
{ toolName: 'infrastructure_stream' }

// Match by state
{ state: 'Response' }

// Custom predicate
{ custom: (event) => event.source === 'otlpGrpc' }

// Catch-all (Mission Monitor pattern)
{ custom: () => true }
```

### HostAdapter Pattern

The `HostAdapter` interface decouples the React UI from any host environment:

```typescript
export interface HostAdapter {
  onMessage(handler: (msg: any) => void): () => void;
  invoke?(command: string, args?: Record<string, unknown>): Promise<unknown>;
  llmChat(messages: LlmMessage[], onToken: (t: string) => void, onDone: () => void): Promise<void>;
  llmChatWithImage(messages: LlmMessage[], imageBase64: string, onToken: (t: string) => void, onDone: () => void): Promise<void>;
}
```

**Rule: Never import `@tauri-apps/api` outside `TauriAdapter.ts`**

```typescript
// ✅ CORRECT — invoke Tauri via adapterBridge
import { adapterBridge } from '../../shared/utils/adapterBridge';
await adapterBridge.invoke('save_setting', { key, value });

// ❌ WRONG — direct Tauri API inside a feature
import { invoke } from '@tauri-apps/api/core';
```

**Rule: Never poll — only react**

```typescript
// ✅ CORRECT — derive state from StreamContext event log
const events = useStream().events.filter(e => e.toolName === 'infrastructure_stream');

// ❌ WRONG — polling the backend
useEffect(() => {
  const id = setInterval(() => adapterBridge.invoke('get_diagram'), 2000);
  return () => clearInterval(id);
}, []);
```

### StreamContext Rules

- **Append-only**: never mutate events after insertion
- **Derive, don't store**: compute display state from the event log in `useMemo`; don't copy events into local `useState`
- **TTL-based expiry**: events expire after 60 seconds by default

### Adapter Hierarchy

```
HostAdapter (interface)
├── TauriAdapter   → @tauri-apps/api via dynamic imports  [production]
└── DevAdapter     → in-memory emitter + mock LLM         [Vite dev server]
```

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

All types that cross the IPC boundary (Rust ↔ TypeScript) must use `camelCase` to match the TypeScript `StreamEvent` interface:

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]  // toolName, sessionId, eventId
pub struct StreamEvent { ... }
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

The Tauri app uses `tokio` (full features). Spawn background tasks via `tokio::spawn`. Never block the Tauri setup closure — move blocking work into spawned tasks:

```rust
// ✅ CORRECT
.setup(|app| {
    let handle = app.handle().clone();
    tokio::spawn(async move { start_ipc_server(handle).await });
    Ok(())
})
```

### StreamEvent Emit Helper

Always use `emit_stream_event()` from `events.rs` rather than calling `app.emit()` directly. This ensures consistent serialization and error logging.

### MCP Tool Conventions

MCP tools are defined using the `rmcp` framework. Each tool category lives in its own module under `features/mcp/<category>/`.

```rust
// ✅ CORRECT — tool with name, description, input schema
#[derive(ToolHandler)]
pub struct KubectlPods;

impl ToolHandler for KubectlPods {
    fn name(&self) -> &str { "kubectl_pods" }
    fn description(&self) -> &str { "List Kubernetes pods in a namespace" }
    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "namespace": { "type": "string", "description": "Kubernetes namespace" }
            }
        })
    }
    async fn call(&self, params: serde_json::Value) -> Result<serde_json::Value, Error> {
        // implementation
    }
}
```

**Credential access:** Read from `AppStore` via the settings feature, never hardcode:

```rust
// ✅ CORRECT
let base_url = app_store.get("mcp.jira.base_url")?.ok_or("mcp.jira.base_url not configured")?;
```

**SQL safety:** Observability tools must enforce SELECT-only validation:

```rust
// ✅ CORRECT — reject non-SELECT queries
if !sql.trim_start().starts_with("SELECT") {
    return Err(anyhow!("Only SELECT queries are allowed"));
}
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

### OTLP Mapping Conventions

OTLP receivers map protobuf payloads to `StreamEvent` records. The mapping lives in `infrastructure/otlp/mapping.rs`.

**Two-pass algorithm:** Pass 1 builds the trace→conversation map, Pass 2 emits events:

```rust
// ✅ CORRECT — build correlation map first, then emit
let trace_map = build_trace_conversation_map(resource_spans);
for span in resource_spans {
    if should_emit_span(&span) {  // only invoke_agent and execute_tool
        emit_stream_event(&app_handle, map_span_to_event(&span, &trace_map))?;
    }
}
```

**Signal filtering:** Only spans reach the UI; metrics and logs are dropped:

```rust
// ✅ CORRECT — drop metrics and logs at source
match signal_type {
    SignalType::Span => emit_stream_event(...)?,
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

### EventSource Attribution

All `StreamEvent` records carry a `source` field for attribution:

```rust
// ✅ CORRECT — set source based on event origin
let event = StreamEvent {
    source: EventSource::OtlpGrpc,  // or OtlpHttp, Hook
    otlp: Some(OtlpPayload { signal_type, attributes }),
    ..
};
```