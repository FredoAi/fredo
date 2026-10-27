/**
 * Wireframe toolbar (Spec #3070, ST-3, UI/UX 2.1 / 2.2 / 3.13 / 3.14).
 *
 * Five groups in DOM order — Insert `1…9`, Element `p k l`, Edit `u y`,
 * View `m g n 0 h`, File `New o w t` — every control rendered from the ONE
 * `WIREFRAME_ACTIONS` table (see `actions/wireframeActions.ts`).
 *
 * The toolbar is `role="group"`, NOT `role="toolbar"`: every control stays an
 * ordinary Tab stop (predictable tab order; the hotkeys are the fast path) and
 * no roving-tabindex code is needed.
 *
 * Focus rules:
 * - `useWireframeHostFocused()` gates every `data-hotkey` (R-5.4) and the
 *   keychip's visibility (the slot stays reserved — no layout shift);
 * - a pointer activation blurs the control so the next bare key is in the
 *   `default` context (G-327 / UI/UX 3.14); a keyboard activation keeps focus
 *   so Tab order survives.
 *
 * Tokens only — semantic tokens plus the shared `tint()` helper.
 */

import React, { useSyncExternalStore } from 'react';
import { Box, Button, Dialog, Flex, HStack, Text } from '@chakra-ui/react';
import type { IconType } from 'react-icons';
import {
  LuCopy,
  LuDownload,
  LuFilePlus2,
  LuFolderOpen,
  LuHand,
  LuImage,
  LuLayoutPanelTop,
  LuLock,
  LuMaximize,
  LuMinus,
  LuPlus,
  LuRedo2,
  LuRectangleHorizontal,
  LuRotateCcw,
  LuSave,
  LuShapes,
  LuSquare,
  LuStar,
  LuTextCursorInput,
  LuTrash2,
  LuType,
  LuUndo2,
} from 'react-icons/lu';

import { useWireframeHostFocused } from '../hooks/useWireframeHostFocused';
import {
  addWireframeElement,
  runWireframeAction,
} from '../actions/wireframeActions';
import type {
  WireframeSectionPreset,
  WireframeShapeKind,
} from '../model/elements';
import { getSnapshot, subscribe } from '../store/wireframeDocumentStore';
import {
  WireframeActionButton,
  WireframeInsertMenu,
} from './WireframeInsertMenu';

/** Insert-group controls, in binding DOM order (`1`…`9`). */
const INSERT_GROUPS: readonly {
  type: 'text' | 'button' | 'input' | 'image' | 'icon' | 'card' | 'section' | 'shape' | 'line';
  label: string;
  actionId: string;
  icon: IconType;
}[] = [
  { type: 'text', label: 'Text', actionId: 'wireframe.add.text', icon: LuType },
  { type: 'button', label: 'Button', actionId: 'wireframe.add.button', icon: LuRectangleHorizontal },
  { type: 'input', label: 'Input', actionId: 'wireframe.add.input', icon: LuTextCursorInput },
  { type: 'image', label: 'Image', actionId: 'wireframe.add.image', icon: LuImage },
  { type: 'icon', label: 'Icon', actionId: 'wireframe.add.icon', icon: LuStar },
  { type: 'card', label: 'Card', actionId: 'wireframe.add.card', icon: LuSquare },
  { type: 'section', label: 'Section', actionId: 'wireframe.add.section', icon: LuLayoutPanelTop },
  { type: 'shape', label: 'Shape', actionId: 'wireframe.add.shape', icon: LuShapes },
  { type: 'line', label: 'Line', actionId: 'wireframe.add.line', icon: LuMinus },
];

const ELEMENT_ACTIONS: readonly { id: string; description: string; icon: IconType }[] = [
  { id: 'wireframe.element.duplicate', description: 'Duplicate', icon: LuCopy },
  { id: 'wireframe.element.delete', description: 'Delete', icon: LuTrash2 },
  { id: 'wireframe.element.toggleLock', description: 'Lock', icon: LuLock },
];

const EDIT_ACTIONS: readonly { id: string; description: string; icon: IconType }[] = [
  { id: 'wireframe.edit.undo', description: 'Undo', icon: LuUndo2 },
  { id: 'wireframe.edit.redo', description: 'Redo', icon: LuRedo2 },
];

