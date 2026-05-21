# Fredo - Test Cases

## 🧪 Comprehensive Test Case Documentation

This document outlines **specific test cases** for all **Fredo services**, ensuring complete coverage of **MCP tools** and **REST endpoints**.

## 📋 Test Case Categories

### **🟢 Unit Tests**
- **BaseService Tests**
- **BaseTool Tests** 
- **Repository Tests**
- **Model Tests**
- **Controller Tests**

### **🟡 Integration Tests**
- **Service Integration Tests**
- **Database Integration Tests**
- **MCP Registration Tests**
- **Route Registration Tests**

### **🔴 End-to-End Tests**
- **REST API Workflow Tests**
- **MCP Tool Execution Tests**
- **Cross-Service Tests**
- **Docker Environment Tests**

---

## 🚀 **BaseService Test Cases**

### **TC-BASE-001: BaseService Abstract Class**
```typescript
describe('BaseService Abstract Class', () => {
  it('should enforce required properties', () => {
    // Verify abstract class cannot be instantiated directly
    expect(() => new BaseService()).toThrow();
  });

  it('should require subclasses to implement abstract methods', () => {
    class TestService extends BaseService {
      // Missing implementation should cause TypeScript error
    }
    // Verify compilation fails without required methods
  });
});
```

### **TC-BASE-002: Service Initialization**
```typescript
describe('Service Initialization', () => {
  it('should initialize repository during init()', async () => {
    const service = new LogsService(mockRepository);
    await service.init();
    
    expect(service.repository.init).toHaveBeenCalled();
    expect(service.isInitialized).toBe(true);
  });

  it('should handle initialization errors gracefully', async () => {
    const service = new LogsService(failingRepository);
    
    await expect(service.init()).rejects.toThrow('Repository initialization failed');
    expect(service.isInitialized).toBe(false);
  });
});
```

### **TC-BASE-003: Route Registration**
```typescript
describe('Route Registration', () => {
  it('should register all service routes', async () => {
    const fastify = createTestServer();
    const service = new LogsService(mockRepository);
    
    await service.registerRoutes(fastify);
    
    const routes = fastify.printRoutes();
    expect(routes).toContain('POST /logs/query');
    expect(routes).toContain('POST /logs/create');
    expect(routes).toContain('GET /logs/health');
  });
});
```

---

## 🛠️ **BaseTool Test Cases**

### **TC-TOOL-001: BaseTool Abstract Class**
```typescript
describe('BaseTool Abstract Class', () => {
  it('should enforce required properties', () => {
    const tool = new LogQueryTool(mockService);
    
    expect(tool.name).toBeDefined();
    expect(tool.description).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('should validate input parameters', async () => {
    const tool = new LogQueryTool(mockService);
    const invalidInput = { invalid: 'data' };
    
    await expect(tool.execute(invalidInput as any))
      .rejects.toThrow('Input validation failed');
  });
});
```

### **TC-TOOL-002: MCP Tool Registration**
```typescript
describe('MCP Tool Registration', () => {
  it('should register with LangChain SDK', () => {
    const toolRegistry = new ToolRegistry();
    const tool = new LogQueryTool(mockService);
    
    toolRegistry.register(tool);
    
    const registeredTool = toolRegistry.getTool('logQuery');
    expect(registeredTool).toBe(tool);
  });

  it('should provide correct tool schema', () => {
    const tool = new LogQueryTool(mockService);
    const schema = tool.getSchema();
    
    expect(schema.name).toBe('logQuery');
    expect(schema.description).toContain('Query log entries');
    expect(schema.parameters).toBeDefined();
  });
});
```

---

## 📊 **Logs Service Test Cases**

