# Atlas Browser Extension - Event Flow Architecture

## Overview

The browser extension receives real-time workflow updates from the MCP server via Server-Sent Events (SSE). This document explains how events flow from AI agents through the backend to the extension UI.

## Event Flow Diagram

```
┌─────────────┐         ┌──────────────┐         ┌────────────┐         ┌────────────┐
│  AI Agent   │  MCP    │  MCP Server  │  Redis  │   Stream   │   SSE   │ Extension  │
│  (Claude)   │────────▶│  Tools       │────────▶│  Streams   │────────▶│    UI      │
└─────────────┘         └──────────────┘         └────────────┘         └────────────┘
```

## 1. Session Flow

### Step 1: Session Auto-Created on First Tool Call
```typescript
// No handshake needed — MCPServer.setupHandlers() calls
// sessionManager.getOrCreateActiveSession() before every tool execution.
// connectionId is stored in Redis (Atlas:active-connection).
// The VS Code extension polls GET /api/session/active to retrieve it.
{
  connectionId: "abc-123-def",
  sseUrl: "/api/v1/Atlas-ui/stream/abc-123-def"
}
```

### Step 2: Backend Creates Session
```typescript
// HandshakeTool.execute()
const connectionId = crypto.randomUUID();
const session = await sessionManager.createSession({ connectionId, ... });

// Returns full details to AI agent
return {
  connectionId,
  sessionId: session.id,
  sseUrl: `/api/v1/Atlas-ui/stream/${connectionId}`,
  message: 'Session established successfully',
  timestamp: new Date().toISOString()
};
```

### Step 3: Extension Observes and Connects
```typescript
// ExtensionProvider.tsx listens for Atlas_HANDSHAKE message
// (AI agent broadcasts connectionId to extension)
if (message.type === 'Atlas_HANDSHAKE' && message.data?.connectionId) {
  setConnectionId(message.data.connectionId);
  
  // Subscribe to SSE stream
  const sseUrl = `https://Atlas.frnx.site/api/v1/Atlas-ui/stream/${connectionId}`;
  const eventSource = new EventSource(sseUrl);
}
```

**Key Point:** AI agent calls handshake first, receives connectionId, and shares it with extension. The extension then establishes SSE connection using that ID.

## 2. Workflow Initialization (Init State)

### Step 1: AI Agent Sends Workflow Steps
```typescript
// AI agent calls
Atlas_ui_stepper({
  action: 'init',
  steps: [
    { name: "Analyze codebase", status: "Running" },
    { name: "Generate report", status: "Waiting" },
    { name: "Send notification", status: "Waiting" }
  ]
})
```

### Step 2: Stepper Tool Publishes to Redis
```typescript
// StepperTool.execute()
const sseConnectionId = context?.sseConnectionId; // From MCP server
await publisher.publishInit(
  'Atlas_ui_stepper',  // toolName
  sseConnectionId,       // sessionId
  input,                 // { action: 'init', steps: [...] }
  correlationId
);
```

### Step 3: Redis Streams Event Structure
```json
{
  "toolName": "Atlas_ui_stepper",
  "state": "Init",
  "sessionId": "abc-123-def",
  "input": {
    "action": "init",
    "steps": [
      { "name": "Analyze codebase", "status": "Running" },
      { "name": "Generate report", "status": "Waiting" },
      { "name": "Send notification", "status": "Waiting" }
    ]
  },
  "timestamp": "2026-01-13T10:31:00.000Z",
  "correlationId": "stepper_1234567890"
}
```

### Step 4: SSE Stream Delivers to Extension
```javascript
// ExtensionProvider.tsx - eventSource.onmessage
const data = JSON.parse(e.data);

