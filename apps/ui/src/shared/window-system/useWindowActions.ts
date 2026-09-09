/**
 * `useWindowActions` — drop-in for the third-party hook (Spec #2807 ST-1).
 *
 * Reads the window actions from the `WindowSystemProvider` context. Must be
 * used within a provider (matching the prior engine's requirement). The
 * returned object is a stable reference (the store functions are module-level
 * and never change identity).
 */

import { useContext } from 'react';
import { WindowSystemContext } from './WindowSystemProvider';
import type { WindowActions } from './windowTypes';

export type { WindowActions } from './windowTypes';

export function useWindowActions(): WindowActions {
  const context = useContext(WindowSystemContext);
  if (context === undefined) {
    throw new Error('useWindowActions must be used within a WindowSystemProvider');
  }
  return context;
}
