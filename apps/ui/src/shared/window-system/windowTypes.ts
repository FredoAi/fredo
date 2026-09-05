/**
 * Own window-kernel type surface (Spec #2807 ST-1).
 *
 * The drop-in model mirrors the third-party `@maomaolabs/core` window-engine
 * call-surface so feature callers need only an import swap. `OpenWindowParams`
 * is what a consumer passes to `openWindow`; `WindowEntry` is what the store
 * holds and what `useWindows()` returns (all control flags resolved to
 * concrete booleans).
 */

import type { ReactNode } from 'react';

/** Params for `openWindow` — the consumer-facing dispatch shape. */
export interface OpenWindowParams {
  /** Stable kebab-case feature id (window key). */
  id: string;
  /** Window-header label AND aria-label. */
  title: string;
  /** Brand icon (feature.icon rendered at size 16). */
  icon: ReactNode;
  /** feature.render() content. */
  component: ReactNode;
  canClose?: boolean;
  canMaximize?: boolean;
  canMinimize?: boolean;
  isMaximized?: boolean;
}

/** The resolved in-store window entry — what `useWindows()` returns. */
export interface WindowEntry {
  id: string;
  title: string;
  icon: ReactNode;
  component: ReactNode;
  canClose: boolean;
  canMaximize: boolean;
  canMinimize: boolean;
  isMaximized: boolean;
  /** Toggled by the minimize control (R-6). */
  isMinimized: boolean;
  /** Top-of-z-order signal (R-6). */
  focused: boolean;
  zIndex: number;
}

/** The `useWindowActions` return shape — drop-in for the third-party hook. */
export interface WindowActions {
  openWindow(params: OpenWindowParams): void;
  /** Idempotent, re-entrancy-guarded. */
  closeWindow(id: string): void;
  /** Spread-merge (R-4) — NEVER full replacement. */
  updateWindow(id: string, patch: Partial<OpenWindowParams>): void;
  focusWindow(id: string, opts?: { minimize?: boolean; maximize?: boolean }): void;
}
