# Fredo - Test Strategy

## 🧪 Testing Philosophy

Fredo follows a **comprehensive testing strategy** ensuring both **MCP tools** and **REST endpoints** work correctly with high confidence and maintainability.

## 📋 Test Pyramid Structure

### **1. Unit Tests (70%)**
- **Scope**: Individual functions, classes, and methods
- **Framework**: Jest with TypeScript support
- **Coverage Target**: 85%+ code coverage
- **Focus Areas**:
  - BaseTool implementations
  - BaseService business logic
  - Repository methods
  - Utility functions
  - Model validation

### **2. Integration Tests (20%)**
- **Scope**: Service interactions and database operations
- **Framework**: Jest with test database
- **Focus Areas**:
  - PostgreSQL repository operations
  - Azure DevOps API integration
  - Service-to-service communication
  - MCP tool registration
  - Route registration

### **3. End-to-End Tests (10%)**
- **Scope**: Complete user workflows
- **Framework**: Jest with Docker containers
- **Focus Areas**:
  - REST API endpoints
  - MCP tool execution via LangChain SDK
  - Database migrations
  - Docker environment setup
  - Multi-service workflows

## 🛠️ Testing Framework Setup

### **Jest Configuration**
```javascript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 85,
      lines: 85,
      statements: 85
    }
  }
};
```

### **Test Database Setup**
- **Separate Test DB**: `Fredo_test` database for isolation
- **Docker Container**: Test-specific PostgreSQL instance
- **Migration Testing**: Verify schema changes work correctly
- **Seed Data**: Controlled test data sets

## 🔧 Unit Testing Strategy

### **BaseService Testing**
```typescript
// /src/services/logs/tests/logsService.test.ts
describe('LogsService', () => {
  let service: LogsService;
  let mockRepository: jest.Mocked<LogsRepository>;

  beforeEach(() => {
    mockRepository = createMockRepository();
    service = new LogsService(mockRepository);
  });

  describe('init()', () => {
    it('should initialize repository connection', async () => {
      await service.init();
      expect(mockRepository.init).toHaveBeenCalled();
    });
  });

  describe('queryLogs()', () => {
    it('should return filtered logs', async () => {
      // Test business logic isolation
    });
  });
});
```

### **BaseTool Testing**
```typescript
// /src/services/logs/tools/tests/logQueryTool.test.ts
describe('LogQueryTool', () => {
  let tool: LogQueryTool;
  let mockService: jest.Mocked<LogsService>;

  beforeEach(() => {
    mockService = createMockService();
    tool = new LogQueryTool(mockService);
  });

  describe('execute()', () => {
    it('should validate input and return results', async () => {
      const input: LogQueryInput = {
        level: 'error',
        startTime: new Date().toISOString()
      };
      
      const result = await tool.execute(input);
      
      expect(result).toBeDefined();
      expect(mockService.queryLogs).toHaveBeenCalledWith(input);
    });

    it('should handle invalid input', async () => {
      const invalidInput = { invalid: 'data' };
      
      await expect(tool.execute(invalidInput as any))
        .rejects.toThrow('Validation failed');
    });
  });
});
```

### **Repository Testing**
```typescript
// /src/services/logs/tests/logsRepository.test.ts
describe('LogsRepository', () => {
  let repository: LogsRepository;
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await setupTestDatabase();
    repository = new LogsRepository(testDb.connection);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  describe('queryLogs()', () => {
    it('should return logs matching criteria', async () => {
      // Insert test data
      await testDb.seedLogs();
      
      const result = await repository.queryLogs({
        level: 'error',
        limit: 10
      });
      
      expect(result).toHaveLength(5); // Expected error logs
      expect(result[0].level).toBe('error');
    });
  });
});
```

## 🔗 Integration Testing Strategy

### **Database Integration**
```typescript
// /tests/integration/database.test.ts
describe('Database Integration', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it('should handle concurrent log insertions', async () => {
    const promises = Array(100).fill(0).map(() => 
      logsRepository.createLog(generateTestLog())
    );
    
    await Promise.all(promises);
    
    const count = await logsRepository.count();
    expect(count).toBe(100);
  });
});
```

