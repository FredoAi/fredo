# Fredo - API Specification

## 🔌 Protocol Support Overview

Fredo exposes tools through two primary interfaces:

1. **Model Context Protocol (MCP)** - For AI agent integration via LangChain SDK
2. **REST API** - For HTTP-based integration via Fastify

Both interfaces provide access to the same underlying tools with consistent functionality.

---

## 🤖 Model Context Protocol (MCP) Interface

### MCP Server Configuration

```json
{
  "name": "Fredo-mcp-server",
  "version": "1.0.0",
  "description": "Fredo AI Tooling Framework MCP Server",
  "capabilities": {
    "tools": true,
    "resources": false,
    "prompts": false
  }
}
```

### Tool Discovery via MCP

**List Available Tools**
```json
{
  "method": "tools/list",
  "params": {}
}
```

**Response**
```json
{
  "tools": [
    {
      "name": "traces_query",
      "description": "Query distributed tracing data with filtering and aggregation",
      "inputSchema": {
        "type": "object",
        "properties": {
          "serviceName": {"type": "string", "description": "Filter by service name"},
          "startTime": {"type": "string", "format": "date-time"},
          "endTime": {"type": "string", "format": "date-time"},
          "minDuration": {"type": "number", "description": "Minimum duration in milliseconds"}
        },
        "required": ["startTime", "endTime"]
      }
    }
  ]
}
```

### Tool Execution via MCP

**Execute Tool**
```json
{
  "method": "tools/call",
  "params": {
    "name": "traces_query",
    "arguments": {
      "serviceName": "user-service",
      "startTime": "2025-11-02T10:00:00Z",
      "endTime": "2025-11-02T11:00:00Z",
      "minDuration": 1000
    }
  }
}
```

**Response**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Found 15 traces matching criteria"
    },
    {
      "type": "json",
      "data": {
        "traces": [
          {
            "traceId": "abc123",
            "spans": [...],
            "duration": 1250,
            "serviceName": "user-service"
          }
        ],
        "totalCount": 15,
        "executionTime": 245
      }
    }
  ]
}
```

---

## 🌐 REST API Specification

### Base Configuration

- **Base URL**: `http://localhost:3000/api/v1`
- **Content-Type**: `application/json`
- **API Version**: `1.0.0`

### OpenAPI 3.0 Specification

```yaml
openapi: 3.0.3
info:
  title: Fredo AI Tooling Framework API
  version: 1.0.0
  description: REST API for Fredo AI tooling framework providing access to observability data and Azure DevOps integration
  contact:
    name: Fredo Development Team
  license:
    name: MIT

servers:
  - url: http://localhost:3000/api/v1
    description: Development server

paths:
  /tools:
    get:
      summary: List all available tools
      operationId: listTools
      tags:
        - Discovery
      responses:
        '200':
          description: List of available tools
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ToolList'
        '500':
          description: Server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /tools/{toolName}/execute:
    post:
      summary: Execute a specific tool
      operationId: executeTool
      tags:
        - Execution
      parameters:
        - name: toolName
          in: path
          required: true
          description: Name of the tool to execute
          schema:
            type: string
            example: "traces_query"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              description: Tool-specific parameters
      responses:
        '200':
          description: Tool execution successful
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ToolResult'
        '400':
          description: Invalid parameters
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ValidationError'
        '404':
          description: Tool not found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '500':
          description: Tool execution failed
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /services/{serviceName}/tools:
    get:
      summary: List tools for a specific service
      operationId: listServiceTools
      tags:
        - Discovery
      parameters:
        - name: serviceName
          in: path
          required: true
          description: Name of the service
          schema:
            type: string
            enum: ["traces", "metrics", "logs", "azdowiql"]
      responses:
        '200':
          description: Service tools retrieved successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ServiceToolList'

components:
  schemas:
    ToolList:
      type: object
      properties:
        tools:
          type: array
          items:
            $ref: '#/components/schemas/ToolMetadata'
        totalCount:
          type: integer
          example: 12

    ServiceToolList:
      type: object
      properties:
        serviceName:
          type: string
          example: "traces"
        tools:
          type: array
          items:
            $ref: '#/components/schemas/ToolMetadata'

    ToolMetadata:
      type: object
      properties:
        name:
          type: string
          example: "traces_query"
        description:
          type: string
          example: "Query distributed tracing data with filtering and aggregation"
        service:
          type: string
          example: "traces"
        version:
          type: string
          example: "1.0.0"
        parameters:
          type: object
          description: JSON Schema for input parameters
        returnType:
          type: object
          description: JSON Schema for return type
        category:
          type: string
          example: "observability"
        examples:
          type: array
          items:
            $ref: '#/components/schemas/ToolExample'
        estimatedDuration:
          type: integer
          description: Estimated execution time in milliseconds
          example: 500

    ToolExample:
      type: object
      properties:
        name:
          type: string
          example: "Query high latency traces"
        input:
          type: object
          example:
            serviceName: "user-service"
            startTime: "2025-11-02T10:00:00Z"
            endTime: "2025-11-02T11:00:00Z"
            minDuration: 1000
        output:
          type: object
          example:
            traces: []
            totalCount: 15
        description:
          type: string
          example: "Find traces with duration over 1 second"

    ToolResult:
      type: object
      properties:
        success:
          type: boolean
          example: true
        data:
          type: object
          description: Tool-specific result data
        metadata:
          type: object
          properties:
            executionTime:
              type: integer
              description: Execution time in milliseconds
              example: 245
            toolName:
              type: string
              example: "traces_query"
            timestamp:
              type: string
              format: date-time
              example: "2025-11-02T10:30:00Z"

    ValidationError:
      type: object
      properties:
        success:
          type: boolean
          example: false
        error:
          type: string
          example: "Validation failed"
        details:
          type: array
          items:
            type: object
            properties:
              path:
                type: string
                example: "startTime"
              message:
                type: string
                example: "Required field missing"
              expected:
                type: string
                example: "ISO 8601 date-time string"

    Error:
      type: object
      properties:
        success:
          type: boolean
          example: false
        error:
          type: string
          example: "Internal server error"
        code:
          type: string
          example: "TOOL_EXECUTION_FAILED"
        timestamp:
          type: string
          format: date-time
          example: "2025-11-02T10:30:00Z"
        requestId:
          type: string
          example: "req_abc123"
```

