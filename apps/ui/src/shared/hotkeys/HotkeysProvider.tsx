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
 * (`WhichKeyOverlay`, ST-5), the app-wide cheat-sheet overlay
 * (`CheatSheetOverlay`, ST-14), the ONE transient context-change indicator
 * (`ContextIndicator`, Spec #2958 ST-4), the S2 keyboard bar and the ONE S3
 * top-left cluster (`HotkeysCluster`, Spec #2960 ST-5 — the regime chip, the
 * zero-knowledge discovery control, and the first-run card, mounted exactly once
 * as in-flow children). It holds no key state and subscribes to nothing, so it
 * never re-renders the feature tree.
 */

import React, { useEffect } from 'react';

import { HotkeyAnnouncer } from './announcer';
import { CheatSheetOverlay } from './CheatSheetOverlay';
import { ContextIndicator } from './ContextIndicator';
import { installHotkeyEngine } from './engine';
import { HotkeysCluster } from './HotkeysCluster';
import { KeyboardBar } from './KeyboardBar';
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
      <ContextIndicator />
      <KeyboardBar />
      <HotkeysCluster />
    </>
  );
}
