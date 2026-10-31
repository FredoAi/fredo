/**
 * Spec #3118 (P4), ST-6 — the DEV-only navigation prototype screen.
 *
 * A live-able surface to design and test the P4 nav stack against before P5 touches Wireframe
 * (R-8.1). It mounts the SHIPPED surfaces — `CommandRail`, `NavigationMap`, `ActivityTrail`,
 * the single `NavigationAnnouncer` and the trail's per-entry undo — over ONE
 * `createNavigationHost` snapshot built from `NAVIGATION_DEMO_SURFACE`.
 *
 * Non-goals (binding):
 *   - this module is NEVER mounted by an application and NEVER root-exported;
 *   - it is reached ONLY through the `React.lazy` DEV branch in `app/routes/Router.tsx`, so a
 *     production build does not contain it (R-8.2);
 *   - it mounts NO navigation engine: the key handler is an element-scoped `onKeyDown` on the
 *     stage that forwards strokes to `host.handleStroke` — there is no document-level listener
 *     and no `role="application"`;
 *   - `?` / `/` are display glyphs (`docs/NAVIGATION_ENGINE.md` §4), so they are accepted by a
 *     MODULE-LOCAL glyph map here only. The declaration binds `m` / `k`.
 *
 * The companion attribution demo seeds ONE entry through the host (`runVerb(..., 'agent')`),
 * so the trail shows a `Companion` actor without any synthetic journal write.
 */

import React from 'react';
import { Box, Button, chakra, Flex, Text } from '@chakra-ui/react';

import {
  DEMO_PLACES,
  NAVIGATION_DEMO_SURFACE,
  createNavigationDemoController,
  resetNavigationDemoState,
} from './navigationDemoSurface';
import { ActivityTrail } from '../../shared/navigation/ui/ActivityTrail';
import { NavigationAnnouncer } from '../../shared/navigation/ui/announce';
import { CommandRail } from '../../shared/navigation/ui/CommandRail';
import {
  createNavigationHost,
  useNavigationHostSnapshot,
  type NavigationHost,
} from '../../shared/navigation/ui/host';
import {
  buildActivityTrailModel,
  buildCommandRailModel,
  buildNavigationMapModel,
} from '../../shared/navigation/ui/models';
import { NavigationMap } from '../../shared/navigation/ui/NavigationMap';

/**
 * Module-local glyph map (C2 / G-419): a `?` opens the map, a `/` asks (the launcher lives in
 * Home). These literals must NOT live in a root-exported module — the production bundle
 * marker scan asserts they never reach `dist/assets`.
 */
const NAV_PREVIEW_GLYPH_KEYS: Readonly<Record<string, 'map' | 'ask'>> = {
  '?': 'map',
  '/': 'ask',
};

/** Dev-route-only copy for the `/` affordance — the real launcher is the Home shell. */
const NAV_PREVIEW_ASK_COPY = 'Ask opens the launcher when Fredo is running';

/**
 * The one-shot seed latch — a SYNCHRONOUS guard keyed to the host instance.
 *
 * `host.runVerb` awaits `dispatch` before the journal entry is appended, so a snapshot read
 * (`entries.length === 0`) lets React StrictMode's second mount-effect invocation pass the
 * same guard and enqueue a second companion entry. The latch is written BEFORE the first
 * await, so the second invocation sees it; it is per-host, so a Reset (which keeps the host
 * instance) does not re-seed. Module-scoped and NOT exported (root-export purity).
 */
const SEEDED_DEMO_HOSTS = new WeakSet<NavigationHost>();

/** The visible stage label (the screen-reader walk's first stop). */
const STAGE_LABEL = 'Navigation prototype stage';

/** The keyboard hint card copy (recognition over recall — no binding is hidden). */
const KEYBOARD_HINT =
  'c create · i edit · a arrange · s style · v view · f file · m map · k ask · ? map · / ask · w then n view · w then p style · Esc back · r/e shapes · u/y undo/redo';

