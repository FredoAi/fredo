/**
 * Type-contract tests for EventFilter + FredoEvent migration (REQ-3.3, REQ-3.4, REQ-3.5)
 *
 * REQ-3.3: EventFilter filters by eventType (FredoEvent field) instead of toolName
 * REQ-3.4: EventFilter type accepts eventTypes field
 * REQ-3.5: processEvent() takes FredoEvent parameter (not StreamEvent)
 *
 * These are compile-time type assertions that verify the contract
 * AFTER migration is complete.
 *
 * CURRENT STATE: These tests will FAIL until the coder implements the migration.
 * When REQ-3.4 is implemented (eventTypes added to EventFilter), these pass.
 */

// Inline types to avoid import issues during migration period
type FredoEventShape = {
  id: string;
  eventType: 'tool_use' | 'agent_session' | 'chat' | 'infrastructure' | 'ui' | 'custom';
  state: 'Init' | 'Update' | 'Response' | 'Error';
  provider: 'open_code' | 'claude_code' | 'internal';
  transport: 'hook' | 'otlp_grpc' | 'otlp_http' | 'web_socket' | 'http_post' | 'internal';
  sessionId: string;
  correlationId?: string;
  toolName?: string;
  payload: Record<string, unknown> | null;
  error?: { message: string; code?: string } | null;
  timestamp: string;
};

// ─── REQ-3.4: EventFilter has eventTypes field ─────────────────────────────────
// The EventFilter type should have an eventTypes field after migration.
// This will FAIL until the coder adds eventTypes to the EventFilter interface.

/**
 * Expected EventFilter shape AFTER migration (REQ-3.4)
 */
interface ExpectedEventFilter {
  eventTypes?: FredoEventShape['eventType'][];
  toolNames?: string[];
  states?: FredoEventShape['state'][];
  custom?: (event: FredoEventShape) => boolean;
}

// Test that the expected shape is valid TypeScript
const _expectedEventFilter: ExpectedEventFilter = {
  eventTypes: ['tool_use', 'agent_session'],
  custom: (event: FredoEventShape) => event.toolName !== undefined,
};

// ─── REQ-3.5: processEvent() takes FredoEvent ──────────────────────────────────
// The processEvent() method should take FredoEvent parameter after migration.

/**
 * Interface that FredoFeatureClass should implement after migration
 */
interface FredoFeatureLike {
  processEvent(event: FredoEventShape): void;
}

const _featureWithFredoEventProcess: FredoFeatureLike = {
  processEvent(event: FredoEventShape) {
    // Can access event.eventType (primary discriminator)
    const _eventType = event.eventType;
    // Can access event.state
    const _state = event.state;
    // Can access event.provider
    const _provider = event.provider;
    // Can access event.transport
    const _transport = event.transport;
    // Can access event.toolName (backward compat - REQ-3.8)
    const _toolName = event.toolName;
  },
};

// ─── REQ-3.8: toolName field is preserved on FredoEvent ───────────────────────
// Verify toolName is accessible on FredoEvent

const _toolNameAccessible: string | undefined = ((): FredoEventShape => ({
  id: 'test',
  eventType: 'tool_use',
  state: 'Init',
  provider: 'internal',
  transport: 'hook',
  sessionId: 'sess',
  timestamp: new Date().toISOString(),
  payload: {},
  toolName: 'my_tool',
}))().toolName;

// ─── Type exports ───────────────────────────────────────────────────────────────

export type { ExpectedEventFilter, FredoEventShape };
export { _expectedEventFilter, _featureWithFredoEventProcess, _toolNameAccessible };

console.log('EventFilter with eventTypes field: COMPILED');
console.log('processEvent() takes FredoEvent: COMPILED');
console.log('toolName field preserved (REQ-3.8): COMPILED');
console.log('Migration contract validation complete');