---
name: dev-environment
description: Fredo dev:tauri instance lifecycle management. Load when any agent needs to start, stop, check status, or diagnose the local development instance.
---

# Dev Environment — Tauri Instance Management

## Status

### Check if the dev instance is running

```
powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action Status
```

Outputs: `running`, `starting`, or `stopped`.

## Startup

### Start the dev instance

```
powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action Start
```

### Wait for it to be ready

```
powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action WaitForReady -TimeoutSecs 120
```

## Stop

### Stop the dev instance

```
powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action Stop
```

## Debugging

### Read startup logs

```
powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action Logs
```

## E2E Testing Flow

For e2e testing, the e2e-tester owns the full dev lifecycle. If the webview freezes or MCP tools hang, restart and retry — never fall back to DB evidence:

1. E2e-tester: `Status` → if stopped → `Start` → `WaitForReady`
2. If webview freezes mid-test: `Stop` → `Start` → `WaitForReady` → reconnect MCP → retry failing ACs (up to 3 times)
3. After 3 restart cycles: report `E2E BLOCKED: webview unresponsive after 3 restart attempts`

Never stop the dev instance after testing — leave it running for the next agent.
