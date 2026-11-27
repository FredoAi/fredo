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
- OTLP telemetry is persisted on receipt to the active store (the embedded PostgreSQL cluster, the shipped default since Spec #2979) (`telemetry_spans`/`telemetry_metrics`/`telemetry_logs`) and classified into canonical rows by the RTDB ingest classifier (`infrastructure/rtdb/ingest.rs`). All persisted telemetry stays local — nothing leaves the machine. Retention is bounded by the existing `delete_expired` sweep (default 7 days).
- Capturing a **GitHub Copilot CLI** session requires no credential held or handled by Fredo: the CLI authenticates itself and exports to plaintext loopback (`http://127.0.0.1:4318`) with no headers. Fredo sets no `OTEL_EXPORTER_OTLP_HEADERS`, adds no token store, and never logs or persists Copilot auth material.

**Limitations:**
- Any process on the same machine can send OTLP data to these ports
- Malicious local processes could inject fake telemetry events
- This is acceptable for a dev tool where the threat model is the local user

---

## Companion engine (in-process)

The companion's inference runtime ships as native DLLs **beside `fredo.exe` in the install directory** (the `engine-payload/` resource tree; the `dynamic-link` build does not link them into the executable) and is loaded **in-process** by the Fredo process through the `llama-cpp-4` bindings, on one dedicated engine thread. There is **no** `llama-server` child process, **no** listening socket, and **no** loopback HTTP transport — the former child-process surface was retired in Spec #3141, so there is no port for another process to reach and no process to leak.

**Protections:**
- **No TLS stack is shipped or required.** The engine is built with `LLAMA_OPENSSL=OFF` (the checked-in `[package.metadata.llama-cpp-sys-4.cmake]` table in `apps/tauri/src-tauri/Cargo.toml`), and no staged payload DLL may carry a load-time or delay-load import of `libssl*`/`libcrypto*`. Both the staging gate (`stage-engine-payload.ps1`) and the produced-installer gate (`verify-installer-payload.ps1`) import-scan every payload DLL on their own tree and fail closed, so the engine cannot speak TLS/HTTPS and no OpenSSL library is distributed alongside it
- No new listening surface: the engine opens no socket, which removes rather than adds an attack surface
- The engine never consults `PATH`, winget, or a configured executable path — model files come from the pinned manifest under the local models directory, and nothing is fetched at load time
- Commands reach the engine only through its owned-thread channel from `applications/llm_server`; nothing spawns an inference process ad hoc
- Model paths come from the local settings DB + the pinned manifest — no network fetch at load

**Limitations:**
- There is **no process-level fault containment**: a `ggml` abort, out-of-memory, or driver fault takes the whole Fredo process down. Mitigation is typed errors on recoverable paths plus defensive context sizing — not process isolation. (This is a disclosed, accepted trade-off of running the engine in-process.)

## Embedded PostgreSQL (`applications/pg_supervisor`)

The embedded-PostgreSQL subsystem ships the **lifecycle supervisor, the PostgreSQL-only storage engine seam, the KV/application family, the RTDB canonical store, and the SpanStore (telemetry spans/metrics/logs), and the packaging/install of the runtime (an explicit build-time acquisition mode + a SHA-256-pinned archive acquisition)**: PostgreSQL is the ONLY store. Spec #3005 removed SQLite entirely — the control-plane file DB, the synchronous SQLite engine, the SQLite driver dependency, and the legacy one-shot migration/backout subsystem. The pool DSN embeds the generated loopback secret held in the **OS keychain** (service `fredo.postgres`, account `loopback:password`) — never logged, never in code, never persisted in a file; the role is the crate's local `postgres` superuser and the application database is `fredo` (Spec #3036 — the role stays unchanged; the database is Fredo-named, migrated in place once from the bootstrap `postgres` via a catalog-only rename). `telemetry_spans` remains strictly read-only to the RTDB/backfill path via `begin_read_only`.

**Protections:**
- The managed postmaster is started on every boot (PostgreSQL is the default engine); it binds an **ephemeral loopback port on `127.0.0.1`** (never OTLP 4317/4318 or the MCP bridge 9223)
- Spawned/stopped only through `applications/pg_supervisor` — by the Fredo desktop process itself; nothing else starts it ad-hoc. That process holds the **exclusive data-dir lock**, so a second instance **fails** to start a cluster instead of attaching to, adopting, or sharing the running one (there is no descriptor-published cluster and no non-GUI owner)
- The resident Fredo process is the **only** owner of both the cluster and the OTLP receivers, and a login launch does not change that: `"<current_exe>" --background` starts the same single process with no window shown, so there is no second owner even when no window exists
- Every start/readiness/stop wait carries a **finite wall-clock cap** with a hard-kill (`taskkill /T /F`) fallback and guaranteed teardown on normal, error, and panic paths — the observed ~11 h unbounded `pg.stop()` hang (#2948) is closed
- A PID-reuse-guarded startup sweep reclaims a previous run's orphan (killed only when its image is `postgres.exe`); an exclusive data-dir lock prevents two launches from touching one cluster
- The cluster password is a generated local-only secret stored in the **OS keychain** (service `fredo.postgres`, account `loopback:password`); it is never written to a file, a log, or telemetry. A fixed loopback-only fallback is used only when the keychain is unavailable (never logged)
- Config surface (Spec #3022): Settings → **Database** changes the superuser password **in place** (`ALTER USER … PASSWORD`, quoted server-side via `format('%L')`) and updates the keychain — never a re-init, no data loss on the happy path; a warned, destructive **Reset database** re-initialises with the stored password to recover a drifted credential. The password is a **write-only** UI field (never returned by `pg_config_get`) and is NOT a field of the non-secret sidecar config `<app_data_dir>/postgres-supervisor.json` (port + log verbosity only). Since Spec #3067 an `authMismatch` boot failure (a drifted credential) also surfaces a prominent app-shell recovery banner — visible without opening Settings — whose one-click **Reset database** is gated by an explicit destructive-data acknowledgement, so the destructive action always requires user consent and is **never performed automatically**. The cluster stays **loopback-only** (`listen_addresses` fixed/non-editable)
- The legacy one-shot migration/backout leg was removed by Spec #3005 (fresh-install-only; a pre-existing legacy SQLite file is ignored byte-for-byte, never read or mutated); `telemetry_spans` reads remain strictly read-only (`begin_read_only`)
- On the shipped `runtime-download` path the PostgreSQL distribution is acquired through Fredo's **SHA-256-pinned streaming engine** (skip-if-verified, `Range` resume, streaming digest seeded from the on-disk prefix, delete-on-mismatch, bounded retry) — the same engine that verifies Companion model files — and is **extracted by Fredo itself**: the digest is re-verified against the committed pin (`PG_ARCHIVE_SHA256`) and the archive is unpacked with Fredo's own streaming tar/gz extractor, which strips the archive's single top-level component so `bin/`, `lib/`, and `share/` land directly under the installation directory. A digest mismatch deletes the artifact and surfaces an actionable error, and extraction writes no distribution file until the digest matches — the binaries that run are never produced from unverified bytes. On this path `postgresql_embedded` performs **no** archive or version download: the installation directory is marked trusted and the crate version is pinned to the exact `18.6.0`, so the crate's `install()`/download path is never reached. The shipped mode is `runtime-download` (the crate default; ~0 B installer growth)
- The Fredo-extracted verified-archive path applies on **Windows x86_64 only**; on every other platform the crate keeps today's own archive self-fetch, which remains outside Fredo's committed pin (documented follow-up)
- The optional `bundled` compile-time feature embeds the archive (no first-run network) but its **build-time** fetch is outside Fredo's SHA-pinned integrity surface — documented as a deliberate deviation, bounded by the pinned crate version + `Cargo.lock` (a SHA-pinned resource is the hardening path)
- The `cutover_release_gate` and its one-shot marker retired with the migration subsystem (Spec #3005); PostgreSQL is unconditional

**Limitations:**
- The loopback cluster is reachable by any process on the same machine (no per-client auth beyond the local password)
- A hard-kill/power-loss can still orphan a postmaster; the next start's sweep reclaims it (residual accepted for this slice)
- Capture and the cluster run for exactly as long as the Fredo process does, and that is accepted behaviour rather than a fault: quitting ends them through the bounded teardown, while a crash, a force-kill, or a reboot before sign-in ends them abruptly. The next start resumes capture (the login entry is a per-user value, so nothing starts before sign-in) and reclaims a postmaster a hard kill orphaned. Full mechanism: [ARCHITECTURE.md → The resident shell](ARCHITECTURE.md#the-resident-shell)
- With `bundled`, the archive is fetched at **build time** from the crate's upstream host, outside Fredo's SHA-pinned integrity surface (see above)

---

## Doom Runtime (`applications/doom`, Specs #2968, #2969, #2970, #2971, #3023)

The Doom Mode foundation runs a **native in-process pure-Rust engine** (`neurodoom` 0.6.7, BSD-3-Clause) behind a Fredo-owned adapter in `applications/doom/engine.rs`. The engine is a cargo dependency compiled into the app — **no separate engine process, no loopback HTTP server, no vendored GPL source, and no build/toolchain/provisioning step**. The game data is the bundled shareware `apps/tauri/src-tauri/doom/DOOM1.WAD`; the installer ships no GPL engine binary and no downloaded WAD (Spec #3023 replaced the former RESTful-DOOM stack).

**Protections:**
- **No network surface:** the engine opens no listener and binds no socket; all control is Rust-side in-process. The webview CSP `connect-src 'self' ipc: http://ipc.localhost` is unchanged and the webview cannot reach the engine directly (it receives base64 PNG frames only)
- Owned only by `applications/doom`; teardown is take-and-drop of the session on window close **and** app exit (`RunEvent::Exit`) — no child process or dedicated engine thread exists, so no orphan is constructible
- **No download / no build:** the engine is a static cargo dependency and the WAD is bundled — nothing is fetched or compiled at runtime, so there is no unpinned acquisition and no toolchain integrity surface
- **Licensing posture:** `neurodoom` is BSD-3-Clause (no GPL / corresponding-source obligation); the retired GPL-2.0 RESTful-DOOM resources are removed. The bundled shareware `DOOM1.WAD` is redistributable; the retail `DOOM.WAD` is never bundled or used. Full record: `docs/THIRD_PARTY_NOTICES.md`
- Companion autoplay (Spec #2969) reuses the **same in-process engine session** — it constructs no second engine; the loop is bounded (600 steps, 3 consecutive failures, 30 s per-decision timeout) and never hangs. Its inference request carries **structured game state only** — no image/audio parts, and the framebuffer is never sent to the model
- Secret activation (Spec #2970): Doom Mode is reachable only via its two secret triggers (`iddqd` typed in the main window, or the companion's model-selected `doom_mode` skill) and leaves **no discoverable trace** before activation; the mode is **never persisted** (a fresh boot is always `inactive`). While active it suppresses only the companion's local voice/audio **input** pipeline (capture + model-audio turn) via an in-memory gate — no audio is emitted, and every exit path (native window close, spoken stop, app exit) clears the gate and restores normal behavior with a bounded teardown
- Doom theme (Spec #2971): while the mode is engaged the app restyles from the **theme token contract only** (`DOOM_PALETTE` applied as a mode-scoped `ThemeProvider` layer); the palette is **never added to the preset list** (it cannot be selected in Settings), the mode-scoped override is **never persisted**, and exit restores the user's prior theme/settings byte-exactly — no residue and no changed setting
- Save/resume (Spec #2972, store moved Spec #3011, map set reworked Spec #3023): the campaign resume point is one bounded record kept **locally only** in the dedicated PostgreSQL feature table `feature_doom_save` (one `id='singleton'` row) — no cloud, no network, no new process; it is a scalar-shaped `DoomSave` written by a single atomic upsert, its coordinates are restricted to the single-episode E1M1–E1M9 set (an out-of-set/E2/E4 record is rejected), and reads reject malformed data (a corrupt or legacy-version save yields a clean run, never a crash)

**Limitations:**
- The engine runs in-process with no IPC boundary; a future engine change would widen the app's own trusted surface (the adapter wraps it behind a Fredo-owned contract for that reason). The retired loopback design's local-attacker concern no longer applies

---

## Database Client (`applications/db_client`, Spec #2950)

The built-in SQL Studio client connects to **external** PostgreSQL databases (separate per-connection pools). Since Spec #3029 it also seeds ONE built-in connection — **"Fredo"** — that targets Fredo's own **embedded** cluster **read-only** (database `fredo`, role `postgres`); its endpoint (host/port) is resolved **live at connect time** from the supervisor and its password comes from the PG **supervisor's** loopback keychain entry (`fredo.postgres` / `loopback:password`), so **no ephemeral port and no secret are ever persisted** in the connection metadata. The client's own per-connection keychain (`fredo.dbclient`) and the external-connection credential model are unchanged.

**Protections:**
- **Credentials in the OS keychain only.** A saved connection's password is stored via the `keyring` crate (Windows Credential Manager / macOS Keychain / Linux Secret Service; service `fredo.dbclient`, account `connection:<id>:password`). The settings store (`settingsService`/`SettingsStore` KV) holds only **secret-free** connection metadata, history, saved queries, and preferences — no plaintext password is written to disk, logs, telemetry, or CSV/JSON exports. (Note: `patStorage.ts`'s base64 PAT handling is obfuscation, not a credential store; DB-client passwords never use it.)
- **Read-only by default.** A new connection defaults to read-only; a read-only connection structurally refuses any non-`read` statement **before contacting the server**. Write mode is an explicit, visible per-connection opt-in.
- **Server-side read-only enforcement (second layer).** A read-only connection's pool applies `SET default_transaction_read_only = on` to **every physical connection** through a pool `after_connect` hook (so it also covers a replacement connection created after a drop). PostgreSQL itself then rejects any statement its read-only-transaction rules disallow — including one that classifies `read` client-side (e.g. `SELECT … FOR UPDATE`, `nextval`/`setval`, `lo_*`) — with SQLSTATE `25006`. Write mode attaches no hook and is unchanged.
- **Destructive/`unknown` statements are confirmation-gated.** In write mode, UPDATE/DELETE/DROP/TRUNCATE/ALTER (and unclassifiable statements) return `confirmationRequired` without executing until the caller echoes back the matching statement hash; a single action never executes multiple statements (multi-statement is an explicit opt-in).
- **Bounded everything.** Connect ≤10 s, statement timeout 30 s, result sets default 100 rows / hard cap 5,000 with explicit "Load more"; at most 2 simultaneous connections (the built-in client's cap, derived from the shared connection policy — Spec #3028); the result cache is released on disconnect/delete.
- **TLS honoured, never silently downgraded.** `require`/`verifyCa`/`verifyFull` map to `sqlx`'s `PgSslMode` and are not weakened.

**Limitations:**
- Any process on the same machine under the same OS user can read the OS-keychain secret for the service, as with any keychain-backed app credential.
- The client can execute arbitrary SQL against the user's external database when write mode is enabled — that is the user's explicit choice, gated by the confirmation flow above.

---

## Voice Input

Voice input is **local-only by hard requirement**. Microphone capture is native (`cpal`/WASAPI in Fredo's Rust — no `getUserMedia`), and the captured utterance is understood by the companion model itself as that turn's input. There is exactly **one speech path** (model audio) and **no separate on-device recognizer or transcription mode**. Audio never traverses the network: the clip is encoded **in-process** by the companion engine (through `mtmd`) and never leaves the machine — there is no network client on the path at all.

**Model audio.** A captured clip is handed to the companion model as that turn's input and **no transcript is shown**. It is encoded in-process, is never uploaded, and adds no outbound route. It is used only when the installed model reports audio support — capability is probed, never inferred from a model name — and when the model does not support audio (or the companion engine is not running) nothing is sent and Fredo says so.

**Protections:**
- No audio or audio-derived payload is transmitted; the capture path contains no network client (pinned by the `voice_decode_path_has_no_network_or_process_symbols` invariant test)
- Voice is **opt-in** (`Fredo_companion_voice_enabled`, default `false`) — nothing is captured before the user enables it
- Capture can be started ONLY by **holding Space in the focused, empty launcher search bar** (Spec #2882) — no keyboard gesture (Ctrl+Space included) starts a session and **no new capture path exists**, so nothing is captured while the user is merely typing or navigating
- Capture must be **visibly indicated for its whole duration** by the **launcher bar cue** (the `Listening` chip and placeholder, announced as text), and the cue appears only while capture is genuinely live, so audio is never captured without a visible active indicator; Spec #2882 retired the companion listening bubble, leaving the bar cue as the only capture indicator
- **No capture before the gesture:** no microphone stream exists and no audio is captured until the Space hold; with voice disabled nothing is captured
- The microphone is released the moment Space is released, the utterance is cancelled, the bar or window loses focus, or voice is disabled
- **Model audio adds no new egress:** a model-audio clip is encoded in-process by the companion engine — there is no transport hop at all — so the layer-confinement invariant over `infrastructure/voice/**` (no network/process symbols) is unchanged, and there is no cloud-fallback branch
- **No transcript exists:** the single speech path produces no transcript, so no audio-derived word reaches any surface
- **The clip is bounded and non-lossy:** capture auto-stops at the pinned limit (`MAX_AUDIO_CLIP_MS`, ~30 s) with a visible notice, and the entire clip is kept and delivered — never a silent truncation or a dropped tail
- **The capture is visibly indicated for its whole duration** by the launcher bar cue (including its processing state); there is no silent capture
- The native WASAPI path needs no CSP widening and no new Tauri capability

**Limitations:**
- Any process on the same machine can access the microphone under the same OS user — the OS owns the microphone privacy/permission boundary

---

## Tauri Capabilities

Tauri v2 uses a capability system to declare the minimum set of permissions the webview requires. There are three capability files, all auto-loaded: the production set (`capabilities/default.json`), the debug bridge's permission (`capabilities/mcp-bridge-dev.json`, dev-only), and — since Spec #3147 — `capabilities/app-commands.json`, which grants the application command surface to the built-in window class (see the application-manifest rule below). Fredo follows least-privilege:

| Permission | Why required |
|-----------|-------------|
| `core:default` | Standard window management (resize, minimize, etc.) |
| `core:event:allow-listen` | Webview subscribes to `fredo-stream-event` and `terminal-output` Tauri events |
| `core:event:allow-emit` | Rust backend emits events to the webview |
| `core:window:allow-create` | Backend opens the `terminal` WebviewWindow for PTY output |
| `core:window:allow-close` | Backend closes the terminal window when the PTY process exits |
| `core:window:allow-start-dragging` | Webview supports native window drag (title bar region) |
| `core:window:allow-set-title` | Backend updates window title dynamically (agent session name) |

No filesystem or shell permissions are granted to the webview. All filesystem operations — and all process spawning — are performed by the Rust backend via Tauri commands and `std::process::Command` / `portable_pty`, never by the webview directly. The shell plugin is still registered by the backend (`tauri_plugin_shell::init()` in `src/lib.rs:167`), but no capability grants any `plugin:shell|*` command, so every shell invocation — `open`, `spawn` and `execute` included — is rejected by the ACL. `shell:allow-open` was removed for the same reason: no product source calls the shell plugin, and `window.open(url, '_blank')` is a pre-existing no-op in this WebView2 app (there is no opener plugin and no `on_new_window` handler, so wry cancels the new-window request) — the permission was never on that path.

### The application-manifest rule (Spec #3147)

`build.rs` registers an **application manifest** with `tauri_build::AppManifest::commands(...)` (the list is `src/runtime/command_manifest.rs`, `COMMAND_MANIFEST`). This is a security boundary, not a build detail, and three rules follow from it:

1. **No capability, no commands.** Registering the manifest makes Tauri's IPC authority gate run (`has_app_acl_manifest` is true), so `resolve_access` runs for **every** command against **every** window label. Before this, a bare `tauri_build::build()` registered no manifest and Tauri skipped the app-command ACL check entirely — every registered command was callable from every window regardless of label, origin or capability. That blanket allow is gone: a window that matches **no** capability now gets **zero** application commands, by construction.
2. **The built-in windows keep today's full surface through one named capability.** `capabilities/app-commands.json` grants the app-manifest `default` permission set — `permissions/app/default.toml`, one `allow-<command>` entry per registered command — to exactly `["main", "terminal", "doom", "app-*"]`. That is the only mechanism by which a command reaches a window now; losing the capability, the permission set, or an entry in either denies that command to every shipped window. Two build-time guards enforce this: a unit test asserts every command parsed out of `generate_handler![]` appears in `COMMAND_MANIFEST` (a missing entry would otherwise be silently denied/dropped in every window), and a second asserts every registered command is granted in `permissions/app/default.toml` and that the capability still targets all four built-in labels.
3. **`installed-*` matches exactly ONE capability.** `capabilities/installed-app-commands.json` is the only file whose `windows` list matches an installed label (`["installed-*"]`), and it grants exactly `allow-installed-app-invoke` — the one command `installed_app_invoke` — with no `core:*` permission. `capabilities/default.json`, `capabilities/app-commands.json` and `capabilities/mcp-bridge-dev.json` all target `["main","terminal","doom","app-*"]` and match no installed label. An installed application's window therefore reaches exactly one command; **which** action and **which** data it may then invoke is decided inside that one handler from the IPC webview's own window label, against the package's declared capabilities and the user's per-application consent (Spec #3146). The isolation is **cardinality plus exact set**, so **a second capability matching an `installed-*` label, an extra permission on the installed capability, or a per-application capability file removes the guarantee** and must be an explicit, reviewed decision, not an incidental edit. `permissions/app/default.toml` is a permission *set* referenced from a capability, never a capability itself — do not give it a `windows` key.

The manifest halves must stay in lockstep, and the command list is the single source: `permissions/autogenerated/` is **gitignored build output** autogenerated from `COMMAND_MANIFEST`, while `permissions/app/**` is the hand-authored set and `src/runtime/command_manifest.rs` is the one list.

**Dev-only debug bridge.** `mcp-bridge:default` (which expands to the plugin's command set, including `execute_js`, `execute_command` and `capture_native_screenshot`) is granted only by `capabilities/mcp-bridge-dev.json`. That file is inert in a release build: the plugin itself is registered under `#[cfg(debug_assertions)]` (`src/lib.rs:169-179`), so a release binary never binds the bridge port and never exposes those commands. The tauri MCP driver still reaches the bridge in a dev build.

**CSP and global Tauri.** The production CSP (`app.security.csp`) is `default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost; worker-src blob:` — `script-src` does **not** contain `'unsafe-inline'`, so an injected inline script cannot execute. `style-src` retains `'unsafe-inline'` because Chakra UI v3 / emotion inject runtime `<style>` elements. `app.security.devCsp` is the dev-only policy and the only place `script-src … 'unsafe-inline'` remains (Vite HMR needs the inline preamble). `app.withGlobalTauri` is `false`, so a shipped webview has no `window.__TAURI__` handle; product code reaches native APIs only through `__TAURI_INTERNALS__` (the dynamic imports in `TauriAdapter.ts` / `adapterBridge.ts`). The dev-only override `tauri.dev.conf.json` (merged by `tauri dev --config`) re-enables `withGlobalTauri` in development only, because the pinned MCP bridge returns its `execute_js` results through `window.__TAURI__.core.invoke`; the `build` and `dev:release` paths do not pass it.

### Opening an external link (Spec #3206)

Settings → Credits offers one activatable control per component entry, and activating it opens that entry's upstream page in the OS default browser. `open_external_link { url }` is the **only** webview-reachable OS-launch path: it is granted to the built-in window class by an `allow-open-external-link` entry in `permissions/app/default.toml` (referenced by `capabilities/app-commands.json`), so **no capability file was changed** and `shell:allow-open` remains absent.

**The refusal is pure and happens before any I/O.** `validate_external_url` (`applications/settings/credits.rs`) is a function over the request string: it performs no I/O, spawns no process, opens no window and mutates no state, so a refused URL physically cannot launch anything. A request is accepted only when **all** of the following hold:

- it begins with `https://` (ASCII case-insensitive) — every other scheme (`http:`, `file:`, `ftp:`, `javascript:`, `data:`, a custom scheme) and a protocol-relative `//host` is refused as `not-https`;
- it is 1…2048 bytes, and every character is in the admitted set: no whitespace, no control character, and none of the ASCII characters that carry meaning to the Windows shell (`&`, `%`, `^`, `|`, `<`, `>`, `"`, a backtick, `(`, `)`, `!`, `$`, `*`, `\`);
- the authority and host are non-empty (`no-host`);
- no userinfo is present (`userinfo`);
- the host is not `localhost`, not a loopback or unspecified address (`127.0.0.0/8`, `::1`, `0.0.0.0`, `::`, an IPv4-mapped loopback) and not a DNS-absolute (trailing-dot) name (`loopback-host`).

The refusal set is **closed** — exactly those five codes — and each crosses IPC as `external link refused: <code>`. An accepted URL whose hand-off then fails crosses as `external link failed: <os error>`; the pane renders whichever string it receives, unedited. (A refusal is rendered inline, under the button that was activated, and a successful hand-off produces no in-app message — Fredo cannot know whether the browser actually raised.)

**What acceptance does — and what this document does not claim.** The validated string is handed, unchanged and as a single target, to the OS through the `open` crate (5.3.4). **This document does not claim that nothing reaches a shell**: that crate's Windows mechanism could not be read at the pinned version from the development sandbox, and its dependency set rules out the usual Win32 shell-exec binding, leaving a shell hand-off as a live possibility. That uncertainty is exactly why the accepted character set above was narrowed rather than left at "no whitespace / no control characters": whatever the crate does with the string, the string it receives contains no character a shell can act on. The refusal path is I/O-free either way, which is the property the security model depends on.

---

## Installed Applications (Spec #3147)

An installed application is third-party code the user chose to add. It is contained by **four separate mechanisms**, each of which fails closed on its own: origin separation, a single declared command surface with per-capability consent, integrity pinned at install and re-verified at load, and install-time archive hardening. The isolation does **not** rest on the package behaving well.

> **Author-facing view.** The same boundary is stated for the people writing packages — as limits they cannot rely on — in [Building a Fredo application](authoring-applications.md), together with the capability vocabulary and the refusal codes.

**Protections:**

- **Origin separation.** An installed app is a document at the `fredoapp` scheme, which Tauri maps to `http://fredoapp.localhost` (Windows/Android) / `fredoapp://localhost` (elsewhere) — distinct from the host's `tauri://localhost` / `http://tauri.localhost` and from the dev server. A separate native window whose document has a separate origin, not an iframe in the host document, is what makes "cannot reach the host's context" structural rather than advisory.
- **One command, declared capabilities, per-app consent.** `capabilities/installed-app-commands.json` is the only capability matching an `installed-` label and it grants exactly `allow-installed-app-invoke` with no `core:*` permission, so the `installed-<id>` window reaches exactly one command (`installed_app_invoke`) and nothing else (see the application-manifest rule above). That one handler derives the caller's identity from the IPC webview's own window label — never from the payload — and decides each call against the package's **declared** capabilities (`data.tables` reaches only the application's own declared tables; `high-risk.*` additionally requires a per-application consent the user grants in Settings, re-read on every call) and the frozen six-code authority vocabulary. The served document's `connect-src` deliberately keeps the IPC transport reachable so that a command attempt is refused by the **ACL**, not by the network — a refusal the product can name, rather than an unexplained transport failure.
- **Verify at serve, not verify then serve.** Each requested file is read **once**, that same buffer is hashed, the hash is compared to the install record, and **that buffer** is served. There is no "check this path, then open this path" step, so there is no window in which the bytes can be swapped between the check and the use (CWE-367). An unrecorded file has no route — the install record *is* the whitelist — and responses carry `Cache-Control: no-store`, so a re-verified document is never served from a cache.
- **Host-authored policy and host-authored chrome.** The scheme handler authors the child document's CSP on every response (`default-src 'none'`, `script-src 'self'`, `base-uri 'none'`, `form-action 'none'`). `tauri.conf.json`'s `app.security.csp` is injected only for Tauri's own asset protocol, so it is untouched. The loading / failure / Retry surface and the theme style are host-authored and injected at serve time; an app supplies its own HTML, module and assets and nothing else.
- **Install-time archive hardening.** Entry names are **refused**, never silently sanitized, for absolute/drive/UNC prefixes, backslashes, NUL, empty/`.`/`..` segments, link or any non-regular entry type, and the host-reserved `__fredo/` segment, plus a normalize-join containment check — so a package cannot write outside its own install directory (zip-slip). Three budgets (4,096 entries / 256 MiB total / 64 MiB per file) are validated over the archive's **declared** sizes before a byte is read and re-enforced while writing, so a lying header cannot fill the disk. The whole install is staged in a sibling directory and renamed into place only when complete, so a refusal leaves no partial install.
- **The manifest is data, never code.** `fredo-app.json` is decoded with `serde_json` and nothing else; no field is interpreted as an executable path or a URL to fetch. `manifestVersion: 1` is a **closed** schema, so an unknown key is refused rather than silently ignored.

**Limitations:**

- **Package artifacts are unsigned.** There is no signature, registry, or update path in this slice. Trust in a package is the user's judgement at install time. The per-file SHA-256 record detects **post-install tampering** — it does not prove who authored the bytes, and it cannot detect a hostile package the user installed deliberately.
- **Installed code has no sandbox of its own beyond the platform webview.** The isolation above bounds what an installed app can *reach* — no host origin, exactly one command, and only the actions its package declared — not what it can *consume*: there is no per-app resource quota, no CPU/memory limit, and no separate security principal, so a hostile package can still burn CPU or memory within the webview it runs in.
- **The declared surface is the ceiling.** The window reaches one command (`installed_app_invoke`), and that command forwards only the actions the package's own `capabilities` object declared: `data.tables` reaches the application's own declared tables (its package's `capabilities.data.tables`, re-read from the canonical manifest on every call) and its writes cannot see the backend-managed columns; `high-risk.*` is refused until the user grants that application that capability, and a grant to one application never enables another. Nothing in this surface is host-minted for the package: there is no window-creating, install, consent or settings capability, and adding one is an explicit, reviewed decision.
- Adding a second `installed-*` entry to any capability `windows` list, an extra permission to the installed capability, or a per-command grant for an installed app **removes the isolation guarantee** (see the application-manifest rule above).

---

## Screenshot Application

The `capture_screen_region` command captures physical screen pixels via the `xcap` crate.

**Protections:**
- Only accessible via Tauri command (not from webview directly)
- Returns base64-encoded PNG — no file system writes
- Multi-monitor aware but only captures the specified region

**Spec #3244 added two further commands on the same surface, both granted to the BUILT-IN window class only:**

- **`capture_target_region`** — captures a physical-pixel rectangle **resolved for a target application**, so the companion's per-turn screen read is framed on the app the user is talking about rather than the whole monitor. It **delegates verbatim to `capture_screen_region`** (`xcap::Monitor` stays the only producer) and returns the same base64 PNG with no file-system write. It resolves the rect by a **DOM recipe for an in-window built-in** or, for a separate installed window, by the host geometry read below; an unknown id or an unopened target is a **typed null**, never a best-effort capture of something else.
- **`installed_app_screen_rect`** — reads a live installed window's **client-area physical rectangle**. It reports geometry only; it captures nothing and returns no pixels.

**The authority boundary is unchanged and is the point:** these two are added to `permissions/app/default.toml` — the **built-in** window class's permission set — and the **installed tier's single capability grants neither**. An installed application still reaches exactly one command (`installed_app_invoke`), so an installed document can neither read its own screen rect nor capture anything. `capabilities/installed-app-commands.json`, `runtime/capability_guard.rs` and the installed-tier exact-set invariant are **byte-unchanged** by the slice, and the audit verified them so (`SEC-1`).

**The companion's screen-read path is the consumer of both,** and it is worth stating what that means: the per-turn injected pair (screenshot + simplified-HTML outline) carries **whatever is rendered in the target application** into that turn's model input. It is produced **in-process, on-device, with no network call** — the same posture as voice capture — and the outline is bounded (`SCREEN_OUTLINE_MAX_NODES` / `SCREEN_OUTLINE_MAX_BYTES`) before it is injected.

**Limitations:**
- Can capture any visible content on the screen (including sensitive information)
- **A capture is whatever is TOP-MOST at the target's rectangle.** The product has **no mechanism to raise or front an installed window**, so with overlapping installed windows a target-framed capture can pick up another application's panel. Observed and proved in #3244's round 2 (`screenshotBytes` 223308 → 74232, distinct digest, once every other window was closed). Region-scoped ordering (#3246) is where this bites hardest.
- Intended for use by AI companion capabilities requiring visual context

---

## Data Storage

Settings are persisted as plain key-value pairs in the PostgreSQL `settings` table. A synchronous, volatile settings cache in `SettingsStore` is hydrated once from that table and write-throughs on every change; it holds no persistent state. The embedded PostgreSQL cluster lives in the Tauri app data directory (`%APPDATA%\fredo` on Windows, `~/.local/share/fredo` on Linux, `~/Library/Application Support/fredo` on macOS).

- No credentials or secrets are stored in the settings database. The one application that handles a user secret — the built-in SQL Studio client (`applications/db_client`) — stores the connection password in the **OS keychain** (`keyring`); the settings KV holds only secret-free connection metadata, history, saved queries, and preferences.
- Every SQL **value** is bound as a parameter — never interpolated (the PostgreSQL `sqlx` path). Dynamic **identifiers** (table and column names) cannot be parameterized, so they are charset-gated to `[A-Za-z0-9_-]`, validated against the target table's real physical columns (`information_schema.columns`), and only then `quote_ident`-quoted. An invalid identifier (including an unknown `order_by` column or `where_cols` key) is rejected with a typed error before any SQL text is built.
- Session history in the Mission Monitor is persisted via the RTDB row store on the embedded PostgreSQL cluster, applied to the module-scoped `StreamContext` row store in-memory. Live rows are unbounded; persistence retention is bounded by the `rtdb.retention_days` / `rtdb.max_rows` knobs.

---

## Input Handling

### IPC Commands
The IPC socket accepts newline-delimited JSON `CliCommand` messages with one variant:
- **`EmitEvent`** — accepts a raw `FredoEvent` via the `fredo emit` CLI command.

All payloads are deserialized via `serde_json`. Unrecognized fields are ignored, and missing required fields cause a deserialization error. The Rust type system prevents injection at the IPC boundary.

### Tauri Commands
Tauri command arguments are passed through Tauri's built-in deserialization, not constructed from raw strings. SQL queries to `SettingsStore` bind every value as a parameter via `sqlx` — no value interpolation. Identifiers cannot be parameterized, so a caller-supplied namespace component is charset-gated to `[A-Za-z0-9_-]` and a caller-supplied `order_by` / `where_cols` key is validated against the target table's physical columns; anything invalid is rejected with a typed error before the statement is built, and only then is the identifier `quote_ident`-quoted — the storage sink is the single quoting point.

### OTLP Input
OTLP protobuf and JSON payloads are deserialized via `opentelemetry-proto` generated types. Received signals are persisted raw on receipt and classified into canonical rows by the RTDB ingest classifier — no standalone `FredoEvent` in the OTLP delivery path. Invalid or malformed OTLP payloads are dropped without processing.

### UI
The React UI renders all agent-provided content via React's JSX (no `dangerouslySetInnerHTML`). `FredoEvent` payloads are treated as data, not markup.

---

## Process Isolation

- The Rust backend and the React webview run in separate processes (Tauri architecture)
- The webview has no access to the filesystem, PTY, or IPC socket — only to declared Tauri commands and events. No capability grants a shell-plugin command (no `open`/`spawn`/`execute`), and a production build sets `withGlobalTauri: false` with a `script-src` that forbids inline script, so a compromised webview has no arbitrary-execution path and no privileged native API surface: the ONLY OS hand-off it can trigger is `open_external_link`, which accepts an `https`-only, character-narrowed, non-loopback URL and refuses everything else before any I/O (see § Opening an external link)
- The communication layer (`infrastructure/comm/`) and the RTDB row pipeline (`infrastructure/rtdb/`) provide the security boundary between agent input and frontend applications. OTLP receivers persist raw spans and the ingest classifier maps them onto canonical rows; `fredo emit` CLI events are enriched by `InternalAdapter` and fed through the same classifier. `EventBus.emit_row_delivery_batch` emits `RowDeliveryBatch` envelopes on the `fredo-stream-event` IPC channel; raw `FredoEvent` never crosses IPC.
- The application-owned data layer (`infrastructure/application_data/`) sits ON TOP of the canonical rows: an application declares its structure and source mapping, and the backend materializes/writes its declared tables on the same active engine (`feature_<sanitized featureId>_<table>`; the embedded PostgreSQL cluster). Every read/watch/write is validated against the requesting `applicationId`, so one application never observes or mutates another's data; canonical rows are READ-ONLY to the projection. Notifications ride the same `fredo-stream-event` channel as `ApplicationDeliveryBatch` envelopes, discriminated in `AppProvider` before the RTDB validators.
- The PTY terminal spawns child processes as the same OS user; no privilege escalation occurs
- OTLP receivers run as separate tokio tasks within the same process; no additional processes spawned

### Reachability hardening (Spec #3078)

Three Rust/IPC seams reachable from the webview are additionally hardened so a compromised webview cannot name an executable or a write target:

- **The terminal test seam is release-absent.** `spawn_terminal_session`'s TEST-ONLY `test_override` argument (wire type `SpawnTestOverride`) is gated on `#[cfg(debug_assertions)]`, so a release build (`debug_assertions = false`) declares no such argument: no IPC payload can select the executable a PTY is pointed at, and the binary comes only from the stored `terminal_copilot_path` (Copilot) or PATH resolution. Debug/test builds keep the seam so the committed terminal recipes remain reachable (`SPAWN_TEST_SEAM_COMPILED_IN` is the compile-time marker).
- **Sensitive settings path values are validated on BOTH write planes.** `save_setting` (data plane) and `save_control_setting` (control-plane cache) apply the same rule to exactly three keys — `llama_server_companion_dir`, `terminal_copilot_path`, `terminal_pwsh_path`. (`llama_server_path` was removed from the set with the out-of-process runtime in Spec #3141; a persisted value is inert — never read for runtime resolution — and is never deleted.) A non-empty value must be absolute, free of control characters and free of `..` components (the checks run control characters → absolute → `..`, and the first match is rejected with a message naming the key and the rule); an empty/whitespace-only value clears the setting; every key outside the three is stored unchanged (no allowlist). An accepted value is persisted byte-identically — never trimmed or normalised.
- **The dataset export cannot name an arbitrary file.** The webview `export_doom_dataset` command takes **no path argument** — it opens a native save dialog and writes only to the path the user picks (`Ok(None)` on cancel, nothing written). The headless CLI/IPC `--out` (a separate, non-webview entry) is confined to `<dataset_dir>/exports/`: absolute paths, drive/UNC prefixes and `..` components are rejected with a typed error, and a blank/absent `--out` writes the default `<dataset_dir>/exports/doom-dataset-<ts>.<ext>`.

The command names and the debug wire keys (`testOverride`, `binary`, `pwshMajor`) are unchanged, and no new dependency, plugin, capability or CSP change is introduced. This hardens reachability only — it does not alter the trust model above (any process running as the same OS user can still call the local IPC socket).

---

## Pipeline Comment Surface

Fredo's automated agentic pipeline uses GitHub issues as its communication backbone and log. **Pipeline issues** (those tracked by pipeline labels such as `backlog`, `planning`, `ready-for-dev`, `testing`, `audit`, `cleanup`, `done`) are a **maintainer-controlled comment surface**: their conversations are **locked** (lock reason `off-topic`), so only users with write access (collaborator/member/owner) can comment. The pipeline state machine retains write access and keeps posting `Status`, `Triage Plan`, and `Tests Runs` comments on them.

**Why this is a security control:** the pipeline reads issue comment text as trusted context. With `FredoAi/fredo` now public, an untrusted third-party comment on a pipeline issue is a **prompt-injection / context-poisoning** vector — it could inject instructions into the automated pipeline's trusted input. Locking pipeline issues confines that surface to write-capable authors, and the pipeline's comment reads additionally flag and **exclude** comments from non-write authors from agent context and verdict parsing.

A repo-level interaction limit (`collaborators_only`) is set as a temporal belt-and-suspenders. It is **temporary by design** — GitHub caps interaction-limit expiry at six months, so it must be re-applied — and it is not a permanent control. The durable guard is per-conversation lock-on-create.

**How to report a real issue:** report security vulnerabilities privately via the repository's Security tab (a private advisory) — see [Reporting Security Issues](#reporting-security-issues) below. For non-security bug reports and enhancement requests, open a regular GitHub issue. Public comments on a locked pipeline issue are not read by the pipeline.

---

## Release Approval Gate (Spec #2803)

Fredo ships installable builds from a dedicated protected release branch (`release/stable`), so a user only ever downloads a deliberately reviewed, versioned release. The release gate is a security control (NFR-1) and is **non-bypassable**:

- Any PR into `release/stable` requires the owner's explicit approval (`@pktron` via `require_code_owner_review` + `required_approving_review_count ≥ 1`). An unapproved PR is blocked even when all CI checks are green.
- Direct pushes to `release/stable` are forbidden, and the repository ruleset is configured with an **empty bypass list** — so no one, including repo admins, can bypass the protection.
- `release.yml` (`.github/workflows/release.yml`) triggers on a push to `release/stable`, builds the platform artifacts, verifies the engine payload inside the produced installer, then runs the **live release-artifact gate** (`gate-release-artifact.ps1`: extraction without elevation, launch survival, a styled UI with zero CSP violations, first-run DB readiness on a fresh and a pre-dirtied profile, one companion turn answered through the app, a closed MCP bridge, and a complete evidence set) plus the three fail-closed negative-control legs (MissingDll / Csp / Database), and only then publishes to a **draft** GitHub Release (`gh release create … --draft`) so the owner reviews and publishes them. A failure at either gate fails the job and leaves **no draft and no asset**. The release workflow never triggers on `main` and is never a required check on `main`.
- The release approval gate and the full owner-manual cut procedure are documented in [`docs/release-process.md`](release-process.md). The `release/stable` branch protection and ruleset are repo-admin **settings** that the owner applies (they are not a checked-in file).

## Merge Gate (Spec #3079)

The `main` merge gate is the other non-bypassable control, and it is **fail-closed**:

- **`validate`** (`.github/workflows/validate.yml`) is the **only** required status check. It runs
  `if: always()`, so it always produces a real conclusion, and it **fails** when the `paths`
  discriminator did not succeed or when either per-stack leg (`ui-validate`, `rust-validate`)
  reports anything other than exactly `success` or `skipped`. A `cancelled`, failed, or otherwise
  abnormal leg therefore turns the required check **red** — it cannot be merged through a
  timeout, a manual cancellation, or a broken path filter.
- **Dependencies are resolved deterministically:** both in-scope installs use
  `pnpm install --frozen-lockfile`, so a drifted `pnpm-lock.yaml` fails the gate instead of
  silently resolving different versions.
- **The OpenCode plugin is covered by the gate:** `apps/opencode-plugin/**` selects the UI leg,
  which installs the plugin workspace and builds `@fredo/fredo-opencode-plugin` — the plugin is a
  Tauri build hook, so a plugin compile break would break the shipped app.
- **`fast-validate`** (`.github/workflows/validate-fast.yml`) is an explicitly **non-gating**
  early signal — it is never a required check and never short-circuits the thorough gate.

[`docs/CI_GATE_CONTRACT.md`](CI_GATE_CONTRACT.md) is the authoritative description of the
per-stack behaviour; the branch-protection rule that points at `validate` is a repo-admin
**setting**, not a checked-in file.

## Reporting Security Issues

Report security vulnerabilities privately via the GitHub repository's Security tab (private advisory). Do not open public issues for security-sensitive findings.
