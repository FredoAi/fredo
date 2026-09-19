/**
 * DesktopBackdrop — the full-bleed desktop background layer (Spec #2899 ST-3).
 *
 * Renders the user's selected background descriptor as an inert layer at the
 * BOTTOM of the desktop stack (`zIndex 0` in the `Home.tsx` desktop box, before
 * `<WindowManager/>` whose container is `zIndex 1`). Because it is strictly
 * below the window stack it can never paint above a window (AC4 / R-4.1), and
 * it is `pointerEvents="none"` + `aria-hidden` with no handlers and no
 * `tabIndex`, so it never receives pointer or keyboard input (R-4.2).
 *
 * `none` renders `null` — ZERO new DOM — keeping the shipped default path
 * byte-identical to pre-#2899 (R-1.3). The paint for a selected descriptor comes
 * verbatim from the registry (`getBackgroundDescriptor(id).css`), which is a
 * pure function of the live theme CSS vars, so it recolors without a restart
 * (R-2.1).
 *
 * Mount-time hydration: the desktop shell owns this component unconditionally,
 * so its mount effect restores the persisted selection on boot (mirrors the
 * `DockPositionSettings.tsx:80-82` pattern; idempotent + dirty-guarded in the
 * store, so a late read never clobbers an in-flight selection).
 */

import React, { useEffect } from 'react';
import { Box } from '@chakra-ui/react';

import { getBackgroundDescriptor } from './backgroundRegistry';
import { hydrateBackground, useBackgroundId } from './backgroundStore';

export const DesktopBackdrop: React.FC = () => {
  const backgroundId = useBackgroundId();

  // Restore the persisted selection once, when the desktop shell mounts. The
  // store is idempotent + dirty-guarded, so this is safe on every remount.
  useEffect(() => {
    void hydrateBackground();
  }, []);

  // Default path: no extra DOM at all.
  if (backgroundId === 'none') return null;

  return (
    <Box
      data-testid="desktop-backdrop"
      aria-hidden="true"
      position="absolute"
      inset={0}
      zIndex={0}
      pointerEvents="none"
      css={getBackgroundDescriptor(backgroundId).css}
    />
  );
};
