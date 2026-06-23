# Fredo Documentation Index

Welcome to the Fredo documentation.

## Quick Start

### For New Developers
1. **[Setup Guide](tauri/SETUP.md)** — Rust, Tauri CLI, pnpm prerequisites and first run
2. **[Architecture Overview](ARCHITECTURE.md)** — Communication layer, adapters, FredoEvent system, reactive UI feature modules
3. **[Coding Guidelines](CODING_GUIDELINES.md)** — TypeScript and Rust patterns
4. **[CLI Guide](tauri/CLI_GUIDE.md)** — All `fredo` CLI commands

### For System Architects
1. **[Architecture Overview](ARCHITECTURE.md)** — Communication layer, adapters, FredoEvent system, feature modules
2. **[Tauri Architecture](tauri/ARCHITECTURE.md)** — Rust module map, IPC protocol, OTLP receiver internals, Tauri commands
3. **[Project Goals](PROJECT_GOALS.md)** — Agent platform vision and success criteria
4. **[Requirements](REQUIREMENTS.md)** — Platform and build requirements
5. **[Scope](SCOPE.md)** — What's included and future roadmap

---

## Documentation Catalog

### Planning & Requirements
| Document | Purpose |
|----------|---------|
| [Project Goals](PROJECT_GOALS.md) | Agent platform vision, objectives, and success criteria |
| [Scope](SCOPE.md) | What's included vs. future phases |
| [Requirements](REQUIREMENTS.md) | Platform and build requirements |

### Architecture & Design
| Document | Purpose |
|----------|---------|
| [Architecture](ARCHITECTURE.md) | Communication layer, adapters, FredoEvent system, reactive UI feature modules |
| [Tauri Architecture](tauri/ARCHITECTURE.md) | Rust module map, IPC protocol, feature modules, OTLP receiver internals, Tauri commands, startup sequence |
| [Folder Structure](FOLDER_STRUCTURE.md) | Project layout and navigation |

### Development
| Document | Purpose |
|----------|---------|
| [Setup Guide](tauri/SETUP.md) | Prerequisites, install, dev commands |
| [CLI Guide](tauri/CLI_GUIDE.md) | All `fredo` CLI subcommands with examples |
| [Coding Guidelines](CODING_GUIDELINES.md) | TypeScript + Rust patterns and standards |
| [CI/CD](CI_CD.md) | Build pipeline and Tauri artifact publishing |

### Reference
| Document | Purpose |
|----------|---------|
| [Security](SECURITY.md) | Tauri CSP, IPC socket security, capabilities |
| [FAQ](FAQ.md) | Common questions and troubleshooting |

### Archived
Historical documentation for superseded components is in [`archive/`](archive/README.md).
