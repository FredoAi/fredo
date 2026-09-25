/**
 * Spec #2946 ST-4 — the app-shell mount point for the ONE hotkey engine.
 *
 * Mounted once in `apps/ui/src/main.tsx` INSIDE the shared provider stack, so
 * both Tauri webviews (the main window and `index.html?view=terminal`) run the
 * same dispatcher (the terminal route renders `TerminalWindow` instead of
 * `Home`, so a `Home`-scoped mount would never reach it).
 *
 * It installs the single `document` keydown listener (idempotent — React
 * StrictMode's double effect cannot double-fire a chord), hydrates the keymap
 * document from the backend KV, and renders the ONE shared polite announcer
 * (`HotkeyAnnouncer`, ST-3), the which-key pending-sequence overlay
 * (`WhichKeyOverlay`, ST-5) and the app-wide cheat-sheet overlay
 * (`CheatSheetOverlay`, ST-14). It holds no key state and subscribes to nothing,
 * so it never re-renders the feature tree.
 */

import React, { useEffect } from 'react';

import { HotkeyAnnouncer } from './announcer';
import { CheatSheetOverlay } from './CheatSheetOverlay';
import { installHotkeyEngine } from './engine';
import { hydrateKeymap } from './store';
import { WhichKeyOverlay } from './WhichKeyOverlay';

export interface HotkeysProviderProps {
  readonly children?: React.ReactNode;
}

/** Mounts the dispatch engine + the single announcement region. */
export function HotkeysProvider({ children }: HotkeysProviderProps) {
  useEffect(() => {
    const uninstall = installHotkeyEngine();
    // Read the persisted keymap once; the store is dirty-guarded and a read
    // failure degrades to the shipped defaults (never throws).
    void hydrateKeymap();
    return uninstall;
  }, []);

  return (
    <>
      {children}
      <HotkeyAnnouncer />
      <WhichKeyOverlay />
      <CheatSheetOverlay />
    </>
  );
}
