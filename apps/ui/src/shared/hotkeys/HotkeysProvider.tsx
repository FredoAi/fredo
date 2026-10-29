/**
 * Spec #3009 ST-3 — the app-shell mount point for the ONE hotkey engine.
 *
 * Mounted once in the served Tauri entry INSIDE the shared provider stack, so
 * both webviews run the same dispatcher. It:
 *   - installs the ONE `document` keydown listener (idempotent),
 *   - installs the ONE `data-hotkey` element discovery (MutationObserver),
 *   - installs the application command-surface runtime (Spec #3097 ST-6),
 *   - renders the ONE shared polite announcer (`HotkeyAnnouncer`),
 *   - renders the always-on bottom `HotkeyBar` from the live element listing AND
 *     the focused application's active command mode / open inline prompt.
 *
 * The retired keyboard surfaces (the configurable hotkey platform and its
 * top-left chrome) are gone.
 *
 * Spec #3097 ST-6 wiring: the provider is the ONLY bridge between the
 * module-scoped command-surface store and the bar model. It derives the bar's
 * `activeMode`/`prompt` views from the store's stable snapshot (never from an
 * array `.length` or a freshly-created object dependency — AGENTS.md #523), and
 * in DEV it installs the fixture bridge (dynamic import ⇒ the fixture + bridge
 * are tree-shaken out of a production build). The props/mount contract is
 * unchanged (`servedEntryMount.test.ts`).
 */

import React, { useEffect, useMemo, useSyncExternalStore } from 'react';

import { HotkeyAnnouncer } from './announcer';
import { getApplicationCommandMode } from './commandSurface';
import {
  installCommandSurfaceRuntime,
  resolveCommandSurface,
  useCommandSurface,
} from './commandSurfaceStore';
import { installHotkeyEngine, useFocusSnapshot, usePendingPrefix } from './engine';
import { HotkeyBar } from './HotkeyBar';
import { buildHotkeyBarModel } from './hotkeyBarModel';
import type { HotkeyBarModeView, HotkeyBarPromptView } from './hotkeyBarModel';
import {
  getElementHotkeyRevision,
  installHotkeyElementDiscovery,
  listElementHotkeys,
  subscribeElementHotkeys,
} from './hotkeyElements';
import type { CommandSurfaceSnapshot } from './commandSurfaceStore';

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

/**
 * The focused application's active command mode as the bar's badge/rows view.
 * Derived from the store's STABLE snapshot (deps are the snapshot identity) so
 * the provider never re-renders as a loop.
 */
function useActiveModeView(snapshot: CommandSurfaceSnapshot): HotkeyBarModeView | null {
  return useMemo(() => {
    const { appId, modePath } = snapshot;
    if (appId === null || modePath.length === 0) return null;
    const surface = resolveCommandSurface(appId);
    if (surface === null) return null;
    const modeId = modePath[modePath.length - 1];
    const mode = getApplicationCommandMode(surface, modeId);
    if (mode === null) return null;
    return { appId, modeId, label: mode.label, path: modePath };
  }, [snapshot]);
}

/** The engine-owned inline prompt as the bar's prompt view (stable snapshot). */
function usePromptView(snapshot: CommandSurfaceSnapshot): HotkeyBarPromptView | null {
  return useMemo(() => {
    const { appId, prompt } = snapshot;
    if (appId === null || prompt === null) return null;
    return {
      appId,
      commandId: prompt.commandId,
      label: prompt.label,
      placeholder: prompt.placeholder,
      value: prompt.value,
    };
  }, [snapshot]);
}

/** Mounts the dispatch engine + element discovery + the single announcer + bar. */
export function HotkeysProvider({ children }: HotkeysProviderProps) {
  useEffect(() => {
    const uninstallEngine = installHotkeyEngine();
    const uninstallDiscovery = installHotkeyElementDiscovery();
    const uninstallCommandSurface = installCommandSurfaceRuntime();
    return () => {
      uninstallCommandSurface();
      uninstallDiscovery();
      uninstallEngine();
    };
  }, []);

  // DEV-only fixture bridge. The `import.meta.env.DEV` guard is statically
  // replaced, so a production build drops both the bridge and the fixture apps.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let uninstall: (() => void) | null = null;
    void import('./commandSurfaceFixtureBridge')
      .then((module) => {
        if (cancelled) return;
        uninstall = module.installCommandSurfaceFixtureBridge();
      })
      .catch(() => {
        // A DEV-only convenience seam must never break the app shell.
      });
    return () => {
      cancelled = true;
      uninstall?.();
    };
  }, []);

  const entries = useElementHotkeys();
  const pending = usePendingPrefix();
  const focus = useFocusSnapshot();
  const snapshot = useCommandSurface();
  const activeMode = useActiveModeView(snapshot);
  const prompt = usePromptView(snapshot);
  const model = useMemo(
    () => buildHotkeyBarModel({ entries, pending, focus, activeMode, prompt }),
    [entries, pending, focus, activeMode, prompt],
  );

  return (
    <>
      {children}
      <HotkeyAnnouncer />
      <HotkeyBar model={model} />
    </>
  );
}