---

## 🔍 Service-Specific API Endpoints

### Observability Services

#### Traces Service API

**Query Traces**
```http
POST /api/v1/tools/traces_query/execute
Content-Type: application/json

{
  "serviceName": "user-service",
  "startTime": "2025-11-02T10:00:00Z",
  "endTime": "2025-11-02T11:00:00Z",
  "minDuration": 1000,
  "limit": 100,
  "offset": 0
}
```

**Response**
```json
{
  "success": true,
  "data": {
    "traces": [
      {
        "traceId": "abc123def456",
        "spans": [
          {
            "spanId": "span001",
            "operationName": "user.authenticate",
            "serviceName": "user-service",
            "startTime": "2025-11-02T10:15:30Z",
            "duration": 1250,
            "status": "OK",
            "attributes": {
              "user.id": "user123",
              "http.method": "POST"
            }
          }
        ],
        "duration": 1250,
        "status": "OK"
      }
    ],
    "totalCount": 15,
    "hasMore": false
  },
  "metadata": {
    "executionTime": 245,
    "toolName": "traces_query",
    "timestamp": "2025-11-02T10:30:00Z"
  }
}
```

#### Metrics Service API

**Query Metrics**
```http
POST /api/v1/tools/metrics_query/execute
Content-Type: application/json

{
  "metricName": "http_requests_total",
  "startTime": "2025-11-02T10:00:00Z",
  "endTime": "2025-11-02T11:00:00Z",
  "labels": {
    "service": "user-service",
    "status_code": "200"
  },
  "aggregation": "sum",
  "bucketSize": "5m"
}
```

**Response**
```json
{
  "success": true,
  "data": {
    "metrics": [
      {
        "name": "http_requests_total",
        "type": "COUNTER",
        "dataPoints": [
          {
            "timestamp": "2025-11-02T10:00:00Z",
            "value": 1500,
            "labels": {
              "service": "user-service",
              "status_code": "200"
            }
          }
        ]
      }
    ],
    "aggregation": "sum",
    "bucketSize": "5m"
  },
  "metadata": {
    "executionTime": 180,
    "toolName": "metrics_query",
    "timestamp": "2025-11-02T10:30:00Z"
  }
}
```

#### Logs Service API

**Search Logs**
```http
POST /api/v1/tools/logs_search/execute
Content-Type: application/json

{
  "serviceName": "user-service",
  "startTime": "2025-11-02T10:00:00Z",
  "endTime": "2025-11-02T11:00:00Z",
  "severity": ["ERROR", "WARN"],
  "messageSearch": "authentication failed",
  "limit": 50
}
```

### Azure DevOps Service API

