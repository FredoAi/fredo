/**
 * Spec #3009 ST-3 — the app-shell mount point for the ONE hotkey engine.
 *
 * Mounted once in the served Tauri entry INSIDE the shared provider stack, so
 * both webviews run the same dispatcher. It:
 *   - installs the ONE `document` keydown listener (idempotent),
 *   - installs the ONE `data-hotkey` element discovery (MutationObserver),
 *   - renders the ONE shared polite announcer (`HotkeyAnnouncer`),
 *   - renders the always-on bottom `HotkeyBar` from the live element listing.
 *
 * The retired surfaces (keymap hydration, which-key overlay, cheat sheet,
 * context indicator, keyboard-mode bar, top-left regime/discovery/first-run
 * cluster) are gone.
 */

import React, { useEffect, useMemo, useSyncExternalStore } from 'react';

import { HotkeyAnnouncer } from './announcer';
import { installHotkeyEngine, useFocusSnapshot, usePendingPrefix } from './engine';
import { HotkeyBar } from './HotkeyBar';
import { buildHotkeyBarModel } from './hotkeyBarModel';
import {
  getElementHotkeyRevision,
  installHotkeyElementDiscovery,
  listElementHotkeys,
  subscribeElementHotkeys,
} from './hotkeyElements';

export interface HotkeysProviderProps {
  readonly children?: React.ReactNode;
}

/**
 * The live element listing, re-rendering only when the discovery revision
 * advances (the listing array identity is stable between real diffs).
 */
function useElementHotkeys() {
  const revision = useSyncExternalStore(
    subscribeElementHotkeys,
    getElementHotkeyRevision,
    getElementHotkeyRevision,
  );
  return useMemo(() => listElementHotkeys(), [revision]);
}

/** Mounts the dispatch engine + element discovery + the single announcer + bar. */
export function HotkeysProvider({ children }: HotkeysProviderProps) {
  useEffect(() => {
    const uninstallEngine = installHotkeyEngine();
    const uninstallDiscovery = installHotkeyElementDiscovery();
    return () => {
      uninstallDiscovery();
      uninstallEngine();
    };
  }, []);

  const entries = useElementHotkeys();
  const pending = usePendingPrefix();
  const focus = useFocusSnapshot();
  const model = useMemo(
    () => buildHotkeyBarModel({ entries, pending, focus }),
    [entries, pending, focus],
  );

  return (
    <>
      {children}
      <HotkeyAnnouncer />
      <HotkeyBar model={model} />
    </>
  );
}
