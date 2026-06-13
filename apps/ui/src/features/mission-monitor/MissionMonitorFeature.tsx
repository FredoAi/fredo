import React from 'react';
import type { ReactElement } from 'react';
import type { IconType } from 'react-icons';
import { LuActivity } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { persistEvent } from './lib/sessionStorage';
import { MissionMonitorPanel } from './components/MissionMonitorPanel';

// ── Event type helpers ──────────────────────────────────────────────

/**
 * Normalize an event type string to a canonical form.
 * Currently a pass-through; may be extended for case/hyphen normalization.
 */
export function normalizeEventName(eventType: string): string {
  return eventType;
}

/**
 * Extract the `role` field from a FredoEvent's payload.
 */
export function extractRole(event: FredoEvent): string {
  return (event.payload?.role as string) ?? '';
}

/**
 * Extract the `partType` field from a FredoEvent's payload.
 */
export function extractPartType(event: FredoEvent): string {
  return (event.payload?.partType as string) ?? '';
}

/**
 * Check whether a raw event type should be processed as a user-prompt
 * target event. Returns `true` only for `UserPromptSubmit` and
 * `UserPromptSubmitted`.
 *
 * Uses `normalizeEventName()` so that future normalisation (case,
 * hyphen → camelCase) works automatically.
 */
export function isTargetEvent(eventType: string): boolean {
  const normalized = normalizeEventName(eventType);
  return normalized === 'UserPromptSubmit' || normalized === 'UserPromptSubmitted';
}

// ── Feature class ───────────────────────────────────────────────────

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = 'mission-monitor';
  readonly name = 'Mission Monitor';
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;
  // Catch-all custom filter — we want every event so sessions accumulate
  // in the background even when the panel is closed.
  readonly eventFilters: EventFilter[] = [{ custom: () => true }];

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
