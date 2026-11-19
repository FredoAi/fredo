/**
 * Platform-chord host (Spec #3151 ST-4) — mounts the ONE re-homed platform-chord listener for
 * a webview's lifetime.
 *
 * Mounted once per webview (the main one and the `?view=terminal` one, both through
 * `apps/ui/src/main.tsx`), replacing the retired navigation shell provider. The mount effect
 * installs the listener and the unmount effect releases it; children render unchanged, so the
 * host is layout-neutral.
 *
 * The listener itself is reference counted (`installPlatformChords`), so React StrictMode's
 * double effect and any accidental second mount still yield exactly ONE listener.
 */

import React, { useEffect } from 'react';

import { installPlatformChords } from './platformChords';

export interface PlatformChordHostProps {
  readonly children?: React.ReactNode;
}

/**
 * Install the platform-chord listener for this host's mounted lifetime. Children render
 * unchanged (fragment pass-through — no wrapper element, no layout shift).
 */
export function PlatformChordHost({ children }: PlatformChordHostProps): React.ReactElement {
  useEffect(() => installPlatformChords(), []);

  return <>{children}</>;
}
