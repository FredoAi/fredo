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

/** Classify an event and return counter increments */
function countEvent(event: FredoEvent): {
  toolDelta: number;
  fileDelta: number;
  subagentDelta: number;
  tokenDelta: number;
} {
  const tn = event.toolName ?? '';
  const payload = event.payload ?? {};

  // chat / invoke_agent → accumulate tokens
  // Use prefix matching: real event toolNames carry suffixes e.g. 'chat claude-sonnet-4-20250514'
  if (tn === 'chat' || tn.startsWith('chat ') || tn === 'invoke_agent' || tn.startsWith('invoke_agent ')) {
    const inputTokens =
      typeof payload['gen_ai.usage.input_tokens'] === 'number'
        ? (payload['gen_ai.usage.input_tokens'] as number)
        : 0;
    const outputTokens =
      typeof payload['gen_ai.usage.output_tokens'] === 'number'
        ? (payload['gen_ai.usage.output_tokens'] as number)
        : 0;
    return { toolDelta: 0, fileDelta: 0, subagentDelta: 0, tokenDelta: inputTokens + outputTokens };
  }

  // SubagentStart → subagent count
  if (tn === 'SubagentStart' || tn.startsWith('SubagentStart ')) {
    return { toolDelta: 0, fileDelta: 0, subagentDelta: 1, tokenDelta: 0 };
  }

  // file.edited → file count
  if (tn === 'file.edited' || tn.startsWith('file.edited ')) {
    return { toolDelta: 0, fileDelta: 1, subagentDelta: 0, tokenDelta: 0 };
  }

  // PreToolUse / execute_tool — distinguish file tools from generic tools
  // Use prefix matching: real event toolNames carry suffixes e.g. 'PreToolUse read_file'
  if (tn === 'PreToolUse' || tn.startsWith('PreToolUse ') || tn === 'execute_tool' || tn.startsWith('execute_tool ')) {
    // Strip suffix from inner tool_name too (e.g. 'str_replace_editor some/path' → 'str_replace_editor')
    const innerToolName: string =
      typeof payload.tool_name === 'string'
        ? (payload.tool_name as string).split(' ')[0]
        : tn.split(' ')[0];
    if (FILE_TOOL_NAMES.has(innerToolName)) {
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
