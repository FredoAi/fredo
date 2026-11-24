# Fredo Desktop App — Setup Guide

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust toolchain | ≥ 1.75 | [rustup.rs](https://rustup.rs/) |
| Tauri CLI v2 | latest | `cargo install tauri-cli --version "^2"` |
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org/) |
| pnpm | ≥ 8 | `npm i -g pnpm` |

### Windows additional dependencies

```powershell
# WebView2 (usually pre-installed on Windows 11)
# Install from: https://developer.microsoft.com/microsoft-edge/webview2/

# Visual Studio 2022 Build Tools with C++ workload (MSVC linker for Rust Windows builds)
# The --add flag ensures the C++ toolchain is included
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

> **Important:** Restart your terminal after installing VS Build Tools so the MSVC linker is found on `PATH`.

### macOS additional dependencies

```bash
xcode-select --install
```

### Linux additional dependencies

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

## Install Dependencies

```bash
# From the monorepo root
pnpm install
```

## Download Models

GGUF model files are **not required to build** — they are only needed at runtime for local AI inference. Models are **not stored in git** (too large).

The **Companion** ships its inference runtime inside Fredo, so setup only needs its three model files — downloaded in-app, no manual download for a normal setup and no external tool to install.

### In-app download (Companion — recommended)

Open **Settings → Companion** and click **Download model files** in the guided setup wizard's **Model files** step. Fredo fetches the three pinned companion files with per-file progress and verifies each with its SHA-256; already-present files are skipped and an interrupted transfer resumes from where it stopped. They land under `<models_dir>/gemma-4-e2b-it-qat/` (the models directory is the `models_dir` setting; default `~/fredo-models`).

| File | Size | Source ([unsloth/gemma-4-E2B-it-qat-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-qat-GGUF)) |
|------|------|--------|
| `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf` | ~2.6 GB | model |
| `mmproj-BF16.gguf` | ~987 MB | vision projector |
| `MTP/mtp-gemma-4-E2B-it-Q4_0.gguf` | ~59 MB | speculative draft (MTP) |

### Manual download

Place the required files (table above) under `<models_dir>/gemma-4-e2b-it-qat/` — default `~/fredo-models/gemma-4-e2b-it-qat/`. Preserve the `MTP/` subfolder for the draft file. Correctly-sized files dropped there manually are detected by **Re-check** in the wizard.

> `*.gguf` files are not stored in git.

### Supported Models

| Model | Vision | Notes |
|-------|--------|-------|
| Gemma 4 E2B (`gemma-4-e2b`) | ✅ | Full vision support via mmproj projector |
| MiniCPM-V 4.6 (`minicpm-v-4-6`) | ⚠️ | Vision projector unsupported; falls back to text-only |

The companion serves the model set configured in the Companion setup; no separate model selector is required.

## Companion Setup

The companion's runtime ships inside Fredo, so the only prerequisite is checked in-app. Open **Settings → Companion** on a machine that is not yet set up and the panel shows a setup wizard as its primary content:

- **Model files** — the three required files (model + vision projector + MTP speculative draft) under `<models_dir>/gemma-4-e2b-it-qat/`. The step lists them individually (`missing` / `downloading` / `present` / `error`), downloads them in-app with per-file progress, skips files already present, resumes an interrupted transfer via HTTP `Range`, verifies each with its pinned SHA-256, and names exactly which file(s) are missing. See [Download Models](#download-models). This is the **only** thing setup asks you to provision — there is nothing else to install.
- **Companion engine** — the engine now starts at launch when the model files are present: a spawned, bounded, once-per-process start loads the model into the in-process engine (shipped with Fredo, no external program) and confirms it is ready before any chat is sent, so a fresh install does not require this step. Its state is composed from `get_llama_server_status`, including the always-present `starting` flag while a load is in flight (the row reads a neutral "Starting", never "Not running"). If the launch start was skipped (no model files yet) or failed, the row's action calls `launch_llama_server` / `start_companion_engine`, which always returns a typed, actionable result (never hangs) — the row remains the retry. If the engine cannot start, the card names the cause and offers Retry.

Each step reports its own honest state (`checking` / `missing` / `installed` / `error`); the wizard is never shown as complete while the model files are missing. Once the model files are present and the engine is running, the normal Companion controls (the engine group, Show Fredo Companion, idle auto-return, voice input, Teleport tip) replace the wizard.

**Companion backend.** The engine runs on the GPU by default through **Vulkan**, with a CPU fallback; there is no CUDA backend. **Settings → Companion → Companion engine** holds a backend switch — **Automatic / GPU / CPU** — plus a readout of the backend and device the engine actually loaded. A change applies the next time the engine starts. Choosing **GPU** on a machine with no usable GPU fails with a typed, actionable message and leaves your setting intact; switch back to Automatic or CPU and start the engine again.

Voice input is a **shipped, opt-in** capability (default off): **Settings → Companion → Voice input** holds the enable/disable switch, the input-device selection, and the model-audio capability row. There is **no separate voice model to download or set up** — enabling voice and choosing an input device is all the setup it needs. It has exactly **one speech path**: the captured utterance is handed to the companion model itself (the same model the Companion setup installs) and **no transcript is shown**. All capture and understanding run on-device — audio never leaves the machine.

**How it works.** A captured utterance is handed to the companion model as that turn's input, and **no transcript is shown** — the model's reply appears in the normal conversation surface. Model audio is available only when the installed companion model supports audio; when it does not, or the companion engine is not running, Fredo says so (nothing is sent). The recording is bounded (about 30 s) with a visible auto-stop at the limit that keeps the whole clip, and it is encoded in-process — nothing leaves the machine.

## OTLP Configuration

Fredo includes local OTLP receivers for agent telemetry. **OpenCode 2 is the supported runtime** — the minimum major the setup gate enforces. The Fredo OpenCode plugin captures **by default** — an OpenCode session sends OTLP data with no environment variable set.

### OpenCode

Fredo supports **OpenCode 2**. Setup detects the installed version (`opencode --version`) and gates on it: on a 1.x install the OpenCode step names the version it found and tells you to run `opencode upgrade`, then re-run `fredo setup --check` — and installs nothing. Upgrading is the bare `opencode upgrade`; the exact selector for landing on 2.x is in the [install guide](https://opencode.ai/docs/install).

On OpenCode 2 setup installs the Fredo plugin **once, globally**, into the global plugins directory (`~/.config/opencode/plugins/fredo.js`): every OpenCode client on the machine loads it, so the plugin is never installed per repository or per session. Finishing setup does not stop, restart or reconfigure anything that is already running: OpenCode loads the installed global plugin itself, so an install never ends a turn that is in progress. (`opencode service restart` is OpenCode's own command if you ever want to cycle its server; Fredo never runs it for you.)

Capture is on unless you opt out. The default target is `http://localhost:4317` over gRPC; set the endpoint/protocol only when you need a non-default receiver.

