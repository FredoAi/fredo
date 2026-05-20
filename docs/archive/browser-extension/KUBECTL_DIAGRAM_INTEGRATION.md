# Kubectl Diagram Integration - Implementation Summary

## Overview
Integrated kubectl operations with K8s infrastructure diagram for real-time event-driven interactions. When kubectl tools execute, the diagram auto-shows and focuses on target nodes with visual feedback.

## Implementation Date
January 2025

## Components Created

### 1. nodeActionRegistry.ts
**Location**: `apps/browser-extension/src/features/diagram/utils/nodeActionRegistry.ts`

**Purpose**: Maps Kubernetes node types to applicable kubectl operations

**Features**:
- **POD_ACTIONS** (11 items): Diagnostics (describe, status, events, metrics), Logs & Exec (logs, exec, shell), Operations (delete), AI Analysis
- **DEPLOYMENT_ACTIONS** (7 items): Diagnostics (describe, status, events), Operations (restart, scale), AI Analysis
- **SERVICE_ACTIONS** (3 items): Diagnostics (describe, list endpoints), AI Analysis
- **NAMESPACE_ACTIONS** (5 items): Diagnostics (pods, deployments, services, events), AI Analysis
- **DEFAULT_ACTIONS** (2 items): Universal fallback actions

**Key Functions**:
- `getActionsForNodeType(type)` - Returns actions for node type
- `isListOperation(toolName)` - Identifies list operations (no auto-focus)
- `groupActionsBySection(actions)` - Groups actions by section for UI

**Action Structure**:
```typescript
{
  section: string;           // 'Diagnostics' | 'Logs & Exec' | 'Operations' | 'AI Analysis'
  label: string;             // Display label
  tool: string;              // kubectl tool name
  description: string;       // Tooltip description
  icon: IconType;            // React icon component
  inputTemplate: (data) => {...}; // Generates tool input
}
```

### 2. promptBuilder.ts
**Location**: `apps/browser-extension/src/features/diagram/utils/promptBuilder.ts`

**Purpose**: Generates comprehensive AI prompts for kubectl operations

**Features**:
- **Resource Information**: Type, namespace, name, age, labels
- **Health Indicators**: Health status, pod phase, deployment replicas
- **Container Details**: Images, restart counts, resource limits
- **Issues Detection**: Current problems and warnings
- **Contextual Hints**: 
  - Crash loop detection (>10 restarts)
  - Replica availability warnings
  - Pod phase analysis
- **Suggested Actions**: Relevant kubectl tools based on state

**Output Format** (Markdown):
```markdown
## 🎯 Kubectl Operation Request

**Action**: Check Pod Logs
**Tool**: kubectl_logs

---

### 📋 Resource Information
- **Type**: Pod
- **Name**: assure-xyz
- **Namespace**: production
- **Age**: 2d

### 🏷️ Labels
- app: assure
- version: v1.2.3

### 📊 Current Status
- **Health**: warning
- **Phase**: Running
- **Restarts**: 15 (⚠️ Crash loop detected)

### 🔍 Contextual Hints
This pod has restarted 15 times, indicating a crash loop.

### 💡 Suggested Actions
- kubectl_logs - View container logs
- kubectl_describe_pod - Get detailed pod information
```

### 3. EventTimeline.tsx
**Location**: `apps/browser-extension/src/features/diagram/components/EventTimeline.tsx`

**Purpose**: Displays kubectl operation lifecycle for resources

**Features**:
- Filters events by namespace + resourceName
- Groups events by correlationId (tracks Init → Update → Response flow)
- State badges: 🔵 Init, 🟡 Update, 🟢 Response, 🔴 Error
- Relative timestamps (e.g., "2 minutes ago")
- Expandable JSON details
- Empty state: "No recent operations for this resource"

**Example Output**:
```
📊 kubectl_logs (abc-123)
  🔵 Init - 2 minutes ago
  🟡 Update - 2 minutes ago (Processing...)
  🟢 Response - 2 minutes ago
  [View Details ▼]
```

## Components Updated

### 4. DiagramFeature.tsx
**Location**: `apps/browser-extension/src/features/diagram/DiagramFeature.tsx`

