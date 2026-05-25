# Adding a Tauri Command

## Pattern

1. Add command in the feature's `commands.rs`:

```rust
#[tauri::command]
pub async fn my_command(
    arg: String,
    state: tauri::State<'_, Mutex<MyFeatureState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let corr_id = uuid::Uuid::new_v4().to_string();
    emit_stream_event(&app, "my_tool", EventState::Init, None, Some(&corr_id))
        .map_err(|e| e.to_string())?;
    // do work
    emit_stream_event(&app, "my_tool", EventState::Response, Some(data), Some(&corr_id))
        .map_err(|e| e.to_string())
}
```

2. Register in `lib.rs` → `AppRuntime`:

```rust
.invoke_handler(tauri::generate_handler![features::my_feature::commands::my_command])
```

3. Call from React via `adapterBridge.invoke()`:

```typescript
const result = await adapterBridge.invoke<ReturnType>('my_command', { arg: value });
```

## Key Rules

- Always use `tauri::async_runtime::spawn` — never `tokio::spawn`
- Import events from `crate::infrastructure::events`
- Always emit Init before work, then Response or Error
- Use `Result<(), String>` as return type