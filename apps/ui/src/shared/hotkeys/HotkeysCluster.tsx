/**
 * Spec #2960 ST-5 — the ONE shared top-left cluster for the S3 surfaces.
 *
 * ST-2/ST-3/ST-4 each shipped a surface that self-positioned `position: fixed`
 * at the same top-left anchor, so the regime chip, the discovery control, and the
 * first-run card overlapped each other. The plan intended ONE fixed flex column
 * (G-267 owner was missing); this component owns that placement so the three
 * surfaces render IN-FLOW inside it and stack instead of colliding.
 *
 * Placement (G-253): the container is `position: fixed; left: 12px;
 * top: measureTopOffsetPx()` — the top inset is DERIVED from the rendered
 * `.fredo-window__header` (never a nominal sum) — at `z-index:
 * REGIME_SIGNAL_Z_INDEX` (1310): above the launcher (1300), below which-key
 * (1400) / cheat sheet (1500). The cluster is a vertical flex column with a gap,
 * so the discovery panel / first-run card expand beneath the chip.
 *
 * Non-blocking: the container itself is `pointer-events: none` (it must never
 * swallow app clicks, not even in the gaps); each interactive surface re-enables
 * pointer events on its own subtree. The regime chip stays click-through.
 *
 * Mounted EXACTLY ONCE by `HotkeysProvider`. It holds no state of its own beyond
 * the derived inset and adds NO live region — the shared `hotkeys-announcer`
 * remains the only `[aria-live]` region.
 */

import React, { useLayoutEffect, useState } from 'react';
import { Box } from '@chakra-ui/react';

import { InputRegimeIndicator, REGIME_SIGNAL_Z_INDEX } from './InputRegimeIndicator';
import { KeysDiscovery } from './KeysDiscovery';
import { KeyboardIntro } from './KeyboardIntro';
import { measureTopOffsetPx, TOP_STACK_ANCHOR_X_PX } from './topStack';

// ── Binding contract (plan BINDING block + ST-5 adjudication) ────────────────

/** The ONE cluster container testid. */
export const HOTKEYS_CLUSTER_TESTID = 'hotkeys-cluster';
/** The vertical gap between the stacked surfaces (px). */
export const HOTKEYS_CLUSTER_GAP_PX = 8;

export interface HotkeysClusterProps {
  /** Test override for `prefers-reduced-motion`, forwarded to the surfaces. */
  readonly reducedMotion?: boolean;
}

/**
 * The single fixed top-left cluster. Renders the regime chip, the discovery
 * control, and the first-run card as in-flow flex children so they stack beneath
 * one another (never overlap).
 */
export function HotkeysCluster({ reducedMotion }: HotkeysClusterProps = {}): React.ReactElement {
  // Derived top inset (G-253): re-measure the rendered header on mount + resize.
  const [topPx, setTopPx] = useState<number>(() => measureTopOffsetPx());
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const update = (): void => setTopPx(measureTopOffsetPx());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return (
    <Box
      data-testid={HOTKEYS_CLUSTER_TESTID}
      style={{
        position: 'fixed',
        left: `${TOP_STACK_ANCHOR_X_PX}px`,
        top: `${topPx}px`,
        zIndex: REGIME_SIGNAL_Z_INDEX,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: `${HOTKEYS_CLUSTER_GAP_PX}px`,
      }}
    >
      <InputRegimeIndicator reducedMotion={reducedMotion} />
      <KeysDiscovery />
      <KeyboardIntro reducedMotion={reducedMotion} />
    </Box>
  );
}
