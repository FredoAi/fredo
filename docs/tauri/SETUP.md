# Fredo Desktop App — Setup Guide

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust toolchain | ≥ 1.75 | [rustup.rs](https://rustup.rs/) |
| Tauri CLI v2 | latest | `cargo install tauri-cli --version "^2"` |
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org/) |
| pnpm | ≥ 8 | `npm i -g pnpm` |

### Windows additional dependencies

```powershell
# WebView2 (usually pre-installed on Windows 11)
# Install from: https://developer.microsoft.com/microsoft-edge/webview2/

# Visual Studio 2022 Build Tools with C++ workload (for Rust + CMake compilation)
# The --add flag ensures the C++ toolchain is included
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# LLVM/Clang (required by llama-cpp-sys-2 for bindgen)
winget install LLVM.LLVM
```

> **Important:** Restart your terminal after installing LLVM and VS Build Tools so `libclang.dll` and CMake generators are found on `PATH`.

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

Fredo requires local GGUF model files to build — the Tauri bundler will fail without them. Models are **not stored in git** (too large).

### Quick download (recommended)

```powershell
# From repo root — downloads Gemma 4 E2B model + vision projector (~4 GB total)
pwsh apps/tauri/src-tauri/scripts/download-mmproj.ps1
```

### Manual download

Place GGUF files under `apps/tauri/src-tauri/models/<model-name>/`:

| File | Size | Source |
|------|------|--------|
| `gemma-4-E2B-it-Q4_K_M.gguf` | ~3.1 GB | [unsloth/gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf) |
| `mmproj-F16.gguf` | ~986 MB | [unsloth/gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/mmproj-F16.gguf) |

> `*.gguf` files are gitignored. The metadata files (`config.json`, `tokenizer.json`, etc.) are tracked in git and already present after cloning.

### Supported Models

| Model | Vision | Notes |
|-------|--------|-------|
| Gemma 4 E2B (`gemma-4-e2b`) | ✅ | Full vision support via mmproj projector |
| MiniCPM-V 4.6 (`minicpm-v-4-6`) | ⚠️ | Vision projector unsupported; falls back to text-only |

Switch models via Settings → Model Selector in the UI. Changes take effect on next launch.

## OTLP Configuration

Fredo includes local OTLP receivers for agent telemetry. Configure your AI agent to send OTLP data:

### Claude Code

```bash
claude setting set env OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317
claude setting set env OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

### Copilot CLI

```bash
# Windows
setx OTEL_EXPORTER_OTLP_ENDPOINT "http://127.0.0.1:4318"
setx OTEL_EXPORTER_OTLP_PROTOCOL "http/protobuf"

# Unix (add to ~/.bashrc or ~/.zshrc)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

### Using the Setup Wizard

Open Fredo → Setup feature → click "Configure OTLP" to automatically configure your installed agents.

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
# Use window.__devAdapter.emit({...}) to simulate events
```

### Testing the MCP Server

```bash
# Start MCP server in stdio mode
fredo mcp

# Start MCP server in HTTP mode
fredo mcp --sse --port 3001
```

## Build

```bash
pnpm build:tauri
```

Artifacts are placed in `apps/tauri/src-tauri/target/release/bundle/`:

| OS | Format | Location |
|----|--------|----------|
| Windows | `.msi` | `bundle/msi/` |
| macOS | `.dmg` | `bundle/dmg/` |
| Linux | `.AppImage` | `bundle/appimage/` |
| Linux | `.deb` | `bundle/deb/` |

## After Installation

The installer adds the `fredo` binary to your system PATH. Verify:

```bash
fredo --help
```

## MCP Credential Configuration

Tools requiring external services need credentials configured via settings:

```bash
# Jira
fredo setting set mcp.jira.base_url "https://your-domain.atlassian.net"
fredo setting set mcp.jira.email "you@example.com"
fredo setting set mcp.jira.api_token "your-token"

# Azure DevOps
fredo setting set mcp.azdo.org_url "https://dev.azure.com/your-org"
fredo setting set mcp.azdo.project "your-project"
fredo setting set mcp.azdo.pat "your-pat"

# Optimizely
fredo setting set mcp.optimizely.project_id "your-project-id"
fredo setting set mcp.optimizely.sdk_key "your-sdk-key"

# PostgreSQL (observability queries)
fredo setting set mcp.db.url "postgresql://user:pass@host:5432/db"
```

Or configure via the Settings panel in the UI.

## Environment Variables

The Tauri app does not require environment variables for basic operation. For connecting to external services (Azure DevOps, Kubernetes, Jira), configure credentials via the Settings panel in the app UI.

For OTLP receivers, the endpoints are hardcoded to `127.0.0.1:4317` (gRPC) and `127.0.0.1:4318` (HTTP).