**Changes**:
- Added kubectl event subscription via `eventFilters`
- Implemented `processEvent()` to handle kubectl Init events
- Added focus target tracking with 500ms debounce
- Skips list operations (no specific resource target)
- Extracts namespace + name from event input
- **Emits custom DOM events** instead of using React props (prevents infinite loops)
- Uses event deduplication and debouncing for performance

**Event Filter**:
```typescript
readonly eventFilters: EventFilter[] = [
  { toolNames: ['infrastructure_stream', 'k8s_diagram'] },
  { custom: (event) => event.toolName.startsWith('kubectl_') && event.state === 'Init' }
];
```

**Focus Logic (Event-Driven Architecture)**:
```typescript
processEvent(event: StreamEvent): void {
  console.log('[DiagramFeature] Received event:', event.toolName, event.state, event.input);
  
  // Only process kubectl Init events for auto-focus
  if (!event.toolName.startsWith('kubectl_') || event.state !== 'Init') return;
  if (isListOperation(event.toolName)) return; // Skip list operations
  
  const target = this.extractFocusTarget(event);
  if (!target) return;
  
  // Deduplication: Skip if same event already processed
  const eventId = `${event.toolName}-${target.namespace}-${target.name}-${event.timestamp || Date.now()}`;
  if (this.lastProcessedEventId === eventId) return;
  
  // Skip if already focused on this target
  const targetKey = `${target.namespace}/${target.name}`;
  const currentFocusKey = this.focusTarget ? `${this.focusTarget.namespace}/${this.focusTarget.name}` : null;
  if (currentFocusKey === targetKey) return;
  
  // Debounce: Prevent rapid focus changes
  const now = Date.now();
  if (now - this.lastFocusTime < this.focusDebounceMs) return;
  
  this.lastProcessedEventId = eventId;
  this.lastFocusTime = now;
  this.focusTarget = { namespace: target.namespace, name: target.name };
  this.focusTargetVersion++;
  
  // Emit custom DOM event (decoupled from React render cycle)
  const focusEvent = new CustomEvent('diagram-focus-node', {
    detail: { namespace: target.namespace, name: target.name }
  });
  window.dispatchEvent(focusEvent);
  
  console.log(`[DiagramFeature] ✅ Focus target set (v${this.focusTargetVersion}): ${target.namespace}/${target.name}`);
}
```

**Why Custom Events Instead of Props?**
- **Prevents infinite loops**: Props create new object references on each render, triggering useEffect
- **Decoupled architecture**: DiagramFeature doesn't need to know about React component lifecycle
- **Better performance**: Event listener registered once, doesn't re-run on every render
- **Simpler debugging**: Clear event flow visible in browser DevTools

### 5. ArchitectureDiagram.tsx
**Location**: `apps/browser-extension/src/features/diagram/components/ArchitectureDiagram.tsx`

**Changes**:
- Removed `focusTarget` prop (now uses event listener pattern)
- Added `onFocusComplete` callback prop
- Implemented auto-focus via custom DOM event listener
- Finds matching node by namespace + label (with fuzzy matching fallback)
- Uses ReactFlow `fitView()` for smooth animation (400ms duration, zoom 1.5, padding 0.3)
- Applies `.focused-node` CSS class for 3s pulse animation
- Guards prevent duplicate processing and infinite loops
- Clears focus styling after animation completes

