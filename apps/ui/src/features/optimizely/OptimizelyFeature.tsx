import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { LuFlag } from 'react-icons/lu';
import type { FeatureHotkeyAction } from '../../shared/hotkeys/types';
import { OptimizelyFlagsPanel } from './components/OptimizelyFlagsPanel';
import {
  dispatchOptimizelyAction,
  isOptimizelyActionAvailable,
  OPTIMIZELY_COLLAPSE_ALL_ACTION_ID,
  OPTIMIZELY_EXPAND_ALL_ACTION_ID,
  OPTIMIZELY_FOCUS_SEARCH_ACTION_ID,
  OPTIMIZELY_REFRESH_ACTION_ID,
} from './lib/hotkeyBridge';

export class OptimizelyFeature extends FredoFeatureClass {
  readonly id = 'optimizely';
  readonly name = 'Feature Flags';
  readonly icon = LuFlag;
  readonly showable = false;

  readonly gridConfig = { closable: true, maximizable: true };

  /**
   * Spec #2961 ST-2 (AC1/AC2/AC5): the Feature Flags app's LOCAL hotkeys,
   * declared through the platform contract (discovered/listed/rebound by the
   * platform — no listing code here). Each `run` dispatches a namespaced event
   * the mounted `OptimizelyFlagsPanel` maps onto its existing
   * `refetch`/search-focus/`expandAll`/`collapseAll` operations, so `run` is a
   * safe no-op while the feature is closed (R-5.4). `collapseAll` is gated by
   * the panel-published, module-scoped availability (AC5).
   */
  readonly hotkeys: readonly FeatureHotkeyAction[] = [
    {
      actionId: OPTIMIZELY_REFRESH_ACTION_ID,
      title: 'Refresh flags',
      description: 'Refetch the feature flag list',
      defaultSequence: 'r',
      run: () => dispatchOptimizelyAction(OPTIMIZELY_REFRESH_ACTION_ID),
    },
    {
      actionId: OPTIMIZELY_FOCUS_SEARCH_ACTION_ID,
      title: 'Focus flag search',
      description: 'Focus the flag search input',
      defaultSequence: 's',
      run: () => dispatchOptimizelyAction(OPTIMIZELY_FOCUS_SEARCH_ACTION_ID),
    },
    {
      actionId: OPTIMIZELY_EXPAND_ALL_ACTION_ID,
      title: 'Expand all flags',
      description: 'Expand every flag group',
      defaultSequence: 'e',
      run: () => dispatchOptimizelyAction(OPTIMIZELY_EXPAND_ALL_ACTION_ID),
    },
    {
      actionId: OPTIMIZELY_COLLAPSE_ALL_ACTION_ID,
      title: 'Collapse all flags',
      description: 'Collapse every flag group',
      defaultSequence: 'c',
      enabled: () => isOptimizelyActionAvailable(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID),
      unavailableReason: 'Nothing is expanded',
      run: () => dispatchOptimizelyAction(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID),
    },
  ];

  render() {
    return <OptimizelyFlagsPanel />;
  }

  onMount() {
    console.log('[OptimizelyFeature] Mounted');
  }

  onUnmount() {
    console.log('[OptimizelyFeature] Unmounted');
  }
}

export const optimizelyFeature = new OptimizelyFeature();
