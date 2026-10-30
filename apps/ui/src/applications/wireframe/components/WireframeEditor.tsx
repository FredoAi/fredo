/**
 * Wireframe editor shell (Spec #3070, ST-1, C8; root hooks extended by
 * Spec #3071, ST-6; re-shaped by Spec #3119, ST-4).
 *
 * Spec #3119 ST-4 replaces the retired toolbar + hidden `g+*` carrier + command
 * surface with the NavigationEngine P4 surfaces: a rail + canvas + details +
 * trail workspace over the declarative `wireframeSurface`. The shell root keeps
 * every shipped `data-wireframe-*` hook (same names and meanings) and gains
 * `data-wireframe-place` + `data-wireframe-arm`.
 *
 * Layout (UI/UX §1):
 *   ≥ lg — left column 266 px (rail over compact trail), canvas `flex:1`,
 *          details 288 px right; file error + status bar span the full width.
 *   < lg — rail band (wrap) → canvas → details (bottom, ≤ 45%) → file error →
 *          status bar.
 * The retired hotkey-bar band padding is gone (Wireframe renders no HotkeyBar).
 *
 * The ONE element-scoped keydown adapter is attached here (no document
 * listener). The rail/map/trail read the host snapshot; the availability models
 * are rebuilt from the FRESH store selection + the host place path so a pure
 * selection change flips `data-nav-availability` without a verb dispatch.
 */

import React, {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Box, Flex } from '@chakra-ui/react';

import type { ContextSnapshot } from '../../../shared/navigation';
import {
  ActivityTrail,
  CommandRail,
  NavigationMap,
  buildActivityTrailModel,
  buildCommandRailModel,
  buildNavigationMapModel,
} from '../../../shared/navigation/ui';
import { useAppCommandIntent } from '../../../shared/companion/useAppCommandIntent';
import { formatGeometry } from '../model/geometry';
import { WIREFRAME_APP_ID } from '../model/document';
import {
  getSnapshot,
  getWireframeContext,
  primarySelectedId,
  selectionGroup,
  subscribe,
} from '../store/wireframeDocumentStore';
import { WIREFRAME_MAP_DEFAULT_ARGS } from '../wireframeSurface';
import {
  WireframeNavigationProvider,
  handleWireframeKeyDown,
  useFreshWireframeContext,
  useWireframeHostSnapshot,
  useWireframeNavigation,
  useWireframePlaceView,
  type WireframeChannel,
} from './WireframeNavigationProvider';
import { WireframeCanvas } from './WireframeCanvas';
import { WireframeFileError } from './WireframeFileError';
import { WireframeInsertMenu } from './WireframeInsertMenu';
import { WireframeNewDocumentDialog } from './WireframeNewDocumentDialog';
import { WireframePropertyPanel } from './WireframePropertyPanel';
import { WireframeStatusBar } from './WireframeStatusBar';

export function WireframeEditor(): React.ReactElement {
  // Spec #3099 ST-6 — the generic Companion relay. It stays mounted so a
  // companion intent reports a clean `Invalid` (the declared command surface was
  // retired in ST-4) instead of a timeout; P6 re-homes the capability.
  useAppCommandIntent(WIREFRAME_APP_ID);

  return (
    <WireframeNavigationProvider>
      <WireframeShell />
    </WireframeNavigationProvider>
  );
}