```bash
# Windows — optional: point at a non-default receiver
setx OPENCODE_OTLP_ENDPOINT "http://127.0.0.1:4317"
setx OPENCODE_OTLP_PROTOCOL "grpc"

# Windows — opt out
setx FREDO_TELEMETRY "0"

# Unix (add to ~/.bashrc or ~/.zshrc) — optional endpoint override
export OPENCODE_OTLP_ENDPOINT=http://127.0.0.1:4317
export OPENCODE_OTLP_PROTOCOL=grpc

# Unix — opt out
export FREDO_TELEMETRY=0
```

`FREDO_TELEMETRY=0` (also `false` / `off`, case-insensitive) disables capture; unset or any other value leaves it on. `OPENCODE_ENABLE_TELEMETRY=0`/`false` also disables, and its absence no longer disables anything. Setting `enabled: false` in the plugin's `options` in `opencode.json(c)` takes precedence over both environment variables.

Fredo Terminal launches OpenCode against its **shared background service** by default, and that process loads the global plugin — that is the capture point, so the default path wires no per-session OTLP receiver and exports no variable. `--standalone` starts a private server instead of the background service and is the **isolation-only** lever: Fredo passes it only when the environment declares isolation (`FREDO_REQUIRE_ENV_ISOLATION`, or a non-default `OPENCODE_OTLP_ENDPOINT`), and on that path it also pins the child's `OPENCODE_ENABLE_TELEMETRY` / `OPENCODE_OTLP_PROTOCOL` / `OPENCODE_OTLP_ENDPOINT` to that environment's own receiver. It is never the default.

### Using the Setup Wizard