### **TC-LOGS-001: Log Query Tool**
```typescript
describe('LogQueryTool', () => {
  let tool: LogQueryTool;
  let mockService: jest.Mocked<LogsService>;

  beforeEach(() => {
    mockService = createMockLogsService();
    tool = new LogQueryTool(mockService);
  });

  it('should query logs by level', async () => {
    const input: LogQueryInput = {
      level: 'error',
      limit: 10
    };

    mockService.queryLogs.mockResolvedValue({
      logs: [
        { id: '1', level: 'error', message: 'Test error', timestamp: new Date() },
        { id: '2', level: 'error', message: 'Another error', timestamp: new Date() }
      ],
      total: 2
    });

    const result = await tool.execute(input);

    expect(result.logs).toHaveLength(2);
    expect(result.logs[0].level).toBe('error');
    expect(mockService.queryLogs).toHaveBeenCalledWith(input);
  });

  it('should query logs by time range', async () => {
    const input: LogQueryInput = {
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-02T00:00:00Z',
      limit: 50
    };

    const result = await tool.execute(input);

    expect(mockService.queryLogs).toHaveBeenCalledWith({
      startTime: new Date('2024-01-01T00:00:00Z'),
      endTime: new Date('2024-01-02T00:00:00Z'),
      limit: 50
    });
  });

  it('should handle empty query results', async () => {
    mockService.queryLogs.mockResolvedValue({ logs: [], total: 0 });

    const result = await tool.execute({ limit: 10 });

    expect(result.logs).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
```

### **TC-LOGS-002: Log Creation Tool**
```typescript
describe('LogCreateTool', () => {
  it('should create single log entry', async () => {
    const input: LogCreateInput = {
      level: 'info',
      message: 'Test log message',
      metadata: { source: 'test' }
    };

    const result = await tool.execute(input);

    expect(result.success).toBe(true);
    expect(result.logId).toBeDefined();
    expect(mockService.createLog).toHaveBeenCalledWith(input);
  });

  it('should create multiple log entries', async () => {
    const input: LogBatchCreateInput = {
      logs: [
        { level: 'info', message: 'Log 1' },
        { level: 'warn', message: 'Log 2' },
        { level: 'error', message: 'Log 3' }
      ]
    };

    const result = await tool.execute(input);

    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(3);
    expect(mockService.createLogBatch).toHaveBeenCalledWith(input.logs);
  });
});
```

### **TC-LOGS-003: REST API Endpoints**
```typescript
describe('Logs REST API', () => {
  it('POST /logs/query should return filtered logs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs/query',
      payload: {
        level: 'error',
        limit: 5
      }
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.payload);
    expect(result).toHaveProperty('logs');
    expect(result).toHaveProperty('total');
  });

  it('POST /logs/create should create new log', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs/create',
      payload: {
        level: 'info',
        message: 'Test log via REST'
      }
    });

    expect(response.statusCode).toBe(201);
    const result = JSON.parse(response.payload);
    expect(result.success).toBe(true);
    expect(result.logId).toBeDefined();
  });
});
```

---

## 📈 **Metrics Service Test Cases**

### **TC-METRICS-001: Metrics Query Tool**
```typescript
describe('MetricsQueryTool', () => {
  it('should query metrics by name', async () => {
    const input: MetricsQueryInput = {
      metricName: 'response_time',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-02T00:00:00Z'
    };

    const result = await tool.execute(input);

    expect(result.metrics).toBeDefined();
    expect(result.metrics[0].name).toBe('response_time');
  });

  it('should aggregate metrics by time period', async () => {
    const input: MetricsQueryInput = {
      metricName: 'request_count',
      aggregation: 'sum',
      granularity: '1h'
    };

    const result = await tool.execute(input);

    expect(result.aggregatedData).toBeDefined();
    expect(result.granularity).toBe('1h');
  });
});
```

### **TC-METRICS-002: Metrics Creation Tool**
```typescript
describe('MetricsCreateTool', () => {
  it('should record single metric', async () => {
    const input: MetricCreateInput = {
      name: 'api_response_time',
      value: 150,
      unit: 'milliseconds',
      tags: { endpoint: '/logs/query' }
    };

    const result = await tool.execute(input);

    expect(result.success).toBe(true);
    expect(result.metricId).toBeDefined();
  });

  it('should record metric batch', async () => {
    const input: MetricBatchCreateInput = {
      metrics: [
        { name: 'requests', value: 1, timestamp: new Date() },
        { name: 'errors', value: 0, timestamp: new Date() }
      ]
    };

    const result = await tool.execute(input);

    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(2);
  });
});
```

---

## 🔍 **Traces Service Test Cases**