**Auto-Focus Logic (Event Listener Pattern)**:
```typescript
const lastFocusedTargetRef = React.useRef<string | null>(null);
const focusInProgressRef = React.useRef(false);

useEffect(() => {
  const handleFocusEvent = (event: Event) => {
    const customEvent = event as CustomEvent<{ namespace: string; name: string }>;
    const focusTarget = customEvent.detail;
    
    const focusKey = `${focusTarget.namespace}/${focusTarget.name}`;
    console.log(`[ArchitectureDiagram] Auto-focusing on ${focusKey}`);
    
    // Guards: Prevent duplicate processing
    if (lastFocusedTargetRef.current === focusKey) return;
    if (focusInProgressRef.current) return;
    
    lastFocusedTargetRef.current = focusKey;
    focusInProgressRef.current = true;
    
    // Schedule focus operation
    setTimeout(() => {
      setNodes((currentNodes) => {
        // Find exact match
        const targetNode = currentNodes.find(node => {
          const data = node.data as K8sNodeData;
          return !node.hidden && 
                 data.namespace === focusTarget.namespace && 
                 data.label === focusTarget.name;
        });

        if (!targetNode) {
          console.log(`[ArchitectureDiagram] ❌ Node not found: ${focusKey}`);
          
          // Fuzzy match fallback (partial name matching)
          const fuzzyMatch = currentNodes.find(node => {
            const data = node.data as K8sNodeData;
            return !node.hidden && 
                   data.namespace === focusTarget.namespace && 
                   (data.label?.includes(focusTarget.name) || 
                    focusTarget.name.includes(data.label || ''));
          });
          
          if (fuzzyMatch) {
            console.log(`[ArchitectureDiagram] ✅ Found fuzzy match:`, (fuzzyMatch.data as K8sNodeData).label);
            fitView({ nodes: [fuzzyMatch], duration: 400, padding: 0.3, maxZoom: 1.5 });
            
            setTimeout(() => {
              setNodes((nds) => nds.map((n) => ({ ...n, className: '' })));
              focusInProgressRef.current = false;
              lastFocusedTargetRef.current = null;
              onFocusComplete?.();
            }, 3000);

            return currentNodes.map((node) => ({
              ...node,
              className: node.id === fuzzyMatch.id ? 'focused-node' : '',
            }));
          }
          
          focusInProgressRef.current = false;
          lastFocusedTargetRef.current = null;
          onFocusComplete?.();
          return currentNodes;
        }

        console.log(`[ArchitectureDiagram] ✅ Zooming to node:`, targetNode.id);
        fitView({ nodes: [targetNode], duration: 400, padding: 0.3, maxZoom: 1.5 });

        setTimeout(() => {
          setNodes((nds) => nds.map((n) => ({ ...n, className: '' })));
          focusInProgressRef.current = false;
          lastFocusedTargetRef.current = null;
          onFocusComplete?.();
        }, 3000);

        return currentNodes.map((node) => ({
          ...node,
          className: node.id === targetNode.id ? 'focused-node' : '',
        }));
      });
    }, 150); // Small delay ensures diagram is ready
  };
  
  // Register event listener ONCE on mount
  window.addEventListener('diagram-focus-node', handleFocusEvent);
  
  // Cleanup on unmount
  return () => window.removeEventListener('diagram-focus-node', handleFocusEvent);
}, [fitView, setNodes, onFocusComplete]); // Stable dependencies only!
```

**Key Improvements**:
- **Stable useEffect**: Dependencies never change, preventing re-runs
- **Guards**: `lastFocusedTargetRef` and `focusInProgressRef` prevent duplicate processing
- **Fuzzy matching**: Handles deployment names with suffixes (e.g., "pagelayouts" matches "ess-pagelayouts-9x")
- **Logging**: Detailed console output for debugging
- **Performance**: Optimized zoom parameters (400ms, maxZoom 1.5)

### 6. NodeContextMenu.tsx
**Location**: `apps/browser-extension/src/features/diagram/components/NodeContextMenu.tsx`

**Changes**:
- Replaced static buttons with dynamic action sets from `nodeActionRegistry`
- Implemented Chakra UI Accordion with 5 sections:
  1. **📊 Recent Operations** - EventTimeline component
  2. **🔍 Diagnostics** - describe, status, events, metrics
  3. **📝 Logs & Exec** - logs, exec, shell access
  4. **⚙️ Operations** - restart, scale, delete
  5. **🤖 AI Analysis** - improvement analysis, hotfix suggestions
- Each action button shows icon, label, and description
- Sends comprehensive prompts to Agent via `window.postMessage()`

**Action Click Handler**:
```typescript
const handleActionClick = (action: NodeAction) => {
  const prompt = buildPromptForNode(data, action);
  window.postMessage({ type: 'INJECT_PROMPT', prompt }, '*');
  onClose();
};
```

### 7. K8sNode.tsx
**Location**: `apps/browser-extension/src/features/diagram/components/K8sNode.tsx`

**Changes**:
- Added `useStream()` hook to subscribe to kubectl events
- Implemented `activeOperations` counter via `useMemo()`
- Filters events by namespace + name matching
- Counts Init + Update state events (active operations)
- Displays operation badge with count (e.g., "2 OPS")
- Badge appears in top-right corner with pulse animation