Fredo no longer opens the wizard automatically on startup. Reach it through either explicit entry:

- **Launcher tile** — from the desktop/launcher, select the **Fredo Setup** tile.
- **Settings** — open **Settings → Fredo Setup**.

Either entry opens the same wizard. It probes the installed OpenCode version and gates on it: on 1.x the OpenCode step shows the version it found plus the `opencode upgrade` remedy and installs nothing; on OpenCode 2 it installs the Fredo plugin into the global plugins directory and prints one `[fredo] … (global …)` line naming the resolved file. Finishing the install touches nothing else on the running runtime: no service restart, no environment variable, and no turn is interrupted. The telemetry step states how capture works — OpenCode loads the installed global plugin itself — so no OTLP environment variable is written or needed.

## Development

```bash
# Start the Tauri dev window with hot reload (Rust + React)
pnpm dev:tauri
```

This runs `tauri dev` which:
1. Starts the Vite dev server at `http://localhost:5174`
2. Compiles the Rust backend in debug mode
3. Opens the Fredo desktop window
4. Hot-reloads the React UI on file changes

### UI-only development (no Rust required)

```bash
# Start just the React UI in the browser
pnpm dev:ui
# Open http://localhost:5173
```

To simulate events from the browser console:

```js
window.__devAdapter.emit({
  id: crypto.randomUUID(),
  eventType: 'tool_use',
  state: 'Init',
  provider: 'open_code',
  transport: 'hook',
  sessionId: 'dev-session-1',
  toolName: 'Bash',
  payload: { command: 'echo hello' },
  timestamp: new Date().toISOString()
})
```

## Build

```bash
pnpm build:tauri
```

A local build produces an installer for your current OS in `apps/tauri/src-tauri/target/release/bundle/`:

| OS | Format | Location |
|----|--------|----------|
| Windows | `.msi` | `bundle/msi/` |
| macOS | `.dmg` | `bundle/dmg/` |
| Linux | `.AppImage` | `bundle/appimage/` |
| Linux | `.deb` | `bundle/deb/` |

> **Released installers are Windows-only.** The officially shipped installer (the NSIS `.exe`) is
> built by the owner-gated `release/stable` pipeline and published to a **draft** GitHub Release that
> the maintainer must review before it's public — see [release-process.md](release-process.md).
> Local `pnpm build:tauri` is for development and works on any host OS.

### Companion engine payload

The companion engine is **not** linked into `fredo.exe`: the `dynamic-link` build produces the ggml/llama/mtmd runtime as DLLs, and `build.beforeBundleCommand` runs `.opencode/scripts/stage-engine-payload.ps1`, which stages the canonical allowlist (`.opencode/scripts/payload-manifest.json`) into `apps/tauri/src-tauri/engine-payload/`. `bundle.resources` (`{"engine-payload/": ""}`) installs that tree **beside `fredo.exe` in the install directory** — not in a separate program and not behind a second install step. The staged set is **14 DLLs: 8 core modules + 6 optional tool modules**, and the staging gate import-scans **every one of them**, both load-time and delay-load imports, so an unresolved dependency — or a forbidden `libssl*`/`libcrypto*` import — fails the build instead of the user's launch.

The release pipeline refuses to publish a draft whose installer fails the artifact gate: `.opencode/scripts/verify-installer-payload.ps1` extracts the produced NSIS `.exe`, requires the **8 core** payload names to be present and non-empty, and then import-scans **every payload DLL actually present** in the extracted tree (core and any tool module) for forbidden or unresolved load-time and delay-load imports. The artifact gate never demands all 14: an optional tool module that did not ship is reported as `PAYLOAD_ABSENT_OPTIONAL=<name>` and is not a failure. To verify a local installer the same way:

```bash
powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -Installer <path-to-the-setup.exe>
```

### App icons

The shipped OS icon set under `apps/tauri/src-tauri/icons/` is generated from the canonical Fredo
avatar — do not hand-edit it. Regenerate the whole set from the committed SVG master, or verify the
committed set is complete and byte-reproducible:

```bash
pnpm icons:generate   # regenerate every shipped icon from the one committed SVG master
pnpm icons:check      # verify config + inventory + sizes + determinism
```

See `scripts/generate-app-icons.mjs` for the source of truth, the composition and baked-palette
contract, and which platform sets are shipped vs explicitly scoped out.

