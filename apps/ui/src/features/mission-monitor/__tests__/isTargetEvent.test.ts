import { describe, it, expect } from 'vitest';
import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import {
  isTargetEvent,
  normalizeEventName,
  extractRole,
  extractPartType,
} from '../MissionMonitorFeature';

describe('normalizeEventName', () => {
  it('returns the event type unchanged', () => {
    expect(normalizeEventName('UserPromptSubmit')).toBe('UserPromptSubmit');
    expect(normalizeEventName('UserPromptSubmitted')).toBe('UserPromptSubmitted');
    expect(normalizeEventName('SessionStart')).toBe('SessionStart');
    expect(normalizeEventName('')).toBe('');
  });
});

describe('isTargetEvent', () => {
  // ── User-prompt events (should match) ──────────────────────────────
  it('returns true for UserPromptSubmit', () => {
    expect(isTargetEvent('UserPromptSubmit')).toBe(true);
  });

  it('returns true for UserPromptSubmitted', () => {
    expect(isTargetEvent('UserPromptSubmitted')).toBe(true);
  });

  // ── Session lifecycle events (should NOT match) ────────────────────
  it.each([
    'SessionStart',
    'SessionEnd',
    'session.created',
    'session.updated',
    'session.deleted',
    'session.status',
    'session.error',
    'session.idle',
  ])('returns false for session lifecycle event "%s"', (eventType) => {
    expect(isTargetEvent(eventType)).toBe(false);
  });

  // ── Agent thinking / response events ───────────────────────────────
  it.each([
    'invoke_agent',
    'chat',
    'chat.message',
    'message.updated',
    'message.part.updated',
    'message.part.delta',
    'message.removed',
    'message.part.removed',
    'session.next.text.delta',
    'session.next.text.started',
    'session.next.text.ended',
  ])('returns false for agent thinking/response event "%s"', (eventType) => {
    expect(isTargetEvent(eventType)).toBe(false);
  });

  // ── Tool-use events ───────────────────────────────────────────────
  it.each([
    'PreToolUse',
    'PostToolBatch',
    'PostToolUseFailure',
    'execute_tool',
    'file.edited',
    'command.executed',
    'session.next.tool.called',
    'session.next.tool.success',
    'session.next.tool.failed',
  ])('returns false for tool-use event "%s"', (eventType) => {
    expect(isTargetEvent(eventType)).toBe(false);
  });

  // ── Subagent events ───────────────────────────────────────────────
  it.each([
    'SubagentStart',
    'SubagentStop',
  ])('returns false for subagent event "%s"', (eventType) => {
    expect(isTargetEvent(eventType)).toBe(false);
  });

  // ── File events ───────────────────────────────────────────────────
  it.each([
    'file.edited',
  ])('returns false for file event "%s"', (eventType) => {
    expect(isTargetEvent(eventType)).toBe(false);
  });

  // ── Miscellaneous / edge cases ────────────────────────────────────
  it('returns false for an empty string', () => {
    expect(isTargetEvent('')).toBe(false);
  });

  it('returns false for undefined and null event types', () => {
    // Simulate a missing eventType as string coercion
    expect(isTargetEvent(String(undefined))).toBe(false);
    expect(isTargetEvent(String(null))).toBe(false);
  });
});

describe('extractRole', () => {
  it('returns the role from a FredoEvent payload', () => {
    const event: FredoEvent = {
      id: '1',
      eventType: 'chat',
      state: 'Update',
      provider: 'internal',
      transport: 'hook',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { role: 'user' },
    };
    expect(extractRole(event)).toBe('user');
  });

  it('returns empty string when payload has no role', () => {
    const event: FredoEvent = {
      id: '2',
      eventType: 'chat',
      state: 'Update',
      provider: 'internal',
      transport: 'hook',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { text: 'hello' },
    };
    expect(extractRole(event)).toBe('');
  });

  it('returns empty string when payload is null', () => {
    const event: FredoEvent = {
      id: '3',
      eventType: 'chat',
      state: 'Update',
      provider: 'internal',
      transport: 'hook',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: null,
    };
    expect(extractRole(event)).toBe('');
  });
});

describe('extractPartType', () => {
  it('returns the partType from a FredoEvent payload', () => {
    const event: FredoEvent = {
      id: '1',
      eventType: 'message.part.delta',
      state: 'Update',
      provider: 'internal',
      transport: 'hook',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { partType: 'text' },
    };
    expect(extractPartType(event)).toBe('text');
  });

  it('returns empty string when payload has no partType', () => {
    const event: FredoEvent = {
      id: '2',
      eventType: 'message.part.delta',
      state: 'Update',
      provider: 'internal',
      transport: 'hook',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { index: 0 },
    };
    expect(extractPartType(event)).toBe('');
  });

  it('returns empty string when payload is null', () => {
    const event: FredoEvent = {
      id: '3',
      eventType: 'message.part.delta',
      state: 'Update',
      provider: 'internal',
      transport: 'hook',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: null,
    };
    expect(extractPartType(event)).toBe('');
  });
});
