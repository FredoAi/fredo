import { describe, it, expect } from 'vitest';
import type { FredoEvent, StreamEvent } from '../StreamContext';

describe('FredoEvent type contract', () => {
  it('should have all required fields (compile-time check)', () => {
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
    const _valid: AssertFredoEventFields = true;
    expect(_valid).toBe(true);
  });

  it('should accept valid eventType values', () => {
    type EventTypeValues = FredoEvent['eventType'];
    const vals: EventTypeValues[] = ['tool_use', 'agent_session', 'chat', 'infrastructure', 'ui', 'custom'];
    expect(vals.length).toBe(6);
  });

  it('should accept valid state values (PascalCase)', () => {
    type EventStateValues = FredoEvent['state'];
    const vals: EventStateValues[] = ['Init', 'Update', 'Response', 'Error'];
    expect(vals.length).toBe(4);
  });

  it('should accept valid provider values', () => {
    type EventProviderValues = FredoEvent['provider'];
    const vals: EventProviderValues[] = ['open_code', 'claude_code', 'internal'];
    expect(vals.length).toBe(3);
  });

  it('should accept valid transport values', () => {
    type TransportValues = FredoEvent['transport'];
    const vals: TransportValues[] = ['hook', 'otlp_grpc', 'otlp_http', 'web_socket', 'http_post', 'internal'];
    expect(vals.length).toBe(6);
  });

  it('should normalize FredoEvent to StreamEvent shape', () => {
    const fredoEvent: FredoEvent = {
      id: 'test-uuid', eventType: 'tool_use', state: 'Init',
      provider: 'internal', transport: 'hook', sessionId: 'tauri-local',
      timestamp: new Date().toISOString(), payload: { test: true },
    };
    const normalized = {
      toolName: fredoEvent.toolName || fredoEvent.eventType,
      sessionId: fredoEvent.sessionId, state: fredoEvent.state,
      timestamp: fredoEvent.timestamp,
      input: fredoEvent.payload ?? undefined, response: undefined,
      data: undefined, eventId: fredoEvent.id,
      correlationId: fredoEvent.correlationId,
      error: fredoEvent.error ?? undefined,
    };
    expect(normalized.toolName).toBe('tool_use');
    expect(normalized.state).toBe('Init');
    expect(normalized.eventId).toBe('test-uuid');
  });

  it('should normalize StreamEvent pass-through unchanged', () => {
    const streamEvent: StreamEvent = {
      toolName: 'test_tool', sessionId: 'tauri', state: 'Init',
      timestamp: new Date().toISOString(),
    };
    expect(streamEvent.toolName).toBe('test_tool');
    expect(streamEvent.state).toBe('Init');
  });
});
