import React, { useRef, useEffect, useCallback } from 'react';
import { Box } from '@chakra-ui/react';
import { WindowSystemProvider, WindowManager, useWindowActions } from '@maomaolabs/core';
import { AlertHandler } from './AlertHandler';
import { StreamStatus } from './StreamStatus';
import { SideStepper } from './SideStepper';
import { DesktopToolbar } from './settings/DesktopToolbar';
import { DesktopBackground } from './DesktopBackground';
import { FloatingSettingsButton } from './settings/FloatingSettingsButton';
import { diagramFeature } from '../../diagram';
import { myWorkItemsFeature } from '../../my-workitems';
import { createWorkItemFeature } from '../../my-workitems';
import { createQueryViewerFeature, queryViewerFeature, type QueryResult } from '../../query-viewer';
import { optimizelyFeature } from '../../optimizely';
import { runCliFeature } from '../../run-cli';
import { themingFeature } from '../../theming';
import { githubViewerFeature } from '../../github-viewer';
import { browserPreviewFeature } from '../../browser-preview';
import { docsViewerFeature } from '../../docs-viewer';
import { devModeFeature } from '../../dev-mode';
import { setupFeature } from '../../setup';
import { missionMonitorFeature } from '../../mission-monitor';
import '../../allFeatures';
import { getFeatures } from '../../featureRegistry';
import { settingsService } from '../../settings';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import { useWindowStyle } from '../../../shared/contexts/WindowStyleContext';
import { useCompanion } from '../../../shared/contexts/CompanionContext';
import { QUERY_TOOL_NAMES, EVENT_STATES } from '../../../shared/constants';
import type { FredoFeatureClass } from '../../../shared/classes/FredoFeatureClass';
import { registerEventContracts } from '../../../shared/classes/EventSubscription';

// Features self-register via allFeatures.ts — no manual list needed.
const ALL_FEATURES = getFeatures();
const SHOWABLE_FEATURES = ALL_FEATURES.filter((feature) => feature.showable);

// ── Inner desktop component — must live inside <WindowSystemProvider> ─────────