#### WIQL Query Tool

**Execute WIQL Query**
```http
POST /api/v1/tools/azdowiql_query/execute
Content-Type: application/json

{
  "organization": "myorg",
  "project": "myproject",
  "wiql": "SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.WorkItemType] = 'Bug' AND [System.State] = 'Active'",
  "maxResults": 100,
  "includeDetails": true
}
```

**Response**
```json
{
  "success": true,
  "data": {
    "workItems": [
      {
        "id": 12345,
        "type": "Bug",
        "state": "Active",
        "title": "Login page not responding",
        "assignedTo": {
          "displayName": "Jane Developer",
          "email": "jane@company.com"
        },
        "createdDate": "2025-11-01T09:00:00Z",
        "priority": 1
      }
    ],
    "totalCount": 8,
    "hasMore": false
  },
  "metadata": {
    "executionTime": 320,
    "toolName": "azdowiql_query",
    "timestamp": "2025-11-02T10:30:00Z",
    "queryMetadata": {
      "organization": "myorg",
      "project": "myproject",
      "executedQuery": "SELECT [System.Id]..."
    }
  }
}
```

---

## 🔒 Error Handling Specifications

### HTTP Status Codes

| Status Code | Description | When Used |
|-------------|-------------|-----------|
| `200` | Success | Tool executed successfully |
| `400` | Bad Request | Invalid parameters or malformed request |
| `404` | Not Found | Tool or service not found |
| `422` | Unprocessable Entity | Valid request format but validation failed |
| `429` | Too Many Requests | Rate limiting applied (future) |
| `500` | Internal Server Error | Unexpected server error |
| `503` | Service Unavailable | Service temporarily unavailable |

### Error Response Format

```json
{
  "success": false,
  "error": "Tool execution failed",
  "code": "TOOL_EXECUTION_ERROR",
  "details": {
    "toolName": "traces_query",
    "cause": "Database connection timeout",
    "retryable": true
  },
  "timestamp": "2025-11-02T10:30:00Z",
  "requestId": "req_abc123def456"
}
```

### Validation Error Format

```json
{
  "success": false,
  "error": "Parameter validation failed",
  "code": "VALIDATION_ERROR",
  "details": [
    {
      "path": "startTime",
      "message": "Required field missing",
      "expected": "ISO 8601 date-time string",
      "received": null
    },
    {
      "path": "minDuration",
      "message": "Value must be positive",
      "expected": "number > 0",
      "received": -100
    }
  ],
  "timestamp": "2025-11-02T10:30:00Z",
  "requestId": "req_abc123def456"
}
```

---

## 📊 Rate Limiting and Performance (Future Scope)

### Rate Limiting Headers

```http
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1699027200
X-RateLimit-Window: 3600
```

### Performance Monitoring Headers

```http
X-Execution-Time: 245
X-Tool-Name: traces_query
X-Request-Id: req_abc123def456
X-Service-Version: 1.0.0
```

---

## 🔧 API Client Examples

### TypeScript/JavaScript Client

```typescript
class FREDOClient {
  private baseUrl: string;
  
  constructor(baseUrl: string = 'http://localhost:3000/api/v1') {
    this.baseUrl = baseUrl;
  }
  
  async listTools(): Promise<ToolMetadata[]> {
    const response = await fetch(`${this.baseUrl}/tools`);
    const data = await response.json();
    return data.tools;
  }
  
  async executeTool(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    const response = await fetch(`${this.baseUrl}/tools/${toolName}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return response.json();
  }
}
```

### Python Client

```python
import requests
from typing import Dict, Any, List

class FREDOClient:
    def __init__(self, base_url: str = "http://localhost:3000/api/v1"):
        self.base_url = base_url
    
    def list_tools(self) -> List[Dict[str, Any]]:
        response = requests.get(f"{self.base_url}/tools")
        response.raise_for_status()
        return response.json()["tools"]
    
    def execute_tool(self, tool_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/tools/{tool_name}/execute",
            json=params
        )
        response.raise_for_status()
        return response.json()
```

---

## 🧪 API Testing and Validation

### Health Check Endpoint

```http
GET /api/v1/health
```

**Response**
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "services": {
    "traces": "operational",
    "metrics": "operational", 
    "logs": "operational",
    "azdowiql": "operational"
  },
  "timestamp": "2025-11-02T10:30:00Z"
}
```

### API Documentation Endpoint

```http
GET /api/v1/docs
```

Returns interactive OpenAPI documentation (Swagger UI) for testing and exploration.