if (data.toolName === 'Atlas_ui_stepper' && data.state === 'Init') {
  // Extract steps from Init event
  const steps = data.input.steps;
  
  // Update state
  setSteps(steps);
  setCurrentPage('steps'); // Navigate to stepper view
}
```

## 3. Progress Updates (Update State)

### Step 1: AI Agent Updates Progress
```typescript
// After completing step 1 work
Atlas_ui_stepper({
  action: 'update',
  currentStep: 1,
  message: 'Report generation in progress...'
})
```

### Step 2: Event Published to Redis
```json
{
  "toolName": "Atlas_ui_stepper",
  "state": "Update",
  "sessionId": "abc-123-def",
  "data": {
    "currentStep": 1,
    "message": "Report generation in progress...",
    "steps": [...]  // Optional: full step array if updating multiple
  },
  "timestamp": "2026-01-13T10:32:00.000Z",
  "correlationId": "stepper_1234567891"
}
```

### Step 3: Extension Handles Update
```javascript
if (data.state === 'Update') {
  // Update steps array if provided
  if (data.data.steps) {
    setSteps(data.data.steps);
  }
  
  // Handle current step indicator
  if (typeof data.data.currentStep === 'number') {
    // Update UI to highlight current step
  }
}
```

## 4. Workflow Completion (Response State)

### Step 1: AI Agent Completes Workflow
```typescript
Atlas_ui_stepper({
  action: 'complete',
  message: 'All tasks completed successfully'
})
```

### Step 2: Completion Event
```json
{
  "toolName": "Atlas_ui_stepper",
  "state": "Response",
  "sessionId": "abc-123-def",
  "response": {
    "status": "completed",
    "message": "All tasks completed successfully"
  },
  "timestamp": "2026-01-13T10:35:00.000Z"
}
```

## 5. Error Handling (Error State)

### Step 1: Tool Encounters Error
```typescript
Atlas_ui_stepper({
  action: 'error',
  message: 'Failed to generate report: API timeout'
})
```

### Step 2: Error Event
```json
{
  "toolName": "Atlas_ui_stepper",
  "state": "Error",
  "sessionId": "abc-123-def",
  "error": {
    "message": "Failed to generate report: API timeout",
    "stack": "..."
  },
  "timestamp": "2026-01-13T10:33:00.000Z"
}
```

## ConnectionId Context Flow

**How the `connectionId` flows through the system:**

1. **AI agent calls handshake** and receives `connectionId` in response
2. **AI agent shares connectionId with extension** (via browser message or other mechanism)
3. **Extension uses connectionId** to establish SSE connection
4. **Backend tracks session:**
   - `SessionManager.createSession()` stores session with connectionId
   - `SessionManager.getCurrentSessionId()` retrieves it for subsequent tool calls
5. **All subsequent MCP tool calls** automatically include session context:
   ```typescript
   // In mcpServer.ts CallToolRequestSchema handler
   const sessionId = sessionManager.getCurrentSessionId();
   const context = { 
     sseConnectionId: sessionId,
     transport: 'mcp'
   };
   const result = await tool.execute(args, context);
   ```
6. **Tools use connectionId from context** to publish events:
   ```typescript
   // In StepperTool.execute()
   const sseConnectionId = context?.sseConnectionId;
   await publisher.publishInit('Atlas_ui_stepper', sseConnectionId, input);
   ```

**Result:** AI agent initiates the connection, shares the ID with extension, then all subsequent tool calls automatically use that session context!

## Event Types Summary

| Event Type | Source | Purpose | Data Location |
|------------|--------|---------|---------------|
| `connected` | SSE Stream | Connection acknowledgement | `type: 'connected'` |
| `heartbeat` | SSE Stream | Keep-alive ping | `type: 'heartbeat'` |
| `Init` | Atlas_ui_stepper | Start workflow with steps | `state: 'Init', input.steps` |
| `Update` | Atlas_ui_stepper | Progress update | `state: 'Update', data` |
| `Response` | Atlas_ui_stepper | Workflow completion | `state: 'Response', response` |
| `Error` | Atlas_ui_stepper | Error occurred | `state: 'Error', error` |

## Extension Event Handling Code

```typescript
// ExtensionProvider.tsx - SSE message handler
eventSource.onmessage = (e) => {
  const data = JSON.parse(e.data);
  
  // Handle Atlas_ui_stepper tool events
  if (data.toolName === 'Atlas_ui_stepper' && data.state) {
    addEvent(data as StreamEvent); // Store in Zustand StreamStore
    
    if (data.state === 'Init' && data.input?.steps) {
      setSteps(data.input.steps);
      setCurrentPage('steps');
    }
    else if (data.state === 'Update' && data.data) {
      if (data.data.steps) setSteps(data.data.steps);
    }
    else if (data.state === 'Response') {
      // Workflow completed
    }
    else if (data.state === 'Error') {
      console.error('Workflow error:', data.error);
    }
  }
  
  // Handle infrastructure events
  else if (data.type === 'connected') {
    setStreamConnectionStatus(true);
  }
  else if (data.type === 'heartbeat') {
    // Keep-alive
  }
};
```

## StreamStore Integration

The extension uses Zustand StreamStore to filter and track tool events:

```typescript
// streamStore.ts
export interface StreamEvent {
  toolName: string;
  state: 'Init' | 'Update' | 'Response' | 'Error';
  input?: any;
  data?: any;
  response?: any;
  error?: any;
  timestamp: string;
  sessionId: string;
  correlationId?: string;
}

