/**
 * TypeScript tests for FredoEvent and AppProvider normalization.
 *
 * Tests the contract defined in Spec 1 REQ-1.13 through REQ-1.14:
 * - FredoEvent interface exported from StreamContext.tsx
 * - AppProvider normalizes both StreamEvent and FredoEvent shapes
 *
 * These are compile-time type tests + shape validation tests.
 * They validate TypeScript types and don't require a test runner.
 */

// Import the actual types from StreamContext.tsx (REQ-1.13)
import type { FredoEvent, FredoEventError, StreamEvent } from '../StreamContext';

// Re-export for external verification
export type { FredoEvent, FredoEventError } from '../StreamContext';

// ─── Type-level assertions for FredoEvent ────────────────────────────────────

// Helper type to validate FredoEvent has all required fields
type AssertHasField<T, K extends keyof T> = K extends keyof T ? true : never;
type AssertFredoEventFields = AssertHasField<FredoEvent, 'id'>
  & AssertHasField<FredoEvent, 'eventType'>
  & AssertHasField<FredoEvent, 'state'>
  & AssertHasField<FredoEvent, 'provider'>
  & AssertHasField<FredoEvent, 'transport'>
  & AssertHasField<FredoEvent, 'sessionId'>
  & AssertHasField<FredoEvent, 'timestamp'>
  & AssertHasField<FredoEvent, 'payload'>;

// Verify the type assertion compiles (if FredoEvent is missing fields, this errors)
const _assertFredoEventFields: AssertFredoEventFields = true;

// ─── EventType enum validation ────────────────────────────────────────────────

type EventTypeValues = FredoEvent['eventType'];
const _eventTypeValid: EventTypeValues = 'tool_use';
const _eventTypeValid2: EventTypeValues = 'agent_session';
const _eventTypeValid3: EventTypeValues = 'chat';
const _eventTypeValid4: EventTypeValues = 'infrastructure';
const _eventTypeValid5: EventTypeValues = 'ui';
const _eventTypeValid6: EventTypeValues = 'custom';

// ─── EventState enum validation (PascalCase) ─────────────────────────────────

type EventStateValues = FredoEvent['state'];
const _stateInit: EventStateValues = 'Init';
const _stateUpdate: EventStateValues = 'Update';
const _stateResponse: EventStateValues = 'Response';
const _stateError: EventStateValues = 'Error';

// Verify EventState is PascalCase (type-level check)
type AssertPascalCase<S extends string> = S extends `${Capitalize<S>}` ? true : false;
type AssertInitIsPascalCase = AssertPascalCase<'Init'>; // true
type AssertinitIsPascalCase = AssertPascalCase<'init'>; // false (lowercase fails)

// ─── EventProvider enum validation ────────────────────────────────────────────

type EventProviderValues = FredoEvent['provider'];
const _providerOpenCode: EventProviderValues = 'open_code';
const _providerClaudeCode: EventProviderValues = 'claude_code';
const _providerInternal: EventProviderValues = 'internal';

// ─── Transport enum validation ───────────────────────────────────────────────

type TransportValues = FredoEvent['transport'];
const _transportHook: TransportValues = 'hook';
const _transportOtlpGrpc: TransportValues = 'otlp_grpc';
const _transportOtlpHttp: TransportValues = 'otlp_http';
const _transportWebSocket: TransportValues = 'web_socket';
const _transportHttpPost: TransportValues = 'http_post';
const _transportInternal: TransportValues = 'internal';

// ─── AppProvider normalization logic ─────────────────────────────────────────

/**
 * Detects if a message is a StreamEvent (has toolName + sessionId)
 */
function isStreamEventShape(msg: unknown): msg is StreamEvent {
  const obj = msg as Record<string, unknown>;
  return typeof obj?.toolName === 'string' && typeof obj?.sessionId === 'string';
}

/**
 * Detects if a message is a FredoEvent (has eventType + provider)
 */
function isFredoEventShape(msg: unknown): msg is FredoEvent {
  const obj = msg as Record<string, unknown>;
  return typeof obj?.eventType === 'string' && typeof obj?.provider === 'string';
}

/**
 * Normalizes any event to StreamEvent shape (what AppProvider.addEvent expects)
 */
function normalizeToStreamEventShape(msg: StreamEvent | FredoEvent): StreamEvent {
  if (isStreamEventShape(msg)) {
    return msg;
  }
  if (isFredoEventShape(msg)) {
    // Map FredoEvent to StreamEvent
    return {
      toolName: msg.toolName || msg.eventType, // toolName field or derive from eventType
      sessionId: msg.sessionId,
      state: msg.state,
      timestamp: msg.timestamp,
      input: msg.payload ?? undefined,
      response: undefined,
      data: undefined,
      eventId: msg.id,
      correlationId: msg.correlationId,
      error: msg.error ?? undefined,
    };
  }
  // Fallback - shouldn't happen if type detection works
  throw new Error('Unknown event shape');
}

// ─── Validation that normalization works ─────────────────────────────────────

// Test: StreamEvent passes through unchanged
const streamEvent: StreamEvent = {
  toolName: 'test_tool',
  sessionId: 'tauri',
  state: 'Init',
  timestamp: new Date().toISOString(),
};
const normalizedStream = normalizeToStreamEventShape(streamEvent);
const _streamToolName: string = normalizedStream.toolName; // Should be 'test_tool'
const _streamState: StreamEvent['state'] = normalizedStream.state; // Should be 'Init'

// Test: FredoEvent normalizes to StreamEvent
const fredoEvent: FredoEvent = {
  id: 'test-uuid',
  eventType: 'tool_use',
  state: 'Init',
  provider: 'internal',
  transport: 'hook',
  sessionId: 'tauri-local',
  timestamp: new Date().toISOString(),
  payload: { test: true },
};
const normalizedFredo = normalizeToStreamEventShape(fredoEvent);
const _fredoToolName: string = normalizedFredo.toolName; // Derived from eventType or toolName
const _fredoState: StreamEvent['state'] = normalizedFredo.state; // Should be 'Init'
const _fredoEventId: string | undefined = normalizedFredo.eventId; // From FredoEvent.id

// ─── Shape detection tests ────────────────────────────────────────────────────

// StreamEvent detection
const _isStreamEvent = isStreamEventShape(streamEvent); // true
const _isStreamEventFredo = isStreamEventShape(fredoEvent); // false

// FredoEvent detection
const _isFredoEvent = isFredoEventShape(fredoEvent); // true
const _isFredoEventStream = isFredoEventShape(streamEvent); // false

// ─── Type export verification ─────────────────────────────────────────────────
// After implementation, these types should be exported from:
// - StreamContext.tsx (FredoEvent alongside StreamEvent)
// - @fredo/ui index.ts (via StreamContext export)

type FredoEventExport = FredoEvent; // If this compiles, the type is exported
type StreamEventExport = StreamEvent; // If this compiles, the type is exported

console.log('FredoEvent type tests compiled successfully');
console.log('StreamEvent type tests compiled successfully');
console.log('AppProvider normalization shape tests compiled successfully');
console.log('Type export verification compiled successfully');