import React from 'react';
import type { ReactElement } from 'react';
import type { IconType } from 'react-icons';
import { LuActivity } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { persistEvent } from './lib/sessionStorage';
import { MissionMonitorPanel } from './components/MissionMonitorPanel';

export class MissionMonitorFeature extends FredoFeatureClass {
  readonly id = 'mission-monitor';
  readonly name = 'Mission Monitor';
  readonly icon: IconType = LuActivity;
  readonly isMultiWindow = false;
  readonly showable = true;
  // Catch-all custom filter — we want every event so sessions accumulate
  // in the background even when the panel is closed.
  readonly eventFilters: EventFilter[] = [{ custom: () => true }];

  processEvent(event: StreamEvent): void {
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
