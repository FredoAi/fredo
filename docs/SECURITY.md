# Fredo — Security

## Security Model

Fredo is a **local desktop application**. Its security surface is fundamentally different from a networked service: there is no authentication layer, no public-facing API, and no multi-tenancy. The threat model centers on the local IPC socket, OTLP receivers, and the Tauri capability system.

---

## IPC Socket

The local socket (`\\.\pipe\fredo-ipc` on Windows, `/tmp/fredo-ipc.sock` on Unix) is the only channel through which external code can communicate with the running app.

**Protections:**
- Named pipes on Windows are owned by the creating user; other OS users cannot connect
- Unix sockets use file-system permissions (`0600`) — only the owner can read/write
- No network port is opened; the socket is not reachable from other machines on the network
- The IPC server does not perform authentication because OS-level user isolation is the security boundary

**Limitations:**
- Any process running as the same OS user can send `CliCommand` messages to the socket
- This is by design: agent plugin hooks, the `fredo` CLI, and other local tools are all expected to be the same user

---

## OTLP Receivers

The gRPC (`:4317`) and HTTP (`:4318`) receivers bind to **`127.0.0.1` only** — they are not reachable from other machines on the network.

**Protections:**
- Loopback-only binding prevents external access
- No authentication required — same threat model as IPC socket (local user only)
- OTLP data is processed in-memory via `OpenCodeAdapter`; no persistence beyond the current session

**Limitations:**
- Any process on the same machine can send OTLP data to these ports
- Malicious local processes could inject fake telemetry events
- This is acceptable for a dev tool where the threat model is the local user

---

## Tauri Capabilities

Tauri v2 uses a capability system (`capabilities/default.json`) to declare the minimum set of permissions the webview requires. Fredo follows least-privilege:

| Permission | Why required |
|-----------|-------------|
| `core:default` | Standard window management (resize, minimize, etc.) |
| `core:event:allow-listen` | Webview subscribes to `fredo-stream-event` and `run-cli-output` Tauri events |
| `core:event:allow-emit` | Rust backend emits events to the webview |
| `core:window:allow-create` | Backend opens the `run-cli-terminal` WebviewWindow for PTY output |
| `core:window:allow-close` | Backend closes the terminal window when the PTY process exits |
| `core:window:allow-start-dragging` | Webview supports native window drag (title bar region) |
| `core:window:allow-set-title` | Backend updates window title dynamically (agent session name) |
| `shell:allow-open` | Open external URLs in the system browser (e.g., docs links) |
| `shell:allow-spawn` | Spawn shell processes for PTY sessions (terminal, CLI agents) |
| `shell:allow-execute` | Execute child processes (agent sessions run via shell) |
| `mcp-bridge:default` | Debug/driver support: enables the MCP Bridge plugin for development automation |

No filesystem permissions are granted to the webview. All filesystem operations are performed by the Rust backend via Tauri commands, not by the webview directly.

---

## Screenshot Feature

The `capture_screen_region` command captures physical screen pixels via the `xcap` crate.

**Protections:**
- Only accessible via Tauri command (not from webview directly)
- Returns base64-encoded PNG — no file system writes
- Multi-monitor aware but only captures the specified region

**Limitations:**
- Can capture any visible content on the screen (including sensitive information)
- Intended for use by AI companion features requiring visual context

---

## Data Storage

Settings are persisted as plain key-value pairs in an SQLite database managed by `AppStore` (the `settings` feature). The database is stored in the Tauri app data directory (`%APPDATA%\fredo` on Windows, `~/.local/share/fredo` on Linux, `~/Library/Application Support/fredo` on macOS).

- No credentials or secrets are stored in the settings database — OS keychain integration is planned for future phases
- All SQL queries use parameterized statements via `rusqlite` — no string interpolation
- Session history in the Mission Monitor is persisted in browser `localStorage` (max 50 sessions)

---

## Input Handling

### IPC Commands
The IPC socket accepts newline-delimited JSON `CliCommand` messages with two variants:
- **`OpenCodePlugin`** — forwards plugin hook events from the `opencode-plugin` CLI command. The `event_type` is validated against an allowlist (`ALLOWED_EVENT_TYPES`); unknown event types are rejected.
- **`EmitEvent`** — accepts a raw `FredoEvent` via the `fredo emit` CLI command.

All payloads are deserialized via `serde_json`. Unrecognized fields are ignored, and missing required fields cause a deserialization error. The Rust type system prevents injection at the IPC boundary. Payloads are capped at 1 MB (`MAX_PAYLOAD_BYTES`).

### Tauri Commands
Tauri command arguments are passed through Tauri's built-in deserialization, not constructed from raw strings. SQL queries to `AppStore` use parameterized statements via `rusqlite` — no string interpolation.

### OTLP Input
OTLP protobuf and JSON payloads are deserialized via `opentelemetry-proto` generated types. Received spans are transformed into `FredoEvent` objects by `OpenCodeAdapter` before emission via `EventBus`. Invalid or malformed OTLP payloads are dropped without processing.

### UI
The React UI renders all agent-provided content via React's JSX (no `dangerouslySetInnerHTML`). `FredoEvent` payloads are treated as data, not markup.

---

## Process Isolation

- The Rust backend and the React webview run in separate processes (Tauri architecture)
- The webview has no access to the filesystem, PTY, or IPC socket — only to declared Tauri commands and events
- The communication layer (`infrastructure/comm/`) provides the security boundary between agent input and frontend features: raw events pass through `CommAdapter` implementations (`OpenCodeAdapter`, `InternalAdapter`) which normalize them into canonical `FredoEvent` objects before emission via `EventBus`
- The PTY terminal spawns child processes as the same OS user; no privilege escalation occurs
- OTLP receivers run as separate tokio tasks within the same process; no additional processes spawned

---

## Reporting Security Issues

Report security vulnerabilities privately via the GitHub repository's Security tab (private advisory). Do not open public issues for security-sensitive findings.