## After Installation

The installer adds the `fredo` binary to your system PATH and installs the companion engine payload **beside `fredo.exe` in the install directory** (the same folder as the binary). Verify the CLI:

```bash
fredo --help
```

To confirm an installer carries the engine payload, run the artifact gate on the `.exe` itself:

```bash
powershell -NoProfile -File .opencode/scripts/verify-installer-payload.ps1 -Installer <path-to-the-setup.exe>
```

`RESULT=PASS` means the installer passed **both** halves of the gate: every core payload DLL was found inside the extracted install, **and** every payload DLL present was import-scanned clean — the run prints `ARTIFACT_PAYLOAD_SCANNED=<n> of=<n>` and then `IMPORT_SCAN=PASS dlls=<n>` (`IMPORT_SCAN=FAIL dlls=<n>` otherwise). `PAYLOAD_MISSING=<name>` with exit 1 means the installer is incomplete. A forbidden import (`ERROR=PAYLOAD_FORBIDDEN_IMPORT_IN_ARTIFACT dll=<dll> module=<module> kind=<import|delay-import>`) or an import the payload cannot satisfy (`ERROR=PAYLOAD_IMPORT_UNRESOLVED_IN_ARTIFACT edge=<dll> -> <module> kind=<import|delay-import>`) also fails the gate, exit 1. `PAYLOAD_ABSENT_OPTIONAL=<name>` only names an optional tool module that was not shipped — it is a report, not a failure.

## Headless Ingest (capturing telemetry with the GUI closed)

By default, agent telemetry is only captured while the Fredo desktop app is running. To keep capturing it from a terminal-only workflow (or a CI/E2E run) with the GUI closed, run the headless ingest daemon:

```bash
fredo ingest
```

The daemon owns the embedded PostgreSQL cluster and the OTLP receivers on the same loopback ports as the GUI (`127.0.0.1:4317` gRPC, `127.0.0.1:4318` HTTP), using the **same data dir and credential** as the desktop app. It holds the exclusive data-dir lock, so a second `fredo ingest` — or the GUI starting its own cluster — fails fast instead of starting a second postmaster. When you later launch the GUI while the daemon is running, the GUI **attaches** to the headless-owned cluster and Mission Monitor renders the sessions the daemon ingested.

