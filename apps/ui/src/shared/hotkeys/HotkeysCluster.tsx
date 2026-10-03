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
 * Spec #2960 round 2 (F-65) — collision-aware placement. The resting top-left
 * lane can hold a feature's OWN text field (Mission Monitor's session-filter
 * input), which the resting cluster would paint over. When a text control is
 * focused AND its rect intersects the cluster's RESTING box, the PURE
 * `resolveClusterTopPx` displaces the cluster vertically to clear it (prefer
 * below, else above, else documented degradation). The field is
 * `document.activeElement`'s rect; the cluster box is measured with `top` taken
 * as the RESTING top (no feedback from an already-displaced box). Recompute
 * triggers: mount, `textEntry` change, `focusin`/`focusout` (capture), `resize`.
 *
 * Mounted EXACTLY ONCE by `HotkeysProvider`. It holds no state of its own beyond
 * the resolved inset and adds NO live region — the shared `hotkeys-announcer`
 * remains the only `[aria-live]` region. No `document` `keydown` listener is added.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { Box } from '@chakra-ui/react';

import { InputRegimeIndicator, REGIME_SIGNAL_Z_INDEX } from './InputRegimeIndicator';
import { KeysDiscovery } from './KeysDiscovery';
import { KeyboardIntro } from './KeyboardIntro';
import { useFocusSnapshot } from './engine';
import {
  measureTopOffsetPx,
  resolveClusterTopPx,
  TOP_STACK_ANCHOR_X_PX,
  type RectLike,
} from './topStack';

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
  // The ONE focus source: `textEntry` tells us whether a text control is focused.
  const snapshot = useFocusSnapshot();
  const containerRef = useRef<HTMLDivElement>(null);
  // Resolved top inset (G-253 + F-65): the header-derived resting top unless a
  // focused text field intersects the resting box, in which case the resolver
  // displaces the cluster to clear it.
  const [topPx, setTopPx] = useState<number>(() => measureTopOffsetPx());

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;

    const update = (): void => {
      const restingTopPx = measureTopOffsetPx();
      const node = containerRef.current;
      if (node === null) {
        setTopPx(restingTopPx);
        return;
      }
      // The cluster's measured box, but with `top` taken as the RESTING top so an
      // already-displaced box never feeds back into the intersection test.
      const clusterRect = node.getBoundingClientRect();
      const active = typeof document === 'undefined' ? null : document.activeElement;
      const field: RectLike | null =
        snapshot.textEntry && active !== null ? active.getBoundingClientRect() : null;
      setTopPx(
        resolveClusterTopPx({
          restingTopPx,
          clusterLeftPx: TOP_STACK_ANCHOR_X_PX,
          clusterWidthPx: clusterRect.width,
          clusterHeightPx: clusterRect.height,
          field,
          viewportHeightPx: window.innerHeight,
        }),
      );
    };

    const onFocus = (event: FocusEvent): void => {
      // A `focusout` paired with a `focusin` on another element leaves
      // `document.activeElement` as `<body>` during the gap; skip the paired move
      // (the following `focusin` recomputes with the real new focus), matching the
      // engine's flicker-free focus tracking. A `focusout` to nothing still runs.
      if (event.type === 'focusout' && event.relatedTarget !== null) return;
      update();
    };

    update();
    window.addEventListener('resize', update);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onFocus, true);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onFocus, true);
    };
  }, [snapshot.textEntry]);

  return (
    <Box
      ref={containerRef}
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