### **TC-TRACES-001: Trace Query Tool**
```typescript
describe('TraceQueryTool', () => {
  it('should query traces by service', async () => {
    const input: TraceQueryInput = {
      serviceName: 'logs-service',
      operation: 'queryLogs',
      startTime: '2024-01-01T00:00:00Z'
    };

    const result = await tool.execute(input);

    expect(result.traces).toBeDefined();
    expect(result.traces[0].serviceName).toBe('logs-service');
  });

  it('should query traces by duration', async () => {
    const input: TraceQueryInput = {
      minDuration: 1000, // 1 second
      maxDuration: 5000  // 5 seconds
    };

    const result = await tool.execute(input);

    result.traces.forEach(trace => {
      expect(trace.duration).toBeGreaterThanOrEqual(1000);
      expect(trace.duration).toBeLessThanOrEqual(5000);
    });
  });
});
```

### **TC-TRACES-002: Trace Creation Tool**
```typescript
describe('TraceCreateTool', () => {
  it('should create trace with spans', async () => {
    const input: TraceCreateInput = {
      traceId: 'trace-123',
      serviceName: 'logs-service',
      operation: 'queryLogs',
      spans: [
        {
          spanId: 'span-1',
          operation: 'database_query',
          startTime: new Date(),
          duration: 150
        }
      ]
    };

    const result = await tool.execute(input);

    expect(result.success).toBe(true);
    expect(result.traceId).toBe('trace-123');
  });
});
```

---

## 🔗 **Azure DevOps WIQL Service Test Cases**

### **TC-WIQL-001: WIQL Query Tool**
```typescript
describe('WIQLQueryTool', () => {
  it('should execute WIQL query', async () => {
    const input: WIQLQueryInput = {
      query: `SELECT [System.Id], [System.Title] 
               FROM WorkItems 
               WHERE [System.WorkItemType] = 'Bug'`,
      project: 'MyProject'
    };

    const result = await tool.execute(input);

    expect(result.workItems).toBeDefined();
    expect(result.workItems.length).toBeGreaterThan(0);
    expect(result.workItems[0]).toHaveProperty('id');
    expect(result.workItems[0]).toHaveProperty('title');
  });

  it('should handle WIQL syntax errors', async () => {
    const input: WIQLQueryInput = {
      query: 'INVALID WIQL SYNTAX',
      project: 'MyProject'
    };

    await expect(tool.execute(input))
      .rejects.toThrow('Invalid WIQL query syntax');
  });

  it('should apply query limits', async () => {
    const input: WIQLQueryInput = {
      query: 'SELECT * FROM WorkItems',
      project: 'MyProject',
      top: 10
    };

    const result = await tool.execute(input);

    expect(result.workItems.length).toBeLessThanOrEqual(10);
  });
});
```

### **TC-WIQL-002: Work Item Update Tool**
```typescript
describe('WorkItemUpdateTool', () => {
  it('should update work item fields', async () => {
    const input: WorkItemUpdateInput = {
      workItemId: 12345,
      fields: {
        'System.Title': 'Updated Bug Title',
        'System.State': 'In Progress'
      }
    };

    const result = await tool.execute(input);

    expect(result.success).toBe(true);
    expect(result.workItemId).toBe(12345);
    expect(result.updatedFields).toHaveProperty('System.Title');
  });
});
```

---

## 🔄 **Integration Test Cases**

### **TC-INT-001: Cross-Service Communication**
```typescript
describe('Cross-Service Integration', () => {
  it('should trace requests across services', async () => {
    // Create a log entry
    const logResult = await logCreateTool.execute({
      level: 'info',
      message: 'Integration test log'
    });

    // Verify trace was created
    const traceResult = await traceQueryTool.execute({
      operation: 'createLog',
      limit: 1
    });

    expect(traceResult.traces).toHaveLength(1);
    expect(traceResult.traces[0].metadata).toContain(logResult.logId);
  });

  it('should record metrics for all operations', async () => {
    // Execute multiple operations
    await Promise.all([
      logQueryTool.execute({ limit: 10 }),
      metricsQueryTool.execute({ metricName: 'test' }),
      traceQueryTool.execute({ limit: 5 })
    ]);

    // Verify metrics were recorded
    const metricsResult = await metricsQueryTool.execute({
      metricName: 'operation_count',
      startTime: new Date(Date.now() - 60000).toISOString()
    });

    expect(metricsResult.metrics.length).toBeGreaterThan(0);
  });
});
```

