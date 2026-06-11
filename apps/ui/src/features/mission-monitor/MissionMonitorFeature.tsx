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
 * Non-target events that are explicitly excluded from the Mission Monitor.
 * These represent internal orchestration, tool results, commands, and other
 * events that are not conversation content per REQ-1.
 */
const NON_TARGET_EVENT_NAMES = new Set([
  'PostToolUse',
  'TaskCreated',
  'session.next.text.started',
  'session.idle',
  'todo.updated',
  'permission',
  'elicitation',
  'command.executed',
]);

/**
 * Matches only REQ-1 event categories: session lifecycle, user messages,
 * agent thinking, agent response, and counting events.
 *
 * Session lifecycle and chat events are matched primarily by FredoEvent.eventType
 * (`agent_session` and `chat` respectively). For events with other eventTypes
 * (e.g. `tool_use`), the event name (toolName or payload.event_type) is checked
 * against known session / user-prompt / counting patterns.
 *
 * Non-target events are explicitly excluded even if they would otherwise match
 * a category pattern.
 */
function isTargetEvent(event: FredoEvent): boolean {
  // ── Resolve the event name from toolName or payload.event_type ────────
  const eventName = event.toolName ?? (event.payload?.event_type as string | undefined) ?? '';

  // ── Explicitly exclude non-target events ──────────────────────────────
  if (NON_TARGET_EVENT_NAMES.has(eventName)) return false;

  // ── REQ-1: Session lifecycle ─────────────────────────────────────────
  if (event.eventType === 'agent_session') return true;

  // ── REQ-1: User messages, Agent thinking, Agent response ──────────────
  if (event.eventType === 'chat') return true;

  // ── REQ-1: Session lifecycle (tool_use eventType with session name) ───
  if (/^Session/.test(eventName) || eventName.startsWith('session.')) return true;

  // ── REQ-1: User messages (tool_use eventType with UserPrompt name) ────
  if (/^UserPrompt/.test(eventName)) return true;

  // ── REQ-1: Counting events (token usage, cost tracking) ───────────────
  if (/^(count|token|cost|usage|metric)_/i.test(eventName)) return true;

  // ── All other events excluded ─────────────────────────────────────────
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
