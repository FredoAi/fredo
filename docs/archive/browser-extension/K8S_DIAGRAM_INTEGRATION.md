# Kubernetes Diagram Integration

## Overview
The Fredo Browser Extension now displays comprehensive Kubernetes operational data from the k8s-diagram MCP service. The integration provides real-time visibility into cluster health, pod status, resource metrics, and deployment information.

## Features Implemented

### 1. Enhanced Data Model
**File**: `entrypoints/sidepanel/lib/elements/BaseElement.ts`

Added comprehensive operational data interfaces:
- `TooltipButton` - Action buttons with labels and prompts
- `PodStatus` - Pod phase, IP addresses, container info
- `ServicePorts` - Port configurations for services
- `DeploymentStatus` - Replica counts and deployment health
- `ResourceMetrics` - CPU and memory requests/limits

Extended `BaseElementData` with:
- `age` - Human-readable resource age
- `createdAt` - ISO timestamp
- `labels` - Kubernetes labels
- `annotations` - Kubernetes annotations
- `podStatus` - Pod-specific operational data
- `serviceType` - Service type (ClusterIP, NodePort, etc.)
- `servicePorts` - Port configurations
- `clusterIP` - Service cluster IP
- `deploymentStatus` - Deployment replica information
- `resources` - Resource requests and limits
- `issues` - Array of detected issues
- `restartCount` - Total container restarts

### 2. Architecture Node Display
**File**: `components/ArchitectureNode.svelte`

Visual enhancements:
- **Health Indicators**: Color-coded badges (green/yellow/red) with pulsing animation
- **Age Display**: Shows resource age in header
- **Pod Status**: Phase badge with restart count
- **Service Info**: Service type and primary port
- **Deployment Status**: Available vs desired replicas
- **Issues Badge**: Warning icon with count of detected issues

CSS additions:
- Status badges with color coding (running/pending/failed)
- Restart count with warning color
- Issues indicator with red accent
- Port info styling
- Replica count display

### 3. Global Tooltip Enhancement
**File**: `components/GlobalTooltip.svelte`

Comprehensive operational details:
- **Resource Name**: Bold header with component name
- **Operational Details Section**:
  - Pod status (phase, IP, restart count, container count)
  - Deployment replicas (available/total)
  - Service type and cluster IP
  - Service ports with protocol
  - Resource age
- **Resource Metrics Section**:
  - CPU request
  - Memory request
- **Issues Section**: Red-highlighted box with list of issues
- **Actions Section**: Tooltip buttons for operations

### 4. Data Parsing Integration
**File**: `entrypoints/sidepanel/App.svelte`

Updated `parseJSONData()` to map all enhanced fields:
```typescript
nodes = data.components.map((comp: BaseElementData) => new NodeElement({
  // ... existing fields ...
  age: comp.age,
  podStatus: comp.podStatus,
  serviceType: comp.serviceType,
  servicePorts: comp.servicePorts,
  deploymentStatus: comp.deploymentStatus,
  resources: comp.resources,
  issues: comp.issues,
  restartCount: comp.restartCount
}));
```

## Data Source

### Backend API
**Service**: `apps/tools-mcp/src/services/k8s-diagram/`
**Endpoint**: `https://Fredo.frnx.site/api/v1/k8s-diagram/diagram`

The backend service:
1. Reads `k8s-export.json` (kubectl export data)
2. Parses Kubernetes resources with `K8sParser`
3. Extracts operational data (pod status, health, metrics)
4. Detects issues (pod failures, high restarts, pending resources)
5. Returns JSON with components, links, and metadata

### Example Data Structure
```json
{
  "components": [
    {
      "id": "coredns-7db6d8ff4d-deployment",
      "type": "deployment",
      "label": "coredns-7db6d8ff4d",
      "namespace": "kube-system",
      "health": "healthy",
      "age": "13h",
      "deploymentStatus": {
        "replicas": 2,
        "availableReplicas": 2,
        "readyReplicas": 2
      },
      "issues": [],
      "tooltipButtons": [
        { "label": "View Logs", "prompt": "kubectl logs deployment/coredns-7db6d8ff4d -n kube-system" }
      ]
    }
  ],
  "metadata": {
    "timestamp": "2025-01-26T12:00:00Z",
    "totalResources": 21,
    "healthSummary": {
      "healthy": 18,
      "warning": 2,
      "error": 1
    }
  }
}
```

## Visual Design

### Health Colors
- **Healthy**: Green (`#10b981`) - No issues detected
- **Warning**: Yellow (`#fbbf24`) - High restarts or pending resources
- **Error**: Red (`#ef4444`) - Pod failures or critical issues

### Status Badges
- **Running**: Green background with green text
- **Pending**: Yellow background with yellow text
- **Failed/Error**: Red background with red text

### Layout
- Card header: Node type, health indicator, age
- Card body: Name, namespace, status info, issues badge
- Tooltip: Detailed operational data in organized sections

## Testing

### Local Development
1. Start k8s-diagram service: `docker-compose -f docker-compose.dev.yml up -d`
2. Start extension dev server: `npm run dev`
3. Load extension in Chrome from `.output/chrome-mv3`
4. Navigate to any webpage
5. Open sidepanel, load k8s-export.json data
6. Hover over nodes to see detailed tooltips

### Production Testing
1. Deploy extension to Chrome Web Store
2. Install from store
3. Configure to fetch from `https://Fredo.frnx.site/api/v1/k8s-diagram/diagram`
4. Verify CORS headers allow extension origin
5. Verify operational data displays correctly

## Known Issues
- None currently

## Future Enhancements
1. **Real-time Updates**: WebSocket connection for live cluster monitoring
2. **Historical Data**: Track resource metrics over time
3. **Alerts**: Browser notifications for critical issues
4. **Resource Filtering**: Filter by namespace, type, or health status
5. **Container Details**: Expand pod status to show per-container metrics
6. **Custom Actions**: User-configurable tooltip buttons
7. **Export**: Download diagram as PNG/SVG with current data

## Related Files
- Backend Service: `apps/tools-mcp/src/services/k8s-diagram/`
- Parser Logic: `apps/tools-mcp/src/services/k8s-diagram/parser.ts`
- Data Models: `apps/tools-mcp/src/services/k8s-diagram/model.ts`
- Test Data: `apps/tools-mcp/src/services/k8s-diagram/k8s-export.json`