const HomeDesktop: React.FC = () => {
  const { openWindow, closeWindow, updateWindow } = useWindowActions();
  const { events, deliveries, clearProcessedEvents } = useStream();
  const { showMessage } = useCompanion();

  // Register all feature eventContracts with the Rust ContractEngine on mount
  React.useEffect(() => {
    registerEventContracts(ALL_FEATURES);
  }, []);

  // Event delivery to features is now handled by the ECE contract pipeline
  // instead of manual eventFilters matching.

  const handleKonamiCode = useCallback(() => {
    openFeatureWindowRef.current(devModeFeature.id, devModeFeature);
    showMessage('Dev Mode Enabled 🐛', 4000);
  }, [showMessage]);
  const processedEventIdsRef = useRef<Set<string>>(new Set());

  // Greet the user once on mount
  useEffect(() => {
    const greetTimer = setTimeout(() => {
      showMessage("Hi! I'm Fredo, your guide! 👋", 5000);
    }, 800);
    return () => clearTimeout(greetTimer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-open Setup wizard on first launch (if plugin not yet installed)
  useEffect(() => {
    settingsService.get('plugin_installed', '').then((installed) => {
      if (!installed) {
        setTimeout(() => openFeatureWindowRef.current(setupFeature.id, setupFeature), 1200);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track open features so we can route deliveries and call lifecycle hooks
  const openFeaturesRef = useRef<Map<string, FredoFeatureClass>>(new Map());

  // Stable ref to allow recursive calls inside transition callbacks without circular deps
  const openFeatureWindowRef = useRef<(id: string, feature: FredoFeatureClass) => void>(() => {});

  // Alternates new windows left → right → left → …
  const windowPlacementSideRef = useRef<'left' | 'right'>('left');

  const openFeatureWindow = useCallback((id: string, feature: FredoFeatureClass) => {
    const MARGIN = 24;
    const TOOLBAR_HEIGHT = 56; // DesktopToolbar height
    const TOP = 60;
    const half = Math.floor(window.innerWidth / 2);
    const availableHeight = window.innerHeight - TOP - TOOLBAR_HEIGHT - MARGIN;

    const side = windowPlacementSideRef.current;
    const x = side === 'left' ? MARGIN : half + MARGIN;
    const width = half - MARGIN * 2;
    windowPlacementSideRef.current = side === 'left' ? 'right' : 'left';

    openWindow({
      id,
      title: feature.name,
      icon: React.createElement(feature.icon as any, { size: 16 }) as React.ReactNode,
      component: feature.render() as React.ReactNode,
      canClose: feature.gridConfig.closable,
      canMaximize: feature.gridConfig.maximizable,
      canMinimize: true,
      initialPosition: { x, y: TOP },
      initialSize: { width, height: availableHeight },
    });

    openFeaturesRef.current.set(id, feature);

    feature.registerCloseCallback(() => {
      feature.onUnmount?.();
      openFeaturesRef.current.delete(id);
      closeWindow(id);
    });

    feature.registerRerenderCallback(() => {
      updateWindow(id, { component: feature.render() as React.ReactNode });
    });

    // Transition callback: create-workitem → my-workitems panel
    if (id === createWorkItemFeature.id && (feature as any).registerTransitionCallback) {
      (feature as any).registerTransitionCallback((workItemId: number) => {
        feature.onUnmount?.();
        openFeaturesRef.current.delete(createWorkItemFeature.id);
        closeWindow(createWorkItemFeature.id);

        myWorkItemsFeature.openAzdoItem(workItemId);

        if (openFeaturesRef.current.has(myWorkItemsFeature.id)) {
          updateWindow(myWorkItemsFeature.id, { component: myWorkItemsFeature.render() });
        } else {
          openFeatureWindowRef.current(myWorkItemsFeature.id, myWorkItemsFeature);
        }
      });
    }

    // Defer onMount so AppProvider's useEffect has time to register the adapterBridge
    setTimeout(() => {
      const result = feature.onMount?.();
      if (result instanceof Promise) {
        result.catch(err => console.error('[Home] onMount threw:', feature.id, err));
      }
    }, 0);
  }, [openWindow, closeWindow, updateWindow]);

  // Keep ref in sync so transition callbacks always call the latest version
  openFeatureWindowRef.current = openFeatureWindow;

  // ── Auto-open Mission Monitor on first delivery or event ─────────────────
  useEffect(() => {
    if (deliveries.length === 0 && events.length === 0) return;
    if (openFeaturesRef.current.has(missionMonitorFeature.id)) return;
    openFeatureWindow(missionMonitorFeature.id, missionMonitorFeature);
  }, [deliveries, events, openFeatureWindow]);

  // ── Handle query events (QUERY_TOOL_NAMES Init + Response pairs) ─────────
  useEffect(() => {
    const eventsByEventId = new Map<string, { init?: any; response?: any }>();
    const processedKeys: string[] = [];

    events.forEach((event) => {
      if (QUERY_TOOL_NAMES.includes(event.toolName as any)) {
        if (event.state === EVENT_STATES.INIT) {
          if (!eventsByEventId.has(event.id!)) {
            eventsByEventId.set(event.id!, {});
          }
          eventsByEventId.get(event.id!)!.init = event;
        } else if (event.state === EVENT_STATES.RESPONSE) {
          const matchingInit = event.correlationId
            ? events.find(
                (e) => e.state === EVENT_STATES.INIT && e.correlationId === event.correlationId
              )
            : events.find(
                (e) =>
                  e.toolName === event.toolName &&
                  e.state === EVENT_STATES.INIT &&
                  e.sessionId === event.sessionId &&
                  e.id !== event.id
              );

          if (matchingInit) {
            if (!eventsByEventId.has(matchingInit.id!)) {
              eventsByEventId.set(matchingInit.id!, {});
            }
            eventsByEventId.get(matchingInit.id!)!.response = event;
          }
        }
      }
    });

    eventsByEventId.forEach((sessionEvents, eventId) => {
      if (
        sessionEvents.init &&
        sessionEvents.response &&
        !processedEventIdsRef.current.has(eventId)
      ) {
        const init = sessionEvents.init;
        const response = sessionEvents.response;

        const queryResult: QueryResult = {
          id: eventId,
          toolName: response.toolName.replace('_', ' ').toUpperCase(),
          query: init?.payload && typeof init.payload === 'object' && 'query' in init.payload ? (init.payload as any).query : 'Query not available',
          results: response.payload && typeof response.payload === 'object' && 'rows' in response.payload ? (response.payload as any).rows : [],
          executionTime: response.payload && typeof response.payload === 'object' && 'execution_time_ms' in response.payload ? (response.payload as any).execution_time_ms : undefined,
          timestamp: response.timestamp,
        };

        const queryFeature = createQueryViewerFeature(queryResult);
        openFeatureWindow(queryFeature.id, queryFeature);

        processedEventIdsRef.current.add(eventId);
        processedEventIdsRef.current.add(response.id!);
        processedKeys.push(eventId);
        processedKeys.push(response.id!);
      }
    });

    if (processedKeys.length > 0) {
      clearProcessedEvents(processedKeys);
    }
  }, [events, clearProcessedEvents, openFeatureWindow]);

  // ── Auto-open diagram on kubectl Init events ────────────────────────────
  useEffect(() => {
    const kubectlInitEvents = events.filter(
      (event) => (event.toolName ?? '').startsWith('kubectl_') && event.state === EVENT_STATES.INIT
    );
    const newEvents = kubectlInitEvents.filter(
      (event) => !processedEventIdsRef.current.has(event.id!)
    );
    if (newEvents.length === 0) return;

    newEvents.forEach((event) => {
      processedEventIdsRef.current.add(event.id!);
    });

    openFeatureWindow(diagramFeature.id, diagramFeature);
  }, [events, openFeatureWindow]);

  // ── Generic delivery-based auto-open for features with eventContracts ───
  useEffect(() => {
    deliveries.forEach((delivery) => {
      ALL_FEATURES.forEach((feature) => {
        // Skip features that are already open
        if (openFeaturesRef.current.has(feature.id)) return;
        // Skip features with no contracts
        if (!feature.eventContracts || feature.eventContracts.length === 0) return;
        // Check if any contract matches this delivery
        const hasMatchingContract = feature.eventContracts.some(
          (c) => c.contractName === delivery.contractName
        );
        if (hasMatchingContract) {
          openFeatureWindow(feature.id, feature);
        }
      });
    });
  }, [deliveries, openFeatureWindow]);

  // ── Route deliveries to currently-open feature windows via handleDelivery ─
  useEffect(() => {
    deliveries.forEach((delivery) => {
      openFeaturesRef.current.forEach((feature, id) => {
        if (!feature.eventContracts?.length) return;

        const hasMatchingContract = feature.eventContracts.some(
          (c) => c.contractName === delivery.contractName
        );

        if (hasMatchingContract) {
          feature.handleDelivery(delivery);
          updateWindow(id, { component: feature.render() as React.ReactNode });
        }
      });
    });
  }, [deliveries, updateWindow]);

  return (
    <Box position="absolute" inset="0" zIndex={0} overflow="hidden">
      <DesktopBackground onKonamiCode={handleKonamiCode} />
    </Box>
  );
};

// ── Top-level Home component ──────────────────────────────────────────────────

export const Home: React.FC = () => {
  const { windowStyle } = useWindowStyle();

  return (
    <Box
      width="100%"
      height="100vh"
      display="flex"
      flexDirection="column"
      bg="var(--bg-primary)"
      overflow="hidden"
      position="relative"
    >
      {/* Global overlays — must sit above everything including windows */}
      <AlertHandler />

      {/* Row: SideStepper (left) + Desktop (right).
          SideStepper is a real flex sibling — when it appears the desktop shrinks;
          when it's gone the desktop takes full width. No overlapping. */}
      <Box flex="1" display="flex" flexDirection="row" overflow="hidden" minHeight="0">
        {/* SideStepper takes its own 56px column; tooltip uses position:fixed → viewport */}
        <SideStepper />

        {/* Desktop: transform scopes position:fixed windows to this box */}
        <Box flex="1" position="relative" overflow="hidden" style={{ transform: 'translateZ(0)' }}>
          <WindowSystemProvider systemStyle={windowStyle as any}>
            <Box display="flex" flexDirection="column" height="100%">
              <Box flex="1" position="relative" overflow="hidden">
                <WindowManager />
                <HomeDesktop />
                <StreamStatus />
                <FloatingSettingsButton features={ALL_FEATURES} />
              </Box>
              <DesktopToolbar showableFeatures={SHOWABLE_FEATURES} />
            </Box>
          </WindowSystemProvider>
        </Box>
      </Box>
    </Box>
  );
};
