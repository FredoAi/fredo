# Fredo

A desktop platform for working with AI coding agents, built with Tauri v2 (Rust backend) and React 19 (TypeScript).

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](./LICENSE)
[![CI](https://github.com/FredoAi/fredo/actions/workflows/validate.yml/badge.svg)](https://github.com/FredoAi/fredo/actions/workflows/validate.yml)

![Fredo desktop home with companion](imgs/fredo-desktop.png)

![Fredo apps — Mission Monitor, Query Viewer, Run CLI, Stepper Probe](imgs/fredo-apps.png)

![Mission Monitor session graph](imgs/mm-1.png)

![Mission Monitor delegation chain detail](imgs/mm-2.png)

![Mission Monitor subagent detail panel](imgs/mm-3.png)

> **A personal project.** Fredo started as a personal tool I use to learn and experiment with AI —
> building and tinkering with it is the point. It's not a commercial product and there's no SLA or
> dedicated support. It may be rough around the edges, and the internals/APIs can change without
> notice. If it's useful to you, great — contributions are welcome, but expectations are modest and
> the maintainer works on it in spare time.

## Features

- **Desktop platform for AI coding agents** — work with agents like OpenCode and Claude Code from a native desktop app instead of a terminal.
- **Agent adapters** — per-provider adapters and connectors (hooks, OTLP) normalize raw agent output into a canonical event stream.
- **Event streaming** — a backend communication layer turns raw agent events into canonical events consumed by declarative, reactive frontend features.
- **Mission monitoring** — a live delegation graph of agent sessions and nested subagents.
- **Run CLI** — a `fredo` CLI for driving agents and emitting events from scripts.
- **Theming** — light/dark themes with user-selectable accent colors across every surface.

The full set of built-in apps is listed in the
[Architecture overview](docs/ARCHITECTURE.md#active-ui-features).

## Install for Users

Fredo ships a **Windows-only** installer through a deliberately owner-gated release pipeline (see
[release-process.md](docs/release-process.md)). Releases are cut manually and every artifact must pass
the full CI gate plus the maintainer's approval before it's published — nothing is released
automatically. For now the easiest path for all platforms is to build from source:

```bash
git clone https://github.com/FredoAi/fredo.git
cd fredo
pnpm install
pnpm build:tauri
```

Prerequisites — Rust ≥ 1.75, Tauri CLI v2, Node ≥ 20, pnpm ≥ 8, and the per-OS build dependencies —
are listed in the [Setup Guide](docs/SETUP.md#prerequisites).

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

The full CI-parity command set that must pass before a PR can merge — including `typecheck`, `test:run`,
`cargo test`, and `cargo clippy -- -D warnings` — is in
[CONTRIBUTING.md](CONTRIBUTING.md#ci-parity-command-set). Per-OS dependencies, model download, and OTLP
configuration are in the [Setup Guide](docs/SETUP.md).

### Documentation

Architecture, agentic pipeline, CLI guide, security model, FAQ, and the rest are indexed at
[docs/README.md](docs/README.md).

The most-used starting points:

| Document | Contents |
|----------|----------|
| [Architecture](docs/ARCHITECTURE.md) | RTDB row pipeline, event flow, Rust module map, IPC protocol, feature modules |
| [Setup Guide](docs/SETUP.md) | Prerequisites, install, dev commands, model download, OTLP config |
| [CLI Guide](docs/CLI_GUIDE.md) | `fredo` CLI commands |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

The code in this repository is dual-licensed under the [MIT](LICENSE-MIT) and [Apache 2.0](LICENSE-APACHE-2.0) licenses — choose whichever suits your project.

The Fredo name and logo are licensed CC-BY-NC-ND; projects derived from or building on Fredo must state they are not affiliated with the Fredo project.
