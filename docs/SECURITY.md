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
- OTLP telemetry is persisted on receipt to the active store (`fredo.db` by default; the managed PostgreSQL cluster when the storage engine is enabled) (`telemetry_spans`/`telemetry_metrics`/`telemetry_logs`) and classified into canonical rows by the RTDB ingest classifier (`infrastructure/rtdb/ingest.rs`). All persisted telemetry stays local — nothing leaves the machine. Retention is bounded by the existing `delete_expired` sweep (default 7 days).
- Capturing a **GitHub Copilot CLI** session requires no credential held or handled by Fredo: the CLI authenticates itself and exports to plaintext loopback (`http://127.0.0.1:4318`) with no headers. Fredo sets no `OTEL_EXPORTER_OTLP_HEADERS`, adds no token store, and never logs or persists Copilot auth material.

**Limitations:**
- Any process on the same machine can send OTLP data to these ports
- Malicious local processes could inject fake telemetry events
- This is acceptable for a dev tool where the threat model is the local user

---

## Companion `llama-server`

The companion's inference runtime is a managed `llama-server` **child process**, launched by the app from a launch config generated from local settings. It binds to **loopback (`127.0.0.1`) only** on the configured port (default `8080`) — it is not reachable from other machines on the network.

**Protections:**
- Loopback-only binding prevents external access
- Spawned and stopped only through the `features/llm_server` commands; the process is never started ad-hoc from other feature code
- Terminated on app exit (kill-on-exit hook); a PID-reuse-guarded startup sweep reclaims an orphan after a hard-kill, so no stale server survives
- The generated launch config and model paths come from the local settings DB — no network fetch at launch

**Limitations:**
- Any process on the same machine can reach the loopback port
- The server has no authentication — the same local-user threat model as the IPC socket and OTLP receivers

## Embedded PostgreSQL (`features/pg_supervisor`)

Slices 1-5 of the SQLite → embedded-PostgreSQL migration ship the **lifecycle supervisor, the storage engine seam, the migration of the KV/feature family, the RTDB canonical store, and the SpanStore (telemetry spans/metrics/logs), the one-shot `fredo.db` data leg with a fail-closed per-table parity gate and an executable SQLite rollback, and the packaging/install of the runtime (an explicit build-time acquisition mode + a SHA-256-pinned archive acquisition + the cutover release gate)**: it is **disabled by default** (`postgres.enabled` absent; opt in via `FREDO_STORAGE_ENGINE=postgres`) and PostgreSQL is selected only for the migrated store family, so the live default persistence is unchanged (`fredo.db`). The pool DSN embeds the slice-1 generated loopback secret held in the control-plane KV (`postgres.password`) — never logged, never in code; the role is the crate's local `postgres` superuser this slice (least-privilege packaging is a later slice). The data leg opens the source **read-only** (a `VACUUM INTO` snapshot) and never mutates or deletes `fredo.db`; any parity mismatch leaves `migration.postgres.completed` unset, does not flip the engine, and leaves `fredo.db` untouched, so the app stays fully operational on SQLite. `telemetry_spans` remains strictly read-only to the RTDB/backfill path.