export function NavigationPreview(): React.ReactElement {
  // One controller + one host for the lifetime of the screen: a parent re-render must not
  // remount the demo (or lose its journal/place state).
  const [controller] = React.useState(() => createNavigationDemoController());
  const [host] = React.useState(() =>
    createNavigationHost({
      surface: NAVIGATION_DEMO_SURFACE,
      getContext: () => controller.getContext(),
      applyPatch: (patch) => controller.applyPatch(patch),
      confirm: (request) => controller.confirm(request),
    }),
  );

  const snapshot = useNavigationHostSnapshot(host);
  const [notice, setNotice] = React.useState<string | null>(null);

  // Seed exactly one companion iteration through the dispatcher (attribution demo). The guard
  // MUST be synchronous: `runVerb` awaits `dispatch` before the entry is appended, so React
  // StrictMode's dev double-effect would race an `entries.length === 0` snapshot read and seed
  // twice. The per-host latch is written before the await, so the second run is a no-op.
  React.useEffect(() => {
    if (SEEDED_DEMO_HOSTS.has(host)) return;
    SEEDED_DEMO_HOSTS.add(host);
    void host.runVerb('place.rect', 'agent');
  }, [host]);

  // One model per surface, derived from the ONE stable snapshot (never `.length`/fresh arrays).
  const railModel = React.useMemo(
    () => buildCommandRailModel(NAVIGATION_DEMO_SURFACE, snapshot.context),
    [snapshot],
  );
  const mapModel = React.useMemo(
    () =>
      buildNavigationMapModel(NAVIGATION_DEMO_SURFACE, snapshot.context, {
        filteredTo: snapshot.mapFilterPlaceId,
      }),
    [snapshot],
  );
  const trailModel = React.useMemo(
    () => buildActivityTrailModel(NAVIGATION_DEMO_SURFACE, snapshot.entries),
    [snapshot],
  );

  /**
   * The element-scoped key sink. Only strokes typed while the STAGE itself is focused reach the
   * host: a control's own activation (Enter/Space on a button) must never be reinterpreted, and
   * the map owns the keyboard while it is open. `?` / `/` are mapped first (glyphs, not bindings).
   */
  const onStageKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.target !== event.currentTarget) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (host.getSnapshot().mapOpen) return;

      const glyph = NAV_PREVIEW_GLYPH_KEYS[event.key];
      if (glyph === 'map') {
        event.preventDefault();
        host.openMap(null);
        return;
      }
      if (glyph === 'ask') {
        event.preventDefault();
        setNotice(NAV_PREVIEW_ASK_COPY);
        return;
      }

      if (event.key !== 'Escape' && event.key.length !== 1) return;
      event.preventDefault();
      void host.handleStroke(event.key, Date.now(), { target: event.currentTarget });
    },
    [host],
  );

  const runVerb = React.useCallback(
    (verbId: string): void => {
      void host.runVerb(verbId);
    },
    [host],
  );

  const undoEntry = React.useCallback(
    (seq: number): void => {
      void host.undoEntry(seq);
    },
    [host],
  );

  const openMap = React.useCallback(
    (filterPlaceId?: string | null): void => {
      host.openMap(filterPlaceId ?? null);
    },
    [host],
  );

  const reset = React.useCallback((): void => {
    // Reset the demo document FIRST so the host's seed path re-reads the Canvas root.
    resetNavigationDemoState();
    host.reset();
    setNotice(null);
  }, [host]);

  return (
    <Box minH="100vh" p="6" bg="bg.canvas">
      <NavigationAnnouncer />

      <chakra.h1 m="0" fontSize="xl" fontWeight="700" color="fg.default">
        Navigation prototype
      </chakra.h1>
      <Text mt="1" fontSize="sm" color="fg.muted">
        DEV-only route — not shipped; press a letter to navigate, ? for the map.
      </Text>

      {/* ST-5: the command bar is a BOTTOM bar — the stage stack grows above it. */}
      <Flex mt="6" gap="6" direction="column">
        <Box flex="1 1 auto" minWidth="0">
          <Flex gap="2" flexWrap="wrap" align="center">
            <Button size="sm" variant="ghost" onClick={() => host.openMap(null)}>
              Open map
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => host.openMap(DEMO_PLACES.arrange)}
            >
              Open map · Arrange
            </Button>
            <Button size="sm" variant="ghost" onClick={() => runVerb('place.rect')}>
              Run shape verb
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void host.runVerb('place.rect', 'agent');
              }}
            >
              Seed companion entry
            </Button>
            <Button size="sm" variant="ghost" onClick={() => runVerb('place.delete')}>
              Run destructive verb
            </Button>
            <Button size="sm" variant="ghost" onClick={reset}>
              Reset
            </Button>
          </Flex>

          {notice === null ? null : (
            <Text mt="2" fontSize="xs" color="fg.muted" role="note">
              {notice}
            </Text>
          )}

          <Box
            mt="4"
            tabIndex={0}
            aria-label={STAGE_LABEL}
            onKeyDown={onStageKeyDown}
            p="4"
            bg="bg.subtle"
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="md"
            _focusVisible={{ outline: '2px solid var(--accent-strong)', outlineOffset: '2px' }}
          >
            <Text fontSize="xs" color="fg.muted" mb="3">
              {STAGE_LABEL}
            </Text>
            <ActivityTrail model={trailModel} onUndo={undoEntry} />
          </Box>
        </Box>

        <CommandRail
          model={railModel}
          onRunVerb={runVerb}
          onOpenMap={openMap}
          onAsk={() => setNotice(NAV_PREVIEW_ASK_COPY)}
        />
      </Flex>

      <Box
        mt="6"
        p="3"
        bg="bg.subtle"
        borderWidth="1px"
        borderColor="border.subtle"
        borderRadius="md"
        fontSize="xs"
        color="fg.muted"
      >
        {KEYBOARD_HINT}
      </Box>

      <NavigationMap
        model={mapModel}
        open={snapshot.mapOpen}
        onClose={() => host.closeMap()}
        onRunVerb={runVerb}
      />
    </Box>
  );
}

// The DEV route loads this module dynamically; a default export lets `React.lazy(() =>
// import('../dev/NavigationPreview'))` resolve without a named-mapping wrapper.
export default NavigationPreview;
