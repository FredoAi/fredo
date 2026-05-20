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
import { useMissionMonitorCapture } from '../../mission-monitor/hooks/useMissionMonitorCapture';
import '../../allFeatures';
import { getFeatures } from '../../featureRegistry';
import { settingsService } from '../../settings';
import { useStream } from '../../../shared/contexts/StreamContext';
import { useWindowStyle } from '../../../shared/contexts/WindowStyleContext';
import { useCompanion } from '../../../shared/contexts/CompanionContext';
import { QUERY_TOOL_NAMES, EVENT_STATES } from '../../../shared/constants';
import type { FredoFeatureClass } from '../../../shared/classes/FredoFeatureClass';

// Features self-register via allFeatures.ts — no manual list needed.
const ALL_FEATURES = getFeatures();
const SHOWABLE_FEATURES = ALL_FEATURES.filter((feature) => feature.showable);

// ── Inner desktop component — must live inside <WindowSystemProvider> ─────────

const HomeDesktop: React.FC = () => {
  const { openWindow, closeWindow, updateWindow } = useWindowActions();
  const { events, clearProcessedEvents } = useStream();
  const { showMessage } = useCompanion();

  // Always capture every event to localStorage — independent of the window state.
  useMissionMonitorCapture();

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

  // Track open features so we can route events and call lifecycle hooks
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
      icon: React.createElement(feature.icon as any, { size: 16 }),
      component: feature.render(),
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
      updateWindow(id, { component: feature.render() });
    });

    // Transition callback: create-workitem → my-workitems panel
    if (id === createWorkItemFeature.id && (feature as any).registerTransitionCallback) {
      (feature as any).registerTransitionCallback((workItemId: number) => {
        console.log('[Home] Transitioning from create to My Work Items panel:', workItemId);
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
      console.log('[Home] calling onMount for feature:', feature.id);
      const result = feature.onMount?.();
      if (result instanceof Promise) {
        result.catch(err => console.error('[Home] onMount threw:', feature.id, err));
      }
    }, 0);
  }, [openWindow, closeWindow, updateWindow]);

  // Keep ref in sync so transition callbacks always call the latest version
  openFeatureWindowRef.current = openFeatureWindow;

  // ── Auto-open Mission Monitor on first event ────────────────────────────────
  useEffect(() => {
    // Open as soon as any event arrives — capture runs in the background
    // regardless, but we also want the window visible once activity starts.
    if (events.length === 0) return;
    if (openFeaturesRef.current.has(missionMonitorFeature.id)) return;
    console.log('[Home] 🚀 First event detected, opening Mission Monitor');
    openFeatureWindow(missionMonitorFeature.id, missionMonitorFeature);
  }, [events, openFeatureWindow]);

  // ── Handle query events (QUERY_TOOL_NAMES Init + Response pairs) ─────────────
  useEffect(() => {
    console.log('[Home] 🔍 Processing events, total:', events.length);

    const eventsByEventId = new Map<string, { init?: any; response?: any }>();
    const processedKeys: string[] = [];

    events.forEach((event) => {
      if (QUERY_TOOL_NAMES.includes(event.toolName as any)) {
        console.log('[Home] 📊 Query event detected:', {
          toolName: event.toolName,
          state: event.state,
          eventId: event.eventId,
        });

        if (event.state === EVENT_STATES.INIT) {
          if (!eventsByEventId.has(event.eventId!)) {
            eventsByEventId.set(event.eventId!, {});
          }
          eventsByEventId.get(event.eventId!)!.init = event;
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
                  e.eventId !== event.eventId
              );

          if (matchingInit) {
            console.log('[Home] 🔗 Linked Response to Init:', matchingInit.eventId);
            if (!eventsByEventId.has(matchingInit.eventId!)) {
              eventsByEventId.set(matchingInit.eventId!, {});
            }
            eventsByEventId.get(matchingInit.eventId!)!.response = event;
          } else {
            console.log('[Home] ⚠️ No matching Init found for Response');
          }
        }
      }
    });

    console.log('[Home] 📦 Event groups found:', eventsByEventId.size);

    eventsByEventId.forEach((sessionEvents, eventId) => {
      if (
        sessionEvents.init &&
        sessionEvents.response &&
        !processedEventIdsRef.current.has(eventId)
      ) {
        console.log('[Home] ✅ Creating query viewer window for:', eventId);

        const init = sessionEvents.init;
        const response = sessionEvents.response;

        const queryResult: QueryResult = {
          id: eventId,
          toolName: response.toolName.replace('_', ' ').toUpperCase(),
          query: init?.input?.query || 'Query not available',
          results: response.response?.rows || [],
          executionTime: response.response?.execution_time_ms,
          timestamp: response.timestamp,
        };

        const queryFeature = createQueryViewerFeature(queryResult);
        console.log('[Home] 🎨 Opening query viewer window id:', queryFeature.id);
        openFeatureWindow(queryFeature.id, queryFeature);
        console.log('[Home] ✅ Query viewer window opened');

        processedEventIdsRef.current.add(eventId);
        processedEventIdsRef.current.add(response.eventId!);
        processedKeys.push(eventId);
        processedKeys.push(response.eventId!);
      }
    });

    if (processedKeys.length > 0) {
      clearProcessedEvents(processedKeys);
    }
  }, [events, clearProcessedEvents, openFeatureWindow]);

  // ── Auto-open diagram on kubectl Init events ──────────────────────────────────
  useEffect(() => {
    const kubectlInitEvents = events.filter(
      (event) => event.toolName.startsWith('kubectl_') && event.state === EVENT_STATES.INIT
    );
    const newEvents = kubectlInitEvents.filter(
      (event) => !processedEventIdsRef.current.has(event.eventId!)
    );
    if (newEvents.length === 0) return;

    newEvents.forEach((event) => {
      console.log('[Home] kubectl Init event detected:', { toolName: event.toolName, state: event.state });
      processedEventIdsRef.current.add(event.eventId!);
    });

    console.log('[Home] 📊 Auto-opening diagram window for kubectl Init events');
    openFeatureWindow(diagramFeature.id, diagramFeature);
    console.log('[Home] ✅ Diagram window opened');
  }, [events, openFeatureWindow]);

  // ── Auto-open unified My Work Items panel on work item Init events ────────────
  useEffect(() => {
    const WORKITEM_TOOLS = [
      'azdo_start_workitem',
      'jira_get_my_issues',
      'jira_get_issue_details',
      // ADO MCP server tools
      'ado-wit_get_work_item',
      'ado-wit_update_work_item',
      'ado-wit_add_comment',
      'ado-wit_link_work_items',
      'ado-search_workitem',
      'ado-work_get_iterations',
      'ado-work_get_team_capacity',
      'ado-core_get_projects',
      'ado-core_get_teams',
    ] as const;
    const newEvents = events.filter(
      (event) =>
        (WORKITEM_TOOLS as readonly string[]).includes(event.toolName) &&
        event.state === EVENT_STATES.INIT &&
        !processedEventIdsRef.current.has(event.eventId!)
    );
    if (newEvents.length === 0) return;

    newEvents.forEach((event) => {
      console.log('[Home] work-item Init event:', event.toolName);
      processedEventIdsRef.current.add(event.eventId!);
      myWorkItemsFeature.processEvent(event);
    });

    console.log('[Home] 📋 Auto-opening unified My Work Items window');
    openFeatureWindow(myWorkItemsFeature.id, myWorkItemsFeature);
  }, [events, openFeatureWindow]);

  // ── Auto-open unified Create Work Item feature ────────────────────────────────
  useEffect(() => {
    const CREATE_TOOLS = ['azdo_create_workitem', 'jira_create_issue', 'ado-wit_create_work_item'] as const;
    const newEvents = events.filter(
      (event) =>
        (CREATE_TOOLS as readonly string[]).includes(event.toolName) &&
        event.state === EVENT_STATES.INIT &&
        !processedEventIdsRef.current.has(event.eventId!)
    );
    if (newEvents.length === 0) return;

    newEvents.forEach((event) => processedEventIdsRef.current.add(event.eventId!));

    console.log('[Home] ➕ Auto-opening unified Create Work Item window');
    openFeatureWindow(createWorkItemFeature.id, createWorkItemFeature);
  }, [events, openFeatureWindow]);

  // ── Auto-open Optimizely feature flags panel ──────────────────────────────────
  useEffect(() => {
    const OPTIMIZELY_TOOLS = ['optimizely_get_flags', 'optimizely_update_flag'] as const;
    const newEvents = events.filter(
      (event) =>
        (OPTIMIZELY_TOOLS as readonly string[]).includes(event.toolName) &&
        event.state === EVENT_STATES.INIT &&
        !processedEventIdsRef.current.has(event.eventId!)
    );
    if (newEvents.length === 0) return;

    newEvents.forEach((event) => processedEventIdsRef.current.add(event.eventId!));

    console.log('[Home] 🚩 Auto-opening Optimizely feature flags window');
    openFeatureWindow(optimizelyFeature.id, optimizelyFeature);
  }, [events, openFeatureWindow]);
  // ── Auto-open GitHub viewer ────────────────────────────────────────────
  useEffect(() => {
    const GITHUB_TOOLS = [
      'pull_request_read', 'get_pull_request', 'get_pull_request_files',
      'get_pull_request_diff', 'get_pull_request_review_comments',
      'search_code', 'get_file_contents', 'list_issues',
    ] as const;
    const newEvents = events.filter(
      (event) =>
        (GITHUB_TOOLS as readonly string[]).includes(event.toolName) &&
        event.state === EVENT_STATES.INIT &&
        !processedEventIdsRef.current.has(event.eventId!)
    );
    if (newEvents.length === 0) return;

    newEvents.forEach((event) => {
      processedEventIdsRef.current.add(event.eventId!);
      githubViewerFeature.processEvent(event);
    });

    console.log('[Home] 🐝 Auto-opening GitHub viewer window');
    if (!openFeaturesRef.current.has(githubViewerFeature.id)) {
      openFeatureWindow(githubViewerFeature.id, githubViewerFeature);
    }
  }, [events, openFeatureWindow]);

  // ── Auto-open Browser Preview ────────────────────────────────────────
  useEffect(() => {
    const BROWSER_TOOLS = [
      'playwright_navigate', 'playwright_screenshot', 'playwright_click',
      'playwright_fill', 'playwright_select', 'playwright_hover',
      'playwright_evaluate', 'playwright_get_visible_text', 'playwright_get_visible_html',
      'playwright_go_back', 'playwright_go_forward',
      'take_screenshot', 'take_snapshot', 'navigate_page',
      'list_network_requests', 'get_network_request', 'list_console_messages', 'list_pages',
    ] as const;
    const newEvents = events.filter(
      (event) =>
        (BROWSER_TOOLS as readonly string[]).includes(event.toolName) &&
        event.state === EVENT_STATES.INIT &&
        !processedEventIdsRef.current.has(event.eventId!)
    );
    if (newEvents.length === 0) return;

    newEvents.forEach((event) => {
      processedEventIdsRef.current.add(event.eventId!);
      browserPreviewFeature.processEvent(event);
    });

    console.log('[Home] 🌐 Auto-opening Browser Preview window');
    if (!openFeaturesRef.current.has(browserPreviewFeature.id)) {
      openFeatureWindow(browserPreviewFeature.id, browserPreviewFeature);
    }
  }, [events, openFeatureWindow]);

  // ── Auto-open Docs Viewer ──────────────────────────────────────────────
  useEffect(() => {
    const DOCS_TOOLS = ['search_documentation', 'microsoft_learn_search', 'microsoft_learn_get'] as const;
    const newEvents = events.filter(
      (event) =>
        (DOCS_TOOLS as readonly string[]).includes(event.toolName) &&
        event.state === EVENT_STATES.INIT &&
        !processedEventIdsRef.current.has(event.eventId!)
    );
    if (newEvents.length === 0) return;

    newEvents.forEach((event) => {
      processedEventIdsRef.current.add(event.eventId!);
      docsViewerFeature.processEvent(event);
    });

    console.log('[Home] 📚 Auto-opening Docs Viewer window');
    if (!openFeaturesRef.current.has(docsViewerFeature.id)) {
      openFeatureWindow(docsViewerFeature.id, docsViewerFeature);
    }
  }, [events, openFeatureWindow]);
  // ── Route events to currently-open feature windows ────────────────────────────
  useEffect(() => {
    events.forEach((event) => {
      openFeaturesRef.current.forEach((feature, id) => {
        if (!feature.eventFilters?.length || !feature.processEvent) return;

        const shouldProcess = feature.eventFilters.some((filter) => {
          if (filter.toolNames) return filter.toolNames.includes(event.toolName);
          if (filter.states) return filter.states.includes(event.state);
          if (filter.custom) return filter.custom(event);
          return false;
        });

        if (shouldProcess) {
          console.log(`[Home] 🔄 Routing event ${event.toolName} to feature window: ${id}`);
          feature.processEvent(event);
          updateWindow(id, { component: feature.render() });
        }
      });
    });
  }, [events, updateWindow]);

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