// Custom hooks for filtering events
const stepperEvents = useStreamStore(
  useShallow((state) => 
    state.events.filter(e => e.toolName === 'Atlas_ui_stepper')
  )
);
```

## Testing the Flow

### 1. Test Session
```typescript
// Session is auto-created when any tool is called.
// Retrieve active connectionId:
const result = await fetch('http://Atlas-mcp.frnx.site/api/session/active');
// Expected response:
{
  "connectionId": "uuid-here",
  "sseUrl": "/api/v1/Atlas-ui/stream/uuid-here",
  "message": "Session established successfully",
  "timestamp": "2026-01-30T..."
}

// AI agent then shares connectionId with extension
// Extension uses it to connect to SSE stream
```

### 2. Test Init Event
```bash
# Call stepper tool with init action
Atlas_ui_stepper({
  action: 'init',
  steps: [
    { name: "Test Step 1", status: "Running" },
    { name: "Test Step 2", status: "Waiting" }
  ]
})

# Check extension console
# Should see: "🚀 INIT STATE - Initializing workflow"
# Should navigate to steps page
```

### 3. Check Redis Streams
```bash
# Connect to Redis container
docker exec -it Atlas-redis redis-cli

# List streams
SCAN 0 MATCH Atlas:sessions:*

# Read stream events
XREAD COUNT 10 STREAMS Atlas:sessions:{sessionId} 0
```

## Troubleshooting

### No events received in extension

**Check:**
1. ✅ SSE connection established (heartbeat received)
2. ✅ `connectionId` stored in extension state
3. ❌ AI agent called `Atlas_ui_stepper` with `action: 'init'`
4. ❌ MCP server logs show tool execution
5. ❌ Redis streams contain events

**Fix:** The AI agent must explicitly call `Atlas_ui_stepper` tool - the handshake only creates the connection, it does NOT send steps!

### Events published but not received

**Check:**
- Stream consumer running: `docker logs Atlas-tools-api-server`
- Redis connection healthy: `docker logs Atlas-redis`
- SSE stream delivering events: Browser DevTools → Network → EventStream

### Wrong event structure

**Verify:**
- Events have `toolName` and `state` properties
- Init events have `input.steps` array
- Update events have `data` object
- Follow StreamEvent interface from streamStore.ts

## Key Differences from Old Architecture

| Old (Documentation) | New (Current Code) |
|---------------------|-------------------|
| Handshake sends steps | Handshake only creates connection |
| Stepper advances to next | Stepper publishes to Redis Streams |
| Events have `type` property | Events have `toolName` + `state` |
| Direct broadcast to SSE | Redis Streams → Stream Consumer → SSE |
| No Init/Update/Response states | Proper state machine with 4 states |

## Related Files

- **Backend:**
  - `apps/tools-mcp/src/services/Atlas-ui/tools/handshakeTool.ts`
  - `apps/tools-mcp/src/services/Atlas-ui/tools/stepperTool.ts`
  - `apps/tools-mcp/src/lib/stream-publisher/StreamPublisher.ts`
  - `apps/tools-mcp/src/core/mcpServer.ts`

- **Extension:**
  - `apps/browser-extension/src/app/providers/ExtensionProvider.tsx`
  - `apps/browser-extension/src/shared/stores/streamStore.ts`
  - `apps/browser-extension/src/features/stepper/components/StepByStepView.tsx`

- **Documentation:**
  - `docs/browser-extension/MESSAGE_PASSING.md` (SSE architecture)
  - `docs/tools-mcp/REDIS_STREAMS_ARCHITECTURE.md` (Event publishing)
