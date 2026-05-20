# Redis Streams Event Architecture - Implementation Complete

## Overview

The Atlas system now uses **Redis Streams** as an event bus for real-time communication between MCP tools and the browser extension. This replaces the previous direct SSE broadcasting with a more scalable, decoupled architecture.

## Architecture

```
┌─────────────── BACKEND (Docker) ───────────────┐
│                                                 │
│  MCP Tools → Redis Streams → StreamConsumer →  │
│                                         ↓       │
│                                  SessionManager │
│                                         ↓       │
│                                   SSE Endpoint  │
└─────────────────────────────────────────────────┘
                        ↓
                  Server-Sent Events
                        ↓
┌────────── BROWSER EXTENSION (React) ───────────┐
│                                                 │
│  EventSource → Zustand Store → Components      │
│                                                 │
└─────────────────────────────────────────────────┘
```

## Event Flow

1. **AI Agent** calls MCP tool (e.g., `Atlas_ui_stepper`)
2. **Tool** publishes event to Redis Stream with state (Init/Update/Response/Error)
3. **StreamConsumer** reads from Redis and routes to SessionManager
4. **SessionManager** sends event via SSE to browser
5. **EventSource** receives event and updates Zustand store
6. **React Components** subscribe to store and re-render

## Event States

Each event follows a lifecycle:

- **Init**: Tool execution started (includes input parameters)
- **Update**: Progress update during execution (optional, repeatable)
- **Response**: Tool completed successfully (includes output)
- **Error**: Tool failed (includes error details)

## Event Schema

```typescript
interface StreamEvent {
  toolName: string;           // 'Atlas_ui_stepper', 'k8s_diagram', etc.
  sessionId: string;          // Session/connection ID
  state: 'Init' | 'Update' | 'Response' | 'Error';
  input?: any;                // Init state only
  response?: any;             // Response state only
  data?: string;              // Flexible field (JSON string)
  timestamp: string;          // ISO 8601
  eventId?: string;           // Unique event ID
  correlationId?: string;     // Track event chains
  error?: {                   // Error state only
    message: string;
    code?: string;
    stack?: string;
  };
}
```

## Backend Components

### 1. StreamPublisher (`apps/tools-mcp/src/services/stream-publisher/StreamPublisher.ts`)

Singleton service for publishing events to Redis Streams.

```typescript
const publisher = StreamPublisher.getInstance();

// Publish Init event
await publisher.publishInit('tool_name', sessionId, { param: 'value' });

// Publish Update event
await publisher.publishUpdate('tool_name', sessionId, { progress: 50 });

// Publish Response event
await publisher.publishResponse('tool_name', sessionId, { result: 'data' });

// Publish Error event
await publisher.publishError('tool_name', sessionId, new Error('Failed'));
```

### 2. StreamConsumer (`apps/tools-mcp/src/services/stream-consumer/StreamConsumer.ts`)

Reads events from Redis Streams and triggers callbacks.

```typescript
const consumer = new StreamConsumer(redisConfig);
await consumer.connect();

await consumer.consumeSession(sessionId, {
  onEvent: async (event) => {
    // Route to SSE
  },
  onError: (error) => {
    console.error(error);
  }
});
```

### 3. SessionManager (`apps/tools-mcp/src/core/SessionManager.ts`)

- Creates sessions on handshake
- Manages SSE connections
- Automatically starts StreamConsumer for each session
- Routes events from Redis to SSE

### 4. Updated Tools

**HandshakeTool** - Creates session and returns connection details:

```typescript
{
  connectionId: 'uuid',
  sessionId: 'uuid',
  sseUrl: '/api/v1/Atlas-ui/stream/{connectionId}',
  message: 'Session established successfully'
}
```

**StepperTool** - Publishes step events:

```typescript
// Initialize workflow
Atlas_ui_stepper({ 
  action: 'init', 
  steps: [{ name: 'Step 1', status: 'Waiting' }] 
})

// Update progress
Atlas_ui_stepper({ 
  action: 'update', 
  currentStep: 0, 
  message: 'Processing...' 
})

// Complete workflow
Atlas_ui_stepper({ 
  action: 'complete', 
  message: 'Done!' 
})
```

## Frontend Components

### 1. Zustand Store (`apps/browser-extension/src/shared/stores/streamStore.ts`)

Global state for streaming events.

```typescript
// In component
const stepperEvents = useStepperEvents(); // Get all stepper events
const latestEvent = useLatestStepperEvent(); // Get latest stepper event
const connectionStatus = useConnectionStatus(); // Get connection status

// Or use store directly
const addEvent = useStreamStore(state => state.addEvent);
const events = useStreamStore(state => state.events);
```

### 2. useStreamService Hook (`apps/browser-extension/src/shared/hooks/useStreamService.ts`)

Manages SSE connection and pipes events to Zustand.

```typescript
const { connect, disconnect, status } = useStreamService({
  autoConnect: true,
  reconnectDelay: 3000,
  maxReconnectAttempts: 5
});
```

### 3. Updated Stepper Component (`apps/browser-extension/src/features/stepper/components/StepByStepView.tsx`)

