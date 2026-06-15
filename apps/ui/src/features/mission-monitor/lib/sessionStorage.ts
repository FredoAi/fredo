/**
 * sessionStorage.ts — pure localStorage helpers for Mission Monitor.
 *
 * Sessions are keyed by event.sessionId (the field on every StreamEvent).
 * persistEvent() is called directly from MissionMonitorFeature.processEvent(),
 * which runs for EVERY event — even when the panel is closed — so sessions
 * accumulate in the background automatically.
 */
import type { FredoEvent, StreamEvent } from '../../../shared/contexts/StreamContext';
import { FILE_TOOL_NAMES } from '../types';

const SESSIONS_KEY = 'mm:sessions';
const MAX_SESSIONS = 50;

export interface SessionRecord {
  sessionId: string;
  /** Human-readable locale date/time of the first event seen */
  label: string;
  startTime: number;
  endTime?: number;
  eventCount: number;
  /** Count of generic tool uses (non-file tools) */
  toolCount?: number;
  /** Count of file edits/creates/writes */
  fileCount?: number;
  /** Count of subagent starts */
  subagentCount?: number;
  /** Total tokens (input + output) accumulated from chat/invoke_agent events */
  tokenCount?: number;
}

function eventsKey(sessionId: string): string {
  return `mm:events:${sessionId}`;
}

export function loadSessions(): SessionRecord[] {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionRecord[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    console.warn('[MissionMonitor] Could not persist sessions');
  }
}

export function getSessionEvents(sessionId: string): FredoEvent[] {
  try {
    const raw = localStorage.getItem(eventsKey(sessionId)) ?? '[]';
    // Legacy sessions stored StreamEvent shape — migrate on read
    const arr = JSON.parse(raw) as any[];
    return arr.map((e) => ({
      id: e.eventId ?? e.id ?? crypto.randomUUID(),
      eventType: (e.eventType as FredoEvent['eventType']) ?? 'tool_use',
      state: e.state ?? 'Update',
      provider: (e.provider as FredoEvent['provider']) ?? 'open_code',
      // Prefer FredoEvent transport field; fall back to legacy source field
      transport: (e.transport as FredoEvent['transport'])
        ?? (e.source === 'otlpGrpc' ? 'otlp_grpc'
          : e.source === 'otlpHttp' ? 'otlp_http'
            : 'hook') as FredoEvent['transport'],
      sessionId: e.sessionId ?? sessionId,
      correlationId: e.correlationId,
      toolName: e.toolName,
      // Prefer FredoEvent payload; fall back to legacy StreamEvent fields
      payload: (e.payload as Record<string, unknown> | null)
        ?? e.input ?? e.response ?? e.data ?? null,
      error: e.error ?? null,
      // Prefer FredoEvent metadata; fall back to legacy otlp field
      metadata: (e.metadata as Record<string, unknown> | null) ?? e.otlp ?? null,
      timestamp: e.timestamp ?? new Date().toISOString(),
    }));
  } catch (err) {
    console.error('[MM] getSessionEvents parse failed for session:', sessionId, err);
    return [];
  }
}

/**
 * Resolve the canonical event name from a FredoEvent.
 * Hook-transport events carry event_type inside payload; fallback to toolName.
 * Strips model suffixes (e.g. "chat claude-sonnet-4-20250514" → "chat").
 */
function resolveEventName(event: FredoEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const hookEventType =
    typeof payload.event_type === 'string' ? payload.event_type : undefined;
  const rawType: string = hookEventType ?? event.toolName ?? '';

  // Normalize: strip model suffixes
  return (
    rawType === 'invoke_agent' || rawType.startsWith('invoke_agent ') ? 'invoke_agent' :
    rawType === 'execute_tool' || rawType.startsWith('execute_tool ') ? 'execute_tool' :
    rawType === 'chat' || rawType.startsWith('chat ') ? 'chat' :
    rawType
  );
}

