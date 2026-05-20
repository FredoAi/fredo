# Atlas Desktop App

Cross-platform desktop application built with [Tauri 2](https://v2.tauri.app/). Replaces the browser extension and VS Code extension.

## Architecture

```
atlas (CLI / GUI binary)
├── No args  →  launches Tauri desktop window
│               └── Webview: @atlas/ui React app (TauriAdapter)
└── With args →  CLI mode (clap)
                 └── Connects to running app via local socket
                     └── Rust backend emits Tauri IPC events → Webview
```

## Prerequisites

- [Rust toolchain ≥ 1.75](https://rustup.rs/)
- [Tauri CLI v2](https://v2.tauri.app/reference/cli/): `cargo install tauri-cli --version "^2"`
- Node.js ≥ 18 + pnpm ≥ 8

## Development

```bash
# Install JS dependencies
pnpm install

# Start Tauri dev (hot-reloads both Rust and React)
pnpm dev:tauri
```

## Build

```bash
pnpm build:tauri
# Produces: src-tauri/target/release/bundle/
#   Windows: .msi
#   macOS:   .dmg
#   Linux:   .AppImage / .deb
```

After installation, the `atlas` binary is added to your system PATH.

## CLI Usage

```bash
# Query logs
atlas logs --query "SELECT * FROM logs WHERE level = 'ERROR' LIMIT 20"

# Query metrics
atlas metrics --query "SELECT * FROM metrics WHERE name = 'cpu_usage' LIMIT 10"

# Query traces
atlas traces --query "SELECT * FROM traces WHERE duration_us > 1000000 LIMIT 10"

# Kubernetes
atlas k8s pods --namespace production
atlas k8s restart my-deployment --namespace production

# Azure DevOps
atlas azdo story --title "Fix login bug" --description "Users cannot log in on Safari"
```

Commands emit stream events into the running Atlas window. If the app is not open, an error message is shown.

## Project Structure

```
apps/tauri/
├── src/
│   └── main.tsx              # React entry — uses TauriAdapter
├── src-tauri/
│   ├── src/
│   │   ├── main.rs           # Binary entry — CLI or GUI dispatch
│   │   ├── lib.rs            # Tauri app builder + IPC server setup
│   │   ├── events.rs         # StreamEvent type + emit helpers
│   │   ├── ipc.rs            # Local socket IPC server + CliCommand types
│   │   └── cli/
│   │       ├── mod.rs        # clap CLI root
│   │       └── commands/     # logs, metrics, traces, k8s, azdo
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/
│       └── default.json      # Tauri IPC permissions
├── vite.config.ts
├── index.html
└── package.json
```
