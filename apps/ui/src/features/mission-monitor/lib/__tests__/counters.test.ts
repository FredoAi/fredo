/**
 * Tests for computeSessionCounters and formatTokenCount.
 *
 * Covers REQ-9 (Header Badges), REQ-10 (Accumulation), REQ-11 (Token Sources).
 */
import { describe, it, expect } from 'vitest';
import type { FredoEvent } from '../../../../shared/contexts/StreamContext';
import { computeSessionCounters } from '../counters';
import { formatTokenCount } from '../contract';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<FredoEvent>): FredoEvent {
  return {
    id: crypto.randomUUID(),
    eventType: 'chat',
    state: 'Update',
    provider: 'open_code',
    transport: 'hook',
    sessionId: 'test-session',
    payload: null,
    error: null,
    metadata: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function hookPartEvent(
  partType: string,
  partId: string,
  extra?: Record<string, unknown>
): FredoEvent {
  return makeEvent({
    toolName: 'message.part.updated',
    // Match OpenCodeAdapter actual output: properties unwrapped, part at top level
    payload: {
      part: { type: partType, id: partId, sessionID: 'test-session', messageID: 'msg-1', ...extra },
    },
  });
}

function fileEditedEvent(filePath: string): FredoEvent {
  return makeEvent({
    toolName: 'file.edited',
    payload: { properties: { file: filePath } },
  });
}

function assistantMessageWithTokens(input: number, output: number): FredoEvent {
  return makeEvent({
    toolName: 'message.updated',
    // Match OpenCodeAdapter actual output: properties unwrapped, info at top level
    payload: {
      info: {
        id: 'msg-assistant-1',
        role: 'assistant',
        sessionID: 'test-session',
        parentID: 'msg-user-1',
        tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), completed: Date.now() },
      },
    },
  });
}

function userMessageEvent(): FredoEvent {
  return makeEvent({
    toolName: 'message.updated',
    // Match OpenCodeAdapter actual output: properties unwrapped, info at top level
    payload: {
      info: {
        id: 'msg-user-1',
        role: 'user',
        sessionID: 'test-session',
        parentID: '',
        tokens: null,
        time: { created: Date.now() },
      },
    },
  });
}

function otlpTokenEvent(input: number, output: number): FredoEvent {
  return makeEvent({
    toolName: 'message.updated',
    transport: 'otlp_grpc',
    payload: {
      gen_ai: {
        usage: { input_tokens: input, output_tokens: output },
      },
    },
    metadata: {
      attributes: { 'gen_ai.system': 'open_code' },
    },
  });
}

