# Fredo CLI Guide

The `fredo` binary is installed alongside the desktop app and added to your system PATH. It has three modes:

1. **GUI mode** (no arguments) — launches the Fredo desktop window
2. **CLI mode** (with arguments) — forwards commands to the running app via the local IPC socket
3. **Headless ingest mode** (`fredo ingest`) — a long-lived daemon that captures agent telemetry while the GUI is closed

> **Prerequisite**: The Fredo desktop app must be running for CLI commands to work — except `fredo ingest` and `fredo companion probe`, which are self-contained. If the app is not open, a CLI command prints an error to stderr and exits with code `2`.

## Commands

### `fredo emit`

Injects a synthetic `FredoEvent` into the running app via the IPC socket. Used for e2e testing and debugging. Events flow through the same pipeline as real events: InternalAdapter → RTDB ingest classifier → canonical row upserts → `RowDeliveryBatch` on `fredo-stream-event` → frontend.

```bash
fredo emit --event-type <type> --state <state> [--provider <provider>] --session-id <id> [--tool-name <name>] [--correlation-id <id>] [--file <path>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--event-type` | Yes | Event type: `tool_use`, `agent_session`, `chat`, `infrastructure`, `ui`, `custom` |
| `--state` | Yes | Event state. **Must be lowercase**: `init`, `update`, `response`, `error` |
| `--provider` | No | Event provider (**snake_case**, default `internal`): `open_code`, `claude_code`, `copilot_cli`, `internal` |
| `--session-id` | Yes | Session identifier for the event |
| `--tool-name` | No | Tool name for tool_use events |
| `--correlation-id` | No | Correlation ID for matching Init/Response pairs |
| `--file` | No | Path to JSON payload file (recommended over inline `--payload`) |

> ⚠️ **Casing matters**: `--state Init` is rejected by the parser — state is **lowercase** (`init`, `update`, `response`, `error`), and `--provider` is **snake_case with underscores** (`open_code`, `claude_code`, `copilot_cli`, `internal`) — an unknown value is rejected by the parser. A bare `emit` (no `--provider`) defaults to `internal`.

**Examples**

```bash
# Inject a tool_use Init event
fredo emit --event-type tool_use --state init --provider open_code --session-id e2e-test --tool-name read_file --correlation-id e2e-1

# Inject a chat event with payload from file
fredo emit --event-type chat --state init --provider open_code --session-id e2e-chat --correlation-id e2e-2 --file ./payload.json

# Inject an error event
fredo emit --event-type tool_use --state error --provider internal --session-id e2e-err --tool-name terminal
```

Settings are managed via Tauri commands invoked from the UI Settings panel, not via CLI subcommands.

| Key | Description |
|-----|-------------|
| `llm_model` | Selected LLM model (`gemma-4-e2b` or `minicpm-v-4-6`) |

### `fredo open-app`

Opens (or raises) a Fredo app window by identity. `<IDENTITY>` is an application's **stable id** (`mission-monitor`) or its **display name** (`Mission Monitor`) — matching is case-insensitive, quotes are allowed, and there is no alias table. The running app's webview performs the ONE identity resolution and opens the window through the same kernel opener the launcher grid uses.

