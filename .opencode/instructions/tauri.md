---
description: Fredo Tauri Desktop App - Rust backend, Tauri v2, async, commands, events
applyTo: 'apps/tauri/**'
---

## Backend Rules

- No cross-feature imports — features never import from other features
- Always use `tauri::async_runtime::spawn` — never `tokio::spawn` (panics with "no reactor")
- Register new commands in `lib.rs` → `AppRuntime`
- Zero warnings — do not suppress with `#[allow(...)]`
- Import events from `crate::infrastructure::events` — NOT `crate::domain::events`
- Always emit Init before work, then Response or Error with correlation IDs

## Key Commands

- `cargo build` — build from `apps/tauri/src-tauri/`
- `cargo check` — verify zero warnings

## References

- Adding a Tauri command: `.opencode/references/tauri-commands.md`
- Emitting stream events: `.opencode/references/tauri-events.md`