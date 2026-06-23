# Fredo Desktop App

Cross-platform desktop application built with [Tauri 2](https://v2.tauri.app/). Pairs a Rust backend with a React frontend to provide a platform for working with AI coding agents.

## Architecture

```
fredo (single binary)
├── No args  →  launches Tauri desktop window
│               └── Webview: @fredo/ui React app (TauriAdapter)
└── With args →  CLI mode (clap)
                 └── Connects to running app via local IPC socket
                     └── Rust backend emits FredoEvents via EventBus → Webview
```

Events flow unidirectionally: Agent sources → Adapters (`infrastructure/comm/`) → EventBus → Tauri IPC → webview features.

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

After installation, the `fredo` binary is added to your system PATH.

## CLI Usage

```bash
# Forward OpenCode plugin hooks
fredo opencode-plugin PreToolUse --payload '{"tool_name":"read","input":{...}}'

# Emit a custom event
fredo emit --event-type tool_use --state Init --tool-name my_tool --payload '{}'

# Setup commands
fredo setup --check
fredo setup --add-to-path
fredo setup --install-plugin
fredo setup --download-model
```

See [CLI Guide](../../docs/CLI_GUIDE.md) for full reference.

## Project Structure

```
apps/tauri/
├── src/
│   └── main.tsx                # React entry — uses TauriAdapter
├── src-tauri/
│   ├── src/
│   │   ├── main.rs             # Binary entry — CLI or GUI dispatch
│   │   ├── lib.rs              # AppRuntime composition root; registers EventBus, commands, state
│   │   ├── features/           # Autonomous feature modules (terminal, llm, settings, setup, screenshot)
│   │   ├── infrastructure/
│   │   │   ├── comm/           # Communication layer (FredoEvent, EventBus, CommAdapter, adapters)
│   │   │   ├── storage/        # AppStore (SQLite KV)
│   │   │   ├── ipc.rs          # Local socket IPC server + CliCommand dispatch
│   │   │   ├── cli/            # clap CLI parser
│   │   │   └── otlp/           # OTLP receivers (gRPC :4317, HTTP :4318)
│   │   ├── runtime/            # AppRuntime + capability traits
│   │   └── utils/              # Stateless helpers (error, event dump)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/
│       └── default.json        # Tauri IPC permissions
├── vite.config.ts
├── index.html
└── package.json
```

## Documentation

- [Architecture Overview](../../docs/ARCHITECTURE.md)
- [Setup Guide](../../docs/SETUP.md)
