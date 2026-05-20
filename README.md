# Atlas

Atlas is a cross-platform desktop application for infrastructure operations. It ships as a single installable binary that opens a React UI and exposes an `atlas` CLI available from any terminal.

## Apps

| App | Description |
|-----|-------------|
| [`apps/tauri`](./apps/tauri) | Desktop app — Tauri 2 + React UI + Rust CLI backend |
| [`apps/ui`](./apps/ui) | Shared React UI library (`@atlas/ui`) |
| [`apps/tools-mcp`](./apps/tools-mcp) | Node.js MCP/API backend (kept for reference) |
| [`apps/code-sandbox`](./apps/code-sandbox) | Python llm-sandbox service |

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

## CLI

After installing the desktop app, the `atlas` binary is in your PATH:

```bash
atlas logs --query "SELECT * FROM logs WHERE level = 'ERROR' LIMIT 20"
atlas metrics --query "SELECT * FROM metrics LIMIT 10"
atlas k8s pods --namespace production
atlas k8s restart my-deployment
atlas azdo story --title "Fix login bug"
```

See [docs/tauri/CLI_GUIDE.md](docs/tauri/CLI_GUIDE.md) for the full reference.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/tauri/ARCHITECTURE.md](docs/tauri/ARCHITECTURE.md).

## Documentation

See [docs/README.md](docs/README.md) for the full documentation index.

## License

MIT


## 🏗️ Architecture

This monorepo uses:

- **pnpm workspaces** for efficient package management
- **Centralized documentation** in `/docs`
- **Docker-first development** for the Tools-MCP app
- **TypeScript** across all packages

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Docker and Docker Compose

### Installation

```bash
# Install pnpm if you don't have it
npm install -g pnpm

# Install all dependencies
pnpm install
```

### Development

**Tools-MCP App (Docker):**
```bash
# Start Tools-MCP with Docker
cd apps/tools-mcp
docker-compose -f docker-compose.dev.yml up -d

# Or from root
pnpm dev:tools
```

**Build all packages:**
```bash
pnpm build
```

**Type checking:**
```bash
pnpm typecheck
```

## 📁 Monorepo Structure

```text
Atlas-monorepo/
├── apps/
│   └── tools-mcp/           # Atlas Tools with MCP server
│       ├── src/
│       ├── database/
│       ├── docker-compose.dev.yml
│       └── package.json
│
├── docs/                    # Centralized documentation
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   └── tools-mcp/           # Tools-MCP specific docs
│
├── package.json             # Root workspace config
└── pnpm-workspace.yaml      # Workspace definition
```
│   ├── SECURITY.md
│   └── tools-mcp/           # Tools-MCP specific docs
│
├── package.json             # Root workspace config
└── pnpm-workspace.yaml      # Workspace definition
```

## � Documentation

- [Architecture Overview](docs/ARCHITECTURE.md) - System design, service patterns, tool exposure
- [Services Overview](docs/tools-mcp/SERVICES_OVERVIEW.md) - Quick reference for all 11 services and 25 tools
- [Folder Structure](docs/FOLDER_STRUCTURE.md) - Complete monorepo file organization
- [Security Guide](docs/SECURITY.md) - Authentication, authorization, and data protection
- [Tools-MCP Documentation](docs/tools-mcp/) - Backend API and MCP server guides
- [Browser Extension Documentation](docs/browser-extension/) - Frontend architecture and features
- [Project Goals](docs/PROJECT_GOALS.md) - Vision and objectives

## 🛠️ Working with the Monorepo

### Adding Dependencies

```bash
# Add to specific app
pnpm --filter @Atlas/tools-mcp add package-name

# Add to root (workspace-wide dev dependency)
pnpm add -w -D package-name
```

### Running Commands

```bash
# Run command in specific workspace
pnpm --filter @Atlas/tools-mcp dev

# Run command in all workspaces
pnpm --recursive build

# Run from root using scripts
pnpm dev:tools
pnpm build
```

## 🐳 Docker Development

Tools-MCP uses Docker for development:

```bash
cd apps/tools-mcp

# Start all services
docker-compose -f docker-compose.dev.yml up -d

# Start with MCP server
docker-compose -f docker-compose.dev.yml --profile mcp up -d

# View logs
docker logs -f Atlas-tools-mcp-dev

# Stop services
docker-compose -f docker-compose.dev.yml down
```

## � Links

- **REST API**: `http://localhost:3000/api/v1`
- **Swagger Docs**: `http://localhost:3000/docs`
- **MCP HTTP Interface**: `http://localhost:3001`
- **Health Check**: `http://localhost:3000/health`

## 📝 License

This project is licensed under the MIT License.

- [API Specification](docs/API_SPEC.md)  
- [Development Guide](docs/WORKFLOWS.md)
- [Folder Structure](docs/FOLDER_STRUCTURE.md)

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and coding standards.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.