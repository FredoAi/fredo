/**
 * Wireframe editor shell (Spec #3070, ST-1, C8; root hooks extended by
 * Spec #3071, ST-6).
 *
 * Composition seam: this file imports exactly the five store-connected, no-prop
 * children. ST-1 owns the shell, the status bar and every C7 root hook; the
 * canvas (ST-2), toolbar (ST-3), property panel (ST-4) and file-error banner
 * (ST-6) replace only their own file's body.
 *
 * ST-6 adds the arrangement observables to the root host (UI/UX 5): the
 * selection SET, its count, the selection's group id, the document group count,
 * the snap mode and the paint order. The Slice-1 hooks keep their names and
 * meanings (`wireframe-selection-id` = the PRIMARY = last selected id).
 *
 * Layout (UI/UX section 1.3): toolbar -> main (canvas + panel) -> file error ->
 * status bar, inside a column that always reserves the shipped hotkey-bar band.
 */

import React, { useSyncExternalStore } from 'react';
import { Flex } from '@chakra-ui/react';

import { HOTKEY_BAR_HEIGHT_PX } from '../../../shared/hotkeys/HotkeyBar';
import { useActiveCommandMode } from '../../../shared/hotkeys/commandSurfaceStore';
import { formatGeometry } from '../model/geometry';
import { WIREFRAME_APP_ID } from '../model/document';
import { useAppCommandIntent } from '../../../shared/companion/useAppCommandIntent';
import { WIREFRAME_PAN_MODE_ID } from '../wireframeCommandSurface';
import {
  getSnapshot,
  primarySelectedId,
  selectionGroup,
  subscribe,
} from '../store/wireframeDocumentStore';
import { WireframeCanvas } from './WireframeCanvas';
import { WireframeFileError } from './WireframeFileError';
import { WireframeHotkeyCarrier } from './WireframeHotkeyCarrier';
import { WireframePropertyPanel } from './WireframePropertyPanel';
import { WireframeStatusBar } from './WireframeStatusBar';
import { WireframeToolbar } from './WireframeToolbar';

export function WireframeEditor(): React.ReactElement {
  // Spec #3099 ST-6 — the generic Companion relay (replaces
  // `useWireframeIntent`): one `app-command-intent` listener plus the
  // take-on-mount drain (the app may have been opened by the request), both
  // filtered to THIS app id and executed exactly once through `executeCommand`.
  useAppCommandIntent(WIREFRAME_APP_ID);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { document, selectedIds, snapToGrid, view, filePath, dirty } = state;

  // Spec #3098 ST-3 — the active command mode is the module-owned source of
  // truth (never a ref / per-effect copy); `data-wireframe-pan-mode` mirrors
  // the MODE, not the store's free-floating pan flag.
  const activeMode = useActiveCommandMode(WIREFRAME_APP_ID);
  const panActive = activeMode?.id === WIREFRAME_PAN_MODE_ID;

  const primaryId = primarySelectedId(state);
  const selectedElement =
    primaryId === null
      ? null
      : document.elements.find((element) => element.id === primaryId) ?? null;
  const activeGroup = selectionGroup(document, selectedIds);
  const selectionShape = selectedElement?.type === 'shape' ? selectedElement.shape : '';
  const selectionFill = selectedElement?.type === 'shape' ? selectedElement.fill : '';

  return (
    <Flex
      data-testid="wireframe-root"
      data-wireframe-element-count={String(document.elements.length)}
      data-wireframe-selection-id={selectedElement?.id ?? ''}
      data-wireframe-selection-type={selectedElement?.type ?? ''}
      data-wireframe-selection-shape={selectionShape}
      data-wireframe-selection-fill={selectionFill}
      data-wireframe-selection-geometry={
        selectedElement ? formatGeometry(selectedElement) : ''
      }
      data-wireframe-selection-ids={selectedIds.join(',')}
      data-wireframe-selection-count={String(selectedIds.length)}
      data-wireframe-selection-group={activeGroup?.id ?? ''}
      data-wireframe-group-count={String(document.groups.length)}
      data-wireframe-snap={snapToGrid ? 'true' : 'false'}
      data-wireframe-stacking={document.elements.map((element) => element.id).join(',')}
      data-wireframe-dirty={dirty ? 'true' : 'false'}
      data-wireframe-document-path={filePath ?? ''}
      data-wireframe-page={`${Math.round(document.page.width)}x${Math.round(
        document.page.height,
      )}`}
      data-wireframe-zoom={String(Math.round(view.scale * 100))}
      data-wireframe-pan-mode={panActive ? 'true' : 'false'}
      flexDirection="column"
      h="100%"
      minH={0}
      pb={`${HOTKEY_BAR_HEIGHT_PX}px`}
      bg="bg.canvas"
    >
      <WireframeHotkeyCarrier />
      <WireframeToolbar />

      <Flex flex="1" minH={0} display="flex" flexDirection={{ base: 'column', lg: 'row' }}>
        <WireframeCanvas />
        <WireframePropertyPanel />
      </Flex>

      <WireframeFileError />
      <WireframeStatusBar />
    </Flex>
  );
}
