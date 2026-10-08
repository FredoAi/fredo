# Fredo Documentation Index

## Quick Start

### For New Developers
1. **[Setup Guide](SETUP.md)** — Prerequisites, install, dev commands, model download, OTLP config
2. **[Architecture Overview](ARCHITECTURE.md)** — Communication layer, RTDB row pipeline, event flow, IPC protocol, OTLP receivers, LLM, mission monitor, companion
3. **[CLI Guide](CLI_GUIDE.md)** — All `fredo` CLI commands

### For System Architects
1. **[Architecture Overview](ARCHITECTURE.md)** — Complete system design: Rust module map, event pipeline, IPC protocol, application modules, Tauri commands, startup sequence
2. **[agentic-pipeline](agentic-pipeline/README.md)** — Agentic SDD pipeline: agent roles, design protocol, implementation lifecycle, quality gates, continuous improvement

---

## Documentation Catalog

Core product and engineering documentation.

| Document | Purpose |
|----------|---------|
| [Architecture](ARCHITECTURE.md) | Communication layer, RTDB row store + ingest classifier, Rust module map, IPC protocol, OTLP receivers, Tauri commands, application modules, agent integrations, startup sequence |
| [Setup Guide](SETUP.md) | Prerequisites, install, dev commands, model download, OTLP configuration |
| [CLI Guide](CLI_GUIDE.md) | All `fredo` CLI subcommands with examples |
| [Security](SECURITY.md) | IPC socket security, OTLP, Tauri capabilities, input handling, process isolation |
| [FAQ](FAQ.md) | Common questions and troubleshooting |
| [GenAI Telemetry Reference](telemetry-reference.md) | What Fredo actually receives — every `gen_ai.*` attribute by signal type, grounded in live `telemetry_spans`/`telemetry_metrics`/`telemetry_logs` and cross-referenced against the OTel GenAI semantic conventions. Start here when a row is missing, empty, or non-conformant |
| [CI Gate Contract](CI_GATE_CONTRACT.md) | What runs on a PR to `main` and which check gates the merge (`validate` is the only required status check; per-stack path-filter gating) |
| [agentic-pipeline](agentic-pipeline/README.md) | Agentic SDD pipeline: agent catalog, phases, artifacts, scripts, skills, metrics — the full development workflow from intake to improvement |

## Contributing & Agent Contract

| Document | Purpose |
|----------|---------|
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to build from source, the CI-parity command set that must pass before a PR can merge, the contribution workflow, priorities, and non-goals |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Community expectations and enforcement |
| [Security Policy](../.github/SECURITY.md) | Reporting a vulnerability privately, supported versions, coordinated disclosure, and what is **not** a vulnerability |
| [AGENTS.md](../AGENTS.md) | **Auto-loaded into every agent session** — how the main session works with the human (Edit / Backlog / Implement-a-backlog-item routing) plus explore/debug guidance and pointers into the docs. Not a reading document: the harness injects it |
| [ENGINEERING_RULES.md](ENGINEERING_RULES.md) | **Auto-injected into every agent session** via `opencode.json` — the binding engineering rules (backend, frontend, Chakra UI, settings). A change that violates one is wrong even if it builds |

> **Human-owned touchpoints.** [`AGENTS.md`](../AGENTS.md) and [`opencode.json`](../opencode.json)
> are **human-owned**: the pipeline and its agents never edit them. A required change to either is
> a **human follow-up** — see
> [`ENGINEERING_RULES.md` → Human-owned touchpoints](ENGINEERING_RULES.md#human-owned-touchpoints-never-pipeline-edited).

## Maintainer Runbooks

**The maintainer (repo owner) runs these — not contributors, and never AI agents.** Repository
settings and release steps are outside what an agent can do, and the steps are deterministic on
purpose.

| Document | Purpose |
|----------|---------|
| [Release Process](release-process.md) | The owner manual for cutting a release: the `release/stable` branch, its ruleset, the draft-release review and publish. Records what the pipeline principal (a GitHub *collaborator*, not an *ADMIN*) cannot do itself |
| [GitHub Settings Runbook](GITHUB_SETUP.md) | One-time repository settings: branch + tag rulesets, secret scanning, Dependabot, CodeQL, private vulnerability reporting, workflow permissions, 2FA, repo topics |

## Spikes

Research that **is part of a spec**, filed flat as `spikes/<issue-number>-<slug>.md`. These are
**records, not code** — a spike's PoC crate and raw measurements are disposable; the decision and
its rationale are what survive. Indexed at [`spikes/README.md`](../spikes/README.md).

| Spike | Outcome |
|-------|---------|
| [#2948 — embedded PostgreSQL evaluation](../spikes/2948-embedded-postgres-spike.md) | Is `postgresql-embedded` viable for `fredo.db`? **NO-GO**. The measurements stand as design inputs, not a veto |
| [#2964 — the migration approach](../spikes/2964-postgres-migration-approach.md) | The migration is **mandated** — so how? The full written approach, with the four section designs absorbed into it |
| [#2897 — model-audio feasibility](../spikes/2897-model-audio-feasibility.md) | The ST-0 gating record for speech input. Model audio shipped; it is the only speech path |
| [#2876 — local-first streaming STT engine](../spikes/2876-stt-engine-selection.md) | **SUPERSEDED** by #2914 — kept verbatim as the spike's historical record |

## Research

[`research/`](../research/) is the maintainer's own landscape research — external papers, vendor
documentation, community practice, and OSS case studies that informed the open-source launch. It is
**not** spec-scoped work and is not indexed here.

---

### Archived

Historical documentation for superseded components is in [`archive/`](archive/README.md).
