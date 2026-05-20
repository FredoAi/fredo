# Atlas - Development Workflows

## 🚀 Getting Started Workflow

### Initial Setup (First Time)

1. **Prerequisites Check**
   ```powershell
   # Verify Docker Desktop is running
   docker --version
   docker-compose --version
   
   # Verify Git is installed
   git --version
   ```

2. **Project Setup**
   ```powershell
   # Clone repository
   git clone <repository-url>
   cd Atlas
   
   # Copy environment template
   copy .env.example .env
   
   # Start development environment
   make dev  # or .\dev.ps1 on Windows
   ```

3. **Verification**
   ```powershell
   # Test MCP interface (if available)
   curl http://localhost:3000/mcp/tools
   
   # Test REST API
   curl http://localhost:3000/api/v1/tools
   
   # Check service health
   curl http://localhost:3000/api/v1/health
   ```

---

## 🛠️ Service Development Workflow

### Creating a New Service

#### Step 1: Service Structure Setup

```powershell
# Create service directory
mkdir src/services/myservice
cd src/services/myservice

# Create required files
New-Item -Name "index.ts" -ItemType File
New-Item -Name "model.ts" -ItemType File
New-Item -Name "myTool.ts" -ItemType File
New-Item -Name "README.md" -ItemType File
```

#### Step 2: Define Data Models (`model.ts`)

```typescript
// src/services/myservice/model.ts
export interface MyServiceConfig {
  apiUrl: string;
  timeout: number;
}

export interface MyToolParams {
  query: string;
  limit: number;
  filters?: Record<string, string>;
}

export interface MyToolResult {
  results: Array<{
    id: string;
    data: Record<string, unknown>;
  }>;
  totalCount: number;
  processingTime: number;
}
```

#### Step 3: Implement Tool (`myTool.ts`)

```typescript
// src/services/myservice/myTool.ts
import { BaseTool, ToolMetadata } from '../../core/BaseTool';
import { MyToolParams, MyToolResult } from './model';

export class MyTool extends BaseTool {
  getMetadata(): ToolMetadata {
    return {
      name: 'myservice_query',
      description: 'Query data from my custom service',
      service: 'myservice',
      version: '1.0.0',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', default: 100, maximum: 1000 }
        },
        required: ['query']
      },
      returnType: {
        type: 'object',
        properties: {
          results: { type: 'array' },
          totalCount: { type: 'number' }
        }
      },
      category: 'data-access'
    };
  }

  async execute(params: MyToolParams): Promise<MyToolResult> {
    // Validate parameters
    const validationResult = this.validate(params);
    if (!validationResult.isValid) {
      throw new Error(`Validation failed: ${validationResult.errors.map(e => e.message).join(', ')}`);
    }

    // Implement tool logic
    const results = await this.queryExternalService(params);
    
    return {
      results,
      totalCount: results.length,
      processingTime: Date.now() - startTime
    };
  }

  private async queryExternalService(params: MyToolParams) {
    // Implementation details
    return [];
  }
}
```

#### Step 4: Implement Service (`index.ts`)

```typescript
// src/services/myservice/index.ts
import { BaseService } from '../../core/BaseService';
import { BaseTool } from '../../core/BaseTool';
import { MyTool } from './myTool';
import { MyServiceConfig } from './model';

export class MyService extends BaseService {
  private config: MyServiceConfig;

  async initialize(): Promise<void> {
    this.config = this.getConfig<MyServiceConfig>();
    
    // Validate configuration
    if (!this.config.apiUrl) {
      throw new Error('MyService requires apiUrl configuration');
    }

    // Initialize connections or dependencies
    await this.validateConnection();
  }

  getTools(): BaseTool[] {
    return [
      new MyTool()
    ];
  }

  private async validateConnection(): Promise<void> {
    // Test external service connection
    try {
      // Implementation
    } catch (error) {
      throw new Error(`Failed to connect to external service: ${error.message}`);
    }
  }
}
```

#### Step 5: Testing and Validation

```powershell
# Hot reload should pick up changes automatically
# Test the new service via REST API

# List all tools (should include your new tool)
curl http://localhost:3000/api/v1/tools

# Execute your tool
curl -X POST http://localhost:3000/api/v1/tools/myservice_query/execute `
  -H "Content-Type: application/json" `
  -d '{
    "query": "test",
    "limit": 10
  }'
```

---

## 🔄 Development Iteration Workflow

### Daily Development Cycle

1. **Start Development Environment**
   ```powershell
   make dev  # or .\dev.ps1
   ```

2. **Monitor Logs**
   ```powershell
   # In separate terminal - watch application logs
   docker-compose -f docker/docker-compose.dev.yml logs -f app
   
   # Watch database logs (if needed)
   docker-compose -f docker/docker-compose.dev.yml logs -f postgres
   ```

3. **Make Code Changes**
   - Edit TypeScript files
   - Hot reload automatically triggers recompilation
   - Watch console for compilation errors

4. **Test Changes**
   ```powershell
   # Quick API test
   curl http://localhost:3000/api/v1/health
   
   # Test specific tool
   curl -X POST http://localhost:3000/api/v1/tools/traces_query/execute `
     -H "Content-Type: application/json" `
     -d '{"startTime": "2025-11-02T10:00:00Z", "endTime": "2025-11-02T11:00:00Z"}'
   ```

5. **Debug Issues**
   ```powershell
   # Check service health
   curl http://localhost:3000/api/v1/health
   
   # Review logs for errors
   docker-compose -f docker/docker-compose.dev.yml logs --tail=50 app
   
   # Connect to database (if needed)
   docker-compose -f docker/docker-compose.dev.yml exec postgres psql -U postgres -d Atlas
   ```

---

