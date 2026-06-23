# Fredo

Desktop platform for working with AI coding agents. Built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend). Agents communicate via adapters through a backend communication layer that normalizes raw events into canonical objects consumed by reactive frontend features.

## Apps

| App | Description |
|-----|-------------|
| [`apps/tauri`](./apps/tauri) | Desktop app — Tauri 2 + Rust backend + React UI |
| [`apps/ui`](./apps/ui) | Shared React UI library (`@fredo/ui`) |
| [`apps/marketplace-plugin`](./apps/marketplace-plugin) | OpenCode plugin descriptor |
| [`apps/code-sandbox`](./apps/code-sandbox) | Python code execution sandbox |

Archived (kept for reference):
- `apps/tools-mcp` — legacy Node.js MCP backend
- `apps/browser-extension` — legacy Chrome extension

## Quick Start

### Prerequisites

- [Rust toolchain ≥ 1.75](https://rustup.rs/)
- [Tauri CLI v2](https://v2.tauri.app/reference/cli/): `cargo install tauri-cli --version "^2"`
- Node.js ≥ 18, pnpm ≥ 8

```bash
# Install JS dependencies
pnpm install

# Start the Tauri desktop app (hot reload)
pnpm dev:tauri

# UI-only dev (browser, no Rust required)
pnpm dev:ui
```

### Commands

```bash
# Build the UI library (type check + vite build)
pnpm --filter @fredo/ui build

# Rust build
cargo build --manifest-path apps/tauri/src-tauri/Cargo.toml

# Production installer
pnpm build:tauri
```

## Documentation

| Document | Contents |
|----------|----------|
| [Architecture](docs/ARCHITECTURE.md) | Communication layer, adapters, FredoEvent system, IPC protocol, feature modules, integrations |
| [Setup Guide](docs/SETUP.md) | Prerequisites, install, dev commands, model download, OTLP config |
| [CLI Guide](docs/CLI_GUIDE.md) | `fredo` CLI commands |
| [Security](docs/SECURITY.md) | IPC, OTLP, capability security model |
| [FAQ](docs/FAQ.md) | Common questions |

Full index at [docs/README.md](docs/README.md).

## License

MIT
