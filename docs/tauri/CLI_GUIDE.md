# Fredo CLI Guide

The `fredo` binary is installed alongside the desktop app and added to your system PATH. It has two modes:

1. **GUI mode** (no arguments) — launches the Fredo desktop window
2. **CLI mode** (with arguments) — forwards commands to the running app via the local IPC socket

> **Prerequisite**: The Fredo desktop app must be running for CLI commands to work. If the app is not open, an error is printed to stderr and the process exits with code `2`.

## Commands

### `fredo hook`

Forwards an agent lifecycle hook event (PreToolUse, PostToolUse, etc.) into the running Fredo desktop app. Used by the OpenCode plugin.

```bash
fredo hook <EventName> --payload '<JSON>'
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<EventName>` | Yes | Hook event name (e.g. `PreToolUse`, `PostToolUse`) |
| `--payload` | No | JSON payload. If omitted, reads from stdin |

**Example**

```bash
# With explicit payload
fredo hook PreToolUse --payload '{"tool_name":"kubectl_get_pods","input":{"namespace":"default"}}'

# Piping from agent hook script (stdin)
echo '{"tool_name":"kubectl_get_pods"}' | fredo hook PostToolUse
```

---

## Settings Management

Settings are managed via Tauri commands invoked from the UI Settings panel, not via CLI subcommands.

| Key | Description |
|-----|-------------|
| `llm_model` | Selected LLM model (`gemma-4-e2b` or `minicpm-v-4-6`) |

---

## Setup (via UI)

OTel configuration and CLI tool detection are handled through the **Setup** feature in the Fredo UI, not via CLI subcommands. Available Tauri commands:

| Command | Description |
|---------|-------------|
| `check_cli_installations` | Detect OpenCode CLI and plugin status |
| `configure_otel` | Write OTEL env vars for OpenCode |
| `check_otel_configured` | Check whether OTel is already configured |
| `check_fredo_in_path` | Check if `fredo` binary is in PATH |
| `add_fredo_to_path` | Add `fredo` binary directory to user PATH |
| `install_plugin` | Install Fredo plugin for OpenCode |
| `get_plugin_source_path` | Get the filesystem path of the plugin source |

---

## Fallback Behaviour

If the Fredo desktop app is **not running**, CLI commands exit with code `2` and print:

```
Fredo app is not running. Start it first with `fredo` (no arguments), then retry.
Tip: run `fredo` to launch the desktop app.
```
