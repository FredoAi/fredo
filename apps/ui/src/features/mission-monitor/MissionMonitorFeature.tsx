import React from 'react';
import type { ReactElement } from 'react';
import type { IconType } from 'react-icons';
import { LuActivity } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { persistEvent } from './lib/sessionStorage';
import { MissionMonitorPanel } from './components/MissionMonitorPanel';

/** Extract the part type from a message part event payload (e.g. 'reasoning', 'text'). */
function extractPartType(payload: Record<string, unknown>): string {
  const props = payload.properties as Record<string, unknown> | undefined;
  const part = (props?.part ?? payload.part ?? {}) as Record<string, unknown>;
  return String(part.type ?? payload.type ?? '');
}

/**
 * Determine whether a message-part event should be processed.
 * Non-reasoning deltas are filtered out to prevent flooding the UI.
 */
function isTargetEvent(eventType: string, payload: Record<string, unknown>): boolean {
  // Reasoning updates are always accepted
  if (eventType === 'message.part.updated' && extractPartType(payload) === 'reasoning') return true;
  // Only reasoning-type deltas — prevents flood of text deltas
  if (eventType === 'message.part.delta' && extractPartType(payload) === 'reasoning') return true;
  return false;
}

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = 'mission-monitor';
  readonly name = 'Mission Monitor';
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;
  // Catch-all custom filter — we want every event so sessions accumulate
  // in the background even when the panel is closed.
  // Non-reasoning message.part.delta events are filtered out to prevent flooding.
  readonly eventFilters: EventFilter[] = [{
    custom: (event: FredoEvent) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const toolName = event.toolName ?? '';
      // Only message.part.delta events need targeted filtering
      if (toolName === 'message.part.delta') return isTargetEvent(toolName, payload);
      return true;
    }
  }];

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