/** View group in binding order: zoom out, zoom in, fit, reset, pan. */
const VIEW_ACTIONS: readonly { id: string; description: string; icon: IconType }[] = [
  { id: 'wireframe.zoom.out', description: 'Zoom out', icon: LuMinus },
  { id: 'wireframe.zoom.in', description: 'Zoom in', icon: LuPlus },
  { id: 'wireframe.view.fitPage', description: 'Fit page', icon: LuMaximize },
  { id: 'wireframe.view.resetView', description: 'Reset view', icon: LuRotateCcw },
  { id: 'wireframe.view.togglePan', description: 'Pan tool', icon: LuHand },
];

/** File group in binding order: New, open, save as, export PNG. */
const FILE_ACTIONS: readonly { id: string; description: string; icon: IconType }[] = [
  { id: 'wireframe.document.new', description: 'New', icon: LuFilePlus2 },
  { id: 'wireframe.file.open', description: 'Open', icon: LuFolderOpen },
  { id: 'wireframe.file.saveAs', description: 'Save As', icon: LuSave },
  { id: 'wireframe.file.exportPng', description: 'Export PNG', icon: LuDownload },
];

/** Group separator: one token-coloured rule, decorative only. */
function GroupSeparator(): React.ReactElement {
  return (
    <Box
      aria-hidden="true"
      w="1px"
      alignSelf="stretch"
      minH="24px"
      my="2px"
      mx={2}
      bg="border.subtle"
      flexShrink={0}
    />
  );
}

