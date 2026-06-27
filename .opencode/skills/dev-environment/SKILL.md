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

For e2e testing, the Reviewer owns startup. The e2e-tester only checks status:

1. Reviewer: `Status` → if stopped → `Start` → `WaitForReady`
2. E2E-tester: `Status` only → if stopped → report `E2E BLOCKED: dev instance not running`

Never stop the dev instance after testing — leave it running for the next agent.
