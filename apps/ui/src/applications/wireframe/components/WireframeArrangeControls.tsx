/**
 * Wireframe arrange controls (Spec #3151, ST-5 — AC3 / R-3.4).
 *
 * The twelve arrangement rows the command bar was the only pointer entry for:
 * the `Element` group (Delete / Duplicate), `Group` (Group / Ungroup / Lock
 * group), `Align` (left / centre / right / Distribute), `Order` (Bring forward /
 * Send backward) and `Snap` (Snap to grid).
 *
 * Every row calls `runWireframeAction(id)` — the ONE existing funnel that owns
 * each action's guard and the store mutation. This component duplicates no
 * mutation rule; it only computes the DISABLED state so the user can see what
 * the current selection supports before acting (the shipped decision to keep the
 * trigger enabled — never disabled — so the "why is this unavailable" answer is
 * one click away).
 *
 * The disabled predicates are the declared model helpers (`canAlign`,
 * `canDistribute`, `isElementMovable`, `isWholeGroupSelection`, `groupOfElement`)
 * — the same rules the actions themselves enforce, read from the store snapshot.
 *
 * Pointer-only surface: no `role`, no roving `tabIndex`, no `onKeyDown`; the
 * menu is reached by ordinary Tab and operated by the platform's own menu
 * semantics inside the popup.
 */

import React, { useSyncExternalStore } from 'react';
import { Button, Icon, Menu, Portal, Text } from '@chakra-ui/react';
import { LuShapes } from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import { runWireframeAction } from '../actions/wireframeActions';
import { canAlign, canDistribute } from '../model/arrange';
import { isElementMovable, isWholeGroupSelection } from '../model/document';
import {
  getSnapshot,
  groupOfElement,
  subscribe,
} from '../store/wireframeDocumentStore';
import {
  WIREFRAME_ARRANGE_ITEM_TESTID,
  WIREFRAME_ARRANGE_TESTID,
} from './wireframeControlIds';

interface ArrangeDisabled {
  readonly emptySelection: boolean;
  readonly group: boolean;
  readonly touchesGroup: boolean;
  readonly align: boolean;
  readonly distribute: boolean;
}

/** The declared disabled predicates for the current selection. */
function deriveDisabled(state: ReturnType<typeof getSnapshot>): ArrangeDisabled {
  const { document, selectedIds } = state;
  const selected = new Set(selectedIds);
  const selectedElements = document.elements.filter((element) => selected.has(element.id));
  const movableCount = selectedElements.filter((element) =>
    isElementMovable(document, element),
  ).length;
  const touchesGroup = selectedElements.some(
    (element) => groupOfElement(document, element.id) !== null,
  );

  return {
    emptySelection: selectedIds.length === 0,
    group: !(selectedIds.length >= 2 && !isWholeGroupSelection(document, selectedIds)),
    touchesGroup: !touchesGroup,
    align: !canAlign(movableCount),
    distribute: !canDistribute(movableCount),
  };
}

/** Shared menu-item chrome (the shipped insert-menu idiom). */
const ITEM_PROPS = {
  fontSize: 'xs',
  color: 'fg.default',
  px: 3,
  py: '4px',
  borderRadius: 'xs',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  _highlighted: { bg: 'bg.hover' },
  _disabled: { color: 'fg.subtle', cursor: 'not-allowed' },
} as const;

function ArrangeItem({
  label,
  disabled,
  onRun,
}: {
  label: string;
  disabled?: boolean;
  onRun: () => void;
}): React.ReactElement {
  return (
    <Menu.Item
      value={label}
      data-testid={WIREFRAME_ARRANGE_ITEM_TESTID}
      disabled={disabled}
      onSelect={onRun}
      {...ITEM_PROPS}
    >
      {label}
    </Menu.Item>
  );
}

