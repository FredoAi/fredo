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
 * Layout (UI/UX §1 / Spec #3120 ST-6):
 *   workspace row (`flex:1; minH:0`) holds EXACTLY two children — canvas
 *   (`flex:1; minWidth:0`) and the details column (`w:288px; flexShrink:0`,
 *   property-panel scroller over the compact trail footer). Below it the
 *   full-width bottom command bar (`flexShrink:0`), then the status bar
 *   (`flexShrink:0`). There is no left rail / 266 px command column (R-8).
 *   < lg — the workspace stacks (canvas → details at ≤ 45%); the bar and the
 *   status bar stay pinned at the bottom.
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
import { requestCompanionComposerOpen } from '../../../shared/companion/composerBridge';
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
  return (
    <WireframeNavigationProvider>
      <WireframeShell />
    </WireframeNavigationProvider>
  );
}

function WireframeShell(): React.ReactElement {
  const { host, surface } = useWireframeNavigation();
  // Spec #3120 (P6) — the generic Companion relay now resolves this app's registered
  // navigation host and executes through `host.runIntent(actor:'companion')`. Mounted
  // INSIDE the provider so the host is registered before an intent can drain.
  useAppCommandIntent(WIREFRAME_APP_ID);
  const hostSnapshot = useWireframeHostSnapshot(host);
  const placeView = useWireframePlaceView(host);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { document, selectedIds, snapToGrid, view, filePath, dirty, panMode } = state;

  const [newDialogOpen, setNewDialogOpen] = useState(false);

  // Freshness seam (AC4) — the host is now the freshness authority: the provider publishes
  // store selection/dirty changes through `NavigationHost.refreshContext()`, so
  // `hostSnapshot.context` is current. This composition is a value-identical defensive
  // merge (the same store selection/dirty plus the host's current place path), not a
  // second freshness source.
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
      // Spec #3120 (P6) R-1.8 — `k` resolves to `app.ask`; Ask opens Fredo's
      // teleport-attached instruction box (the composer bridge), never the launcher.
      // The stroke is consumed here so the surface's `app.ask` run never publishes a
      // second request. The binding itself is unchanged (still `k` → `app.ask`).
      if (verbId === 'app.ask') {
        requestCompanionComposerOpen({
          source: 'keyboard',
          appId: WIREFRAME_APP_ID,
          focus: true,
        });
        return true;
      }
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

  /** Spec #3120 (P6) R-1.8 — `Ask` publishes ONE composer request for this app. */
  const openCompanionComposer = useCallback(() => {
    requestCompanionComposerOpen({
      source: 'command-bar-ask',
      appId: WIREFRAME_APP_ID,
      focus: true,
    });
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
      {/* ── Workspace row: EXACTLY two children — canvas + details (R-1.7) ── */}
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

        {/* Details column: the property panel over the compact trail footer. */}
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
          <Box flex="1" minH={0} overflowY="auto" display="flex" flexDirection="column">
            <WireframePropertyPanel />
          </Box>
          <Box flexShrink={0} maxH="50" overflowY="auto" p={2}>
            <ActivityTrail
              model={trailModel}
              compact
              onUndo={(seq) => {
                void host.undoEntry(seq);
              }}
            />
          </Box>
        </Flex>
      </Flex>

      <WireframeFileError />

      {/* ── Bottom command bar: breadcrumb · verbs · globals (R-1.1) ── */}
      <Box
        data-testid="wireframe-command-bar"
        data-wireframe-region="command-bar"
        flexShrink={0}
        w="100%"
        minWidth="0"
      >
        <CommandRail
          model={railModel}
          onRunVerb={runVerb}
          onOpenMap={(filterPlaceId) => host.openMap(filterPlaceId ?? null)}
          onAsk={openCompanionComposer}
        />
      </Box>

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
