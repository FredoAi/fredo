# Fredo - Deployment Guide

## 🚀 Deployment Strategy

Fredo supports **multiple deployment environments** with **Docker-based containerization** for both **development** and **production** scenarios.

## 📦 Deployment Options

### **1. Development Environment**
- **Docker Compose**: Full local development stack
- **Hot Reload**: Automatic code reloading for development
- **Debug Mode**: Enhanced logging and debugging capabilities
- **Test Database**: Isolated PostgreSQL instance for testing

### **2. Production Environment**
- **Docker Swarm**: Multi-node orchestration
- **Kubernetes**: Enterprise-grade container orchestration
- **Cloud Platforms**: Azure Container Instances, AWS ECS, GCP Cloud Run
- **Load Balancing**: High availability and scalability

### **3. Hybrid Environment**
- **Local Development**: MCP tools with external databases
- **Cloud Services**: Production databases with local development
- **CI/CD Integration**: Automated deployment pipelines

## 🛠️ Development Deployment

### **Quick Start with Docker Compose**
```bash
# Clone repository
git clone <repository-url>
cd Fredo

# Run development setup script
./scripts/setup-dev.sh
# or on Windows
./scripts/setup-dev.ps1

# Start development environment
docker-compose -f docker-compose.dev.yml up -d

# Verify services are running
curl http://localhost:3000/health
```

### **Development Docker Compose Configuration**
```yaml
# docker-compose.dev.yml
version: '3.8'

services:
  Fredo-api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://postgres:password@postgres:5432/Fredo_dev
      - AZURE_DEVOPS_URL=${AZURE_DEVOPS_URL}
      - AZURE_DEVOPS_TOKEN=${AZURE_DEVOPS_TOKEN}
    volumes:
      - ./src:/app/src:ro
      - ./package.json:/app/package.json:ro
      - /app/node_modules
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=Fredo_dev
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
    ports:
      - "5432:5432"
    volumes:
      - postgres_dev_data:/var/lib/postgresql/data
      - ./database/migrations:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d Fredo_dev"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_dev_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  postgres_dev_data:
  redis_dev_data:

networks:
  default:
    name: Fredo-dev
```

### **Development Dockerfile**
```dockerfile
# Dockerfile.dev
FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Install development dependencies for hot reload
RUN npm ci && npm cache clean --force

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# Start with hot reload in development
CMD ["npm", "run", "dev"]
```

---

## 🏭 Production Deployment

### **Production Docker Compose**
```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  Fredo-api:
    build:
      context: .
      dockerfile: Dockerfile.prod
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      - AZURE_DEVOPS_URL=${AZURE_DEVOPS_URL}
      - AZURE_DEVOPS_TOKEN=${AZURE_DEVOPS_TOKEN}
      - JWT_SECRET=${JWT_SECRET}
      - LOG_LEVEL=info
    restart: unless-stopped
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
        failure_action: rollback
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
    depends_on:
      - Fredo-api
    restart: unless-stopped

  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=${POSTGRES_DB}
      - POSTGRES_USER=${POSTGRES_USER}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres_prod_data:/var/lib/postgresql/data
      - ./database/migrations:/docker-entrypoint-initdb.d:ro
    restart: unless-stopped
    deploy:
      placement:
        constraints:
          - node.labels.postgres == true

  redis:
    image: redis:7-alpine
    volumes:
      - redis_prod_data:/data
    restart: unless-stopped
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}

volumes:
  postgres_prod_data:
    driver: local
  redis_prod_data:
    driver: local
```

### **Production Dockerfile**
```dockerfile
# Dockerfile.prod
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-alpine AS production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S Fredo -u 1001

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/database ./database

# Change ownership
RUN chown -R FREDO:nodejs /app
USER Fredo

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# Start application
CMD ["node", "dist/index.js"]
```

---

## ☸️ Kubernetes Deployment

### **Kubernetes Manifests**
```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: Fredo

---
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: Fredo-api
  namespace: Fredo
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  selector:
    matchLabels:
      app: Fredo-api
  template:
    metadata:
      labels:
        app: Fredo-api
    spec:
      containers:
      - name: Fredo-api
        image: FREDO:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: Fredo-secrets
              key: database-url
        - name: AZURE_DEVOPS_TOKEN
          valueFrom:
            secretKeyRef:
              name: Fredo-secrets
              key: azure-devops-token
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5

---
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: Fredo-service
  namespace: Fredo
spec:
  selector:
    app: Fredo-api
  ports:
  - port: 80
    targetPort: 3000
    protocol: TCP
  type: LoadBalancer

---
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: Fredo-ingress
  namespace: Fredo
  annotations:
    kubernetes.io/ingress.class: "nginx"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
  - hosts:
    - api.FREDO.com
    secretName: Fredo-tls
  rules:
  - host: api.FREDO.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: Fredo-service
            port:
              number: 80
```

