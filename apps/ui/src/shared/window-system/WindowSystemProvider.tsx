/**
 * Own window-system provider (Spec #2807 ST-1).
 *
 * Provides the module-scoped kernel store's actions to the React tree. The
 * store itself is module-scoped (windowStore.ts) so the open-window list
 * survives React mount/unmount cycles; this provider is the single context
 * that surfaces the window actions to `useWindowActions`.
 *
 * NOTE: no `systemStyle` prop — single brand chrome only (R-9/AC4). A persisted
 * legacy `windowStyle` is never read here; the own kernel renders the one
 * brand chrome unconditionally.
 */

import React, { createContext, useMemo, type ReactElement, type ReactNode } from 'react';
import { openWindow, closeWindow, updateWindow, focusWindow } from './windowStore';
import type { WindowActions } from './windowTypes';

export interface WindowSystemContextValue extends WindowActions {}

export const WindowSystemContext = createContext<WindowSystemContextValue | undefined>(undefined);

export interface WindowSystemProviderProps {
  children: ReactNode;
  // NOTE: no `systemStyle` prop — single brand chrome only (R-9/AC4).
}

export function WindowSystemProvider(props: WindowSystemProviderProps): ReactElement {
  const { children } = props;
  const value = useMemo<WindowSystemContextValue>(
    () => ({ openWindow, closeWindow, updateWindow, focusWindow }),
    [],
  );
  return <WindowSystemContext.Provider value={value}>{children}</WindowSystemContext.Provider>;
}
