---
name: test-cli-events
description: 'Test Atlas CLI commands end-to-end and verify they emit Tauri IPC stream events into the UI. Use when: testing CLI event flow, verifying Tauri IPC events, debugging missing events in StreamContext, smoke-testing atlas CLI commands, validating Init/Response event pairs, checking correlation IDs, testing multiple CLI commands in sequence.'
argument-hint: 'Optional: specify which commands to test (logs, metrics, traces, k8s, azdo) or leave blank to run all'
---

# Test CLI → Tauri IPC → UI Event Flow

Tests that Atlas CLI commands reach the running desktop app, emit the correct `atlas-stream-event` pairs through Tauri IPC, and appear in the Dev Mode event log.

## Prerequisites

- Atlas desktop app is running (`pnpm dev:tauri` from `c:\Atlas`)
- Dev Mode panel is open: navigate to **Dev Mode** inside the app
- CLI dev binary: `C:\Atlas\apps\tauri\src-tauri\target\debug\atlas.exe` (built via `cargo build`)

## Event Flow Reference

```
CLI command
  → IPC socket (\\.\pipe\atlas-ipc on Windows)
    → dispatch_command() in ipc.rs
      → emit_stream_event("atlas-stream-event")
        → TauriAdapter.onMessage()
          → AppProvider.addEvent()
            → StreamContext (visible in Dev Mode)
```

Each command emits **two events** sharing a `correlationId`:
1. `Init` — sent immediately when the command is received
2. `Response` — sent after the handler runs

## Commands and Expected Events

| CLI command | Init `toolName` | Response `toolName` |
|---|---|---|
| `atlas logs -q "..."` | `logs_query` | `logs_query` |
| `atlas metrics -q "..."` | `metrics_query` | `metrics_query` |
| `atlas traces -q "..."` | `traces_query` | `traces_query` |
| `atlas k8s pods` | `kubectl_get_pods` | `infrastructure_snapshot` |
| `atlas k8s restart <name>` | `kubectl_restart_deployment` | `kubectl_restart_deployment` |
| `atlas azdo story --title "..."` | `azdo_create_work_item` | `azdo_create_work_item` |

## Procedure

### 1. Build the CLI (if needed)

```powershell
cd C:\Atlas\apps\tauri\src-tauri
cargo build
# Binary: C:\Atlas\apps\tauri\src-tauri\target\debug\atlas.exe
```

Define a shorthand for the session:

```powershell
$atlas = "C:\Atlas\apps\tauri\src-tauri\target\debug\atlas.exe"
```

### 2. Open Dev Mode in the UI

Navigate to the Dev Mode panel. The event stream will show incoming events in real time with `toolName`, `state`, and `correlationId`.

### 3. Run the smoke test sequence

Run each command below in a terminal, then verify the event pair appears in Dev Mode.

```powershell
$atlas = "C:\Atlas\apps\tauri\src-tauri\target\debug\atlas.exe"

# Logs
& $atlas logs --query "SELECT * FROM logs LIMIT 5"

# Metrics
& $atlas metrics --query "SELECT * FROM metrics LIMIT 5"

# Traces
& $atlas traces --query "SELECT * FROM traces LIMIT 5"

# K8s pods (all namespaces)
& $atlas k8s pods

# K8s restart
& $atlas k8s restart my-deployment --namespace default

# Azure DevOps story
& $atlas azdo story --title "Test story from CLI"
```

### 4. Verify each event pair

For each command, confirm in Dev Mode:

- [ ] `Init` event appears with the correct `toolName`
- [ ] `Response` event appears with the same `correlationId`
- [ ] The Tauri IPC LED in the top-right corner briefly turns **active** (blue pulse)
- [ ] No `Error` state events appear

### 5. Run all commands in rapid succession (concurrency test)

```powershell
$atlas = "C:\Atlas\apps\tauri\src-tauri\target\debug\atlas.exe"

# Fire all commands back-to-back to test event ordering
& $atlas logs -q "SELECT 1" ; & $atlas metrics -q "SELECT 1" ; & $atlas traces -q "SELECT 1" ; & $atlas k8s pods ; & $atlas azdo story --title "Concurrency test"
```

Verify in Dev Mode:
- [ ] All 10 events appear (5 Init + 5 Response)
- [ ] Each Init/Response pair shares the same `correlationId`
- [ ] Events from different commands do not share `correlationId`

## Debugging

**No events appear in Dev Mode**
- Check the Atlas app is running (the Tauri IPC LED shows green/connected)
- Run `& $atlas logs -q "SELECT 1"` and check for `"Atlas app is not running"` error in terminal
- Verify the IPC socket exists: `Test-Path \\.\pipe\atlas-ipc`

**Only Init, no Response**
- The `dispatch_command` handler may have panicked — check the Tauri app console for Rust errors

**Events appear but correlationId is missing**
- Check `events.rs`: `StreamEvent::new()` auto-generates `event_id` but `correlation_id` is set per-handler in `ipc.rs`. Each `CliCommand` arm must call `.with_correlation(&correlation_id)` on both events.

**Wrong toolName in UI**
- Cross-reference the table above against `dispatch_command()` in `apps/tauri/src-tauri/src/ipc.rs`