Stop it with Ctrl+C (SIGINT) or `--shutdown-file`; shutdown is bounded and leaves no orphan postmaster. See [CLI_GUIDE.md](CLI_GUIDE.md#fredo-ingest) for all flags and exit codes.

**Auto-start at login.** Settings → **Ingest** installs a per-user login entry that runs `fredo ingest` at sign-in, so capture is continuous without keeping the GUI open. Disabling the toggle removes the entry. No administrator rights are required (an OS-level service is out of scope).

> **Upgraded installs:** PostgreSQL is the only store (Spec #3005). A pre-existing legacy SQLite file in the data dir is ignored byte-for-byte — the daemon never reads, carries, or migrates it. There is no cutover leg.

## PostgreSQL Persistence

Fredo persists everything in an **embedded PostgreSQL** cluster — the only store since Spec #3005. The cluster runs on an ephemeral loopback port, is managed by the lifecycle supervisor (`applications/pg_supervisor`), and shares its data dir and credential with the `fredo ingest` daemon.

- **Cluster directory (Spec #3180, extended Spec #3188):** the cluster initialises in `<app-data>/postgres/cluster`, with the postmaster log at the sibling `<app-data>/postgres/log/postgres.log` — the app writes nothing else into the `initdb` target. `FREDO_PG_DATA_DIR` / `--pg-data-dir` still overrides the cluster location verbatim (the log then lives at `<override>/log`). A cluster created by an earlier version at `<app-data>/postgres` (recognised by `postgresql.conf`) is kept and used as-is, never re-initialised. Leftover files at the new cluster path are moved aside to a timestamped `<path>.rejected-<timestamp>` sibling (renamed, never deleted) before initialisation, so a reinstall over an old profile self-heals instead of failing forever with "the directory exists but is not empty"; a directory that still cannot be initialised surfaces the typed `dataDirNotEmpty` cause with its remedy in the health readout. An existing-but-**empty** cluster directory (for example one a setup probe pre-created) is vacated by the same timestamped `<path>.rejected-<timestamp>` rename before `initdb` runs — so `initdb` creates the directory itself and never needs to change an existing directory's permissions; it is renamed, never deleted, and the recovery never depends on chmod succeeding. If the filesystem refuses even that vacate (a locked-down folder), the failure surfaces the typed `dataDirPermissionDenied` cause in the health readout, whose remedy is to grant the current Windows user modify permission on the cluster folder's parent **or** point `FREDO_PG_DATA_DIR` at a writable folder, then restart Fredo — nothing is removed. The `FREDO_PG_CLUSTER_PERMISSION_FAIL` environment variable is the inert-by-default in-repo test seam for that refusal; it is not needed in normal use.
- **Store:** settings, canonical RTDB rows (`chat_rows` / `tool_use_rows` / `agent_session_rows`), and telemetry (`telemetry_spans` / `telemetry_metrics` / `telemetry_logs`) live in the cluster database `fredo` (the Fredo application database; the superuser role stays the unchanged `postgres` — Spec #3036). No `.db` file is created or read under the app-data dir.
- **Settings:** a synchronous, volatile cache in `SettingsStore` is hydrated once from the PostgreSQL `settings` table and write-throughs on every change.
- **Password:** the generated loopback password lives in the **OS keychain** (service `fredo.postgres`, account `loopback:password`) — never in a file, log, or telemetry. A fixed loopback-only fallback is used only when the keychain is unavailable.
- **Configuration (Spec #3022):** Settings → **Database** lets the owner change the password in place (no re-init, no data loss), recover a drifted credential via the warned **Reset database** action, choose the port (Automatic/OS-assigned, or a pinned fixed port that fails closed on a collision and keeps the prior config), and set log verbosity. Port + verbosity persist in `<app-data>/postgres-supervisor.json` (non-secret); the password stays keychain-only. A fresh install still auto-installs and auto-loads with no configuration.
- **Boot-failure recovery (Spec #3067):** if the cluster fails to start because the stored credential has drifted from it (`authMismatch`), the app shows a prominent, non-modal banner in the app shell — **no need to open Settings** — naming the mismatch and offering a one-click **Reset database…** behind an explicit destructive-data confirmation. Reset is **never automatic** (it deletes all local data and requires the acknowledgement), and while the cluster is failed the repeated storage-unavailable log errors back off instead of flooding the log. Non-credential failures (e.g. a port collision) do not show this banner.

### Legacy data

Spec #3005 is **fresh-install-only**. There is no migration, cutover, snapshot, rollback, or downgrade path, and no reverse export: every current setting is dropped (defaults are re-seeded on PostgreSQL), and any pre-existing legacy SQLite file in the data dir is ignored byte-for-byte — never read, carried, mutated, or deleted.

## Doom Mode (optional)

The Doom game window (Spec #2968) runs a **native, in-process, pure-Rust Doom engine** (`neurodoom` 0.6.7, BSD-3-Clause) behind a Fredo-owned adapter (`applications/doom/engine.rs`); there is **no child process, no loopback HTTP bridge, no vendored engine source, and no first-use build**. The engine is an ordinary cargo dependency, and the game data is the **bundled shareware `apps/tauri/src-tauri/doom/DOOM1.WAD`** (tracked, ~4,196,020 B, E1M1–E1M9) — there is no Freedoom download, no retail/`DOOM.WAD` path, and no WAD setting. Because nothing is built or downloaded, Doom Mode is **playable offline on a fresh install with no toolchain acquisition** (Spec #3023 replaced the retired RESTful-DOOM stack). If the engine cannot start or the bundled WAD is missing/corrupt, the `doom` window opens and renders a typed in-window error (`engineStartFailed` / `wadMissing` / `wadCorrupt`) with a Retry affordance; there is no app crash and no orphan. The QA env seams `FREDO_DOOM_WAD_PATH` (WAD override) and `FREDO_DOOM_FAIL_ENGINE_SPAWN=1` (force an engine-start failure) are inert when unset. The licensing/third-party record is in [`docs/THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Companion autonomous play (Spec #2969, surface reworked Spec #3007, feel reworked Spec #3026):** with the engine running, the companion plays the game on its own via a continuous-clock loop (an injectable tick seam keeps the world advancing between the model's decisions; the last intent is held with a safety reflex, a stuck player is unstuck by an escape that turns and moves it, and an unavailable/slow model degrades the pacing rather than freezing), and **auto-starts when the Doom window opens** — there is no in-window autoplay control (Spec #3007 removed the toggle/status/stop chrome). The genuine-play leg uses the in-process companion engine's model; a deterministic **scripted** decision lever (`FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` + `FREDO_DOOM_AGENT_SCRIPT`) exists for QA without a live model. The loop is bounded (`FREDO_DOOM_AGENT_MAX_STEPS` / `_MAX_FAILURES`) and reuses the same in-process engine session (no extra process). Since Spec #3054 the companion also **loots opportunistically along its route** — it collects the items and weapons it passes (a route-aligned bounded deflection keeps it on the corridor, and the run status's `itemsCollected` counter plus the `player.weapons` set grow); the classic engine `items` counter is never incremented, so the collection count is derived adapter-side and no configuration is required.

**Secret activation (Spec #2970):** Doom Mode is raised only by typing `iddqd` in the main window or by telling the companion "fredo, go Doom Mode" (a model-selected `doom_mode` companion skill); it leaves no settings/launcher/help entry before activation. Since Spec #3007 the `doom` window is **game-only** (no header/footer, no in-window controls): exit by closing the native `doom` window (the only exit affordance — there is no "Exit Doom Mode" button) or by "fredo, stop Doom Mode". Closing the window stops the playing agent first, then the engine (bounded ≤ 5 s with a hard-kill fallback), and publishes the mode change. No configuration is required; the QA failure seam `FREDO_DOOM_MODE_FAIL_ENTER=1` injects an enter failure (no half-entered state).

**Doom theme + armored avatar (Spec #2971):** while Doom Mode is active the whole app restyles to a Doom-inspired palette (driven entirely by the theme token contract) and the Fredo avatar wears Doom armor; on exit every surface and the avatar revert to the user's prior theme exactly. The Doom theme is never offered in Settings and is never persisted — no configuration is required.

**Save/resume across sessions (Spec #2972, store moved Spec #3011, window chrome removed Spec #3007):** entering Doom Mode resumes from the last saved campaign point (stored as one typed row in the dedicated PostgreSQL feature table `feature_doom_save`; no cloud). The resume point and completion state are read at the **data level** (`get_doom_save` / `get_doom_autoplay_status`) — the Spec #3007 game-only window renders no save-status, completion-badge, or fresh-start chrome. A fresh run is started only by passing `freshStart: true` to `start_doom_autoplay` (there is no in-window "Start fresh" control). The test-only levers `FREDO_DOOM_SAVE_STATE_DIR=<dir>` (a JSON state dir) and `FREDO_DOOM_SAVE_FORCE_FAIL=read|write` (in-process fault injection) induce the save's error paths (inert when unset). No configuration is required.

## Environment Variables

The Tauri app does not require environment variables for basic operation. For connecting to external services (Azure DevOps, Kubernetes, Jira), configure credentials via the Settings panel in the app UI.

For OTLP receivers, the endpoints default to `127.0.0.1:4317` (gRPC) and `127.0.0.1:4318` (HTTP) and are resolved at runtime from `FREDO_INGEST_GRPC_PORT` / `FREDO_INGEST_HTTP_PORT` (the headless `fredo ingest` `--grpc-port`/`--http-port` flags share those names). An isolated local test environment (`dev-env.ps1 -EnvId <id> -EnvSlot <n>`, Spec #2944) binds its own ports for the app, MCP bridge, OTLP receivers, and CLI pipe; slot 0 keeps these defaults.

OpenCode telemetry needs no variable: the Fredo plugin is installed into the global plugins directory and captures by default (`FREDO_TELEMETRY=0`/`false`/`off` opts out, and `enabled: false` in the plugin's `options` takes precedence). An isolated environment (`FREDO_REQUIRE_ENV_ISOLATION`, or a non-default `OPENCODE_OTLP_ENDPOINT`) is the only case that pins `OPENCODE_ENABLE_TELEMETRY` / `OPENCODE_OTLP_PROTOCOL` / `OPENCODE_OTLP_ENDPOINT` on the spawned session — and the only case Fredo passes `--standalone`. The default path writes none of them.