function fileEditedEventPayloadFilePath(filePath: string): FredoEvent {
  return makeEvent({
    toolName: 'file.edited',
    payload: { file_path: filePath },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('computeSessionCounters', () => {
  it('returns zero counters for empty events', () => {
    const result = computeSessionCounters([]);
    expect(result).toEqual({ tools: 0, files: 0, subagents: 0, tokens: 0 });
  });

  it('counts unique tool calls from message.part.updated with tool type', () => {
    const events = [
      hookPartEvent('tool', 'tool-1'),
      hookPartEvent('tool', 'tool-2'),
      hookPartEvent('tool', 'tool-3'),
    ];
    const result = computeSessionCounters(events);
    expect(result.tools).toBe(3);
  });

  it('deduplicates tool calls by part.id', () => {
    const events = [
      hookPartEvent('tool', 'tool-1'),
      hookPartEvent('tool', 'tool-1'), // duplicate
      hookPartEvent('tool', 'tool-2'),
    ];
    const result = computeSessionCounters(events);
    expect(result.tools).toBe(2);
  });

  it('counts unique file paths from file.edited events (properties.file)', () => {
    const events = [
      fileEditedEvent('src/main.rs'),
      fileEditedEvent('src/lib.rs'),
    ];
    const result = computeSessionCounters(events);
    expect(result.files).toBe(2);
  });

  it('deduplicates file paths', () => {
    const events = [
      fileEditedEvent('src/main.rs'),
      fileEditedEvent('src/main.rs'), // duplicate
    ];
    const result = computeSessionCounters(events);
    expect(result.files).toBe(1);
  });

  it('counts file paths from payload.file_path fallback', () => {
    const events = [
      fileEditedEventPayloadFilePath('/tmp/test.txt'),
    ];
    const result = computeSessionCounters(events);
    expect(result.files).toBe(1);
  });

  it('counts unique subagents from message.part.updated with agent type', () => {
    const events = [
      hookPartEvent('agent', 'agent-1'),
      hookPartEvent('agent', 'agent-2'),
    ];
    const result = computeSessionCounters(events);
    expect(result.subagents).toBe(2);
  });

  it('counts unique subagents from message.part.updated with subtask type', () => {
    const events = [
      hookPartEvent('subtask', 'subtask-1'),
    ];
    const result = computeSessionCounters(events);
    expect(result.subagents).toBe(1);
  });

  it('deduplicates subagent calls by part.id', () => {
    const events = [
      hookPartEvent('agent', 'agent-1'),
      hookPartEvent('agent', 'agent-1'), // duplicate
    ];
    const result = computeSessionCounters(events);
    expect(result.subagents).toBe(1);
  });

  it('sums tokens from hook path (payload.properties.info.tokens)', () => {
    const events = [
      assistantMessageWithTokens(100, 50),
      assistantMessageWithTokens(200, 75),
    ];
    const result = computeSessionCounters(events);
    // Total: (100+50) + (200+75) = 425
    expect(result.tokens).toBe(425);
  });

  it('ignores user message.updated events (no tokens)', () => {
    const events = [
      userMessageEvent(),
      assistantMessageWithTokens(100, 50),
    ];
    const result = computeSessionCounters(events);
    expect(result.tokens).toBe(150);
  });

  it('falls back to OTLP path when hook tokens are absent', () => {
    const events = [
      otlpTokenEvent(300, 100),
    ];
    const result = computeSessionCounters(events);
    expect(result.tokens).toBe(400);
  });

  it('prefers hook path over OTLP path when both present', () => {
    // Event with both hook tokens AND OTLP gen_ai fields
    // Adapter-unwrapped shape: info at payload top level, no properties wrapper
    const events = [
      makeEvent({
        toolName: 'message.updated',
        transport: 'otlp_grpc',
        payload: {
          info: {
            id: 'msg-assistant-1',
            role: 'assistant',
            sessionID: 'test-session',
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          gen_ai: {
            usage: { input_tokens: 999, output_tokens: 999 }, // should be ignored
          },
        },
      }),
    ];
    const result = computeSessionCounters(events);
    // Hook path takes precedence: 100 + 50 = 150
    expect(result.tokens).toBe(150);
  });

  it('accumulates counters across multiple events (integration)', () => {
    const events: FredoEvent[] = [
      // Turn 1
      userMessageEvent(),
      hookPartEvent('text', 'part-text-1', { text: 'Hello', messageID: 'msg-user-1' }),
      hookPartEvent('reasoning', 'part-reason-1', { text: 'thinking...' }),
      hookPartEvent('tool', 'tool-1'),
      hookPartEvent('tool', 'tool-2'),
      hookPartEvent('text', 'part-text-2', { text: 'Response', messageID: 'msg-assistant-1' }),
      assistantMessageWithTokens(150, 60),
      fileEditedEvent('src/main.rs'),

      // Turn 2
      hookPartEvent('text', 'part-text-3', { text: 'Follow-up', messageID: 'msg-user-2' }),
      hookPartEvent('tool', 'tool-1'),       // same tool, dedup
      hookPartEvent('tool', 'tool-3'),       // new tool
      hookPartEvent('agent', 'agent-1'),
      hookPartEvent('subtask', 'subtask-1'),
      assistantMessageWithTokens(80, 20),
      fileEditedEvent('src/main.rs'),        // same file, dedup
      fileEditedEvent('src/lib.rs'),         // new file
    ];

    const result = computeSessionCounters(events);
    // Tools: tool-1, tool-2, tool-3 = 3
    expect(result.tools).toBe(3);
    // Files: src/main.rs, src/lib.rs = 2
    expect(result.files).toBe(2);
    // Subagents: agent-1, subtask-1 = 2
    expect(result.subagents).toBe(2);
    // Tokens: (150+60) + (80+20) = 310
    expect(result.tokens).toBe(310);
  });

  it('handles events with null payload gracefully', () => {
    const events = [
      makeEvent({ toolName: 'message.part.updated', payload: null }),
      makeEvent({ toolName: 'file.edited', payload: null }),
    ];
    const result = computeSessionCounters(events);
    expect(result).toEqual({ tools: 0, files: 0, subagents: 0, tokens: 0 });
  });

  it('handles events with empty or missing properties', () => {
    const events = [
      makeEvent({ toolName: 'message.part.updated', payload: { properties: {} } }),
      makeEvent({ toolName: 'file.edited', payload: { properties: {} } }),
    ];
    const result = computeSessionCounters(events);
    expect(result).toEqual({ tools: 0, files: 0, subagents: 0, tokens: 0 });
  });

  // ── Bug 2 regression: adapter-unwrapped payloads (no properties wrapper) ──

  it('should count tools from adapter-unwrapped payload (payload.part, not payload.properties.part)', () => {
    // This is the ACTUAL shape the OpenCodeAdapter produces.
    // Bug 2 was caused by looking at payload.properties.part which is undefined.
    const events = [
      makeEvent({
        toolName: 'message.part.updated',
        payload: {
          // No 'properties' wrapper — adapter unwraps it. This is the real shape.
          part: { type: 'tool', id: 'tool-real-1', sessionID: 'test-session', messageID: 'msg-1' },
        },
      }),
    ];
    const result = computeSessionCounters(events);
    expect(result.tools).toBe(1);
  });

  it('should count tokens from adapter-unwrapped payload (payload.info, not payload.properties.info)', () => {
    const events = [
      makeEvent({
        toolName: 'message.updated',
        payload: {
          // No 'properties' wrapper — real adapter output
          info: {
            id: 'msg-a1', role: 'assistant', sessionID: 'test-session',
            tokens: { input: 42, output: 10 },
          },
        },
      }),
    ];
    const result = computeSessionCounters(events);
    expect(result.tokens).toBe(52);
  });

  it('should count subagents from adapter-unwrapped part payload', () => {
    const events = [
      makeEvent({
        toolName: 'message.part.updated',
        payload: {
          part: { type: 'agent', id: 'agent-1', sessionID: 'test-session', messageID: 'msg-1' },
        },
      }),
    ];
    const result = computeSessionCounters(events);
    expect(result.subagents).toBe(1);
  });

  // ── Backward compatibility: legacy properties-wrapped payloads ──

  it('should still count tools from legacy-wrapped payload (payload.properties.part)', () => {
    const events = [
      makeEvent({
        toolName: 'message.part.updated',
        payload: {
          properties: {
            part: { type: 'tool', id: 'tool-legacy-1', sessionID: 'test-session', messageID: 'msg-1' },
          },
        },
      }),
    ];
    const result = computeSessionCounters(events);
    expect(result.tools).toBe(1);
  });

  it('should still count tokens from legacy-wrapped payload (payload.properties.info)', () => {
    const events = [
      makeEvent({
        toolName: 'message.updated',
        payload: {
          properties: {
            info: {
              id: 'msg-a1', role: 'assistant', sessionID: 'test-session',
              tokens: { input: 30, output: 15 },
            },
          },
        },
      }),
    ];
    const result = computeSessionCounters(events);
    expect(result.tokens).toBe(45);
  });
});

// ── formatTokenCount tests ─────────────────────────────────────────────────────

describe('formatTokenCount', () => {
  // AC-2: Given token counts of 0, 420, 1840, and 2500000
  // formatTokenCount returns "0", "420", "1.8k", and "2.5M" respectively

  it('returns raw number for values < 1K (AC-2)', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(420)).toBe('420');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('returns "k" format for values >= 1K and < 1M (AC-2)', () => {
    expect(formatTokenCount(1_000)).toBe('1k');
    expect(formatTokenCount(1_840)).toBe('1.8k');
    expect(formatTokenCount(10_000)).toBe('10k');
    expect(formatTokenCount(42_000)).toBe('42k');
    expect(formatTokenCount(999_949)).toBe('999.9k');
  });

  it('returns "M" format for values >= 1M (AC-2)', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
    expect(formatTokenCount(1_234_567)).toBe('1.2M');
    expect(formatTokenCount(10_500_000)).toBe('10.5M');
  });

  it('strips trailing .0 in k and M formats (AC-2)', () => {
    expect(formatTokenCount(2_000_000)).toBe('2M');
    expect(formatTokenCount(3_500_000)).toBe('3.5M');
    expect(formatTokenCount(1_000)).toBe('1k');
  });
});
