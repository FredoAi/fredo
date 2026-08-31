# Fredo

A desktop platform for working with AI coding agents, built with Tauri v2 (Rust backend) and React 19 (TypeScript).

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](./LICENSE)
[![CI](https://github.com/FredoAi/fredo/actions/workflows/validate.yml/badge.svg)](https://github.com/FredoAi/fredo/actions/workflows/validate.yml)

<!-- TODO(human): add real screenshots post-launch -->

*_Screenshots coming soon._*

## Features

- **Desktop platform for AI coding agents** — work with agents like OpenCode and Claude Code from a native desktop app instead of a terminal.
- **Agent adapters** — per-provider adapters and connectors (hooks, OTLP) normalize raw agent output into a canonical event stream.
- **Event streaming** — a backend communication layer turns raw agent events into canonical events consumed by declarative, reactive frontend features.
- **Mission monitoring** — a live delegation graph of agent sessions and nested subagents.
- **Run CLI** — a `fredo` CLI for driving agents and emitting events from scripts.
- **Theming** — light/dark themes with user-selectable accent colors across every surface.

## Install for Users

Fredo currently installs from source. Prebuilt installers are coming (the release pipeline is planned) — for now, build it yourself:

### Prerequisites

- [Rust toolchain ≥ 1.75](https://rustup.rs/)
- [Tauri CLI v2](https://v2.tauri.app/reference/cli/): `cargo install tauri-cli --version "^2"`
- Node.js ≥ 18, pnpm ≥ 8

### Build from source

```bash
git clone https://github.com/FredoAi/fredo.git
cd fredo
pnpm install
pnpm build:tauri
```

## Development

```bash
# Start the Tauri desktop app (hot reload)
pnpm dev:tauri

# UI-only dev (browser, no Rust required)
pnpm dev:ui

# Build the UI library (type check + vite build)
pnpm --filter @fredo/ui build

# Rust build
cargo build --manifest-path apps/tauri/src-tauri/Cargo.toml
```

### Apps

| App | Description |
|-----|-------------|
| [`apps/tauri`](./apps/tauri) | Desktop app — Tauri 2 + Rust backend + React UI |
| [`apps/ui`](./apps/ui) | Shared React UI library (`@fredo/ui`) |
| [`apps/marketplace-plugin`](./apps/marketplace-plugin) | OpenCode plugin descriptor |
| [`apps/code-sandbox`](./apps/code-sandbox) | Python code execution sandbox |

Archived (kept for reference):
- `apps/tools-mcp` — legacy Node.js MCP backend
- `apps/browser-extension` — legacy Chrome extension

### Documentation

| Document | Contents |
|----------|----------|
| [Architecture](docs/ARCHITECTURE.md) | Communication layer, adapters, FredoEvent system, IPC protocol, feature modules, integrations |
| [Setup Guide](docs/SETUP.md) | Prerequisites, install, dev commands, model download, OTLP config |
| [CLI Guide](docs/CLI_GUIDE.md) | `fredo` CLI commands |
| [Security](docs/SECURITY.md) | IPC, OTLP, capability security model |
| [FAQ](docs/FAQ.md) | Common questions |

Full index at [docs/README.md](docs/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

The code in this repository is dual-licensed under the [MIT](LICENSE-MIT) and [Apache 2.0](LICENSE-APACHE-2.0) licenses — choose whichever suits your project.

The Fredo name and logo are licensed CC-BY-NC-ND; projects derived from or building on Fredo must state they are not affiliated with the Fredo project.