### **TC-INT-002: Database Integration**
```typescript
describe('Database Integration', () => {
  it('should handle concurrent operations', async () => {
    const operations = Array(50).fill(0).map(() =>
      logCreateTool.execute({
        level: 'info',
        message: `Concurrent test ${Math.random()}`
      })
    );

    const results = await Promise.all(operations);

    // All operations should succeed
    results.forEach(result => {
      expect(result.success).toBe(true);
    });

    // Verify all logs were created
    const queryResult = await logQueryTool.execute({
      level: 'info',
      limit: 100
    });

    expect(queryResult.total).toBeGreaterThanOrEqual(50);
  });
});
```

---

## 🎯 **End-to-End Test Cases**

### **TC-E2E-001: Complete Workflow via REST**
```typescript
describe('Complete REST API Workflow', () => {
  it('should execute full observability workflow', async () => {
    // 1. Create logs
    const logResponse = await app.inject({
      method: 'POST',
      url: '/logs/create',
      payload: { level: 'error', message: 'E2E test error' }
    });
    expect(logResponse.statusCode).toBe(201);

    // 2. Record metrics
    const metricResponse = await app.inject({
      method: 'POST',
      url: '/metrics/create',
      payload: { name: 'test_metric', value: 1 }
    });
    expect(metricResponse.statusCode).toBe(201);

    // 3. Query traces
    const traceResponse = await app.inject({
      method: 'POST',
      url: '/traces/query',
      payload: { operation: 'createLog' }
    });
    expect(traceResponse.statusCode).toBe(200);

    // 4. Verify all data is connected
    const traceData = JSON.parse(traceResponse.payload);
    expect(traceData.traces.length).toBeGreaterThan(0);
  });
});
```

### **TC-E2E-002: MCP Tool Execution via LangChain**
```typescript
describe('MCP Tool Execution', () => {
  it('should execute tools through LangChain SDK', async () => {
    const langChain = new LangChain({
      tools: [logQueryTool, metricsQueryTool, traceQueryTool, wiqlQueryTool]
    });

    const prompt = `
      Query the logs for any errors in the last hour,
      then get metrics for error rates,
      and finally trace any related operations.
    `;

    const result = await langChain.run(prompt);

    expect(result).toContain('logs');
    expect(result).toContain('metrics');
    expect(result).toContain('traces');
  });
});
```

### **TC-E2E-003: Docker Environment**
```typescript
describe('Docker Environment E2E', () => {
  it('should start and connect all services', async () => {
    // Start services
    await execAsync('docker-compose -f docker-compose.dev.yml up -d');

    // Wait for health checks
    await waitForService('http://localhost:3000/health', 30000);
    await waitForService('postgresql://localhost:5432/Fredo', 30000);

    // Test service connectivity
    const healthResponse = await fetch('http://localhost:3000/health');
    const healthData = await healthResponse.json();

    expect(healthData.status).toBe('healthy');
    expect(healthData.services.database).toBe('connected');
    expect(healthData.services.logs).toBe('ready');
    expect(healthData.services.metrics).toBe('ready');
    expect(healthData.services.traces).toBe('ready');
    expect(healthData.services.wiql).toBe('ready');
  }, 60000);
});
```

---

## ✅ **Test Coverage Validation**

### **Coverage Requirements per Test Case**
- **Unit Tests**: 90%+ code coverage for business logic
- **Integration Tests**: 85%+ path coverage for service interactions  
- **E2E Tests**: 80%+ user workflow coverage

### **Quality Gates**
- All test cases must pass before deployment
- Performance benchmarks must meet SLA requirements
- Security test cases must validate input sanitization
- MCP and REST endpoints must have equivalent test coverage

This comprehensive test suite ensures **complete validation** of all **Fredo functionality** across **MCP tools** and **REST endpoints** with **high confidence** and **maintainability**.