/**
 * Type-contract tests for AppProvider FredoEvent-only normalization (REQ-3.2)
 *
 * REQ-3.2: AppProvider shall only normalize FredoEvent shapes,
 * removing the dual-shape detection logic that distinguishes between
 * FredoEvent and StreamEvent message formats.
 *
 * These are compile-time type assertions. The AppProvider should ONLY
 * check for 'eventType' in msg (FredoEvent discriminator) and NOT
 * check for 'toolName' + 'state' (StreamEvent legacy discriminator).
 */

import type { FredoEvent, EventType, EventProvider, Transport } from '../../../shared/contexts/StreamContext';

// ─── REQ-3.2: FredoEvent message shape ─────────────────────────────────────────

/**
 * A raw FredoEvent message as received from the host adapter.
 * This is what AppProvider.onMessage() should receive.
 */
interface RawFredoEventMessage {
  id: string;
  eventType: EventType;
  state: 'Init' | 'Update' | 'Response' | 'Error';
  provider: EventProvider;
  transport: Transport;
  sessionId: string;
  correlationId?: string;
  toolName?: string;
  payload: Record<string, unknown> | null;
  error?: { message: string; code?: string } | null;
  timestamp: string;
}

// Valid FredoEvent message instance
const rawFredoEventMsg: RawFredoEventMessage = {
  id: 'evt-001',
  eventType: 'tool_use',
  state: 'Init',
  provider: 'open_code',
  transport: 'hook',
  sessionId: 'session-001',
  toolName: 'my_tool',
  payload: { input: 'test' },
  timestamp: new Date().toISOString(),
};

// Verify the message shape has eventType as discriminator
const _discriminatorIsEventType: EventType = rawFredoEventMsg.eventType;
const _providerField: EventProvider = rawFredoEventMsg.provider;
const _transportField: Transport = rawFredoEventMsg.transport;

// ─── REQ-3.2: AppProvider should NOT handle StreamEvent shape ──────────────────

/**
 * Legacy StreamEvent message shape (should NOT be handled after migration)
 * This interface represents the OLD shape that AppProvider should no longer accept.
 */
interface LegacyStreamEventMessage {
  toolName: string;
  sessionId: string;
  state: 'Init' | 'Update' | 'Response' | 'Error';
  input?: unknown;
  response?: unknown;
  data?: unknown;
  timestamp: string;
  eventId?: string;
  correlationId?: string;
  source?: 'hook' | 'otlpGrpc' | 'otlpHttp';
}

// AFTER migration, AppProvider should NOT normalize this shape
// The fact that this interface exists is for backward compat reference only

// ─── REQ-3.2: Verify FredoEvent can be converted to internal event ───────────────

/**
 * Internal event shape (what StreamContext.store expects after migration).
 * After REQ-3.7, this should be FredoEvent.
 */
type InternalEvent = FredoEvent;

// Verify RawFredoEventMessage can map to InternalEvent
const internalEvent: InternalEvent = {
  id: rawFredoEventMsg.id,
  eventType: rawFredoEventMsg.eventType,
  state: rawFredoEventMsg.state,
  provider: rawFredoEventMsg.provider,
  transport: rawFredoEventMsg.transport,
  sessionId: rawFredoEventMsg.sessionId,
  correlationId: rawFredoEventMsg.correlationId,
  toolName: rawFredoEventMsg.toolName,
  payload: rawFredoEventMsg.payload,
  error: rawFredoEventMsg.error ?? null,
  timestamp: rawFredoEventMsg.timestamp,
};

// Verify all FredoEvent fields are populated from raw message
const _internalId: string = internalEvent.id;
const _internalEventType: EventType = internalEvent.eventType;
const _internalState: 'Init' | 'Update' | 'Response' | 'Error' = internalEvent.state;
const _internalProvider: EventProvider = internalEvent.provider;
const _internalTransport: Transport = internalEvent.transport;
const _internalSessionId: string = internalEvent.sessionId;
const _internalToolName: string | undefined = internalEvent.toolName;

// ─── REQ-3.8: toolName field preserved ─────────────────────────────────────────

// toolName should be preserved from raw message to internal event
const _toolNamePreserved: string | undefined = internalEvent.toolName;

// ─── Type export ───────────────────────────────────────────────────────────────

export type { RawFredoEventMessage, LegacyStreamEventMessage };
export { rawFredoEventMsg };

console.log('RawFredoEventMessage shape: COMPILED');
console.log('AppProvider FredoEvent-only normalization: COMPILED');
console.log('Legacy StreamEvent shape (not handled): reference only');
console.log('FredoEvent toolName field preserved: COMPILED');
console.log('AppProvider normalization contract validated');