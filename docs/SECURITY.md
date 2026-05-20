# Fredo — Security

## Security Model

Fredo is a **local desktop application**. Its security surface is fundamentally different from a networked service: there is no authentication layer, no public-facing API, and no multi-tenancy. The threat model centers on the local IPC socket, OTLP receivers, MCP server, and the Tauri capability system.

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
- This is by design: agent hook scripts, the `fredo` CLI, and other local tools are all expected to be the same user

---

## OTLP Receivers

The gRPC (`:4317`) and HTTP (`:4318`) receivers bind to **`127.0.0.1` only** — they are not reachable from other machines on the network.

**Protections:**
- Loopback-only binding prevents external access
- No authentication required — same threat model as IPC socket (local user only)
- OTLP data is processed in-memory; no persistence beyond the current session

**Limitations:**
- Any process on the same machine can send OTLP data to these ports
- Malicious local processes could inject fake telemetry events
- This is acceptable for a dev tool where the threat model is the local user

---

## MCP Server

The MCP server operates in two modes:

**stdio transport** (`fredo mcp`):
- Communicates via stdin/stdout with the spawning process
- No network exposure; inherits the security context of the spawning agent

**Streamable HTTP transport** (`fredo mcp --sse --port 3001`):
- Binds to `127.0.0.1` by default (configurable port)
- No authentication — any local process can connect
- `LocalSessionManager` manages sessions in-memory

**Credential handling:**
- MCP tools requiring external services (Jira, Azure DevOps, Optimizely, PostgreSQL) read credentials from `AppStore` (SQLite)
- Credentials are stored in plaintext in the SQLite database — OS keychain integration is planned for future phases
- The observability tools enforce **SELECT-only** SQL validation to prevent data modification

---

## Tauri Capabilities

Tauri v2 uses a capability system (`capabilities/default.json`) to declare the minimum set of permissions the webview requires. Fredo follows least-privilege:

| Permission | Why required |
|-----------|-------------|
| `core:event:allow-listen` | Webview subscribes to `fredo-stream-event` and `run-cli-output` Tauri events |
| `core:event:allow-emit` | Rust backend emits events to the webview |
| `core:window:allow-create` | Backend opens the `run-cli-terminal` WebviewWindow for PTY output |
| `core:window:allow-close` | Backend closes the terminal window when the PTY process exits |
| `core:default` | Standard window management (resize, minimize, etc.) |

No filesystem, shell, or network permissions are granted to the webview. All filesystem and process operations are performed by the Rust backend via Tauri commands, not by the webview directly.

---

## Screenshot Feature

The `capture_screen_region` command captures physical screen pixels via the `xcap` crate.

**Protections:**
- Only accessible via Tauri command (not from webview directly)
- Returns base64-encoded PNG — no file system writes
- Multi-monitor aware but only captures the specified region

**Limitations:**
- Can capture any visible content on the screen (including sensitive information)
- Intended for use by the Tic-Tac-Toe AI companion and similar vision-based features

---

## Data Storage

Settings are persisted in an SQLite database managed by `AppStore` (the `settings` feature). The database is stored in the Tauri app data directory (`%APPDATA%\fredo` on Windows, `~/.local/share/fredo` on Linux, `~/Library/Application Support/fredo` on macOS).

- No credentials or secrets are stored in the settings database (planned for future OS keychain integration)
- MCP tool credentials (Jira tokens, Azure DevOps PATs, etc.) are stored as plaintext KV pairs — this is a known limitation
- Session history in the Mission Monitor is persisted in browser `localStorage` (max 50 sessions)

---

## Input Handling

### IPC Commands
`CliCommand` payloads are deserialized via `serde_json`. All fields are strongly typed — unrecognized fields are ignored, and missing required fields cause a deserialization error. The Rust type system prevents injection at the IPC boundary.

### Tauri Commands
Tauri command arguments are passed through Tauri's built-in deserialization, not constructed from raw strings. SQL queries to `AppStore` use parameterized statements via `rusqlite` — no string interpolation.

### OTLP Input
OTLP protobuf payloads are deserialized via `opentelemetry-proto` generated types. The two-pass mapping algorithm validates trace IDs and session IDs before emitting events.

### MCP Tool Input
MCP tool arguments are validated against JSON schemas defined in each tool's metadata. The observability tools additionally enforce SELECT-only SQL validation.

### UI
The React UI renders all agent-provided content via React's JSX (no `dangerouslySetInnerHTML`). `StreamEvent` payloads are treated as data, not markup.

---

## Process Isolation

- The Rust backend and the React webview run in separate processes (Tauri architecture)
- The webview has no access to the filesystem, PTY, or IPC socket — only to declared Tauri commands and events
- The PTY terminal spawns child processes as the same OS user; no privilege escalation occurs
- OTLP receivers run as separate tokio tasks within the same process; no additional processes spawned

---

## Reporting Security Issues

Report security vulnerabilities privately via the GitHub repository's Security tab (private advisory). Do not open public issues for security-sensitive findings.
