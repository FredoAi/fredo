/**
 * Wireframe history controls (Spec #3151, ST-5 — AC4 / R-4.1…R-4.3).
 *
 * Undo / Redo as a flat row of two icon buttons. The command bar was the only
 * pointer entry for these capabilities, so deleting it without this strip would
 * silently remove undo from the product (AC3's "no lost capability").
 *
 * Handlers go through `runWireframeAction` — the ONE funnel that already owns
 * each action's guard and the app-local bounded history (ST-3). No guard logic
 * and no store mutator is duplicated here.
 *
 * Pointer-only surface: no `role`, no roving `tabIndex`, no `onKeyDown`. Every
 * control is reached by ordinary Tab and activated by the platform's own
 * button semantics.
 */

import React, { useSyncExternalStore } from 'react';
import { Button, Flex, Icon } from '@chakra-ui/react';
import { LuRedo2, LuUndo2 } from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import { runWireframeAction } from '../actions/wireframeActions';
import { getSnapshot, subscribe } from '../store/wireframeDocumentStore';
import { WIREFRAME_REDO_TESTID, WIREFRAME_UNDO_TESTID } from './wireframeControlIds';

export function WireframeHistoryControls(): React.ReactElement {
  const { canUndo, canRedo } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <Flex gap={1} align="center" flexShrink={0}>
      <Button
        type="button"
        data-testid={WIREFRAME_UNDO_TESTID}
        aria-label="Undo"
        disabled={!canUndo}
        onClick={() => runWireframeAction('wireframe.edit.undo')}
        size="sm"
        variant="ghost"
        px={2}
        minW={0}
        flexShrink={0}
        color="fg.default"
        _hover={{ bg: tint('var(--accent-primary)', 10) }}
        data-contrast-pair="control-ghost|active|label"
      >
        <Icon as={LuUndo2} boxSize={4} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        data-testid={WIREFRAME_REDO_TESTID}
        aria-label="Redo"
        disabled={!canRedo}
        onClick={() => runWireframeAction('wireframe.edit.redo')}
        size="sm"
        variant="ghost"
        px={2}
        minW={0}
        flexShrink={0}
        color="fg.default"
        _hover={{ bg: tint('var(--accent-primary)', 10) }}
        data-contrast-pair="control-ghost|active|label"
      >
        <Icon as={LuRedo2} boxSize={4} aria-hidden="true" />
      </Button>
    </Flex>
  );
}

export default WireframeHistoryControls;
