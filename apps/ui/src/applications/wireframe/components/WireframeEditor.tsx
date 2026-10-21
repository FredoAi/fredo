/**
 * Wireframe editor shell (Spec #3070, ST-1, C8).
 *
 * Composition seam: this file imports exactly the five store-connected, no-prop
 * children. ST-1 owns the shell, the status bar and every C7 root hook; the
 * canvas (ST-2), toolbar (ST-3), property panel (ST-4) and file-error banner
 * (ST-6) replace only their own file's body.
 *
 * Layout (UI/UX section 1.3): toolbar -> main (canvas + panel) -> file error ->
 * status bar, inside a column that always reserves the shipped hotkey-bar band.
 */

import React, { useSyncExternalStore } from 'react';
import { Flex } from '@chakra-ui/react';

import { HOTKEY_BAR_HEIGHT_PX } from '../../../shared/hotkeys/HotkeyBar';
import { formatGeometry } from '../model/geometry';
import { getSnapshot, subscribe } from '../store/wireframeDocumentStore';
import { WireframeCanvas } from './WireframeCanvas';
import { WireframeFileError } from './WireframeFileError';
import { WireframePropertyPanel } from './WireframePropertyPanel';
import { WireframeStatusBar } from './WireframeStatusBar';
import { WireframeToolbar } from './WireframeToolbar';

export function WireframeEditor(): React.ReactElement {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { document, selectedId, view, filePath, dirty, panMode } = state;

  const selectedElement =
    selectedId === null
      ? null
      : document.elements.find((element) => element.id === selectedId) ?? null;

  return (
    <Flex
      data-testid="wireframe-root"
      data-wireframe-element-count={String(document.elements.length)}
      data-wireframe-selection-id={selectedElement?.id ?? ''}
      data-wireframe-selection-type={selectedElement?.type ?? ''}
      data-wireframe-selection-geometry={
        selectedElement ? formatGeometry(selectedElement) : ''
      }
      data-wireframe-dirty={dirty ? 'true' : 'false'}
      data-wireframe-document-path={filePath ?? ''}
      data-wireframe-page={`${Math.round(document.page.width)}x${Math.round(
        document.page.height,
      )}`}
      data-wireframe-zoom={String(Math.round(view.scale * 100))}
      data-wireframe-pan-mode={panMode ? 'true' : 'false'}
      flexDirection="column"
      h="100%"
      minH={0}
      pb={`${HOTKEY_BAR_HEIGHT_PX}px`}
      bg="bg.canvas"
    >
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
