# Fredo

A desktop platform for working with AI coding agents — my approach to **Agentic UI**.

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](./LICENSE)
[![CI](https://github.com/FredoAi/fredo/actions/workflows/validate.yml/badge.svg)](https://github.com/FredoAi/fredo/actions/workflows/validate.yml)

## Intro

**Fredo is my approach to "Agentic UI".** It's a desktop platform (Tauri v2 on the Rust
backend, React 19 + TypeScript on the frontend) for working with AI coding agents like
OpenCode and Claude Code — not from a terminal, but from a native app where the agent and I
are both present in the same place. It ingests agent telemetry and lifecycle events,
normalizes them into typed, replayable rows, and renders them as reactive UI.

This is a **personal project.** I build and tinker with it because it's how I learn — it isn't
a commercial product, there's no SLA or dedicated support, and it may be rough around the
edges. The internals and APIs can change without notice. If it's useful to you, great;
contributions are welcome, but expectations are modest and I work on it in spare time.

## Current situation

Fredo is my **playground** — the place where I learn and experiment with AI, agents, and
agentic systems. Building it is the point.

- **Pre-1.0 and actively developed.** Things move, and they break.
- **Windows-only installer**, cut through a deliberately owner-gated, manual release process.
  On every other platform, build from source.
- **Storage migration in progress.** A PostgreSQL storage engine is being wired in alongside
  the default SQLite one; it's disabled by default and fails closed to SQLite.
- **One known limitation:** with Mission Monitor open on a very large corpus under sustained
  live agent traffic, the webview can intermittently saturate. The backend stays healthy; the
  drain usually recovers.

## Core concept / idea

The idea behind Fredo is a **two-way Agentic UI**. Interaction can originate from the
**agent → UI**, from the **human → UI**, and the **UI → both the human and the agent**. Both
sides are participants — never one watching the other.

- **Agent → UI.** Most agent interfaces are present-tense readouts: what the agent is saying
  right now. Agent work is *durable* — it happens, it's persisted, you come back to it. So this
  direction subscribes to what *happened*, as a typed row store that can be replayed.
- **Human → UI.** You type to an agent, interrupt a running session, rename it, inspect a tool
  call and act on what you see.
- **UI → agent.** Those interruptions re-enter as rows, so the agent's view of the session
  reflects what you just did. The UI speaks back to both of you.

A small model running locally is meant to be the main interaction — the thing that sits between
you and the UI and decides what gets shown and what responds. That's the direction the project
is heading, and the part I spend the most time on.

## How it works

Agents feed Fredo through two paths: an OTLP plugin (OpenCode exports OpenTelemetry traces
directly to the local receiver) and the `fredo emit` CLI. Both converge on one pipeline:

```
Agent (OTLP) ─┐
              ├─→ raw persistence on receipt ─→ RTDB ingest classifier
fredo emit  ──┘                                        │
                                                       ▼
                              typed rows (chat / tool-use / agent-session)
                                                       │
                                                       ▼
                                  durable seq ─→ coalesced flush ─→ IPC
                                                       │
                                                       ▼
                                       useEventRows ─→ reactive app UI
```

The frontend doesn't poll the backend. Every app **subscribes to a typed row query** and reacts
to live patches; a persisted snapshot is replayed first, so late-joiners get the whole history,
not a truncated log. Rows carry a stable identity and merge rather than scroll away.

Everything is **local-first**: telemetry is collected by a local-only collector on
`127.0.0.1`, and nothing leaves your machine.

## Features

### Apps

Every UI surface in Fredo is an **app** — an autonomous feature module that declares what it
cares about and reacts to it. The built-in apps:

- **Home & Companion** — the navigation grid and a small local model with a personality you can
  talk to by typing or by voice; it acts on the UI through a deliberately small, bounded skill set.
- **Terminal** — multi-session PTY panes for `opencode`, `copilot`, and your own shell.
- **Mission Monitor** — a live delegation graph of agent sessions and nested subagents, built
  from the same rows.
- **Workspace** — a customizable dockable/tileable layout, with a first-class keyboard and
  hotkey contract (sequences, macros, per-app contexts).
- **Setup** — OTel configuration and CLI detection.
- **Theming** — light/dark themes with user-selectable accents across every surface.

### The agentic pipeline

Fredo is **built by the pipeline it documents.** The repo carries a complete multi-agent
development pipeline — a single orchestrator, a triage cluster that plans, a pool of developers,
a tester, and an audit gate — driven by a state machine that owns *where we are*. Each agent
reads its assignment, phase, and workload from that state instead of inferring it.

The part I most want to travel is the **state-machine context-injection methodology**: make the
plumbing around a stochastic model deterministic, then inject that determinism back in as
context. It's designed to be copied — point your own agent at
[`docs/agentic-pipeline/`](docs/agentic-pipeline/README.md), let it read the roles, principles,
and state machine, and have it set the whole thing up for your codebase.

## Getting started

Build from source:

```bash
git clone https://github.com/FredoAi/fredo.git
cd fredo
pnpm install
pnpm build:tauri
```

Common dev commands:

```bash
pnpm dev:tauri                              # desktop app (hot reload)
pnpm dev:ui                                 # UI only, in a browser (no Rust)
pnpm --filter @fredo/ui build               # type check + build the UI library
cargo build --manifest-path apps/tauri/src-tauri/Cargo.toml
```

Prerequisites (Rust ≥ 1.75, Tauri CLI v2, Node ≥ 20, pnpm ≥ 8, per-OS build deps) are in the
[Setup Guide](docs/SETUP.md#prerequisites).

## Documentation

| Document | Contents |
|----------|----------|
| [Architecture](docs/ARCHITECTURE.md) | RTDB row pipeline, event flow, Rust module map, IPC protocol, feature modules |
| [The agentic pipeline](docs/agentic-pipeline/README.md) | The methodology: roles, phases, artifacts, state machine, and why it's built this way |
| [Setup Guide](docs/SETUP.md) | Prerequisites, install, dev commands, model download, OTLP config |
| [CLI Guide](docs/CLI_GUIDE.md) | `fredo` CLI commands |

The full index is at [docs/README.md](docs/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

The code in this repository is dual-licensed under the [MIT](LICENSE-MIT) and
[Apache 2.0](LICENSE-APACHE-2.0) licenses — choose whichever suits your project.

The Fredo name and logo are licensed CC-BY-NC-ND; projects derived from or building on Fredo
must state they are not affiliated with the Fredo project.
