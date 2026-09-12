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

The **Companion** (out-of-process `llama-server` runtime) downloads its three required files in-app — no manual download is required for a normal setup.

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

The companion's runtime prerequisites are checked in-app. Open **Settings → Companion** on a machine that is not yet set up and the panel shows a setup wizard as its only content:

- **llama.cpp runtime** — a usable `llama-server` (resolved from a configured path, then `PATH`, then the winget Links shim). The wizard offers a one-click **Install llama.cpp** (`winget install --id ggml.llamacpp -e`) and re-checks readiness in place — no app reload.
- **Model files** — the three required files (model + vision projector + MTP speculative draft) under `<models_dir>/gemma-4-e2b-it-qat/`. The step lists them individually (`missing` / `downloading` / `present` / `error`), downloads them in-app with per-file progress, skips files already present, resumes an interrupted transfer via HTTP `Range`, verifies each with its pinned SHA-256, and names exactly which file(s) are missing. See [Download Models](#download-models).
- **Companion server** — starting the companion launches `llama-server` from the generated launch config and confirms readiness with a health check on the configured port before any chat is sent. Its state is composed from `get_llama_server_status`; its action calls `launch_llama_server`, which always returns an actionable error (never hangs).

Each prerequisite reports its own honest state (`checking` / `missing` / `installed` / `error`); the wizard is never shown as complete while a prerequisite is missing. Once all prerequisites are satisfied, the normal Companion controls (Show Fredo Companion, idle auto-return, Teleport tip) replace the wizard. If `winget` is unavailable or the install fails, the wizard shows an actionable error and stays in the not-set-up state.

## OTLP Configuration

Fredo includes local OTLP receivers for agent telemetry. Configure OpenCode to send OTLP data:

### OpenCode

```bash
# Windows
setx OPENCODE_ENABLE_TELEMETRY "1"
setx OPENCODE_OTLP_ENDPOINT "http://127.0.0.1:4317"
setx OPENCODE_OTLP_PROTOCOL "grpc"

# Unix (add to ~/.bashrc or ~/.zshrc)
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT=http://127.0.0.1:4317
export OPENCODE_OTLP_PROTOCOL=grpc
```

### Using the Setup Wizard

Open Fredo → Setup feature → the wizard automatically detects OpenCode and configures OTLP.

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

## After Installation

The installer adds the `fredo` binary to your system PATH. Verify:

```bash
fredo --help
```

## Environment Variables

The Tauri app does not require environment variables for basic operation. For connecting to external services (Azure DevOps, Kubernetes, Jira), configure credentials via the Settings panel in the app UI.

For OTLP receivers, the endpoints are hardcoded to `127.0.0.1:4317` (gRPC) and `127.0.0.1:4318` (HTTP).