**Operation Counter**:
```typescript
const activeOperations = useMemo(() => {
  return events.filter(event => {
    if (!event.toolName.startsWith('kubectl_')) return false;
    if (event.state !== 'Init' && event.state !== 'Update') return false;
    
    const input = event.input || {};
    const targetName = input.name || input.pod;
    return input.namespace === data.namespace && targetName === data.label;
  }).length;
}, [events, data.namespace, data.label]);
```

### 8. K8sNode.module.css
**Location**: `apps/browser-extension/src/features/diagram/components/K8sNode.module.css`

**Changes**:
- Added `.focused-node` animation (3s purple pulse)
- Added `.operationBadge` styling (purple gradient, pulse animation)

**CSS Additions**:
```css
/* Focused node animation (triggered by kubectl events) */
:global(.focused-node) .turboNode {
  animation: focusPulse 3s ease-in-out;
}

@keyframes focusPulse {
  0%, 100% { box-shadow: var(--node-box-shadow); }
  50% { box-shadow: 0 0 30px 8px var(--accent-primary); }
}

/* Active operation badge */
.operationBadge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: linear-gradient(135deg, #9333ea 0%, #c084fc 100%);
  color: white;
  border-radius: 12px;
  padding: 4px 10px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  box-shadow: 0 2px 8px rgba(147, 51, 234, 0.4);
  z-index: 2;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.05); opacity: 0.9; }
}
```

## User Experience Flow

### Scenario 1: Check Pod Logs
1. User right-clicks pod node "assure-xyz"
2. Context menu opens with dynamic actions
3. User clicks "📝 View container logs" in "Logs & Exec" section
4. Comprehensive prompt sent to Agent:
   ```markdown
   ## 🎯 Kubectl Operation Request
   **Action**: View container logs
   **Tool**: kubectl_logs
   
   ### 📋 Resource Information
   - Type: Pod
   - Name: assure-xyz
   - Namespace: production
   
   ### 💡 Suggested Actions
   - kubectl_logs with tail=100 and timestamps
   ```
5. Agent executes `kubectl_logs` → Init event published to Redis
6. SSE broadcasts event to StreamContext → Home.tsx distributes to features
7. DiagramFeature.processEvent() validates event → emits 'diagram-focus-node' event
8. ArchitectureDiagram event listener triggers → finds node → applies focus
9. Purple pulse animation plays for 3 seconds on "assure-xyz" pod
8. K8sNode shows operation badge "1 OP"
9. EventTimeline updates in context menu:
   ```
   🔵 Init - just now
   🟡 Update - just now (Processing...)
   🟢 Response - just now
   ```

### Scenario 2: Restart Deployment
1. User right-clicks deployment "api-server"
2. Context menu shows 7 actions for deployments
3. User clicks "⚙️ Restart deployment" in "Operations" section
4. Agent executes `kubectl_restart_deployment`
5. Diagram auto-shows and focuses on "api-server" deployment
6. Operation badge shows "1 OP"
7. Timeline shows Init → Update → Response lifecycle

### Scenario 3: List Pods (No Auto-Focus)
1. User asks Agent: "Show me all pods in production namespace"
2. Agent executes `kubectl_get_pods`
3. DiagramFeature skips auto-focus (list operation, no specific target)
4. Diagram remains in current view
5. User sees pod list in chat, diagram stays stable

## Technical Details

### Event Streaming Architecture
```
kubectl Tool Execution (e.g., restart deployment)
  ↓
MCP Server publishes Init event → Redis Stream
  ↓
SSE endpoint broadcasts → Browser Extension (port 3001)
  ↓
StreamContext updates events array
  ↓
Home.tsx distributes event to all grid features
  ↓
DiagramFeature.processEvent() triggered
  ↓
Validation: deduplication, debouncing, list operation check
  ↓
Emit custom DOM event: window.dispatchEvent('diagram-focus-node')
  ↓
ArchitectureDiagram event listener receives event
  ↓
Guards check: not already focused, not in progress
  ↓
Find node → fitView() → Apply CSS class 'focused-node'
  ↓
Purple pulse animation (3s) → Clear styling → onFocusComplete()
```

