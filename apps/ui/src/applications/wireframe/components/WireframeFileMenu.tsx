/**
 * Wireframe file menu (Spec #3151, ST-5 — AC3 / AC4 / R-3.4).
 *
 * `New` · `Open` · `Save As` · `Export PNG` as a menu. The command bar was the
 * only pointer entry for the file commands, so this re-homes them before the bar
 * is deleted.
 *
 * `New` is the ONE row whose shipped wiring cannot be copied verbatim: the shell's
 * dirty guard used to end in `performVerb` → `host.runVerb`, and the host dies in
 * this same sub-task. The shell now supplies `onNew`, which keeps the EXACT shipped
 * two-step shape — dirty ⇒ the discard dialog (`WireframeNewDocumentDialog` stays
 * mounted), clean ⇒ reset immediately — with the reset landing on
 * `runWireframeAction('wireframe.document.new')` → `resetForNewDocument()`. The
 * row is NEVER disabled: a clean document simply skips the prompt, and a
 * disabled row would hide why.
 *
 * The three I/O rows call the file handlers DIRECTLY (static import), so the
 * control never depends on the action table's `import.meta.glob` discovery seam.
 * `status !== 'idle'` mirrors the module's one-at-a-time in-flight lock, which is
 * set on the same tick before any await — so the menu can never start a second
 * concurrent file operation.
 *
 * Pointer-only surface: no `role`, no roving `tabIndex`, no `onKeyDown`.
 */

import React, { useSyncExternalStore } from 'react';
import { Button, Icon, Menu, Portal, Text } from '@chakra-ui/react';
import { LuFile } from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import { exportPng, openDocument, saveAs } from '../actions/wireframeFileActions';
import { getSnapshot, subscribe } from '../store/wireframeDocumentStore';
import {
  WIREFRAME_FILE_ITEM_TESTID,
  WIREFRAME_FILE_MENU_TESTID,
} from './wireframeControlIds';

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

export interface WireframeFileMenuProps {
  /**
   * The shell's dirty-discard path for `New` (the ONE place the reset is routed
   * through). A clean document simply resets; a dirty one opens the existing
   * `WireframeNewDocumentDialog` first.
   */
  readonly onNew: () => void;
}

export function WireframeFileMenu({ onNew }: WireframeFileMenuProps): React.ReactElement {
  const { status } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const busy = status !== 'idle';

  return (
    <Menu.Root positioning={{ placement: 'bottom-end' }}>
      <Menu.Trigger asChild>
        <Button
          type="button"
          data-testid={WIREFRAME_FILE_MENU_TESTID}
          aria-label="File"
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
          <Icon as={LuFile} boxSize={4} aria-hidden="true" />
          <Text as="span" fontSize="xs">
            File
          </Text>
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content
            aria-label="File"
            minWidth="10rem"
            bg="bg.surface"
            borderColor="border.default"
            borderWidth="1px"
            borderRadius="sm"
            boxShadow="md"
            py={1}
          >
            <Menu.Item
              value="New"
              data-testid={WIREFRAME_FILE_ITEM_TESTID}
              onSelect={onNew}
              {...ITEM_PROPS}
            >
              New
            </Menu.Item>
            <Menu.Item
              value="Open"
              data-testid={WIREFRAME_FILE_ITEM_TESTID}
              disabled={busy}
              onSelect={() => void openDocument()}
              {...ITEM_PROPS}
            >
              Open
            </Menu.Item>
            <Menu.Item
              value="Save As"
              data-testid={WIREFRAME_FILE_ITEM_TESTID}
              disabled={busy}
              onSelect={() => void saveAs()}
              {...ITEM_PROPS}
            >
              Save As
            </Menu.Item>
            <Menu.Item
              value="Export PNG"
              data-testid={WIREFRAME_FILE_ITEM_TESTID}
              disabled={busy}
              onSelect={() => void exportPng()}
              {...ITEM_PROPS}
            >
              Export PNG
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export default WireframeFileMenu;
