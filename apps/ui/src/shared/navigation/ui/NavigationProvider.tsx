/**
 * Spec #3122 (P8), ST-1 — the ONE webview shell provider for the navigation layer.
 *
 * Mounted exactly once per webview (it replaced the retired shell provider in
 * `apps/ui/src/main.tsx` and `apps/tauri/src/main.tsx`). It:
 *   1. installs the ONE navigation chord dispatcher (`installNavigationKeyDispatch`) on mount
 *      and releases it on unmount, and
 *   2. renders exactly ONE `<NavigationAnnouncer />` — the single polite live region.
 *
 * A second mount is a documented defect signal (two announcers, never silently deduped). This
 * provider adds no other global listener and no chrome of its own.
 */

import React, { useEffect } from 'react';

import { NavigationAnnouncer } from './announce';
import { installNavigationKeyDispatch } from './globalKeys';

export interface NavigationProviderProps {
  readonly children?: React.ReactNode;
}

/**
 * Install the global chord dispatch and render the ONE navigation announcer. Children are
 * rendered unchanged so the provider can wrap the whole shell without altering layout.
 */
export function NavigationProvider({ children }: NavigationProviderProps): React.ReactElement {
  useEffect(() => installNavigationKeyDispatch(), []);

  return (
    <>
      {children}
      <NavigationAnnouncer />
    </>
  );
}
