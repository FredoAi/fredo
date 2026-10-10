# Fredo

Desktop platform for working with AI coding agents. Built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend). Agent telemetry flows through the **RTDB row pipeline** — an ingest classifier maps OTLP spans and CLI events onto typed rows that stream to the webview and feed declarative frontend features via `useEventRows` subscriptions. Rows, not polls.

> **All agents** (main session and pipeline subagents) are bound by the engineering rules in
> `docs/ENGINEERING_RULES.md` — auto-injected into every session via `opencode.json`. Pipeline
> agents additionally follow `docs/agentic-pipeline/common-rules.md` (research, shared
> references, citing, sandbox behaviour) and their playbook.

## How I work with you

This section describes the **main session** (the agent I talk to directly). I will tell you
which of three modes I want — do not pick one yourself:

- **Edit** — I want a code change. Make it directly: implement within scope, verify it, report what changed. Use the engineering rules and build hygiene below.
- **Backlog** — I want a work item shaped, not implemented. Route to the **`product-owner`** subagent; it clarifies with me and creates the backlog issue.
- **Implement a backlog item** — I want a backlog item built. Route to the **`product-owner`**, which dispatches the **`self-improver`**; the pipeline runs the spec end-to-end (plan → implement → test → audit).

Do **not** start a spec, create issues, or dispatch `product-owner` / `self-improver` unless I
ask for it. When in doubt about which mode I mean, ask.

## Exploring & debugging

- Read/grep the repo freely — `apps/tauri/src-tauri/src/` (Rust), `apps/ui/src/` (React), `apps/opencode-plugin/` (OTLP emission).
- **Telemetry:** query the live database with the `telemetry-query` skill (`telemetry_spans` / `telemetry_metrics` / `telemetry_logs` in the embedded PostgreSQL cluster — PostgreSQL is the only persistence system; there is no `fredo.db`).
- **Runtime/dev instance:** the `dev-environment` skill covers launch, plugin install, and DB reset.
- **Dev commands:** `pnpm dev:tauri` (desktop app, hot reload), `pnpm dev:ui` (browser only, no Rust), `pnpm --filter @fredo/ui build` (typecheck + build), `cargo build` (from `apps/tauri/src-tauri/`).
- Verify claims against real code, spans, or build output — not assumptions.

## Where things live

| Topic | Document |
|-------|----------|
| Architecture, module map, event flow, IPC, feature modules | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Engineering rules (backend, frontend, Chakra, settings) — **binding** | [`docs/ENGINEERING_RULES.md`](docs/ENGINEERING_RULES.md) |
| The agentic pipeline: roles, phases, artifacts, state machine | [`docs/agentic-pipeline/README.md`](docs/agentic-pipeline/README.md) |
| Pipeline process rules + SDD hygiene | [`docs/agentic-pipeline/common-rules.md`](docs/agentic-pipeline/common-rules.md) |
| Shared references + known failure modes (guardrails) | [`docs/agentic-pipeline/playbooks/references.md`](docs/agentic-pipeline/playbooks/references.md) |
| Setup, prerequisites, model download, OTLP config | [`docs/SETUP.md`](docs/SETUP.md) |
| `fredo` CLI commands | [`docs/CLI_GUIDE.md`](docs/CLI_GUIDE.md) |
| Contributing, CI-parity command set | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Full docs index | [`docs/README.md`](docs/README.md) |

## Build hygiene

- `pnpm --filter @fredo/ui build` after UI changes — fix all TypeScript errors
- `cargo check` after Rust changes — zero warnings
- `pnpm dev:ui` from repo root for the Vite dev server