**Protections:**
- The managed postmaster is started only when the engine is explicitly enabled; it binds an **ephemeral loopback port on `127.0.0.1`** (never OTLP 4317/4318 or the MCP bridge 9223)
- Spawned/stopped only through `features/pg_supervisor`; nothing else starts it ad-hoc
- Every start/readiness/stop wait carries a **finite wall-clock cap** with a hard-kill (`taskkill /T /F`) fallback and guaranteed teardown on normal, error, and panic paths — the observed ~11 h unbounded `pg.stop()` hang (#2948) is closed
- A PID-reuse-guarded startup sweep reclaims a previous run's orphan (killed only when its image is `postgres.exe`); an exclusive data-dir lock prevents two launches from touching one cluster
- The cluster password is local-only (AppStore key `postgres.password`); OS-keyring hardening is deferred to a later slice
- The one-shot data leg opens `fredo.db` **read-only** (via a `VACUUM INTO` snapshot) and never writes the source; the pre-cutover snapshot is the executable backout and `fredo.db` is never mutated or deleted by the migration. The copy/parity gate is fail-closed toward SQLite, and an exclusive gate holds storage writers quiesced across the window
- The PostgreSQL distribution is acquired through Fredo's **SHA-256-pinned streaming engine** (skip-if-verified, `Range` resume, streaming digest seeded from the on-disk prefix, delete-on-mismatch, bounded retry) — the same engine that verifies Companion model files. A digest mismatch deletes the artifact and surfaces an actionable error; the distribution is never extracted from unverified bytes. The shipped mode is `runtime-download` (the crate default; ~0 B installer growth)
- The optional `bundled` compile-time feature embeds the archive (no first-run network) but its **build-time** fetch is outside Fredo's SHA-pinned integrity surface — documented as a deliberate deviation, bounded by the pinned crate version + `Cargo.lock` (a SHA-pinned resource is the hardening path)
- The read-only `cutover_release_gate` computes the shipped default from the acquisition mode + the `migration.postgres.completed` marker (fail-closed to SQLite while the marker is absent); slice 5 does not flip the engine

**Limitations:**
- The loopback cluster is reachable by any process on the same machine (no per-client auth beyond the local password)
- A hard-kill/power-loss can still orphan a postmaster; the next start's sweep reclaims it (residual accepted for this slice)
- With `bundled`, the archive is fetched at **build time** from the crate's upstream host, outside Fredo's SHA-pinned integrity surface (see above)

---

## Voice Input

Voice input is **local-only by hard requirement**. Microphone capture is native (`cpal`/WASAPI in Fredo's Rust — no `getUserMedia`), and the captured utterance is understood by the locally-managed companion model itself as that turn's input. There is exactly **one speech path** (model audio) and **no separate on-device recognizer or transcription mode**. Audio never traverses the network: the **only** way the clip leaves the capture path is the `input_audio` content part of a turn sent over **loopback** to the managed `llama-server` (the same `127.0.0.1` process documented above).

**Model audio.** A captured clip is handed to the locally-managed companion model as that turn's input and **no transcript is shown**. It is delivered over **loopback only**, is never uploaded, and adds no outbound route. It is used only when the installed model reports audio support — capability is probed, never inferred from a model name — and when the model does not support audio (or the local server is unavailable) nothing is transmitted and Fredo says so.

**Protections:**
- No audio or audio-derived payload is transmitted; the capture path contains no network client (pinned by the `voice_decode_path_has_no_network_or_process_symbols` invariant test)
- Voice is **opt-in** (`Fredo_companion_voice_enabled`, default `false`) — nothing is captured before the user enables it
- Capture can be started ONLY by **holding Space in the focused, empty launcher search bar** (Spec #2882) — no keyboard gesture (Ctrl+Space included) starts a session and **no new capture path exists**, so nothing is captured while the user is merely typing or navigating
- Capture must be **visibly indicated for its whole duration** by the **launcher bar cue** (the `Listening` chip and placeholder, announced as text), and the cue appears only while capture is genuinely live, so audio is never captured without a visible active indicator; Spec #2882 retired the companion listening bubble, leaving the bar cue as the only capture indicator
- **No capture before the gesture:** no microphone stream exists and no audio is captured until the Space hold; with voice disabled nothing is captured
- The microphone is released the moment Space is released, the utterance is cancelled, the bar or window loses focus, or voice is disabled
- **Model audio adds no new egress:** a model-audio clip is carried by the existing loopback chat transport to the managed `llama-server`; the layer-confinement invariant over `infrastructure/voice/**` (no network/process symbols) is unchanged, and there is no cloud-fallback branch
- **No transcript exists:** the single speech path produces no transcript, so no audio-derived word reaches any surface
- **The clip is bounded and non-lossy:** capture auto-stops at the pinned limit (`MAX_AUDIO_CLIP_MS`, ~30 s) with a visible notice, and the entire clip is kept and delivered — never a silent truncation or a dropped tail
- **The capture is visibly indicated for its whole duration** by the launcher bar cue (including its processing state); there is no silent capture
- The native WASAPI path needs no CSP widening and no new Tauri capability

**Limitations:**
- Any process on the same machine can access the microphone under the same OS user — the OS owns the microphone privacy/permission boundary

---

## Tauri Capabilities

Tauri v2 uses a capability system (`capabilities/default.json`) to declare the minimum set of permissions the webview requires. Fredo follows least-privilege:

| Permission | Why required |
|-----------|-------------|
| `core:default` | Standard window management (resize, minimize, etc.) |
| `core:event:allow-listen` | Webview subscribes to `fredo-stream-event` and `terminal-output` Tauri events |
| `core:event:allow-emit` | Rust backend emits events to the webview |
| `core:window:allow-create` | Backend opens the `terminal` WebviewWindow for PTY output |
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
- Session history in the Mission Monitor is persisted via the RTDB row store on the active engine (SQLite by default; PostgreSQL when the storage engine is enabled), applied to the module-scoped `StreamContext` row store in-memory. Live rows are unbounded; persistence retention is bounded by the `rtdb.retention_days` / `rtdb.max_rows` knobs.

---

## Input Handling

### IPC Commands
The IPC socket accepts newline-delimited JSON `CliCommand` messages with one variant:
- **`EmitEvent`** — accepts a raw `FredoEvent` via the `fredo emit` CLI command.

All payloads are deserialized via `serde_json`. Unrecognized fields are ignored, and missing required fields cause a deserialization error. The Rust type system prevents injection at the IPC boundary.

### Tauri Commands
Tauri command arguments are passed through Tauri's built-in deserialization, not constructed from raw strings. SQL queries to `AppStore` use parameterized statements via `rusqlite` — no string interpolation.

### OTLP Input
OTLP protobuf and JSON payloads are deserialized via `opentelemetry-proto` generated types. Received signals are persisted raw on receipt and classified into canonical rows by the RTDB ingest classifier — no standalone `FredoEvent` in the OTLP delivery path. Invalid or malformed OTLP payloads are dropped without processing.

### UI
The React UI renders all agent-provided content via React's JSX (no `dangerouslySetInnerHTML`). `FredoEvent` payloads are treated as data, not markup.

---

## Process Isolation

- The Rust backend and the React webview run in separate processes (Tauri architecture)
- The webview has no access to the filesystem, PTY, or IPC socket — only to declared Tauri commands and events
- The communication layer (`infrastructure/comm/`) and the RTDB row pipeline (`infrastructure/rtdb/`) provide the security boundary between agent input and frontend features. OTLP receivers persist raw spans and the ingest classifier maps them onto canonical rows; `fredo emit` CLI events are enriched by `InternalAdapter` and fed through the same classifier. `EventBus.emit_row_delivery_batch` emits `RowDeliveryBatch` envelopes on the `fredo-stream-event` IPC channel; raw `FredoEvent` never crosses IPC.
- The feature-owned data layer (`infrastructure/feature_data/`) sits ON TOP of the canonical rows: a feature declares its structure and source mapping, and the backend materializes/writes its declared tables on the same active engine (`feature_<sanitized featureId>_<table>`; `fredo.db` by default). Every read/watch/write is validated against the requesting `featureId`, so one feature never observes or mutates another's data; canonical rows are READ-ONLY to the projection. Notifications ride the same `fredo-stream-event` channel as `FeatureDeliveryBatch` envelopes, discriminated in `AppProvider` before the RTDB validators.
- The PTY terminal spawns child processes as the same OS user; no privilege escalation occurs
- OTLP receivers run as separate tokio tasks within the same process; no additional processes spawned

---

## Pipeline Comment Surface

Fredo's automated agentic pipeline uses GitHub issues as its communication backbone and log. **Pipeline issues** (those tracked by pipeline labels such as `backlog`, `planning`, `ready-for-dev`, `testing`, `audit`, `cleanup`, `done`) are a **maintainer-controlled comment surface**: their conversations are **locked** (lock reason `off-topic`), so only users with write access (collaborator/member/owner) can comment. The pipeline state machine retains write access and keeps posting `Status`, `Triage Plan`, and `Tests Runs` comments on them.

**Why this is a security control:** the pipeline reads issue comment text as trusted context. With `FredoAi/fredo` now public, an untrusted third-party comment on a pipeline issue is a **prompt-injection / context-poisoning** vector — it could inject instructions into the automated pipeline's trusted input. Locking pipeline issues confines that surface to write-capable authors, and the pipeline's comment reads additionally flag and **exclude** comments from non-write authors from agent context and verdict parsing.

A repo-level interaction limit (`collaborators_only`) is set as a temporal belt-and-suspenders. It is **temporary by design** — GitHub caps interaction-limit expiry at six months, so it must be re-applied — and it is not a permanent control. The durable guard is per-conversation lock-on-create.

**How to report a real issue:** report security vulnerabilities privately via the repository's Security tab (a private advisory) — see [Reporting Security Issues](#reporting-security-issues) below. For non-security bug reports and feature requests, open a regular GitHub issue. Public comments on a locked pipeline issue are not read by the pipeline.

---

## Release Approval Gate (Spec #2803)

Fredo ships installable builds from a dedicated protected release branch (`release/stable`), so a user only ever downloads a deliberately reviewed, versioned release. The release gate is a security control (NFR-1) and is **non-bypassable**:

- Any PR into `release/stable` requires the owner's explicit approval (`@pktron` via `require_code_owner_review` + `required_approving_review_count ≥ 1`). An unapproved PR is blocked even when all CI checks are green.
- Direct pushes to `release/stable` are forbidden, and the repository ruleset is configured with an **empty bypass list** — so no one, including repo admins, can bypass the protection.
- `release.yml` (`.github/workflows/release.yml`) triggers on a push to `release/stable`, builds the platform artifacts, and publishes them to a **draft** GitHub Release (`releaseDraft: true`) so the owner reviews and publishes them. The release workflow never triggers on `main` and is never a required check on `main`.
- The release approval gate and the full owner-manual cut procedure are documented in [`docs/release-process.md`](release-process.md). The `release/stable` branch protection and ruleset are repo-admin **settings** that the owner applies (they are not a checked-in file).

## Reporting Security Issues

Report security vulnerabilities privately via the GitHub repository's Security tab (private advisory). Do not open public issues for security-sensitive findings.
