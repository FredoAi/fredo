# Fredo CLI Guide

The `fredo` binary is installed alongside the desktop app and added to your system PATH. It has two modes:

1. **GUI mode** (no arguments) — launches the Fredo desktop window
2. **CLI mode** (with arguments) — forwards commands to the running app via the local IPC socket

> **Prerequisite**: The Fredo desktop app must be running for CLI commands to work. If the app is not open, an error is printed to stderr and the process exits with code `2`.

## Commands

### `fredo emit`

Injects a synthetic `FredoEvent` into the running app via the IPC socket. Used for e2e testing and debugging. Events flow through the same pipeline as real events: InternalAdapter → RTDB ingest classifier → canonical row upserts → `RowDeliveryBatch` on `fredo-stream-event` → frontend.

```bash
fredo emit --event-type <type> --state <state> --provider <provider> --session-id <id> [--tool-name <name>] [--correlation-id <id>] [--file <path>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--event-type` | Yes | Event type: `tool_use`, `agent_session`, `chat`, `infrastructure`, `ui`, `custom` |
| `--state` | Yes | Event state. **Must be lowercase**: `init`, `update`, `response`, `error` |
| `--provider` | Yes | Event provider. **Must be hyphenated**: `open-code`, `claude-code`, `internal` |
| `--session-id` | Yes | Session identifier for the event |
| `--tool-name` | No | Tool name for tool_use events |
| `--correlation-id` | No | Correlation ID for matching Init/Response pairs |
| `--file` | No | Path to JSON payload file (recommended over inline `--payload`) |

> ⚠️ **Casing matters**: `--state Init` and `--provider open_code` silently fail — the event queues but is misrouted. Always use lowercase state and hyphenated provider.

**Examples**

```bash
# Inject a tool_use Init event
fredo emit --event-type tool_use --state init --provider open-code --session-id e2e-test --tool-name read_file --correlation-id e2e-1

# Inject a chat event with payload from file
fredo emit --event-type chat --state init --provider open-code --session-id e2e-chat --correlation-id e2e-2 --file ./payload.json

# Inject an error event
fredo emit --event-type tool_use --state error --provider internal --session-id e2e-err --tool-name terminal
```

Settings are managed via Tauri commands invoked from the UI Settings panel, not via CLI subcommands.

| Key | Description |
|-----|-------------|
| `llm_model` | Selected LLM model (`gemma-4-e2b` or `minicpm-v-4-6`) |

### `fredo open-app`

Opens (or raises) a Fredo app window by identity. `<IDENTITY>` is a feature's **stable id** (`mission-monitor`) or its **display name** (`Mission Monitor`) — matching is case-insensitive, quotes are allowed, and there is no alias table. The running app's webview performs the ONE identity resolution and opens the window through the same kernel opener the launcher grid uses.

```bash
fredo open-app <IDENTITY>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<IDENTITY>` | Yes | Feature stable id (`mission-monitor`) or display name (`Mission Monitor`) |

**Outcome and exit codes**

| Exit | Meaning | stdout |
|------|---------|--------|
| `0` | Resolved uniquely — the window was opened/raised | `{"outcome":"opened","displayName":"Mission Monitor"}` |
| `1` | Not uniquely resolved, or the open failed | `{"outcome":"unknown","spokenName":"Narnia"}`, `{"outcome":"ambiguous","spokenName":"monitor","candidates":[...]}`, or `{"outcome":"unavailable","spokenName":"mission-monitor"}` |
| `2` | Fredo app is not running | _(the fallback message below)_ |

**Examples**

```bash
# By stable id
fredo open-app mission-monitor

# By display name (quote it on the shell)
fredo open-app "Mission Monitor"

# Case-insensitive
fredo open-app "OPEN MISSION MONITOR"
```

> The CLI never blocks unbound: the app confirmation is bounded at 5 s and the spawned child is bounded at 10 s, after which the outcome degrades to `unavailable`.


---

## Setup (via UI)

OTel configuration and CLI tool detection are handled through the **Setup** feature in the Fredo UI, not via CLI subcommands. Available Tauri commands:

| Command | Description |
|---------|-------------|
| `check_cli_installations` | Detect OpenCode CLI and Fredo OTLP plugin status |
| `configure_otel` | Write OTEL env vars for OpenCode |
| `check_otel_configured` | Check whether OTel is already configured |
| `check_fredo_in_path` | Check if `fredo` binary is in PATH |
| `add_fredo_to_path` | Add `fredo` binary directory to user PATH |
| `install_plugin` | Install Fredo OTLP plugin for OpenCode (async — resolves the plugin source workspace-first with fail-loud errors when absent, rebuilds only when the bundled dist is missing/stale, and returns a self-describing result: source label + copied byte count) |
| `get_plugin_source_path` | Get the filesystem path of the plugin source |

---

## Fallback Behaviour

If the Fredo desktop app is **not running**, CLI commands exit with code `2` and print:

```
Fredo app is not running. Start it first with `fredo` (no arguments), then retry.
Tip: run `fredo` to launch the desktop app.
```
