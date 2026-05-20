---
description: Atlas Tauri Desktop App - Tauri v2, Rust, Vite, React, @atlas/ui
applyTo: 'apps/tauri/**'
---

## Feature Module Rules — `src-tauri/src/`

The backend is organized as **autonomous feature modules**. Enforce these when editing any Rust file:

| Layer | Folder | Rule |
|---|---|---|
| Features | `features/<name>/` | Owns models, service logic, state, and Tauri command handlers. No cross-feature imports. |
| Runtime | `runtime/` | `AppRuntime` composition root + `DesktopCapable`/`CliCapable`/`McpCapable` traits. |
| Infrastructure | `infrastructure/` | Shared platform services: `StreamEvent`, `AppStore`, IPC socket, CLI parser. No business logic. |
| Utils | `utils/` | Stateless helpers with no domain knowledge. |

**Never** import from another feature module (e.g. `crate::features::k8s` from inside `terminal/`).  
**Never** put business logic in `infrastructure/` — it provides platform services only.  
**Always** register new feature state and command handlers in `lib.rs` → `AppRuntime`.

### Capability Traits

Features declare their surface via traits in `runtime/capability.rs`. Implement only what you actually expose:

```rust
impl DesktopCapable for MyFeature {}  // has Tauri commands
impl CliCapable for MyFeature {}      // reachable from atlas CLI
// McpCapable is a stub — don't implement until MCP exposure is real
```

## Rust Async — Always Use Tauri's Runtime

```rust
// ✅ correct
tauri::async_runtime::spawn(async move { ... });

// ❌ panics with "no reactor running"
tokio::spawn(async move { ... });
```

## Adding a Tauri Command

1. Add it in the feature's `commands.rs` — keep it thin (validate input, call service/business logic, emit event, return `Result<(), String>`):
```rust
#[tauri::command]
pub async fn my_command(
    arg: String,
    state: tauri::State<'_, Mutex<MyFeatureState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // do work, then emit
    emit_stream_event(&app, "my_tool", EventState::Response, Some(data), None)
        .map_err(|e| e.to_string())
}
```
2. Register in `lib.rs` `AppRuntime` handler list:
```rust
.invoke_handler(tauri::generate_handler![features::my_feature::commands::my_command])
```
3. Call from React via `adapterBridge.invoke('my_command', { arg: 'value' })`.

## Emitting Stream Events (Rust → UI)

Always emit Init before work, then Response or Error. Import from `infrastructure::events`:
```rust
use crate::infrastructure::events::{EventState, emit_stream_event};
// NOTE: crate::domain::events no longer exists — always use infrastructure::events

let corr_id = uuid::Uuid::new_v4().to_string();
emit_stream_event(&app, "tool_name", EventState::Init, None, Some(&corr_id))
    .map_err(|e| e.to_string())?;
// ... do work ...
emit_stream_event(&app, "tool_name", EventState::Response, Some(data), Some(&corr_id))
    .map_err(|e| e.to_string())?;
```

## Frontend — Never Static-Import `@tauri-apps/api` in `apps/ui`

`TauriAdapter` uses dynamic import so `apps/ui` compiles outside Tauri:
```typescript
// ✅ correct — in TauriAdapter only
import('@tauri-apps/api/event').then(({ listen }) => listen('atlas-stream-event', ...));

// ❌ wrong — breaks non-Tauri builds
import { listen } from '@tauri-apps/api/event';
```

Call Tauri commands from React via `adapterBridge.invoke()`, not direct `invoke()` imports.

## Build Hygiene

- Run `cargo build` after every Rust change — confirm `Finished` with **0 warnings**
- Do not suppress warnings with `#[allow(...)]` unless the item is intentionally unused future code
- New dependencies go in `Cargo.toml` with explicit versions and required feature flags

## Dev Server

- Vite runs on **port 5174** (`strictPort: true`) — `tauri.conf.json` `devUrl` must match
- `pnpm dev:tauri` from repo root starts both Vite and Cargo watch