/** Classify an event and return counter increments */
function countEvent(event: FredoEvent): {
  toolDelta: number;
  fileDelta: number;
  subagentDelta: number;
  tokenDelta: number;
} {
  const name = resolveEventName(event);
  const payload = event.payload ?? {};

  // ── Token accumulation: chat / invoke_agent / chat.message ──────────
  if (name === 'chat' || name === 'invoke_agent' || name === 'chat.message') {
    // 1. OTLP format
    let inputTokens: number =
      typeof payload['gen_ai.usage.input_tokens'] === 'number'
        ? (payload['gen_ai.usage.input_tokens'] as number)
        : 0;
    let outputTokens: number =
      typeof payload['gen_ai.usage.output_tokens'] === 'number'
        ? (payload['gen_ai.usage.output_tokens'] as number)
        : 0;

    // 2. Fallback: hook-format tokens.input / tokens.output (nested object)
    if (inputTokens === 0 && outputTokens === 0) {
      const tokens = payload.tokens as Record<string, unknown> | undefined;
      if (typeof tokens?.input === 'number') inputTokens = tokens.input;
      if (typeof tokens?.output === 'number') outputTokens = tokens.output;
    }

    // 3. Fallback: hook-format usage.total_tokens (flat usage object)
    if (inputTokens === 0 && outputTokens === 0) {
      const usage = payload.usage as Record<string, unknown> | undefined;
      if (typeof usage?.total_tokens === 'number') {
        inputTokens = usage.total_tokens;
      }
    }

    return { toolDelta: 0, fileDelta: 0, subagentDelta: 0, tokenDelta: inputTokens + outputTokens };
  }

  // ── SubagentStart → subagent count ──────────────────────────────────
  if (name === 'SubagentStart') {
    return { toolDelta: 0, fileDelta: 0, subagentDelta: 1, tokenDelta: 0 };
  }

  // ── file.edited → file count ────────────────────────────────────────
  if (name === 'file.edited') {
    return { toolDelta: 0, fileDelta: 1, subagentDelta: 0, tokenDelta: 0 };
  }

  // ── PreToolUse / execute_tool — distinguish file tools from generic ─
  if (name === 'PreToolUse' || name === 'execute_tool') {
    // Strip suffix from inner tool_name too (e.g. 'str_replace_editor some/path' → 'str_replace_editor')
    const innerToolName: string =
      typeof payload.tool_name === 'string'
        ? (payload.tool_name as string).split(' ')[0]
        : '';
    if (FILE_TOOL_NAMES.has(innerToolName)) {
      return { toolDelta: 0, fileDelta: 1, subagentDelta: 0, tokenDelta: 0 };
    }
    return { toolDelta: 1, fileDelta: 0, subagentDelta: 0, tokenDelta: 0 };
  }

  // ── Fallback: prefix matching for any unhandled name formats ─────────
  if (name.startsWith('chat ') || name.startsWith('invoke_agent ') || name.startsWith('chat.message ')) {
    // 1. OTLP format
    let inputTokens: number =
      typeof payload['gen_ai.usage.input_tokens'] === 'number'
        ? (payload['gen_ai.usage.input_tokens'] as number)
        : 0;
    let outputTokens: number =
      typeof payload['gen_ai.usage.output_tokens'] === 'number'
        ? (payload['gen_ai.usage.output_tokens'] as number)
        : 0;

    // 2. Fallback: hook-format tokens.input / tokens.output (nested object)
    if (inputTokens === 0 && outputTokens === 0) {
      const tokens = payload.tokens as Record<string, unknown> | undefined;
      if (typeof tokens?.input === 'number') inputTokens = tokens.input;
      if (typeof tokens?.output === 'number') outputTokens = tokens.output;
    }

    // 3. Fallback: hook-format usage.total_tokens (flat usage object)
    if (inputTokens === 0 && outputTokens === 0) {
      const usage = payload.usage as Record<string, unknown> | undefined;
      if (typeof usage?.total_tokens === 'number') {
        inputTokens = usage.total_tokens;
      }
    }

    return { toolDelta: 0, fileDelta: 0, subagentDelta: 0, tokenDelta: inputTokens + outputTokens };
  }

  if (name.startsWith('SubagentStart ')) {
    return { toolDelta: 0, fileDelta: 0, subagentDelta: 1, tokenDelta: 0 };
  }

  if (name.startsWith('file.edited ')) {
    return { toolDelta: 0, fileDelta: 1, subagentDelta: 0, tokenDelta: 0 };
  }

  if (name.startsWith('PreToolUse ') || name.startsWith('execute_tool ')) {
    const innerToolName: string =
      typeof payload.tool_name === 'string'
        ? (payload.tool_name as string).split(' ')[0]
        : name.split(' ')[0];
    if (FILE_TOOL_NAMES.has(innerToolName)) {
      return { toolDelta: 0, fileDelta: 1, subagentDelta: 0, tokenDelta: 0 };
    }
    return { toolDelta: 1, fileDelta: 0, subagentDelta: 0, tokenDelta: 0 };
  }

  // ── Final fallback: hook-transported PreToolUse/PostToolUse where
  // the adapter sets toolName to the inner tool name (e.g. "Bash")
  // without preserving event_type in the payload.
  if (event.eventType === 'tool_use' && (event.state === 'Init' || event.state === 'Response')) {
    const innerName = event.toolName ?? '';
    if (FILE_TOOL_NAMES.has(innerName)) {
      return { toolDelta: 0, fileDelta: 1, subagentDelta: 0, tokenDelta: 0 };
    }
    return { toolDelta: 1, fileDelta: 0, subagentDelta: 0, tokenDelta: 0 };
  }

  return { toolDelta: 0, fileDelta: 0, subagentDelta: 0, tokenDelta: 0 };
}