**Why This Architecture Works**:
1. **Decoupled**: DiagramFeature and ArchitectureDiagram communicate via browser events
2. **No prop dependencies**: Event listener has stable dependencies `[fitView, setNodes, onFocusComplete]`
3. **No infinite loops**: Events only fire when processEvent() is called, not on every render
4. **Debuggable**: Event flow visible in browser DevTools Event Listeners tab

### Debouncing Strategy
- **Focus Events**: 500ms debounce prevents rapid focus changes
- **Event Timeline**: No debounce, shows all events in real-time
- **Operation Badge**: Reacts instantly to event stream

### Performance Optimizations
- `useMemo()` for operation counting (prevents re-filtering on every render)
- `useMemo()` for action grouping (computed once per node type)
- Event filtering happens in memory (no network calls)
- ReactFlow `fitView()` uses hardware-accelerated animations

## Testing Checklist

### Basic Functionality
- [x] kubectl_logs Init event → pod node focused
- [x] kubectl_restart_deployment → deployment node focused
- [x] kubectl_describe_pod → pod node focused
- [x] kubectl_get_pods (list) → no auto-focus
- [x] Multiple rapid events → debounce works (500ms)
- [x] Event deduplication prevents duplicate processing
- [x] Fuzzy matching handles deployment name variations
- [x] No infinite loops (stable useEffect dependencies)
- [x] Custom DOM events visible in DevTools

### Context Menu
- [x] Pod node → 11 actions (4 sections)
- [x] Deployment node → 7 actions (4 sections)
- [x] Service node → 3 actions (2 sections)
- [x] Namespace node → 5 actions (2 sections)
- [x] EventTimeline shows operation lifecycle
- [x] Prompts sent to Agent correctly

### Visual Feedback
- [x] Focused node has purple pulse animation (3s)
- [x] Operation badge shows count "1 OP", "2 OPS"
- [x] Badge pulse animation runs continuously
- [x] Focus clears after 3 seconds

### Edge Cases
- [x] Node not found → no error, onFocusComplete called
- [x] Empty namespace → no crash
- [x] No events → EventTimeline shows "No recent operations"

## Future Enhancements

### Short-term
- Add toast notifications for kubectl errors
- Implement action confirmation for destructive operations (delete, restart)
- Add keyboard shortcuts for common actions (L = logs, D = describe)

### Medium-term
- Multi-node selection for batch operations
- Drag-and-drop kubectl commands to nodes
- Real-time log streaming in side panel

### Long-term
- Interactive kubectl terminal in diagram
- Kubectl operation history with replay
- AI-suggested remediation workflows

## Files Modified
1. `apps/browser-extension/src/features/diagram/DiagramFeature.tsx` (90 lines)
2. `apps/browser-extension/src/features/diagram/components/ArchitectureDiagram.tsx` (+50 lines)
3. `apps/browser-extension/src/features/diagram/components/NodeContextMenu.tsx` (280 → 320 lines)
4. `apps/browser-extension/src/features/diagram/components/K8sNode.tsx` (+30 lines)
5. `apps/browser-extension/src/features/diagram/components/K8sNode.module.css` (+50 lines)

## Files Created
1. `apps/browser-extension/src/features/diagram/utils/nodeActionRegistry.ts` (298 lines)
2. `apps/browser-extension/src/features/diagram/utils/promptBuilder.ts` (245 lines)
3. `apps/browser-extension/src/features/diagram/components/EventTimeline.tsx` (157 lines)

## Total Lines of Code
- **Created**: 700 lines
- **Modified**: 170 lines
- **Total**: 870 lines

## Dependencies
- React 18.3.1 (hooks: useMemo, useEffect, useCallback)
- ReactFlow 11.11.4 (fitView, node management)
- Chakra UI 3.2.2 (Accordion, Badge, Button)
- date-fns (relative timestamps)
- react-icons/lu (Lucide icons)

## Related Documentation
- [FEATURE_CLASS_GUIDE.md](./FEATURE_CLASS_GUIDE.md) - Feature class architecture
- [EVENT_FLOW.md](./EVENT_FLOW.md) - Event streaming system
- [K8S_DIAGRAM_INTEGRATION.md](./K8S_DIAGRAM_INTEGRATION.md) - Original integration plan
- [AI_INTERACTION.md](./AI_INTERACTION.md) - Agent chat integration

## Maintainer
Copilot (GitHub Copilot AI Assistant)
