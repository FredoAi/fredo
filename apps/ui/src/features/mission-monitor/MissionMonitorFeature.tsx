import React from 'react';
import type { ReactElement } from 'react';
import type { IconType } from 'react-icons';
import { LuActivity } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { persistEvent } from './lib/sessionStorage';
import { MissionMonitorPanel } from './components/MissionMonitorPanel';

/**
 * Resolve the canonical event name from a FredoEvent.
 * Hook-transport events carry event_type inside payload; fallback to toolName.
 * Strips model suffixes (e.g. "chat claude-sonnet-4-20250514" → "chat").
 */
export function normalizeEventName(event: FredoEvent): string {
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

/**
 * Extract the nested `role` from a FredoEvent payload.
 * Checks both `payload.properties.info.role` and `payload.info.role`.
 */
export function extractRole(payload: Record<string, unknown>): string {
  const props = payload.properties as Record<string, unknown> | undefined;
  const info = props?.info ?? payload.info ?? {};
  return (info as Record<string, unknown>).role as string ?? payload.role as string ?? '';
}

/**
 * Extract the nested `part.type` from a FredoEvent payload.
 * Checks both `payload.properties.part.type` and `payload.part.type`.
 */
export function extractPartType(payload: Record<string, unknown>): string {
  const props = payload.properties as Record<string, unknown> | undefined;
  const part = (props?.part ?? payload.part ?? {}) as Record<string, unknown>;
  return String(part.type ?? payload.type ?? '');
}

/**
 * Positive-match event filter for REQ-1.
 *
 * Only accepts events explicitly matching one of the five accepted categories:
 *   1. Session lifecycle (SessionStart, session.created, session.deleted)
 *   2. User messages (UserPromptSubmit, UserPromptSubmitted, UserPromptExpansion, message.updated role=user)
 *   3. Agent thinking (message.part.updated part.type=reasoning, message.part.delta)
 *   4. Agent response (chat, invoke_agent, message.updated role=assistant, message.part.updated part.type=text)
 *   5. Counting events (PreToolUse*, execute_tool*, file.edited, SubagentStart)
 *
 * All other events — including session.idle, session.next.*, todo.updated,
 * permission, elicitation, command.executed, PostToolUse, PostToolBatch,
 * SubagentStop, message.removed, TaskCreated, etc. — are REJECTED.
 */
export function isTargetEvent(event: FredoEvent): boolean {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const eventType = normalizeEventName(event);

  // ── BUG-F1.1: Session lifecycle events ────────────────────────────────
  if (eventType === 'SessionStart' || eventType === 'session.created' || eventType === 'session.deleted') {
    return true;
  }

  // ── BUG-F1.2: User message events ─────────────────────────────────────
  if (eventType === 'UserPromptSubmit' || eventType === 'UserPromptSubmitted' || eventType === 'UserPromptExpansion') {
    return true;
  }
  if (eventType === 'message.updated' && extractRole(payload) === 'user') {
    return true;
  }

  // ── BUG-F1.3: Agent thinking events ───────────────────────────────────
  if (eventType === 'message.part.updated' && extractPartType(payload) === 'reasoning') {
    return true;
  }
  if (eventType === 'message.part.delta' && extractPartType(payload) === 'reasoning') {
    return true;
  }

  // ── BUG-F1.4: Agent response events ───────────────────────────────────
  if (eventType === 'chat' || eventType === 'invoke_agent') {
    return true;
  }
  if (eventType === 'message.updated' && extractRole(payload) === 'assistant') {
    return true;
  }
  if (eventType === 'message.part.updated' && extractPartType(payload) === 'text') {
    return true;
  }

  // ── BUG-F1.5: Counting events ─────────────────────────────────────────
  if (eventType.startsWith('PreToolUse') || eventType.startsWith('execute_tool')) {
    return true;
  }
  if (eventType === 'file.edited' || eventType === 'SubagentStart') {
    return true;
  }

  // ── BUG-F1.6: ALL OTHER events REJECTED ──────────────────────────────
  return false;
}

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = 'mission-monitor';
  readonly name = 'Mission Monitor';
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;
  // Selective filter — only events matching REQ-1 categories are processed.
  readonly eventFilters: EventFilter[] = [{ custom: isTargetEvent }];

  processEvent(event: FredoEvent): void {
    // Persist to localStorage immediately (pure, no React state).
    persistEvent(event);
    // Re-render the panel if it is open.
    this.forceRerender?.();
  }

  render(): ReactElement {
    return <MissionMonitorPanel />;
  }
}

export const missionMonitorFeature = new MissionMonitorFeature();
