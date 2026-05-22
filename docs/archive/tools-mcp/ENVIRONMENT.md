# Fredo - Environment Setup & Configuration

## 🚀 Quick Setup

### System Requirements

- **Docker Desktop**: Latest version with Docker Compose support
- **Git**: For version control and repository access
- **Optional**: Node.js 18+ (only if running outside Docker)

### Platform-Specific Setup

#### Windows (PowerShell)
```powershell
# Clone repository
git clone <repository-url>
cd Fredo

# Copy environment configuration
Copy-Item .env.example .env

# Start development environment
.\dev.ps1
```

#### Linux/macOS
```bash
# Clone repository  
git clone <repository-url>
cd Fredo

# Copy environment configuration
cp .env.example .env

# Start development environment
make dev
```

---

## 📋 Environment Configuration

### Environment Variables (.env)

```env
# Application Configuration
NODE_ENV=development
LOG_LEVEL=debug
PORT=3000
HOST=0.0.0.0

# Database Configuration (PostgreSQL for Observability Services)
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=Fredo
POSTGRES_USER=postgres
POSTGRES_PASSWORD=password
POSTGRES_SSL=false
POSTGRES_TIMEOUT=30000
POSTGRES_MAX_CONNECTIONS=20

# Azure DevOps Configuration (WIQL Service)
AZURE_DEVOPS_ORG=your-organization
AZURE_DEVOPS_PAT=your-personal-access-token
AZURE_DEVOPS_TIMEOUT=10000
AZURE_DEVOPS_API_VERSION=7.0

# Framework Configuration
SERVICE_DISCOVERY_ENABLED=true
HOT_RELOAD_ENABLED=true
AUTO_REGISTER_TOOLS=true
VALIDATE_TOOL_SCHEMAS=true

# Logging Configuration
LOG_FORMAT=json
LOG_TIMESTAMP=true
LOG_COLORS=true
DEBUG=FREDO:*
```

### Required vs Optional Variables

#### Required for Basic Functionality
```env
NODE_ENV=development
POSTGRES_HOST=postgres
POSTGRES_DB=Fredo
POSTGRES_USER=postgres
POSTGRES_PASSWORD=password
```

#### Optional with Defaults
```env
PORT=3000                    # Default: 3000
LOG_LEVEL=info              # Default: info
POSTGRES_PORT=5432          # Default: 5432
POSTGRES_SSL=false          # Default: false
```

#### Service-Specific (Optional)
```env
# Only required if using Azure DevOps WIQL service
AZURE_DEVOPS_ORG=myorg
AZURE_DEVOPS_PAT=token123
```

---

## 🐳 Docker Environment

### Development Environment

**File**: `docker/docker-compose.dev.yml`

```yaml
version: '3.8'

services:
  app:
    build:
      context: ..
      dockerfile: docker/Dockerfile.dev
    ports:
      - "3000:3000"
    volumes:
      - ../src:/app/src:cached
      - ../package.json:/app/package.json:cached
      - ../tsconfig.json:/app/tsconfig.json:cached
      - node_modules:/app/node_modules
    environment:
      - NODE_ENV=development
    env_file:
      - ../.env
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:15-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-Fredo}
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-password}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ../config/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-postgres}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  postgres_data:
  node_modules:
```

### Development Dockerfile

**File**: `docker/Dockerfile.dev`

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=development

# Install development tools
RUN npm install -g nodemon ts-node

# Copy source code (volume mounted for hot reload)
COPY src/ ./src/
COPY tsconfig.json ./

# Expose port
EXPOSE 3000

# Start with hot reload
CMD ["npm", "run", "dev"]
```

---

## ⚙️ Service Configuration

### Database Setup (PostgreSQL)

#### Connection Configuration
```typescript
interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  connectionTimeout: number;
  maxConnections: number;
}
```

#### Initial Schema Setup

**File**: `config/init.sql`

```sql
-- OpenTelemetry schema for observability data
CREATE SCHEMA IF NOT EXISTS observability;

