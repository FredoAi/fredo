/**
 * Wireframe editor shell (Spec #3070, ST-1, C8; root hooks extended by
 * Spec #3071, ST-6; re-shaped by Spec #3119, ST-4; engine seams stripped by
 * Spec #3151, ST-5).
 *
 * Spec #3151 deletes the navigation engine, so this shell no longer mounts a
 * navigation provider, a command rail, a navigation map or an activity trail.
 * What remains is the pointer product: a canvas region (insert pill + stage) and
 * a details column (pointer control strip over the property panel), then the
 * file-error banner and the status bar. Every capability the command bar was the
 * only pointer entry for (history, view, arrange, file) is re-homed onto the
 * control strip at the top of the details column — the exact footprint the
 * deleted activity-trail footer occupied, so the canvas keeps its width.
 *
 * The shell keeps every shipped `data-wireframe-*` hook (same names and
 * meanings) EXCEPT the two that existed only to arm the engine cursor
 * (`data-wireframe-place`, `data-wireframe-arm`).
 *
 * There is NO keyboard handling of any kind here: no `onKeyDown`, no key table,
 * no global listener. The strip is ordinary Tab-reachable chrome.
 */

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Flex } from '@chakra-ui/react';

import {
  COMPANION_GROUNDING_VERSION,
  registerCompanionGrounding,
} from '../../../shared/companion/grounding';
import { getApplications } from '../../applicationRegistry';
import { formatGeometry } from '../model/geometry';
import { WIREFRAME_APP_ID } from '../model/document';
import { runWireframeAction } from '../actions/wireframeActions';
import {
  getSnapshot,
  getWireframeContext,
  primarySelectedId,
  selectionGroup,
  subscribe,
} from '../store/wireframeDocumentStore';
import { WireframeArrangeControls } from './WireframeArrangeControls';
import { WireframeCanvas } from './WireframeCanvas';
import { WireframeFileError } from './WireframeFileError';
import { WireframeFileMenu } from './WireframeFileMenu';
import { WireframeHistoryControls } from './WireframeHistoryControls';
import { WireframeInsertMenu } from './WireframeInsertMenu';
import { WireframeNewDocumentDialog } from './WireframeNewDocumentDialog';
import { WireframePropertyPanel } from './WireframePropertyPanel';
import { WireframeStatusBar } from './WireframeStatusBar';
import { WireframeViewControls } from './WireframeViewControls';

export function WireframeEditor(): React.ReactElement {
  return <WireframeShell />;
}

function WireframeShell(): React.ReactElement {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { document, selectedIds, snapToGrid, view, filePath, dirty, panMode } = state;

  const [newDialogOpen, setNewDialogOpen] = useState(false);

  // #3151 ST-2 (AC5) — this shell owns the Wireframe selection, so it registers the
  // application-level companion grounding source. The provider reads the store
  // SYNCHRONOUSLY at turn time (`getSnapshot()`), so a turn always carries the live
  // selection/dirty — never a captured render snapshot.
  useEffect(
    () =>
      registerCompanionGrounding(WIREFRAME_APP_ID, () => {
        const snapshot = getSnapshot();
        const byId = new Map(snapshot.document.elements.map((element) => [element.id, element]));
        return {
          version: COMPANION_GROUNDING_VERSION,
          appId: WIREFRAME_APP_ID,
          appName:
            getApplications().find((application) => application.id === WIREFRAME_APP_ID)?.name ??
            'Wireframe',
          selection: {
            count: snapshot.selectedIds.length,
            ids: [...snapshot.selectedIds],
            kinds: snapshot.selectedIds.map((id) => byId.get(id)?.type ?? 'element'),
            label: getWireframeContext().selection.label,
          },
          dirty: snapshot.dirty,
        };
      }),
    [],
  );

  // #3151 ST-5 — the dirty guard survives, the engine route does not. The File
  // menu's `New` row is the ONE pointer caller: a clean document resets
  // immediately, a dirty one raises the shipped discard dialog first. The reset
  // itself is `wireframe.document.new` (`runWireframeAction` →
  // `resetForNewDocument`), never a host verb.
  const handleNew = useCallback(() => {
    if (dirty) {
      setNewDialogOpen(true);
      return;
    }
    runWireframeAction('wireframe.document.new');
  }, [dirty]);

  const discardNewDocument = useCallback(() => {
    setNewDialogOpen(false);
    runWireframeAction('wireframe.document.new');
  }, []);

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
      data-wireframe-pan-mode={panMode ? 'true' : 'false'}
      flexDirection="column"
      h="100%"
      minH={0}
      bg="bg.canvas"
    >
      {/* ── Workspace row: canvas + details column ── */}
      <Flex
        data-testid="wireframe-workspace"
        flex="1"
        minH={0}
        display="flex"
        flexDirection={{ base: 'column', lg: 'row' }}
        gap={{ base: 2, lg: 0 }}
      >
        {/* Canvas region: the pointer-only insert pill over the stage. */}
        <Box
          data-wireframe-region="canvas"
          flex="1"
          minWidth="0"
          minH={{ base: '320px', lg: 0 }}
          position="relative"
          display="flex"
          flexDirection="column"
        >
          <WireframeInsertMenu />
          <WireframeCanvas />
        </Box>

        {/* Details column: the pointer control strip over the property panel. */}
        <Flex
          data-testid="wireframe-details-column"
          data-wireframe-region="details"
          flexDirection="column"
          w={{ base: '100%', lg: '288px' }}
          maxH={{ base: '45%', lg: 'none' }}
          flexShrink={0}
          minWidth="0"
          minH={0}
          overflow="hidden"
        >
          {/*
            The pointer control strip — the ONE re-home for the capabilities the
            command bar was the only pointer entry for. It takes exactly the
            footprint of the deleted activity-trail footer, so the canvas keeps
            its width and no store value changes.
          */}
          <Flex
            data-testid="wireframe-control-strip"
            p={2}
            gap={1}
            align="center"
            flexWrap="wrap"
            flexShrink={0}
            minWidth={0}
            bg="bg.surface"
            borderBottomWidth="1px"
            borderColor="border.subtle"
          >
            <WireframeHistoryControls />
            <WireframeViewControls />
            <WireframeArrangeControls />
            <WireframeFileMenu onNew={handleNew} />
          </Flex>
          <Box flex="1" minH={0} overflowY="auto" display="flex" flexDirection="column">
            <WireframePropertyPanel />
          </Box>
        </Flex>
      </Flex>

      <WireframeFileError />

      <WireframeStatusBar />

      <WireframeNewDocumentDialog
        open={newDialogOpen}
        onCancel={() => setNewDialogOpen(false)}
        onDiscard={discardNewDocument}
      />
    </Flex>
  );
}