Now subscribes to Zustand store instead of props:

```typescript
const stepperEvents = useStepperEvents();

useEffect(() => {
  const latestEvent = stepperEvents[stepperEvents.length - 1];
  
  if (latestEvent?.state === 'Init') {
    setSteps(latestEvent.input.steps);
  } else if (latestEvent?.state === 'Update') {
    // Update steps based on event data
  }
}, [stepperEvents]);
```

## Configuration

### Environment Variables

```bash
# Backend (.env)
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=       # Optional

# Frontend (browser extension)
VITE_API_URL=http://localhost:3000
```

### Redis Stream Settings

- **Stream Key Pattern**: `Atlas:sessions:{sessionId}`
- **Max Length**: 1000 events per stream (MAXLEN ~1000)
- **TTL**: 24 hours (auto-cleanup)

## Usage Examples

### 1. Stepper Workflow (AI Agent)

```typescript
// 1. Session is auto-created on first tool call (no handshake needed)
// connectionId available via GET /api/session/active

// 2. Initialize workflow
await Atlas_ui_stepper({
  action: 'init',
  steps: [
    { name: 'Analyze code', status: 'Waiting' },
    { name: 'Generate report', status: 'Waiting' },
    { name: 'Send notification', status: 'Waiting' }
  ]
});

// 3. Update progress
await Atlas_ui_stepper({
  action: 'update',
  currentStep: 0,
  message: 'Analyzing codebase...'
});

// 4. Complete
await Atlas_ui_stepper({
  action: 'complete',
  message: 'Workflow completed successfully'
});
```

### 2. Custom Tool (Backend)

```typescript
export class MyCustomTool extends BaseTool {
  async execute(input: any, context?: any): Promise<any> {
    const sessionId = context?.sseConnectionId;
    const publisher = StreamPublisher.getInstance();
    
    try {
      // Publish Init
      await publisher.publishInit('my_custom_tool', sessionId, input);
      
      // Do work...
      const result = await doSomeWork(input);
      
      // Publish Response
      await publisher.publishResponse('my_custom_tool', sessionId, result);
      
      return result;
    } catch (error) {
      // Publish Error
      await publisher.publishError('my_custom_tool', sessionId, error);
      throw error;
    }
  }
}
```

### 3. Custom Component (Frontend)

```typescript
export const MyCustomComponent = () => {
  const myToolEvents = useStreamStore(state => 
    state.getEventsByTool('my_custom_tool')
  );
  
  const latestEvent = myToolEvents[myToolEvents.length - 1];
  
  if (!latestEvent) return <div>Waiting for events...</div>;
  
  if (latestEvent.state === 'Init') {
    return <div>Processing: {JSON.stringify(latestEvent.input)}</div>;
  }
  
  if (latestEvent.state === 'Response') {
    return <div>Result: {JSON.stringify(latestEvent.response)}</div>;
  }
  
  if (latestEvent.state === 'Error') {
    return <div>Error: {latestEvent.error?.message}</div>;
  }
  
  return null;
};
```

## Deployment

### 1. Start Redis

```bash
docker-compose -f docker-compose.dev.yml up redis -d
```

### 2. Start Backend

```bash
docker-compose -f docker-compose.dev.yml up api-server -d
docker-compose -f docker-compose.dev.yml up mcp-server -d
```

### 3. Install Dependencies

```bash
# Backend
cd apps/tools-mcp
pnpm install

# Frontend
cd apps/browser-extension
pnpm install
```

### 4. Start Development

```bash
# Backend auto-connects to Redis on startup
# Frontend extension loads and initiates handshake
```

## Troubleshooting

### Events not reaching browser

1. Check Redis is running: `docker ps | grep redis`
2. Check SessionManager initialized: Look for "Redis configuration initialized" in logs
3. Check StreamConsumer started: Look for "Stream consumer started for session" in logs
4. Check SSE connection: Browser DevTools → Network → EventSource

### Redis connection errors

1. Verify environment variables: `REDIS_HOST` and `REDIS_PORT`
2. Check Redis container health: `docker exec Atlas-tools-redis redis-cli ping`
3. Check network connectivity: `docker network inspect Atlas-network`

### Events stuck in Redis

1. View stream contents: `docker exec Atlas-tools-redis redis-cli XRANGE Atlas:sessions:{sessionId} - +`
2. Check stream length: `docker exec Atlas-tools-redis redis-cli XLEN Atlas:sessions:{sessionId}`
3. Clear stream: `docker exec Atlas-tools-redis redis-cli DEL Atlas:sessions:{sessionId}`

## Future Enhancements

1. **Consumer Groups**: Add Redis consumer groups for horizontal scaling
2. **Event Replay**: Store last consumed event ID for reconnection recovery
3. **Dead Letter Queue**: Handle failed event processing
4. **Metrics**: Track event throughput and latency
5. **Event Filtering**: Allow browser to subscribe to specific tool events only

## References

- Redis Streams: https://redis.io/docs/data-types/streams/
- Zustand: https://zustand-demo.pmnd.rs/
- Server-Sent Events: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