/**
 * Persist a single event.  Creates or upserts the session record automatically
 * using event.sessionId — no SessionStart event required.
 *
 * Stores events in FredoEvent shape (or legacy StreamEvent with migration on read).
 * Safe to call outside React (no hooks). Called from MissionMonitorFeature.processEvent().
 */
export function persistEvent(event: FredoEvent): void {
  if (!event.sessionId) return;

  const sessionId = event.sessionId;
  const deltas = countEvent(event);

  // ── Append event (deduplicate by id / composite key) ──────────────────
  try {
    const existing = getSessionEvents(sessionId);
    const dedupeKey =
      event.id ?? `${event.toolName ?? ''}:${event.state}:${event.timestamp}`;
    const alreadyStored = existing.some((e) => {
      const k = e.id ?? `${e.toolName ?? ''}:${e.state}:${e.timestamp}`;
      return k === dedupeKey;
    });
    if (!alreadyStored) {
      localStorage.setItem(eventsKey(sessionId), JSON.stringify([...existing, event]));
    }
  } catch {
    console.warn('[MissionMonitor] Could not store event');
    return;
  }

  // ── Upsert session record ──────────────────────────────────────────────────
  try {
    const sessions = loadSessions();
    const idx = sessions.findIndex((s) => s.sessionId === sessionId);
    const eventTime = new Date(event.timestamp).getTime();

    if (idx !== -1) {
      const prev = sessions[idx];
      sessions[idx] = {
        ...prev,
        eventCount: prev.eventCount + 1,
        startTime: Math.min(prev.startTime, eventTime),
        toolCount: (prev.toolCount ?? 0) + deltas.toolDelta,
        fileCount: (prev.fileCount ?? 0) + deltas.fileDelta,
        subagentCount: (prev.subagentCount ?? 0) + deltas.subagentDelta,
        tokenCount: (prev.tokenCount ?? 0) + deltas.tokenDelta,
      };
      saveSessions(sessions);
    } else {
      const newRecord: SessionRecord = {
        sessionId,
        label: new Date(eventTime).toLocaleString(),
        startTime: eventTime,
        eventCount: 1,
        toolCount: deltas.toolDelta,
        fileCount: deltas.fileDelta,
        subagentCount: deltas.subagentDelta,
        tokenCount: deltas.tokenDelta,
      };
      const next = [newRecord, ...sessions];
      // Prune oldest session when over cap
      if (next.length > MAX_SESSIONS) {
        const pruned = next.pop()!;
        try { localStorage.removeItem(eventsKey(pruned.sessionId)); } catch {}
      }
      saveSessions(next);
    }
  } catch {
    console.warn('[MissionMonitor] Could not upsert session record');
  }
}

export function finalizeSession(sessionId: string): void {
  try {
    const sessions = loadSessions().map((s) =>
      s.sessionId === sessionId && !s.endTime ? { ...s, endTime: Date.now() } : s
    );
    saveSessions(sessions);
  } catch {}
}

export function deleteSession(sessionId: string): void {
  try { localStorage.removeItem(eventsKey(sessionId)); } catch {}
  try {
    saveSessions(loadSessions().filter((s) => s.sessionId !== sessionId));
  } catch {}
}
