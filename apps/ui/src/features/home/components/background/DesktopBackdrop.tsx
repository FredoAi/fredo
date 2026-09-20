/**
 * DesktopBackdrop — the full-bleed desktop background layer (Spec #2899 ST-3;
 * layered + animated in Spec #2905 ST-2/ST-3).
 *
 * Renders the user's selected descriptor as an inert layer at the BOTTOM of the
 * desktop stack (`zIndex 0` in the `Home.tsx` desktop box, before
 * `<WindowManager/>` whose container is `zIndex 1`). Because it is strictly
 * below the window stack it can never paint above a window, and it is
 * `pointerEvents="none"` + `aria-hidden` with no handlers and no `tabIndex`, so
 * it never receives pointer or keyboard input.
 *
 * Structure: the root paints the descriptor's GROUND (`descriptor.css`); one
 * absolutely positioned `[data-background-layer]` child paints each layer in
 * order. While animated, the root stamps `data-motion="animated"` and injects
 * the ONE motion stylesheet (`[data-testid="desktop-backdrop-motion-styles"]`)
 * and each animated layer carries its bounded inline `animation*` properties.
 * Animated layers are oversized by the shared `layerBoxStyle` geometry (so
 * travel never exposes an edge — G-169) and carry `data-motion-kind="<kind>"`.
 * Under reduced motion the root stamps `data-motion="static"`, the stylesheet is
 * NOT rendered, and no layer carries an animation property — the identical paint
 * with animations removed (not paused mid-frame); the overscan geometry stays.
 *
 * `none` renders `null` — ZERO new DOM — keeping the shipped default path
 * byte-identical to pre-#2899.
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
import {
  buildBackgroundMotionCss,
  MOTION_LAYER_CLASS,
  layerAnimationStyle,
  layerBoxStyle,
  useBackgroundMotion,
} from './backgroundMotion';

export const DesktopBackdrop: React.FC = () => {
  const backgroundId = useBackgroundId();
  const motion = useBackgroundMotion();

  // Restore the persisted selection once, when the desktop shell mounts. The
  // store is idempotent + dirty-guarded, so this is safe on every remount.
  useEffect(() => {
    void hydrateBackground();
  }, []);

  // Default path: no extra DOM at all.
  if (backgroundId === 'none') return null;

  const descriptor = getBackgroundDescriptor(backgroundId);
  const animated = motion === 'animated';

  return (
    <Box
      data-testid="desktop-backdrop"
      data-background-id={descriptor.id}
      data-motion={motion}
      aria-hidden="true"
      position="absolute"
      inset={0}
      zIndex={0}
      pointerEvents="none"
      css={descriptor.css}
    >
      {animated && (
        <style data-testid="desktop-backdrop-motion-styles">
          {buildBackgroundMotionCss(descriptor.layers)}
        </style>
      )}
      {descriptor.layers.map((layer) => (
        <Box
          key={layer.id}
          data-background-layer={layer.id}
          data-motion-kind={layer.motion?.kind}
          className={MOTION_LAYER_CLASS}
          position="absolute"
          pointerEvents="none"
          css={{ ...layer.css, ...layerBoxStyle(layer) }}
          style={
            animated && layer.motion
              ? layerAnimationStyle({ id: layer.id, motion: layer.motion })
              : undefined
          }
        />
      ))}
    </Box>
  );
};