function WireframeShell(): React.ReactElement {
  const { host, surface } = useWireframeNavigation();
  const hostSnapshot = useWireframeHostSnapshot(host);
  const placeView = useWireframePlaceView(host);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { document, selectedIds, snapToGrid, view, filePath, dirty, panMode } = state;

  const [newDialogOpen, setNewDialogOpen] = useState(false);

  // Freshness seam (AC4): a pure selection change notifies the store but writes no
  // journal entry, so the host snapshot's context can be stale. Rebuild the models
  // from the live store selection/dirty + the host's current place path.
  const storeContext = useMemo<ContextSnapshot>(() => getWireframeContext(), [state]);
  const liveContext = useFreshWireframeContext(hostSnapshot.context, storeContext);

  const railModel = useMemo(
    () => buildCommandRailModel(surface, liveContext),
    [surface, liveContext],
  );
  const mapModel = useMemo(
    () =>
      buildNavigationMapModel(surface, liveContext, {
        filteredTo: hostSnapshot.mapFilterPlaceId,
      }),
    [surface, liveContext, hostSnapshot.mapFilterPlaceId],
  );
  const trailModel = useMemo(
    () => buildActivityTrailModel(surface, hostSnapshot.entries),
    [surface, hostSnapshot.entries],
  );

  /** Run one verb through the map-click defaults (UI/UX §9). */
  const performVerb = useCallback(
    async (verbId: string, channel: WireframeChannel = 'pointer') => {
      const args = WIREFRAME_MAP_DEFAULT_ARGS[verbId] ?? {};
      const result = await host.runVerb(verbId, channel, args);
      // `m` at the root (and `?`) perform `app.map`; the shell opens the map once.
      if (verbId === 'app.map' && result.status === 'performed') host.openMap(null);
      return result;
    },
    [host],
  );

  /** The shell's dirty guard owns the New-discard dialog (File `n` + rail/map rows). */
  const runVerb = useCallback(
    (verbId: string) => {
      if (verbId === 'wireframe.document.new' && dirty) {
        setNewDialogOpen(true);
        return;
      }
      void performVerb(verbId, 'pointer');
    },
    [dirty, performVerb],
  );

  const beforeDispatch = useCallback(
    (verbId: string): boolean => {
      if (verbId === 'wireframe.document.new' && dirty) {
        setNewDialogOpen(true);
        return true;
      }
      return false;
    },
    [dirty],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      handleWireframeKeyDown(event, host, performance.now(), { beforeDispatch });
    },
    [host, beforeDispatch],
  );

  const discardNewDocument = useCallback(() => {
    setNewDialogOpen(false);
    void performVerb('wireframe.document.new', 'pointer');
  }, [performVerb]);

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
      data-wireframe-place={placeView.placeId}
      data-wireframe-arm={placeView.armed ?? 'none'}
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
      onKeyDown={onKeyDown}
    >
      <Flex
        flex="1"
        minH={0}
        display="flex"
        flexDirection={{ base: 'column', lg: 'row' }}
        gap={{ base: 2, lg: 0 }}
      >
        {/* ── Left column: rail over compact trail (≥lg) / rail band (<lg) ── */}
        <Flex
          flexDirection={{ base: 'row', lg: 'column' }}
          flexWrap={{ base: 'wrap', lg: 'nowrap' }}
          alignItems="flex-start"
          gap={3}
          w={{ base: '100%', lg: '266px' }}
          flexShrink={0}
          minWidth="0"
          maxH={{ base: '220px', lg: 'none' }}
          overflowY={{ base: 'auto', lg: 'hidden' }}
          p={{ base: 0, lg: 2 }}
        >
          <CommandRail
            model={railModel}
            onRunVerb={runVerb}
            onOpenMap={(filterPlaceId) => host.openMap(filterPlaceId ?? null)}
          />
          <Box
            flex="1"
            minWidth="0"
            maxW={{ base: '360px', lg: '100%' }}
            overflowY="auto"
            display="flex"
            alignItems="flex-start"
          >
            <ActivityTrail
              model={trailModel}
              compact
              onUndo={(seq) => {
                void host.undoEntry(seq);
              }}
            />
          </Box>
        </Flex>

        {/* ── Canvas region: the pointer-only insert pill (ST-6) over the stage ── */}
        <Box
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

        {/* ── Details view: the selection's verbs (ST-6) ── */}
        <Box
          w={{ base: '100%', lg: '288px' }}
          maxW={{ base: '100%', lg: '72' }}
          maxH={{ base: '45%', lg: 'none' }}
          flexShrink={0}
          minWidth="0"
          overflowY="auto"
        >
          <WireframePropertyPanel />
        </Box>
      </Flex>

      <WireframeFileError />
      <WireframeStatusBar />

      <NavigationMap
        model={mapModel}
        open={hostSnapshot.mapOpen}
        onClose={() => host.closeMap()}
        onRunVerb={runVerb}
      />

      <WireframeNewDocumentDialog
        open={newDialogOpen}
        onCancel={() => setNewDialogOpen(false)}
        onDiscard={discardNewDocument}
      />
    </Flex>
  );
}
