/**
 * Wireframe view controls (Spec #3151, ST-5 — AC3 / R-3.4).
 *
 * Zoom out / Zoom in / Fit page / Reset view / Pan tool as a flat row. The
 * command bar was the only pointer entry for the view transforms, so this strip
 * re-homes them rather than letting the deletion lose the capability.
 *
 * Every control calls `runWireframeAction` — the ONE funnel that owns each
 * action's guard and the store-only view writes (`actions/wireframeViewActions.ts`);
 * nothing here touches the store directly and nothing duplicates a guard.
 *
 * Disabled rules are the DECLARED clamps (`model/geometry.ts` MIN/MAX_VIEW_SCALE):
 * at a limit another press is already a silent no-op, so the control says so.
 *
 * Pointer-only surface: no `role`, no roving `tabIndex`, no `onKeyDown`.
 */

import React, { useSyncExternalStore } from 'react';
import { Button, Flex, Icon } from '@chakra-ui/react';
import {
  LuHand,
  LuMaximize2,
  LuMinus,
  LuPlus,
  LuRotateCcw,
} from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import { runWireframeAction } from '../actions/wireframeActions';
import { MAX_VIEW_SCALE, MIN_VIEW_SCALE } from '../model/geometry';
import { getSnapshot, subscribe } from '../store/wireframeDocumentStore';
import { WIREFRAME_VIEW_ITEM_TESTID, WIREFRAME_VIEW_TESTID } from './wireframeControlIds';

export function WireframeViewControls(): React.ReactElement {
  const { view, panMode } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <Flex data-testid={WIREFRAME_VIEW_TESTID} gap={1} align="center" flexShrink={0}>
      <Button
        type="button"
        data-testid={WIREFRAME_VIEW_ITEM_TESTID}
        aria-label="Zoom out"
        disabled={view.scale <= MIN_VIEW_SCALE}
        onClick={() => runWireframeAction('wireframe.zoom.out')}
        size="sm"
        variant="ghost"
        px={2}
        minW={0}
        flexShrink={0}
        color="fg.default"
        _hover={{ bg: tint('var(--accent-primary)', 10) }}
        data-contrast-pair="control-ghost|active|label"
      >
        <Icon as={LuMinus} boxSize={4} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        data-testid={WIREFRAME_VIEW_ITEM_TESTID}
        aria-label="Zoom in"
        disabled={view.scale >= MAX_VIEW_SCALE}
        onClick={() => runWireframeAction('wireframe.zoom.in')}
        size="sm"
        variant="ghost"
        px={2}
        minW={0}
        flexShrink={0}
        color="fg.default"
        _hover={{ bg: tint('var(--accent-primary)', 10) }}
        data-contrast-pair="control-ghost|active|label"
      >
        <Icon as={LuPlus} boxSize={4} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        data-testid={WIREFRAME_VIEW_ITEM_TESTID}
        aria-label="Fit page"
        onClick={() => runWireframeAction('wireframe.view.fitPage')}
        size="sm"
        variant="ghost"
        px={2}
        minW={0}
        flexShrink={0}
        color="fg.default"
        _hover={{ bg: tint('var(--accent-primary)', 10) }}
        data-contrast-pair="control-ghost|active|label"
      >
        <Icon as={LuMaximize2} boxSize={4} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        data-testid={WIREFRAME_VIEW_ITEM_TESTID}
        aria-label="Reset view"
        onClick={() => runWireframeAction('wireframe.view.resetView')}
        size="sm"
        variant="ghost"
        px={2}
        minW={0}
        flexShrink={0}
        color="fg.default"
        _hover={{ bg: tint('var(--accent-primary)', 10) }}
        data-contrast-pair="control-ghost|active|label"
      >
        <Icon as={LuRotateCcw} boxSize={4} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        data-testid={WIREFRAME_VIEW_ITEM_TESTID}
        aria-label="Pan tool"
        aria-pressed={panMode}
        onClick={() => runWireframeAction('wireframe.view.togglePan')}
        size="sm"
        variant="ghost"
        px={2}
        minW={0}
        flexShrink={0}
        color="fg.default"
        bg={panMode ? tint('var(--accent-primary)', 18) : undefined}
        _hover={{ bg: tint('var(--accent-primary)', panMode ? 18 : 10) }}
        data-contrast-pair="control-ghost|active|label"
      >
        <Icon as={LuHand} boxSize={4} aria-hidden="true" />
      </Button>
    </Flex>
  );
}

export default WireframeViewControls;