export function WireframeArrangeControls(): React.ReactElement {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const disabled = deriveDisabled(state);
  const run = (id: string) => (): void => {
    runWireframeAction(id);
  };

  return (
    <Menu.Root positioning={{ placement: 'bottom-end' }}>
      <Menu.Trigger asChild>
        <Button
          type="button"
          data-testid={WIREFRAME_ARRANGE_TESTID}
          aria-label="Arrange"
          aria-haspopup="menu"
          size="sm"
          variant="ghost"
          gap={1.5}
          px={2}
          minW={0}
          flexShrink={0}
          color="fg.default"
          _hover={{ bg: tint('var(--accent-primary)', 10) }}
          data-contrast-pair="control-ghost|active|label"
        >
          <Icon as={LuShapes} boxSize={4} aria-hidden="true" />
          <Text as="span" fontSize="xs">
            Arrange
          </Text>
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content
            aria-label="Arrange"
            minWidth="10rem"
            bg="bg.surface"
            borderColor="border.default"
            borderWidth="1px"
            borderRadius="sm"
            boxShadow="md"
            py={1}
          >
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel fontSize="xs" color="fg.muted">
                Element
              </Menu.ItemGroupLabel>
              <ArrangeItem
                label="Delete"
                disabled={disabled.emptySelection}
                onRun={run('wireframe.element.delete')}
              />
              <ArrangeItem
                label="Duplicate"
                disabled={disabled.emptySelection}
                onRun={run('wireframe.element.duplicate')}
              />
            </Menu.ItemGroup>
            <Menu.Separator />
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel fontSize="xs" color="fg.muted">
                Group
              </Menu.ItemGroupLabel>
              <ArrangeItem
                label="Group"
                disabled={disabled.group}
                onRun={run('wireframe.arrange.group')}
              />
              <ArrangeItem
                label="Ungroup"
                disabled={disabled.touchesGroup}
                onRun={run('wireframe.arrange.ungroup')}
              />
              <ArrangeItem
                label="Lock group"
                disabled={disabled.touchesGroup}
                onRun={run('wireframe.arrange.toggleGroupLock')}
              />
            </Menu.ItemGroup>
            <Menu.Separator />
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel fontSize="xs" color="fg.muted">
                Align
              </Menu.ItemGroupLabel>
              <ArrangeItem
                label="Align left"
                disabled={disabled.align}
                onRun={run('wireframe.arrange.alignLeft')}
              />
              <ArrangeItem
                label="Align centre"
                disabled={disabled.align}
                onRun={run('wireframe.arrange.alignCenter')}
              />
              <ArrangeItem
                label="Align right"
                disabled={disabled.align}
                onRun={run('wireframe.arrange.alignRight')}
              />
              <ArrangeItem
                label="Distribute"
                disabled={disabled.distribute}
                onRun={run('wireframe.arrange.distribute')}
              />
            </Menu.ItemGroup>
            <Menu.Separator />
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel fontSize="xs" color="fg.muted">
                Order
              </Menu.ItemGroupLabel>
              <ArrangeItem
                label="Bring forward"
                disabled={disabled.emptySelection}
                onRun={run('wireframe.arrange.bringForward')}
              />
              <ArrangeItem
                label="Send backward"
                disabled={disabled.emptySelection}
                onRun={run('wireframe.arrange.sendBackward')}
              />
            </Menu.ItemGroup>
            <Menu.Separator />
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel fontSize="xs" color="fg.muted">
                Snap
              </Menu.ItemGroupLabel>
              <Menu.CheckboxItem
                value="Snap to grid"
                data-testid={WIREFRAME_ARRANGE_ITEM_TESTID}
                checked={state.snapToGrid}
                onCheckedChange={() => runWireframeAction('wireframe.arrange.toggleSnap')}
                closeOnSelect={false}
                {...ITEM_PROPS}
              >
                Snap to grid
              </Menu.CheckboxItem>
            </Menu.ItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export default WireframeArrangeControls;