## 🐛 Debugging Workflow

### Common Debugging Scenarios

#### Service Not Loading

1. **Check Service Discovery**
   ```powershell
   # Review application startup logs
   docker-compose -f docker/docker-compose.dev.yml logs app | findstr "service"
   ```

2. **Validate Service Structure**
   ```
   src/services/myservice/
   ├── index.ts      # Must export service class
   ├── model.ts      # Must define interfaces
   └── *.ts          # Tool implementations
   ```

3. **Check Configuration**
   ```typescript
   // Verify .env file has required variables
   POSTGRES_HOST=postgres
   POSTGRES_DB=Atlas
   AZURE_DEVOPS_URL=https://dev.azure.com
   ```

#### Tool Execution Failures

1. **Parameter Validation Issues**
   ```powershell
   # Test with minimal parameters
   curl -X POST http://localhost:3000/api/v1/tools/mytool/execute `
     -H "Content-Type: application/json" `
     -d '{}'
   
   # Check validation error response
   ```

2. **Database Connection Issues**
   ```powershell
   # Test database connectivity
   docker-compose -f docker/docker-compose.dev.yml exec app npm run db-test
   
   # Check PostgreSQL status
   docker-compose -f docker/docker-compose.dev.yml ps postgres
   ```

3. **External API Issues**
   ```powershell
   # Test from within container
   docker-compose -f docker/docker-compose.dev.yml exec app curl https://dev.azure.com
   ```

#### Performance Issues

1. **Monitor Execution Times**
   ```powershell
   # Enable debug logging
   # Add DEBUG=Atlas:* to .env file
   
   # Monitor response times
   curl -w "Total time: %{time_total}s\n" http://localhost:3000/api/v1/tools
   ```

2. **Database Query Optimization**
   ```sql
   -- Connect to database and analyze slow queries
   SELECT query, mean_time, calls 
   FROM pg_stat_statements 
   ORDER BY mean_time DESC 
   LIMIT 10;
   ```

---

## 📦 Build and Deployment Workflow

### Local Build Testing

```powershell
# Build production image
docker build -f docker/Dockerfile -t Atlas:latest .

# Test production build locally
docker run -p 3000:3000 --env-file .env Atlas:latest

# Verify functionality
curl http://localhost:3000/api/v1/health
```

### Environment Configuration

#### Development Environment (`.env.dev`)
```env
NODE_ENV=development
DEBUG=Atlas:*
LOG_LEVEL=debug
POSTGRES_HOST=postgres
AZURE_DEVOPS_TIMEOUT=30000
```

#### Production Environment (`.env.prod`)
```env
NODE_ENV=production
LOG_LEVEL=info
POSTGRES_HOST=production-postgres-host
AZURE_DEVOPS_TIMEOUT=10000
```

---

## 🔄 Hot Reload Workflow

### Understanding Hot Reload Behavior

1. **File Change Detection**
   - `nodemon` monitors `/src` directory
   - Triggers on `.ts`, `.js`, `.json` file changes
   - Ignores `node_modules`, `dist`, `*.log` files

2. **Reload Process**
   ```
   File Change → TypeScript Compilation → Service Restart → Tool Re-registration
   ```

3. **Reload Speed Optimization**
   - Keep service initialization lightweight
   - Cache expensive operations when possible
   - Use lazy loading for heavy dependencies

### Troubleshooting Hot Reload

```powershell
# Check nodemon configuration
docker-compose -f docker/docker-compose.dev.yml exec app cat nodemon.json

# Manual restart if hot reload fails
docker-compose -f docker/docker-compose.dev.yml restart app

# Clear TypeScript compilation cache
docker-compose -f docker/docker-compose.dev.yml exec app rm -rf dist/
```

---

## 📝 Documentation Workflow

### Updating Service Documentation

1. **Service README Template**
   ```markdown
   # MyService

   ## Overview
   Brief description of service functionality

   ## Tools
   - `myservice_query`: Query data with filtering

   ## Configuration
   Required environment variables and settings

   ## Examples
   Common usage patterns and API examples
   ```

2. **API Documentation Updates**
   - Update OpenAPI schemas in code
   - Documentation auto-generates from tool metadata
   - Test examples in Swagger UI at `/api/v1/docs`

### Code Documentation Standards

```typescript
/**
 * Query data from external service with filtering and pagination
 * 
 * @param params - Query parameters including search terms and filters
 * @returns Promise resolving to query results with metadata
 * @throws Error when parameters are invalid or service is unavailable
 * 
 * @example
 * ```typescript
 * const result = await tool.execute({
 *   query: "search term",
 *   limit: 100,
 *   filters: { status: "active" }
 * });
 * ```
 */
async execute(params: MyToolParams): Promise<MyToolResult> {
  // Implementation
}
```

---

## 🎯 Quality Assurance Workflow

### Pre-Commit Checks

```powershell
# TypeScript compilation check
npm run build

# Linting check
npm run lint

# Format check
npm run format:check

# API functionality test
curl http://localhost:3000/api/v1/health
```

### Code Review Checklist

- [ ] Service follows BaseService pattern
- [ ] Tools implement proper validation
- [ ] Error handling is comprehensive
- [ ] Configuration is externalized
- [ ] Documentation is updated
- [ ] Examples are provided
- [ ] Performance is acceptable

### Integration Verification

```powershell
# Test all service endpoints
$services = @("traces", "metrics", "logs", "azdowiql")
foreach ($service in $services) {
  curl "http://localhost:3000/api/v1/services/$service/tools"
}

# Verify MCP integration (when available)
# Test with actual MCP client or mock
```

This workflow documentation provides a comprehensive guide for developers to efficiently work with the Atlas framework, from initial setup through daily development and quality assurance.