```bash
fredo open-app <IDENTITY>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `<IDENTITY>` | Yes | Application stable id (`mission-monitor`) or display name (`Mission Monitor`) |

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

### `fredo open-terminal`

Opens (or focuses) the Terminal host and, when a session type and/or working directory is supplied, starts that session in that folder in the same invocation. The running app validates the arguments **before** anything opens: an invalid session type or directory creates no window and starts no session.

> **Window presentation (Spec #2955, generalizing #2947).** Where an app opens is a remembered, per-app setting: **Settings → Apps** lists every app with a **Main window** / **Own window** choice. The default is **Main window** (inside the main Fredo window); **Own window** opens/focuses that app's own native OS window as a per-app singleton. `fredo open-terminal` and `fredo open-app` both honour the choice — in Main-window mode the app opens inside the main Fredo window and **no native window is created**. The per-invocation arguments, printed outcomes, and exit codes below are unchanged in both modes.

> **How OpenCode is launched.** The default path starts OpenCode against its **shared background service** — no per-session receiver wiring, no exported variable — and that process loads the global Fredo plugin, which is the telemetry capture point. `--standalone` (a private server instead of the background service) is added only in an isolated environment (`FREDO_REQUIRE_ENV_ISOLATION`, or a non-default `OPENCODE_OTLP_ENDPOINT`), where the session is also pinned to that environment's own OTLP receiver. It is never the default.

```bash
fredo open-terminal [--cli <shell|opencode|copilot>] [--dir <PATH>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--cli` | No | Session type to start: `shell` (a plain OS shell — the default), `opencode`, or `copilot`. Omitted with `--dir` → the saved default session type (`terminal_default_cli`, else `shell`) |
| `--dir` | No | Working directory to start it in. Omitted with `--cli` → the saved work directory (`terminal_work_dir`, else your home folder) |

**Outcome and exit codes**

| Exit | Meaning | stdout |
|------|---------|--------|
| `0` | No arguments — the window was opened/focused | `{"outcome":"opened"}` |
| `0` | A CLI and/or dir was supplied and started | `{"outcome":"started","cli":"opencode","workDir":"C:\\repo"}` |
| `1` | Unknown CLI | `{"outcome":"invalid-cli","message":"..."}` |
| `1` | Directory does not exist / is not a directory | `{"outcome":"invalid-directory","message":"..."}` |
| `1` | Malformed invocation (missing value, unknown flag) | _(a clear error on stderr)_ |
| `2` | Fredo app is not running | _(the fallback message below)_ |

**Examples**

```bash
# Open Terminal only
fredo open-terminal

# Start OpenCode in a folder
fredo open-terminal --cli opencode --dir C:\Code\fredo

# Start the saved default CLI in a folder
fredo open-terminal --dir C:\Code\fredo

# Start a plain OS shell (the default session type) in a folder
fredo open-terminal --cli shell --dir C:\Code\fredo

# Start GitHub Copilot in the saved work directory
fredo open-terminal --cli copilot
```

> A malformed invocation exits `1` (invalid argument), distinct from the `2` used for app-not-running. Re-invoking focuses the same single `terminal` window.

### `fredo doom export-dataset`

Exports the Doom Companion's **fine-tuning dataset** — the raw per-decision records captured (opt-in) from the companion's play — to a local file in the chosen format. Each record correlates one decision's observation (including the additive `forward` sensor), the adopted **plan** (`doom_plan`), the per-step executed actions, the re-plan events + triggers, the next state, the shaped reward, and the terminal result. The export is **local-only — no egress**; the CLI forwards to the running app, which writes the file.

```bash
fredo doom export-dataset [--format <raw|sft|dpo>] [--out <PATH>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--format` | No | `raw` (default — the lossless per-decision JSONL), `sft`, or `dpo` |
| `--out` | No | Target file path **relative to** `<dataset dir>/exports/` — a relative value is joined under it. Absolute paths, drive/UNC prefixes and `..` components are rejected (exit `1`) and write nothing; omitted or blank → `<dataset dir>/exports/doom-dataset-<ts>.<ext>` |

> `--out` is confined to `<dataset dir>/exports/`; there is no way to name a target outside it from the CLI. The webview export surface is separate: it takes no path argument and uses a native save dialog.

**Exit codes**

| Exit | Meaning | stdout |
|------|---------|--------|
| `0` | Written | `{"path":"…","format":"raw","records":N,"bytes":N}` |
| `1` | Invalid format / refused `--out` / empty dataset / write failure | a clear error |
| `2` | Fredo app is not running | _(the fallback message below)_ |

> Capture is **opt-in** (`doom_dataset_enabled`, off by default; env `FREDO_DOOM_DATASET_ENABLED` overrides) and **local-only** — nothing is transmitted off-device. The dataset lives as an append-only JSONL under `<app-data>/doom-dataset/` with a bounded retention/rotation policy (it replaces the retired `doom-agent-requests.jsonl` / `doom-agent-actions.jsonl` audit files).

### `fredo companion probe`

Starts the in-process companion engine and runs ONE bounded turn — the shipped diagnostic that makes the engine observable from a **release** binary. A release build carries no MCP bridge, so this command is how an installed artifact (and the release verification) proves the engine loads and answers without launching the app.

```bash
fredo companion probe [--prompt <TEXT>]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `--prompt` | No | Text of the single probe turn (default: a short sentence about the color blue). A blank value is a usage error (exit `2`) |

**Behaviour.** It resolves the models directory with the same CLI rule `fredo setup` uses (`<home>/fredo-models`), refuses a missing engine model file with the engine's typed code, then spawns its own engine handle (it never enables or disables the app's companion), starts it in `auto` mode, runs one turn capped at 64 completion tokens, and prints ONE JSON object on stdout.

**Precondition.** The three GGUF files must be present under `<home>/fredo-models/<manifest subdir>/` (run `fredo setup --download-model`). The model files are not part of the installer payload (~3.66 GB); a probe without them exits `1` with `modelMissing` / `mmprojInitFailed` / `mtpInitFailed` — a precondition failure, not a missing-engine failure.

**JSON shape**

```json
{
  "success": true,
  "backend": "cpu",
  "backendMode": "auto",
  "gpuLayers": 0,
  "devices": [],
  "modelId": "gemma-4-E2B-it-qat-UD-Q4_K_XL",
  "replyChars": 42,
  "detail": "the companion engine is ready."
}
```

| Field | Meaning |
|-------|---------|
| `success` | The engine started and the turn produced a reply |
| `backend` | The device class ggml reported for the loaded set: `cpu`, `gpu`, `integratedGpu`, `accel`, `meta` (`null` before a load) |
| `backendMode` | The requested mode — always `auto` for the probe |
| `gpuLayers` | GPU layers the load's own projection resolves to: `0` on the CPU arm; `4294967295` (`u32::MAX`, "every layer") on the full-offload arm |
| `devices` | The device set the start reported (name, class, free/total bytes) |
| `modelId` | The main model's id (the manifest model file stem) |
| `replyChars` | Characters in the assistant reply (`0` on a failure) |
| `detail` | The engine's curated detail string |
| `code` | Present only on a typed engine failure (e.g. `modelMissing`, `gpuUnavailable`, `startTimeout`) |

> On a host with no usable accelerator the device set is empty (`[]`) — ggml's model split selection is empty there; a single `CPU` entry appears only under the test-only `FREDO_COMPANION_FORCE_CPU` seam and is not a product state.

**Exit codes**

| Exit | Meaning |
|------|---------|
| `0` | The engine started and answered the turn |
| `1` | A typed engine failure — `code` names it (missing model, load/backend failure, timeout) |
| `2` | A usage or local precondition error (e.g. a blank `--prompt`); the app-not-running fallback does not apply |

> `fredo companion probe` runs entirely in this process: no app instance is needed, and nothing is written to the app's persisted companion state.

### `fredo ingest`

Runs Fredo's **headless ingest daemon**: a long-lived, non-GUI process that owns the embedded PostgreSQL cluster and the OTLP receivers so agent telemetry keeps being captured while the desktop app is closed. It uses the **same data dir and the same control-plane credential** as the desktop app and holds the **exclusive data-dir lock**, so exactly one owner starts the cluster. Events flow through the existing paths — the `IngestClassifier` (canonical rows) and `SpanStore` (raw `telemetry_spans`) — with no alternate row-emission route and no subscription gating.

```bash
fredo ingest [--data-dir <PATH>] [--pg-data-dir <PATH>] [--lock-dir <PATH>] [--grpc-port <PORT>] [--http-port <PORT>] [--run-ms <MS>] [--shutdown-file <PATH>]
```

| Argument | Default | Description |
|----------|---------|-------------|
| `--data-dir` | OS app-data dir | Override the resolved app-data dir (`FREDO_DATA_DIR`) |
| `--pg-data-dir` | `<data-dir>/postgres/cluster` — or the legacy `<data-dir>/postgres` when it already holds a cluster (`postgresql.conf` present) | Override the PostgreSQL cluster data dir (`FREDO_PG_DATA_DIR`). The flag/env always wins verbatim; by default the postmaster log lives in the sibling `<data-dir>/postgres/log` (under an override, `<override>/log`) |
| `--lock-dir` | `<data-dir>` | Directory holding the exclusive `postgres.lock` + the headless descriptor (`FREDO_PG_LOCK_DIR`) |
| `--grpc-port` | `4317` | OTLP gRPC receiver port (`FREDO_INGEST_GRPC_PORT`) |
| `--http-port` | `4318` | OTLP HTTP receiver port (`FREDO_INGEST_HTTP_PORT`) |
| `--run-ms` | unset (run until signal) | Bounded self-terminate after N ms (`FREDO_INGEST_RUN_MS`) |
| `--shutdown-file` | unset | When this file appears the daemon shuts down gracefully (`FREDO_INGEST_SHUTDOWN_FILE`) |

Precedence is **CLI flag > environment variable > default**. The daemon never overrides a caller-supplied value.

**Exit codes**

| Exit | Meaning |
|------|---------|
| `0` | Graceful shutdown (SIGINT, the shutdown file, or `--run-ms` elapsed) |
| `1` | Fail-fast — the data-dir lock is already held by another `fredo ingest`, or the cluster failed to start |
| `2` | Reserved |

**Behaviour**

- **Owns the cluster.** Starts the embedded PostgreSQL cluster via the existing supervisor and holds the exclusive data-dir lock; a second `fredo ingest` (or the GUI's own cluster start) fails fast with a clear message instead of starting a second postmaster.
- **GUI attach.** When a headless daemon owns the cluster, launching the GUI **attaches** to that same cluster/data dir/credential (status `attached`) rather than starting its own; it never starts or later stops a postmaster.
- **Bounded shutdown (G-263).** On SIGINT, the shutdown file, or `--run-ms`, the daemon drains and flushes the write-behind queue, closes the pool, stops the cluster within a finite bound (hard-kill fallback on expiry), releases the lock, and clears its descriptor — no orphan postmaster.
- **Loopback only.** PostgreSQL binds an ephemeral `127.0.0.1` port by default — or the port pinned in the shared Settings → **Database** configuration (Spec #3022), along with its log verbosity; the OTLP receivers bind `127.0.0.1:4317`/`:4318`, exactly like the GUI.
- **Markers untouched.** The daemon never reads or writes the one-shot `rtdb.backfill.*` markers and never writes `telemetry_spans` from the backfill path.

> **Login auto-start.** Settings → **Ingest** installs a per-user login entry that runs `fredo ingest` at sign-in; disabling it removes the entry. OS-level service installation (Windows Service / systemd / launchd daemon) and elevation are out of scope.

---

## Setup (via UI)

Setup is driven through the **Fredo Setup** wizard in the Fredo UI — reachable from the **Fredo Setup** launcher tile or **Settings → Fredo Setup** — with the same two actions available from the CLI as `fredo setup --check` (inspect every step) and `fredo setup --install-plugin` (install the plugin). Both paths gate on the installed OpenCode version: **OpenCode 2** is the supported runtime, and on 1.x they name the version they found plus the `opencode upgrade` remedy and install nothing (upgrading is the bare `opencode upgrade`; re-run `fredo setup --check` afterwards). On OpenCode 2 the plugin is copied once into the **global** plugins directory (`~/.config/opencode/plugins/fredo.js`), which is the telemetry capture point — no OTLP environment variable is written. When the copy writes a new bundle and OpenCode's background service is running, the install then restarts that service (`opencode service restart`) so the running server loads the plugin and reports the outcome; if the restart fails the step fails with the remedy, and the installed file stays in place. `fredo setup --install-plugin --no-restart-service` performs the copy without the restart. Available Tauri commands:

| Command | Description |
|---------|-------------|
| `check_cli_installations` | Detect the OpenCode CLI and its major (`opencode: false` when the major is below the supported minimum or cannot be determined) and whether the global Fredo OTLP plugin is installed |
| `configure_otel` | Not required — an idempotent no-op that writes no environment variable (the global plugin is the capture point) |
| `check_otel_configured` | Report whether the capture point — the global Fredo plugin — is installed |
| `check_fredo_in_path` | Check if `fredo` binary is in PATH |
| `add_fredo_to_path` | Add `fredo` binary directory to user PATH |
| `install_plugin` | Copy the plugin artifact into the global plugins directory (`~/.config/opencode/plugins/fredo.js`) — gated on OpenCode 2, fails loud when the artifact is absent, and returns the one `[fredo] … (global …)` line naming the resolved file (async) |
| `get_setup_plan` | List pending setup steps (`skipped` / `needed` / `blocked`), carrying the version-gate message when OpenCode is installed but unusable |
| `check_all_setup` | Run all setup checks — the `opencode` step is `error` carrying the version message, and the `otel` step is `ok` with the not-required detail |
| `get_plugin_source_path` | Get the filesystem path of the plugin source |

---

## Fallback Behaviour

If the Fredo desktop app is **not running**, CLI commands exit with code `2` and print:

```
Fredo app is not running. Start it first with `fredo` (no arguments), then retry.
Tip: run `fredo` to launch the desktop app.
```
