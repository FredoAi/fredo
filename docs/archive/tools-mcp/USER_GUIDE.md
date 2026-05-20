# Atlas - User Guide

## 🚀 Getting Started with Atlas

Atlas is an **AI-powered observability platform** that provides **comprehensive logging**, **metrics**, **tracing**, and **Azure DevOps integration** through both **REST APIs** and **MCP tools** for seamless AI agent integration.

## 📖 Table of Contents

- [Quick Start](#quick-start)
- [REST API Usage](#rest-api-usage)
- [MCP Tools Integration](#mcp-tools-integration)
- [Service Features](#service-features)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## 🚀 Quick Start

### **Installation & Setup**

1. **Clone the Repository**
```bash
git clone <repository-url>
cd Atlas
```

2. **Environment Configuration**
```bash
# Copy environment template
cp .env.example .env

# Edit configuration
nano .env
```

3. **Start Development Environment**
```bash
# Quick setup with Docker
./scripts/setup-dev.sh

# Start all services
docker-compose -f docker-compose.dev.yml up -d

# Verify services are running
curl http://localhost:3000/health
```

4. **Access the Platform**
- **REST API**: `http://localhost:3000`
- **API Documentation**: `http://localhost:3000/docs`
- **Health Check**: `http://localhost:3000/health`

### **Environment Variables**
```env
# Database Configuration
DATABASE_URL=postgresql://postgres:password@localhost:5432/Atlas
REDIS_URL=redis://localhost:6379

# Azure DevOps Integration
AZURE_DEVOPS_URL=https://dev.azure.com/your-organization
AZURE_DEVOPS_TOKEN=your-personal-access-token

# Application Settings
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
```

---

## 🌐 REST API Usage

### **Logs Service**

#### **Query Logs**
```bash
# Get recent error logs
curl -X POST http://localhost:3000/logs/query \
  -H "Content-Type: application/json" \
  -d '{
    "level": "error",
    "startTime": "2024-01-01T00:00:00Z",
    "limit": 50
  }'
```

#### **Create Log Entry**
```bash
# Single log entry
curl -X POST http://localhost:3000/logs/create \
  -H "Content-Type: application/json" \
  -d '{
    "level": "info",
    "message": "User login successful",
    "metadata": {
      "userId": "12345",
      "ipAddress": "192.168.1.1"
    }
  }'

# Batch log creation
curl -X POST http://localhost:3000/logs/batch \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [
      {
        "level": "info",
        "message": "Process started",
        "timestamp": "2024-01-01T10:00:00Z"
      },
      {
        "level": "warn", 
        "message": "Memory usage high",
        "timestamp": "2024-01-01T10:01:00Z"
      }
    ]
  }'
```

### **Metrics Service**

#### **Query Metrics**
```bash
# Get response time metrics
curl -X POST http://localhost:3000/metrics/query \
  -H "Content-Type: application/json" \
  -d '{
    "metricName": "response_time",
    "startTime": "2024-01-01T00:00:00Z",
    "endTime": "2024-01-02T00:00:00Z",
    "aggregation": "avg",
    "granularity": "1h"
  }'
```

#### **Record Metrics**
```bash
# Single metric
curl -X POST http://localhost:3000/metrics/create \
  -H "Content-Type: application/json" \
  -d '{
    "name": "api_response_time",
    "value": 150,
    "unit": "milliseconds",
    "tags": {
      "endpoint": "/users",
      "method": "GET"
    }
  }'
```

### **Traces Service**

#### **Query Traces**
```bash
# Get traces for a specific service
curl -X POST http://localhost:3000/traces/query \
  -H "Content-Type: application/json" \
  -d '{
    "serviceName": "user-service",
    "operation": "getUserById",
    "minDuration": 1000,
    "limit": 25
  }'
```

#### **Create Trace**
```bash
# Record distributed trace
curl -X POST http://localhost:3000/traces/create \
  -H "Content-Type: application/json" \
  -d '{
    "traceId": "trace-12345",
    "serviceName": "user-service", 
    "operation": "getUserById",
    "startTime": "2024-01-01T10:00:00Z",
    "duration": 250,
    "spans": [
      {
        "spanId": "span-1",
        "operation": "database_query",
        "startTime": "2024-01-01T10:00:01Z",
        "duration": 100,
        "tags": {"table": "users"}
      },
      {
        "spanId": "span-2", 
        "operation": "cache_lookup",
        "startTime": "2024-01-01T10:00:02Z",
        "duration": 50,
        "tags": {"cache_hit": "false"}
      }
    ]
  }'
```

### **Azure DevOps WIQL Service**

#### **Execute WIQL Query**
```bash
# Query work items
curl -X POST http://localhost:3000/wiql/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.WorkItemType] = '\''Bug'\'' AND [System.State] = '\''Active'\''",
    "project": "MyProject",
    "top": 100
  }'
```

#### **Update Work Item**
```bash
# Update work item fields
curl -X POST http://localhost:3000/wiql/update \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": 12345,
    "fields": {
      "System.Title": "Updated Bug Title",
      "System.State": "In Progress",
      "System.AssignedTo": "john.doe@company.com"
    }
  }'
```

---

## 🤖 MCP Tools Integration

### **LangChain SDK Integration**

#### **Setup MCP Tools**
```typescript
import { MCPToolRegistry } from 'Atlas-mcp-client';

// Initialize MCP tools
const mcpClient = new MCPToolRegistry({
  serverUrl: 'http://localhost:3000'
});

// Load all available tools
const tools = await mcpClient.loadTools();

// Use with LangChain agent
const agent = new Agent({
  tools: tools,
  llm: new OpenAI({
    temperature: 0.1
  })
});
```

#### **Available MCP Tools**

**Log Query Tool**
```typescript
const logResults = await mcpClient.executeTool('logQuery', {
  level: 'error',
  startTime: '2024-01-01T00:00:00Z',
  limit: 50
});
```

**Metrics Query Tool**
```typescript
const metricsResults = await mcpClient.executeTool('metricsQuery', {
  metricName: 'response_time',
  aggregation: 'avg',
  granularity: '1h'
});
```

**Trace Query Tool**
```typescript
const traceResults = await mcpClient.executeTool('traceQuery', {
  serviceName: 'user-service',
  minDuration: 1000
});
```

**WIQL Query Tool**
```typescript
const wiqlResults = await mcpClient.executeTool('wiqlQuery', {
  query: "SELECT * FROM WorkItems WHERE [State] = 'Active'",
  project: 'MyProject'
});
```

### **Natural Language Queries with AI Agents**

```typescript
// Example AI agent prompts
const prompt = `
Analyze the system health by:
1. Getting all error logs from the last 24 hours
2. Checking response time metrics for slow endpoints
3. Finding any traces with duration > 5 seconds
4. Querying Azure DevOps for any critical bugs
`;

const result = await agent.run(prompt);
```

---

## 🛠️ Service Features

### **Logs Service Features**
- **Multi-level Logging**: Support for debug, info, warn, error, fatal levels
- **Structured Logging**: JSON-formatted logs with metadata
- **Time-based Queries**: Filter by date ranges and time windows
- **Full-text Search**: Search log messages and metadata
- **Batch Processing**: Efficient bulk log ingestion
- **Real-time Streaming**: WebSocket-based log streaming

### **Metrics Service Features**
- **Time Series Data**: High-precision timestamp storage
- **Aggregation Functions**: Sum, average, min, max, percentiles
- **Custom Dimensions**: Tags and labels for metric categorization
- **Retention Policies**: Configurable data retention periods
- **Alerting Integration**: Threshold-based alerting
- **Dashboard Support**: Pre-built visualization queries

### **Traces Service Features**
- **Distributed Tracing**: End-to-end request tracking
- **Span Relationships**: Parent-child span hierarchies
- **Performance Analysis**: Duration and latency tracking
- **Error Correlation**: Link errors to trace contexts
- **Service Maps**: Automatic service dependency mapping
- **Sampling Configuration**: Configurable trace sampling rates

### **Azure DevOps WIQL Service Features**
- **WIQL Query Execution**: Full WIQL syntax support
- **Work Item Management**: Create, read, update work items
- **Project Integration**: Multi-project support
- **Field Mapping**: Custom field configuration
- **Batch Operations**: Bulk work item updates
- **Webhook Integration**: Real-time change notifications

---

## 📊 Best Practices

### **Logging Best Practices**

1. **Use Appropriate Log Levels**
```typescript
// Good: Structured logging with appropriate levels
logger.info('User authentication successful', {
  userId: user.id,
  email: user.email,
  loginMethod: 'password'
});

logger.warn('Rate limit approaching', {
  userId: user.id,
  currentRequests: 45,
  limit: 50
});

logger.error('Database connection failed', {
  error: error.message,
  connectionString: 'postgresql://...',
  retryAttempt: 3
});
```

2. **Include Contextual Metadata**
```typescript
// Include relevant context for debugging
logger.info('API request processed', {
  requestId: req.id,
  method: req.method,
  url: req.url,
  responseTime: Date.now() - startTime,
  statusCode: res.statusCode,
  userId: req.user?.id
});
```

### **Metrics Best Practices**

1. **Use Meaningful Metric Names**
```typescript
// Good metric naming convention
const metrics = [
  'http_request_duration_seconds',
  'database_query_count_total',
  'cache_hit_rate_percentage',
  'user_registration_count_daily'
];
```

2. **Include Relevant Tags**
```typescript
// Tag metrics for better analysis
await metricsService.record({
  name: 'http_request_duration',
  value: responseTime,
  tags: {
    method: 'GET',
    endpoint: '/api/users',
    statusCode: '200',
    userType: 'premium'
  }
});
```

### **Tracing Best Practices**

1. **Create Meaningful Spans**
```typescript
// Trace important operations
const trace = await tracingService.startTrace('user_registration');

const databaseSpan = trace.createSpan('validate_user_data');
// ... validation logic
databaseSpan.finish();

const emailSpan = trace.createSpan('send_welcome_email');
// ... email sending
emailSpan.finish();

trace.finish();
```

2. **Add Contextual Tags**
```typescript
span.setTags({
  'user.id': userId,
  'user.type': userType,
  'operation.type': 'database_query',
  'database.table': 'users'
});
```

### **WIQL Query Best Practices**

1. **Optimize Query Performance**
```sql
-- Good: Use specific fields and filters
SELECT [System.Id], [System.Title], [System.State]
FROM WorkItems 
WHERE [System.WorkItemType] = 'Bug' 
  AND [System.State] IN ('New', 'Active')
  AND [System.CreatedDate] >= '2024-01-01'
ORDER BY [System.CreatedDate] DESC

-- Avoid: SELECT * queries without filters
```

2. **Use Parameterized Queries**
```typescript
// Build queries safely
const query = `
  SELECT [System.Id], [System.Title] 
  FROM WorkItems 
  WHERE [System.AssignedTo] = '${sanitizeInput(assignee)}'
  AND [System.State] = '${sanitizeInput(state)}'
`;
```

---

## 🔧 Troubleshooting

### **Common Issues & Solutions**

#### **Database Connection Issues**

**Issue**: Database connection timeout
```bash
# Check database health
docker exec Atlas-postgres pg_isready -U postgres -d Atlas

# Restart database service
docker-compose restart postgres

# Check connection pool status
curl -X GET http://localhost:3000/health/database
```

#### **Service Unavailable**

**Issue**: Service returns `503 Service Unavailable`
```bash
# Check service health
curl -X GET http://localhost:3000/health

# Verify all services are running
docker-compose ps

# Check service logs
docker-compose logs Atlas-api
```

#### **Query Performance Issues**

**Issue**: Slow query responses
```bash
# Check query performance
curl -X GET http://localhost:3000/metrics/query \
  -d '{
    "metricName": "query_duration",
    "tags": {"service": "logs"}
  }'

# Enable query debugging
export DEBUG_QUERIES=true
docker-compose restart Atlas-api
```

### **Debug Mode Configuration**

```env
# Enable debug logging
LOG_LEVEL=debug
DEBUG=Atlas:*

# Enable query logging
DEBUG_QUERIES=true
SLOW_QUERY_THRESHOLD=1000

# Enable performance monitoring
PERFORMANCE_MONITORING=true
```

### **Health Check Endpoints**

```bash
# Overall system health
curl http://localhost:3000/health

# Database health
curl http://localhost:3000/health/database

# Redis health
curl http://localhost:3000/health/redis

# Service-specific health
curl http://localhost:3000/health/logs
curl http://localhost:3000/health/metrics
curl http://localhost:3000/health/traces
curl http://localhost:3000/health/wiql
```

---

## 📚 Additional Resources

### **API Documentation**
- **OpenAPI Spec**: `http://localhost:3000/docs`
- **Postman Collection**: Available in `/docs/postman/`
- **SDK Documentation**: `/docs/sdk/`

### **Community & Support**
- **GitHub Issues**: Report bugs and feature requests
- **Discord Community**: Real-time support and discussions
- **Documentation Wiki**: Extended guides and tutorials

### **Sample Applications**
- **Node.js Example**: `/examples/nodejs-client/`
- **Python Example**: `/examples/python-client/`
- **LangChain Integration**: `/examples/langchain-agent/`

This user guide provides everything needed to **effectively use Atlas** for **observability**, **monitoring**, and **AI agent integration** across all supported protocols and services.