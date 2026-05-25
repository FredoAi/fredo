# Emitting Stream Events (Rust → UI)

## Pattern

```rust
use crate::infrastructure::events::{EventState, emit_stream_event};

let corr_id = uuid::Uuid::new_v4().to_string();

// Init event before work
emit_stream_event(&app, "tool_name", EventState::Init, None, Some(&corr_id))
    .map_err(|e| e.to_string())?;

// ... do work ...

// Response event after work
emit_stream_event(&app, "tool_name", EventState::Response, Some(data), Some(&corr_id))
    .map_err(|e| e.to_string())?;
```

## Key Rules

- Always emit Init before starting work
- Always emit Response or Error when done
- Use correlation IDs to match Init/Response pairs
- Import from `crate::infrastructure::events` — NOT `crate::domain::events`
- Use `uuid::Uuid::new_v4().to_string()` for correlation IDs