/**
 * Tests for sessionStorage.ts — primarily countEvent() classification.
 *
 * countEvent() is called internally by persistEvent(); we verify the
 * resulting session record counters to confirm correct classification.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { FredoEvent } from '../../../../shared/contexts/StreamContext';
import { persistEvent, loadSessions } from '../sessionStorage';

/** Build a minimal FredoEvent with defaults for testing */
function makeEvent(overrides: Partial<FredoEvent> & { sessionId: string }): FredoEvent {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    eventType: overrides.eventType ?? 'tool_use',
    state: overrides.state ?? 'Init',
    provider: overrides.provider ?? 'open_code',
    transport: overrides.transport ?? 'hook',
    sessionId: overrides.sessionId,
    toolName: overrides.toolName,
    payload: overrides.payload ?? null,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    correlationId: overrides.correlationId,
    error: overrides.error ?? null,
    metadata: overrides.metadata ?? null,
  };
}

describe('countEvent — hook-transported PreToolUse / PostToolUse fallback', () => {
  beforeEach(() => {
    // Clear localStorage between tests
    localStorage.clear();
  });

  it('BUG-CNT-1: fallback triggers when resolveEventName returns unknown name', () => {
    // Hook transport where payload has no event_type, toolName is an inner tool name
    // that doesn't match any known category — falls through to the final fallback.
    const event = makeEvent({
      id: 'e1',
      sessionId: 's-fallback',
      eventType: 'tool_use',
      state: 'Init',
      toolName: 'Bash',
      payload: { command: 'ls -la' }, // no event_type field
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].toolCount).toBe(1);
    expect(sessions[0].fileCount).toBe(0);
    expect(sessions[0].subagentCount).toBe(0);
    expect(sessions[0].tokenCount).toBe(0);
  });

  it('BUG-CNT-2: PreToolUse with non-file toolName increments toolCount', () => {
    // Bash is NOT in FILE_TOOL_NAMES → should increment toolCount
    const event = makeEvent({
      id: 'e2',
      sessionId: 's-tool',
      eventType: 'tool_use',
      state: 'Init',
      toolName: 'Bash',
      payload: { command: 'echo hello' },
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions[0].toolCount).toBe(1);
    expect(sessions[0].fileCount).toBe(0);
  });

  it('BUG-CNT-2: PreToolUse with file toolName apply_patch increments fileCount', () => {
    // apply_patch IS in FILE_TOOL_NAMES → should increment fileCount
    const event = makeEvent({
      id: 'e3',
      sessionId: 's-file',
      eventType: 'tool_use',
      state: 'Init',
      toolName: 'apply_patch',
      payload: { patch: '--- a/src/main.ts' },
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions[0].toolCount).toBe(0);
    expect(sessions[0].fileCount).toBe(1);
  });

  it('BUG-CNT-2: PreToolUse with file toolName str_replace_editor increments fileCount', () => {
    // str_replace_editor IS in FILE_TOOL_NAMES → should increment fileCount
    const event = makeEvent({
      id: 'e4',
      sessionId: 's-file2',
      eventType: 'tool_use',
      state: 'Init',
      toolName: 'str_replace_editor',
      payload: { old_string: 'foo', new_string: 'bar' },
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions[0].toolCount).toBe(0);
    expect(sessions[0].fileCount).toBe(1);
  });

  it('BUG-CNT-3: PostToolUse with file toolName apply_patch increments fileCount', () => {
    // PostToolUse events (state='Response') should also be counted by the fallback
    const event = makeEvent({
      id: 'e5',
      sessionId: 's-posttool',
      eventType: 'tool_use',
      state: 'Response',
      toolName: 'apply_patch',
      payload: { patch: '--- a/file.txt' },
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions[0].toolCount).toBe(0);
    expect(sessions[0].fileCount).toBe(1);
  });

  it('BUG-CNT-4: OTLP execute_tool events are NOT double-counted', () => {
    // OTLP transport: toolName='execute_tool', with payload.tool_name='Bash'
    // This should match the existing name === 'execute_tool' check (line 138)
    // and NOT reach the final fallback.
    const event = makeEvent({
      id: 'e6',
      sessionId: 's-otlp',
      eventType: 'tool_use',
      state: 'Init',
      transport: 'otlp_grpc',
      toolName: 'execute_tool',
      payload: { tool_name: 'Bash', arguments: 'ls' },
    });

    persistEvent(event);

    // Should be counted as a tool (non-file) via the existing execute_tool handler
    const sessions = loadSessions();
    expect(sessions[0].toolCount).toBe(1);
    expect(sessions[0].fileCount).toBe(0);
  });

  it('BUG-CNT-4: OTLP execute_tool with file tool increments fileCount', () => {
    // OTLP execute_tool with payload.tool_name='apply_patch' → should use existing
    // handler to check FILE_TOOL_NAMES and count as file
    const event = makeEvent({
      id: 'e7',
      sessionId: 's-otlp-file',
      eventType: 'tool_use',
      state: 'Init',
      transport: 'otlp_grpc',
      toolName: 'execute_tool',
      payload: { tool_name: 'apply_patch', patch: '--- a/file.txt' },
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions[0].toolCount).toBe(0);
    expect(sessions[0].fileCount).toBe(1);
  });

  it('BUG-CNT-5: existing counting for chat is unaffected', () => {
    // Chat events should still be counted by the existing handler
    const event = makeEvent({
      id: 'e8',
      sessionId: 's-chat',
      eventType: 'chat',
      state: 'Update',
      toolName: 'chat',
      transport: 'otlp_grpc',
      payload: {
        'gen_ai.usage.input_tokens': 50,
        'gen_ai.usage.output_tokens': 100,
      },
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions[0].toolCount).toBe(0);
    expect(sessions[0].fileCount).toBe(0);
    expect(sessions[0].subagentCount).toBe(0);
    expect(sessions[0].tokenCount).toBe(150);
  });

  it('BUG-CNT-5: existing counting for SubagentStart is unaffected', () => {
    const event = makeEvent({
      id: 'e9',
      sessionId: 's-subagent',
      eventType: 'tool_use',
      state: 'Init',
      toolName: 'SubagentStart',
      payload: { agent_name: 'planner' },
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions[0].subagentCount).toBe(1);
    expect(sessions[0].toolCount).toBe(0);
  });

  it('BUG-CNT-5: existing counting for file.edited is unaffected', () => {
    const event = makeEvent({
      id: 'e10',
      sessionId: 's-fileedited',
      eventType: 'tool_use',
      state: 'Update',
      toolName: 'file.edited',
      payload: { path: '/tmp/test.txt' },
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions[0].fileCount).toBe(1);
    expect(sessions[0].toolCount).toBe(0);
  });

  it('BUG-CNT-5: existing PreToolUse via payload.event_type still works', () => {
    // Hook transport with event_type='PreToolUse' and payload.tool_name='Bash'
    // (non-file) → should match existing PreToolUse check
    const event = makeEvent({
      id: 'e11',
      sessionId: 's-pretool-payload',
      eventType: 'tool_use',
      state: 'Init',
      toolName: 'Bash',
      payload: {
        event_type: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: 'ls',
      },
    });

    persistEvent(event);
    const sessions = loadSessions();
    expect(sessions[0].toolCount).toBe(1);
    expect(sessions[0].fileCount).toBe(0);
  });
});