### **MCP Tool Integration**
```typescript
// /tests/integration/mcp.test.ts
describe('MCP Tool Integration', () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
  });

  it('should register all tools automatically', async () => {
    await toolRegistry.loadTools();
    
    const tools = toolRegistry.getTools();
    expect(tools).toContain('logQuery');
    expect(tools).toContain('metricsQuery');
    expect(tools).toContain('traceQuery');
    expect(tools).toContain('wiqlQuery');
  });

  it('should execute tools via LangChain SDK', async () => {
    const tool = toolRegistry.getTool('logQuery');
    const result = await tool.execute({
      level: 'error',
      limit: 5
    });
    
    expect(result).toHaveProperty('logs');
    expect(result.logs).toBeInstanceOf(Array);
  });
});
```

## 🎯 End-to-End Testing Strategy

### **REST API E2E Tests**
```typescript
// /tests/e2e/rest-api.test.ts
describe('REST API E2E', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  it('should query logs via REST endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logs/query',
      payload: {
        level: 'error',
        startTime: new Date().toISOString()
      }
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.payload);
    expect(result).toHaveProperty('logs');
  });
});
```

### **Docker Environment E2E**
```typescript
// /tests/e2e/docker.test.ts
describe('Docker Environment E2E', () => {
  it('should start all services successfully', async () => {
    // Test docker-compose.dev.yml startup
    await execAsync('docker-compose -f docker-compose.dev.yml up -d');
    
    // Wait for services to be ready
    await waitForHealthCheck('http://localhost:3000/health');
    
    // Test service availability
    const response = await fetch('http://localhost:3000/health');
    expect(response.status).toBe(200);
  }, 30000);
});
```

## 🏃‍♂️ Test Execution Strategy

### **Development Testing**
```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch

# Run specific test suite
npm test -- --testPathPattern=logs

# Run integration tests only
npm run test:integration
```

### **CI/CD Testing Pipeline**
```yaml
# Example GitHub Actions workflow
- name: Run Unit Tests
  run: npm run test:unit

- name: Run Integration Tests
  run: |
    docker-compose -f docker-compose.test.yml up -d
    npm run test:integration
    docker-compose -f docker-compose.test.yml down

- name: Run E2E Tests
  run: npm run test:e2e

- name: Check Coverage
  run: npm run test:coverage
```

## 📊 Test Data Management

### **Test Data Strategy**
- **Fixtures**: Predefined test data sets in JSON files
- **Factories**: Dynamic test data generation with realistic values
- **Cleanup**: Automatic test data cleanup after each test suite
- **Isolation**: Each test runs with fresh data

### **Mock Strategy**
- **External APIs**: Mock Azure DevOps API responses
- **Database**: Use test database, not mocks for repository tests
- **Services**: Mock service dependencies in unit tests
- **Time**: Mock dates/timestamps for consistent testing

## ✅ Test Coverage Requirements

### **Coverage Targets by Component**
| Component | Unit Tests | Integration Tests | E2E Tests |
|-----------|------------|-------------------|-----------|
| BaseService | 90%+ | 80%+ | - |
| BaseTool | 90%+ | 80%+ | - |
| Repositories | 85%+ | 90%+ | - |
| Controllers | 80%+ | 85%+ | 70%+ |
| Routes | 70%+ | 80%+ | 85%+ |
| Tools | 90%+ | 85%+ | 80%+ |

### **Quality Gates**
- **PR Requirements**: All tests must pass + 85%+ coverage
- **Deployment Gates**: E2E tests must pass in staging environment
- **Performance Gates**: Response time tests for all endpoints
- **Security Gates**: Input validation and sanitization tests

## 🔍 Testing Best Practices

### **Test Organization**
- **Co-location**: Tests live near the code they test
- **Naming**: Clear, descriptive test names explaining the scenario
- **AAA Pattern**: Arrange, Act, Assert structure
- **DRY Principle**: Reusable test utilities and helpers

### **MCP-Specific Testing**
- **Tool Registration**: Verify tools are properly registered with LangChain SDK
- **Input/Output Validation**: Test TypeScript interface compliance
- **Error Handling**: Consistent error responses across MCP and REST
- **Performance**: Tool execution time benchmarks

### **Database Testing**
- **Transaction Isolation**: Each test runs in a transaction that's rolled back
- **Migration Testing**: Test all migration scripts up and down
- **Performance Testing**: Query performance with realistic data volumes
- **Connection Management**: Test connection pooling and timeout scenarios

This testing strategy ensures **high confidence** in both **MCP and REST** functionality while maintaining **fast feedback loops** and **comprehensive coverage**.