-- Traces table
CREATE TABLE IF NOT EXISTS observability.traces (
  trace_id VARCHAR(32) PRIMARY KEY,
  service_name VARCHAR(255) NOT NULL,
  operation_name VARCHAR(255),
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  duration_ms INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL,
  attributes JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Spans table
CREATE TABLE IF NOT EXISTS observability.spans (
  span_id VARCHAR(16) PRIMARY KEY,
  trace_id VARCHAR(32) REFERENCES observability.traces(trace_id),
  parent_span_id VARCHAR(16),
  service_name VARCHAR(255) NOT NULL,
  operation_name VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  duration_ms INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL,
  attributes JSONB,
  events JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Metrics table
CREATE TABLE IF NOT EXISTS observability.metrics (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  labels JSONB,
  resource_attributes JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Logs table  
CREATE TABLE IF NOT EXISTS observability.logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  severity VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  service_name VARCHAR(255) NOT NULL,
  trace_id VARCHAR(32),
  span_id VARCHAR(16),
  attributes JSONB,
  resource_attributes JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_traces_service_time ON observability.traces(service_name, start_time);
CREATE INDEX IF NOT EXISTS idx_traces_duration ON observability.traces(duration_ms);
CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON observability.spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_service_time ON observability.spans(service_name, start_time);
CREATE INDEX IF NOT EXISTS idx_metrics_name_time ON observability.metrics(name, timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_service_time ON observability.logs(service_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_severity_time ON observability.logs(severity, timestamp);
```

### Azure DevOps Configuration

#### Authentication Setup
1. **Generate Personal Access Token (PAT)**:
   - Go to Azure DevOps → User Settings → Personal Access Tokens
   - Create token with "Work Items (Read)" permissions
   - Copy token to `AZURE_DEVOPS_PAT` environment variable

2. **Organization Configuration**:
   ```env
   AZURE_DEVOPS_ORG=mycompany
   # Results in API calls to: https://dev.azure.com/mycompany/
   ```

#### API Configuration
```typescript
interface AzureDevOpsConfig {
  organization: string;
  personalAccessToken: string;
  apiVersion: string;
  timeout: number;
  baseUrl: string;
}
```

---

## 🔧 Development Tools Configuration

### TypeScript Configuration

**File**: `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS", 
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitReturns": true,
    "noImplicitThis": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "removeComments": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "node_modules",
    "dist",
    "tests"
  ]
}
```

### Hot Reload Configuration

**File**: `nodemon.json`

```json
{
  "watch": ["src"],
  "ext": "ts,js,json",
  "ignore": [
    "src/**/*.test.ts",
    "src/**/*.spec.ts",
    "node_modules/**/*",
    "dist/**/*"
  ],
  "exec": "ts-node src/index.ts",
  "env": {
    "NODE_ENV": "development"
  },
  "delay": 1000
}
```

---

## 🐛 Troubleshooting

### Common Setup Issues

#### Docker Issues
```bash
# Docker Desktop not running
docker --version
# Should return version, not "command not found"

# Port already in use
docker-compose -f docker/docker-compose.dev.yml down
netstat -tulpn | grep :3000

# Clear Docker cache
docker system prune -a
```

#### Database Connection Issues
```bash
# Check PostgreSQL container status
docker-compose -f docker/docker-compose.dev.yml ps postgres

# Test database connection
docker-compose -f docker/docker-compose.dev.yml exec postgres \
  psql -U postgres -d Fredo -c "SELECT version();"

# Check database logs
docker-compose -f docker/docker-compose.dev.yml logs postgres
```

#### Environment Variable Issues
```bash
# Verify .env file exists and has content
cat .env | grep -v '^#' | grep -v '^$'

# Check if variables are loaded in container
docker-compose -f docker/docker-compose.dev.yml exec app printenv | grep POSTGRES
```

### Environment Validation Script

**File**: `scripts/validate-env.js`

```javascript
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const requiredVars = [
  'POSTGRES_HOST',
  'POSTGRES_DB', 
  'POSTGRES_USER',
  'POSTGRES_PASSWORD'
];

const optionalVars = [
  'AZURE_DEVOPS_ORG',
  'AZURE_DEVOPS_PAT'
];

console.log('🔍 Validating Fredo Environment Configuration...\n');

// Check .env file exists
if (!fs.existsSync('.env')) {
  console.error('❌ .env file not found. Copy from .env.example');
  process.exit(1);
}

// Load environment variables
require('dotenv').config();

let hasErrors = false;

// Check required variables
console.log('📋 Required Variables:');
requiredVars.forEach(varName => {
  const value = process.env[varName];
  if (!value) {
    console.log(`  ❌ ${varName}: Missing`);
    hasErrors = true;
  } else {
    console.log(`  ✅ ${varName}: Set`);
  }
});

// Check optional variables
console.log('\n🔧 Optional Variables:');
optionalVars.forEach(varName => {
  const value = process.env[varName];
  if (!value) {
    console.log(`  ⚠️  ${varName}: Not set (service may be unavailable)`);
  } else {
    console.log(`  ✅ ${varName}: Set`);
  }
});

if (hasErrors) {
  console.log('\n❌ Environment validation failed. Check .env file.');
  process.exit(1);
} else {
  console.log('\n✅ Environment validation passed!');
}
```

---

## 📊 Performance Configuration

### Database Performance Tuning

```sql
-- PostgreSQL performance settings for development
-- Add to config/postgresql.conf or environment variables

-- Connection settings
max_connections = 100
shared_buffers = 256MB
effective_cache_size = 1GB

-- Query performance  
work_mem = 4MB
maintenance_work_mem = 64MB

-- Logging for development
log_statement = 'all'
log_duration = on
log_min_duration_statement = 1000
```

### Application Performance Settings

```env
# Memory and performance settings
NODE_MAX_OLD_SPACE_SIZE=4096
UV_THREADPOOL_SIZE=16

# Database connection pooling
POSTGRES_MAX_CONNECTIONS=20
POSTGRES_MIN_CONNECTIONS=2
POSTGRES_ACQUIRE_TIMEOUT=30000
POSTGRES_IDLE_TIMEOUT=30000

# HTTP settings
HTTP_TIMEOUT=30000
HTTP_MAX_SOCKETS=50
```

This environment configuration provides everything needed to get Fredo running efficiently in development, with clear troubleshooting guidance and performance optimization options.