export function WireframeToolbar(): React.ReactElement {
  const { selectedId, canUndo, canRedo, panMode, status, dirty } =
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const focused = useWireframeHostFocused();

  const selectedElement =
    selectedId === null
      ? null
      : getSnapshot().document.elements.find((element) => element.id === selectedId) ?? null;
  const hasSelection = selectedElement !== null;
  const fileBusy = status !== 'idle';

  const [confirmNewOpen, setConfirmNewOpen] = React.useState(false);
  const cancelNewRef = React.useRef<HTMLButtonElement | null>(null);

  // Deterministic focus contract for the discard prompt: Cancel wins.
  React.useEffect(() => {
    if (!confirmNewOpen) return;
    const frame = window.requestAnimationFrame(() => cancelNewRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirmNewOpen]);

  /** Pointer activation returns focus to the `default` hotkey context. */
  const applyPostActivationFocus = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.detail > 0) event.currentTarget.blur();
    },
    [],
  );

  const activate = React.useCallback(
    (id: string) => (event: React.MouseEvent<HTMLButtonElement>) => {
      // A user-initiated New on a dirty document asks before discarding; the
      // table's `run` stays non-blocking for the Companion (ST-7).
      if (id === 'wireframe.document.new' && dirty) {
        setConfirmNewOpen(true);
        return;
      }
      runWireframeAction(id);
      applyPostActivationFocus(event);
    },
    [dirty, applyPostActivationFocus],
  );

  const isDisabled = React.useCallback(
    (id: string): boolean => {
      if (id === 'wireframe.edit.undo') return !canUndo;
      if (id === 'wireframe.edit.redo') return !canRedo;
      if (
        id === 'wireframe.element.duplicate' ||
        id === 'wireframe.element.delete' ||
        id === 'wireframe.element.toggleLock'
      ) {
        return !hasSelection;
      }
      if (id === 'wireframe.document.new' || id.startsWith('wireframe.file.')) {
        return fileBusy;
      }
      return false;
    },
    [canUndo, canRedo, hasSelection, fileBusy],
  );

  const isPressed = React.useCallback(
    (id: string): boolean | undefined => {
      if (id === 'wireframe.element.toggleLock') return selectedElement?.locked === true;
      if (id === 'wireframe.view.togglePan') return panMode;
      return undefined;
    },
    [selectedElement?.locked, panMode],
  );

  /** A menu pick is a pointer flow: drop focus so the next bare key fires. */
  const addFromMenu = React.useCallback((add: () => void) => {
    add();
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
    }, 0);
  }, []);

  const startNewDocument = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      setConfirmNewOpen(false);
      runWireframeAction('wireframe.document.new');
      if (event.detail > 0) {
        window.setTimeout(() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
        }, 0);
      }
    },
    [],
  );

  return (
    <Flex
      data-testid="wireframe-toolbar"
      role="group"
      aria-label="Wireframe tools"
      flexWrap="wrap"
      align="center"
      rowGap={1}
      columnGap={0}
      px={3}
      py={2}
      flexShrink={0}
      bg="bg.surface"
      borderBottomWidth="1px"
      borderColor="border.subtle"
    >
      <HStack gap={0.5} flexWrap="wrap" rowGap={1}>
        {INSERT_GROUPS.map((item) =>
          item.type === 'section' || item.type === 'shape' ? (
            <WireframeInsertMenu
              key={item.actionId}
              kind={item.type}
              focused={focused}
              onAddDefault={activate(item.actionId)}
              onAddOption={(value) =>
                addFromMenu(() => {
                  if (item.type === 'section') {
                    addWireframeElement('section', {
                      preset: value as WireframeSectionPreset,
                    });
                  } else {
                    addWireframeElement('shape', {
                      shape: value as WireframeShapeKind,
                    });
                  }
                })
              }
            />
          ) : (
            <WireframeActionButton
              key={item.actionId}
              actionId={item.actionId}
              label={item.label}
              description={item.label}
              icon={item.icon}
              density="full"
              focused={focused}
              disabled={isDisabled(item.actionId)}
              onActivate={activate(item.actionId)}
            />
          ),
        )}
      </HStack>

      <GroupSeparator />

      <HStack gap={0.5} flexWrap="wrap" rowGap={1}>
        {ELEMENT_ACTIONS.map((item) => (
          <WireframeActionButton
            key={item.id}
            actionId={item.id}
            label={item.description}
            description={item.description}
            icon={item.icon}
            density="compact"
            focused={focused}
            disabled={isDisabled(item.id)}
            pressed={isPressed(item.id)}
            onActivate={activate(item.id)}
          />
        ))}
      </HStack>

      <GroupSeparator />

      <HStack gap={0.5} flexWrap="wrap" rowGap={1}>
        {EDIT_ACTIONS.map((item) => (
          <WireframeActionButton
            key={item.id}
            actionId={item.id}
            label={item.description}
            description={item.description}
            icon={item.icon}
            density="compact"
            focused={focused}
            disabled={isDisabled(item.id)}
            onActivate={activate(item.id)}
          />
        ))}
      </HStack>

      <GroupSeparator />

      <HStack gap={0.5} flexWrap="wrap" rowGap={1}>
        {VIEW_ACTIONS.map((item) => (
          <WireframeActionButton
            key={item.id}
            actionId={item.id}
            label={item.description}
            description={item.description}
            icon={item.icon}
            density="compact"
            focused={focused}
            disabled={isDisabled(item.id)}
            pressed={isPressed(item.id)}
            onActivate={activate(item.id)}
          />
        ))}
      </HStack>

      <GroupSeparator />

      <HStack gap={0.5} flexWrap="wrap" rowGap={1}>
        {FILE_ACTIONS.map((item) => (
          <WireframeActionButton
            key={item.id}
            actionId={item.id}
            label={item.description}
            description={item.description}
            icon={item.icon}
            density="compact"
            focused={focused}
            disabled={isDisabled(item.id)}
            onActivate={activate(item.id)}
          />
        ))}
      </HStack>

      <Dialog.Root
        role="alertdialog"
        open={confirmNewOpen}
        onOpenChange={(details) => {
          if (!details.open) setConfirmNewOpen(false);
        }}
        initialFocusEl={() => cancelNewRef.current}
      >
        <Dialog.Backdrop bg="overlay.scrim" />
        <Dialog.Positioner>
          <Dialog.Content
            data-testid="wireframe-new-document-dialog"
            bg="bg.surface"
            borderWidth="1px"
            borderColor="border.default"
            borderRadius="md"
            boxShadow="shadow.dialog"
            maxW="md"
          >
            <Dialog.Header>
              <Dialog.Title color="fg.default" fontSize="md" fontWeight="600">
                Discard unsaved changes?
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text fontSize="sm" color="fg.default">
                Starting a new wireframe discards the current unsaved document.
              </Text>
            </Dialog.Body>
            <Dialog.Footer gap={2}>
              <Button
                ref={cancelNewRef}
                data-testid="wireframe-new-document-cancel"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmNewOpen(false)}
              >
                Cancel
              </Button>
              <Button
                data-testid="wireframe-new-document-discard"
                size="sm"
                bg="status.error"
                color="status.onSolids"
                onClick={startNewDocument}
              >
                Discard
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </Flex>
  );
}
