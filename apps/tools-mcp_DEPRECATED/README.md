# Fredo Tools-MCP

AI tooling framework with Fastify backend, PostgreSQL integration, and Model Context Protocol (MCP) server.

## Features

- **REST API**: Fastify-based REST endpoints with OpenAPI documentation
- **MCP Server**: Model Context Protocol server for AI agent integration
- **Auto-discovery**: Services and tools are automatically registered
- **PostgreSQL**: Observability data storage (logs, metrics, traces)
- **Docker-first**: Development in containers with hot reload

## Quick Start

### Development

```bash
# Start with Docker (from project root)
cd ../..
docker-compose -f docker-compose.dev.yml up -d

# Or use pnpm from root
pnpm dev:tools
```

### With MCP Server

```bash
# From project root
docker-compose -f docker-compose.dev.yml --profile mcp up -d
```

## Architecture

### Service Pattern

Each service follows this structure:
```
services/{service-name}/
├── service.ts      # Extends BaseService
├── routes.ts       # Extends BaseRoutes
├── model.ts        # Data models
├── repository.ts   # Data access
├── controller.ts   # Business logic
└── tools/          # MCP tools
    └── *Tool.ts    # Extends BaseTool
```

### Available Services

- **Logs**: Query application logs
- **Metrics**: Query metrics data
- **Traces**: Query distributed traces
- **Azure DevOps WIQL**: Execute work item queries

## API Access

- **REST API**: http://localhost:3000/api/v1
- **Swagger**: http://localhost:3000/docs
- **Health**: http://localhost:3000/health

## MCP Server Access

The MCP server supports two transport modes:

### 1. SSE (Server-Sent Events) - For Remote AI Agents

```bash
# Start with SSE transport (from project root)
cd ../..
npm run mcp-server-sse

# Or via Docker
docker-compose -f docker-compose.dev.yml up mcp-server
```

**Connection URL**: `http://localhost:3001/sse`

**Configure in AI Agent**:
```json
{
  "mcpServers": {
    "Fredo-tools": {
      "url": "http://localhost:3001/sse"
    }
  }
}
```

**Endpoints**:
- SSE: `http://localhost:3001/sse` - MCP protocol over SSE
- Health: `http://localhost:3001/health` - Server status
- Tools: `http://localhost:3001/tools` - List available tools
- Web UI: `http://localhost:3001/` - Interactive documentation

### 2. Stdio - For Local AI Agents

```bash
# Start with stdio transport
npm run mcp-server
```

**Configure in AI Agent (e.g., Claude Desktop)**:
```json
{
  "mcpServers": {
    "Fredo-tools": {
      "command": "docker",
      "args": ["exec", "-i", "Fredo-tools-mcp-server", "npm", "run", "mcp-server"]
    }
  }
}
```

## Documentation

See [docs/tools-mcp/](../../docs/tools-mcp/) for detailed documentation:
- [API Specification](../../docs/tools-mcp/API_SPEC.md)
- [Base Routes Guide](../../docs/tools-mcp/BASE_ROUTES_GUIDE.md)
- [Data Model](../../docs/tools-mcp/DATA_MODEL.md)
- [Deployment](../../docs/tools-mcp/DEPLOYMENT.md)

## Development

```bash
# Install dependencies (from monorepo root)
pnpm install

# Run development server
pnpm dev

# Build
pnpm build

# Type check
pnpm typecheck
```

## Environment

Copy `.env.example` to `.env` and configure:

```bash
# Server
PORT=3000
NODE_ENV=development

# Database
DB_HOST=postgres
DB_PORT=5432
DB_NAME=Fredo
DB_USER=Fredo_user
DB_PASSWORD=Fredo_password
```

## License

MIT
