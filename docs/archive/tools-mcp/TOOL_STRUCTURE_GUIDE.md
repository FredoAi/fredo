# Tool Structure Guide

**Mandatory structure for all tools in tools-mcp**

## Structure Requirements

Every tool MUST follow this exact structure:

```
services/{service-name}/
  tools/
    {tool_name}/              ← MUST be snake_case matching tool.name exactly
      {Tool}Tool.ts           ← PascalCase, ends with "Tool.ts"
      doc.md                  ← Minimal AI-friendly documentation (REQUIRED)
```

## Validation

ServiceLoader validates structure at startup and prevents server from starting if any issues are found:

### Batch Error Reporting
All errors are collected and displayed together:

```
[service-name] Tool structure validation FAILED:
  ❌ Flat structure detected: 'MyTool.ts' must be migrated to nested folder
  ❌ Folder name 'my-tool' doesn't match tool.name 'my_tool'
  ❌ Tool 'my_tool' missing doc.md in src/services/my-service/tools/my_tool

✨ Required structure: tools/{tool_name}/{Tool}Tool.ts + doc.md
   Folder name MUST match tool.name exactly (snake_case)
```

### Validation Rules
1. **No flat structure** - Files like `tools/MyTool.ts` will fail
2. **Folder name must match tool.name** - Exact match required (snake_case)
3. **doc.md required** - Every tool must have documentation
4. **Nested structure only** - `tools/{tool_name}/{Tool}Tool.ts` pattern enforced

## Creating a New Tool

### Step 1: Create Nested Folder
```bash
cd src/services/my-service/tools
mkdir my_tool_name  # MUST match tool.name exactly
```

### Step 2: Create Tool File
File: `src/services/my-service/tools/my_tool_name/MyToolNameTool.ts`

```typescript
import { BaseTool } from '../../../core/BaseTool.js';
import type { MyService } from '../service.js';

export class MyToolNameTool extends BaseTool {
  readonly name = 'my_tool_name';  // snake_case - folder name must match this
  readonly description = 'Brief description for AI agents';
  readonly exposedAs: 'mcp' | 'api' | 'both' = 'mcp';
  
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      param1: { 
        type: 'string', 
        description: 'Parameter description'
      }
    },
    required: ['param1']
  };

  constructor(private service: MyService) {
    super();
  }

  async execute(input: any, context?: any): Promise<any> {
    // Implementation
    return { success: true, data: {} };
  }
}
```

### Step 3: Create Minimal Documentation
File: `src/services/my-service/tools/my_tool_name/doc.md`

```markdown
# my_tool_name

Brief description of what this tool does.

## Input Schema
\`\`\`json
{
  "param1": "string (description)",
  "param2": "integer (optional, description)"
}
\`\`\`

## Example
\`\`\`json
{
  "param1": "example value",
  "param2": 42
}
\`\`\`

## Response
Description of what the tool returns.
```

### Step 4: Verify Structure
```bash
# Server will validate on startup
pnpm dev

# Or run verification script
.\scripts\verify-migration.ps1
```

## Tool Exposure Types

### `exposedAs: 'mcp'`
- **Only available via MCP** (Model Context Protocol)
- No HTTP endpoint created
- Example: `azdo_start_workitem`, `kubectl_restart_deployment`, `kubectl_get_pods`

### `exposedAs: 'api'`
- **Only available via HTTP REST API**
- Requires manual route registration in service routes
- Example: `infrastructure_snapshot`, `infrastructure_stream`

### `exposedAs: 'both'`
- **Available via both MCP and HTTP**
- Can use `autoRegisterTools=true` with `httpEndpoint` for automatic API generation
- Example: `logs_query`, `metrics_query`, `traces_query`

## Auto-Registration (for `exposedAs: 'both'`)

Services can enable automatic HTTP route generation:

```typescript
export class MyServiceRoutes extends BaseRoutes {
  protected serviceName = 'my-service';
  protected autoRegisterTools = true;  // Enable auto-generation
  
  async register(fastify: FastifyInstance, options: any): Promise<void> {
    this.serviceInstance = options['my-serviceService'];
    
    // Auto-register tool routes if enabled
    await this.autoRegisterToolRoutes(fastify);
  }
}
```

Tool must define `httpEndpoint`:

```typescript
readonly httpEndpoint = {
  method: 'POST' as const,
  path: '/query',
  description: 'Execute query',
  parameterMapping: {
    query: { location: 'body' as const, httpName: 'query' }
  },
  responseSchema: {
    successShape: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: { type: 'object' }
      }
    }
  }
};
```

## Documentation Format

### Minimal AI-Friendly Format
Optimized for Claude Sonnet 4 and other AI agents:

- **Tool name** (h1)
- **Brief description** (1-2 sentences)
- **Input Schema** (JSON with inline descriptions)
- **Example** (Realistic example request)
- **Response** (What the tool returns)

### Keep It Minimal
- No extensive explanations
- No implementation details
- Focus on what AI needs to use the tool
- JSON schemas with inline descriptions
- Realistic examples

## Common Patterns

### MCP-Only Tool
```typescript
readonly exposedAs = 'mcp';
// No httpEndpoint needed
```

### API-Only Tool (Manual Routes)
```typescript
readonly exposedAs = 'api';
// Define routes manually in service routes.ts
```

### Both MCP & API (Auto-Generated)
```typescript
readonly exposedAs = 'both';
readonly httpEndpoint = {
  method: 'POST',
  path: '/query',
  // ... configuration
};
// Enable autoRegisterTools=true in routes
```

## Migration Notes

### Removed Features
- ❌ Flat structure (`tools/*.ts`) - No longer supported
- ❌ Backwards compatibility exports - Removed from all route files
- ❌ `registerRoutes()` helper - Use `BaseRoutes` class only

### Breaking Changes
- ✅ None for external consumers
- All changes are internal structure only
- MCP tool names unchanged
- HTTP endpoints unchanged

## Troubleshooting

### Server Won't Start
```
[my-service] Tool structure validation FAILED:
  ❌ Folder name 'my-tool' doesn't match tool.name 'my_tool'
```

**Fix:** Rename folder to exactly match `tool.name`:
```bash
mv src/services/my-service/tools/my-tool src/services/my-service/tools/my_tool
```

### Missing Documentation Error
```
❌ Tool 'my_tool' missing doc.md in /path/to/my_tool
```

**Fix:** Create `doc.md` in the tool folder using the minimal template above.

### Flat Structure Error
```
❌ Flat structure detected: 'MyTool.ts' must be migrated to nested folder
```

**Fix:** Create nested folder and move file:
```bash
mkdir src/services/my-service/tools/my_tool
mv src/services/my-service/tools/MyTool.ts src/services/my-service/tools/my_tool/
```

## Additional Resources

- [Tools Documentation Service](../src/services/tools-documentation/README.md) - Retrieves tool docs
- [BaseRoutes Guide](BASE_ROUTES_GUIDE.md) - Route creation patterns
- [Migration Report](../MIGRATION_REPORT.md) - Post-migration status