### **Kubernetes Configuration**
```yaml
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: Fredo-config
  namespace: Fredo
data:
  NODE_ENV: "production"
  LOG_LEVEL: "info"
  PORT: "3000"

---
# k8s/secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: Fredo-secrets
  namespace: Fredo
type: Opaque
stringData:
  database-url: "postgresql://user:password@postgres:5432/Fredo"
  redis-url: "redis://redis:6379"
  azure-devops-token: "your-azure-devops-token"
  jwt-secret: "your-jwt-secret"
```

---

## 🌐 Cloud Platform Deployment

### **Azure Container Instances**
```bash
# Create resource group
az group create --name Fredo-rg --location eastus

# Create container registry
az acr create --resource-group Fredo-rg --name FREDOregistry --sku Basic

# Build and push image
az acr build --registry FREDOregistry --image FREDO:latest .

# Deploy container instance
az container create \
  --resource-group Fredo-rg \
  --name Fredo-api \
  --image FREDOregistry.azurecr.io/FREDO:latest \
  --cpu 2 \
  --memory 4 \
  --ports 3000 \
  --environment-variables \
    NODE_ENV=production \
    DATABASE_URL="postgresql://..." \
  --secure-environment-variables \
    AZURE_DEVOPS_TOKEN="..." \
  --restart-policy OnFailure
```

### **AWS ECS Deployment**
```json
{
  "family": "Fredo-task",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::account:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "Fredo-api",
      "image": "your-account.dkr.ecr.region.amazonaws.com/FREDO:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:FREDO/database-url"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/Fredo",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

---

## 🔒 Security Considerations

### **Production Security Checklist**
- [ ] **Environment Variables**: Store sensitive data in secure secret management
- [ ] **SSL/TLS**: Enable HTTPS with valid certificates
- [ ] **Authentication**: Implement JWT-based authentication for REST APIs
- [ ] **Authorization**: Role-based access control for MCP tools
- [ ] **Input Validation**: Sanitize all user inputs
- [ ] **Rate Limiting**: Implement API rate limiting
- [ ] **CORS**: Configure proper CORS policies
- [ ] **Logging**: Sanitize logs to prevent information leakage

### **Network Security**
```nginx
# nginx/nginx.conf
server {
    listen 443 ssl http2;
    server_name api.FREDO.com;
    
    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";
    
    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req zone=api burst=20 nodelay;
    
    location / {
        proxy_pass http://Fredo-api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 📊 Monitoring and Health Checks

### **Health Check Endpoints**
```typescript
// src/health/healthCheck.ts
export class HealthCheck {
  async checkDatabase(): Promise<boolean> {
    try {
      await this.database.query('SELECT 1');
      return true;
    } catch (error) {
      return false;
    }
  }

  async checkRedis(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  async getHealthStatus() {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: await this.checkDatabase(),
        redis: await this.checkRedis(),
        logs: this.logsService.isHealthy(),
        metrics: this.metricsService.isHealthy(),
        traces: this.tracesService.isHealthy(),
        wiql: this.wiqlService.isHealthy()
      }
    };
  }
}
```

### **Monitoring with Prometheus**
```yaml
# prometheus/prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'Fredo-api'
    static_configs:
      - targets: ['Fredo-api:3000']
    metrics_path: '/metrics'
    scrape_interval: 10s
```

---

## 🚀 Deployment Scripts

### **Deployment Automation**
```bash
#!/bin/bash
# scripts/deploy.sh

set -e

ENV=${1:-production}
VERSION=${2:-latest}

echo "Deploying Fredo $VERSION to $ENV environment..."

# Build and tag image
docker build -t FREDO:$VERSION -f Dockerfile.prod .

# Run tests
echo "Running tests..."
npm test

# Tag for registry
docker tag FREDO:$VERSION $REGISTRY/FREDO:$VERSION

# Push to registry
docker push $REGISTRY/FREDO:$VERSION

# Deploy based on environment
case $ENV in
  "development")
    docker-compose -f docker-compose.dev.yml up -d
    ;;
  "production")
    docker-compose -f docker-compose.prod.yml up -d
    ;;
  "k8s")
    kubectl set image deployment/Fredo-api Fredo-api=$REGISTRY/FREDO:$VERSION -n Fredo
    kubectl rollout status deployment/Fredo-api -n Fredo
    ;;
esac

echo "Deployment completed successfully!"
```

### **Rollback Strategy**
```bash
#!/bin/bash
# scripts/rollback.sh

PREVIOUS_VERSION=${1:-latest}
ENV=${2:-production}

echo "Rolling back to version $PREVIOUS_VERSION in $ENV..."

case $ENV in
  "k8s")
    kubectl rollout undo deployment/Fredo-api -n Fredo
    kubectl rollout status deployment/Fredo-api -n Fredo
    ;;
  *)
    docker-compose -f docker-compose.$ENV.yml down
    docker tag $REGISTRY/FREDO:$PREVIOUS_VERSION FREDO:latest
    docker-compose -f docker-compose.$ENV.yml up -d
    ;;
esac

echo "Rollback completed!"
```

This deployment guide provides **comprehensive deployment strategies** for **all environments** with **security best practices** and **monitoring capabilities** to ensure **reliable Fredo operations**.