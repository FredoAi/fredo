# Fredo Documentation Index

## Quick Start

### For New Developers
1. **[Setup Guide](SETUP.md)** — Prerequisites, install, dev commands, model download, OTLP config
2. **[Architecture Overview](ARCHITECTURE.md)** — Communication layer, RTDB row pipeline, event flow, IPC protocol, OTLP receivers, LLM, mission monitor, companion
3. **[CLI Guide](CLI_GUIDE.md)** — All `fredo` CLI commands

### For System Architects
1. **[Architecture Overview](ARCHITECTURE.md)** — Complete system design: Rust module map, event pipeline, IPC protocol, feature modules, Tauri commands, startup sequence
2. **[agentic-pipeline](agentic-pipeline/README.md)** — Agentic SDD pipeline: agent roles, design protocol, implementation lifecycle, quality gates, continuous improvement

---

## Documentation Catalog

| Document | Purpose |
|----------|---------|
| [Architecture](ARCHITECTURE.md) | Communication layer, RTDB row store + ingest classifier, Rust module map, IPC protocol, OTLP receivers, Tauri commands, feature modules, agent integrations, startup sequence |
| [agentic-pipeline](agentic-pipeline/README.md) | Agentic SDD pipeline: agent catalog, phases, artifacts, scripts, skills, metrics — the full development workflow from intake to improvement |
| [Setup Guide](SETUP.md) | Prerequisites, install, dev commands, model download, OTLP configuration |
| [CLI Guide](CLI_GUIDE.md) | All `fredo` CLI subcommands with examples |
| [Security](SECURITY.md) | IPC socket security, OTLP, Tauri capabilities, input handling, process isolation |
| [FAQ](FAQ.md) | Common questions and troubleshooting |
| [App Icons](app-icons.md) | Shipped OS icon set: source of truth (the canonical avatar geometry), composition + baked palette, regeneration commands, platform scope |
| [STT Engine Selection (research, superseded)](research/stt-engine-selection.md) | Historical #2876 spike — **superseded by #2914**: the local-first streaming STT engine decision (candidate comparison, 6 engines × 8 criteria, cited) and its capture + provisioning recommendation, kept as a record after the on-device engine was removed and model audio became the only voice path |

### Archived
Historical documentation for superseded components is in [`archive/`](archive/README.md).
