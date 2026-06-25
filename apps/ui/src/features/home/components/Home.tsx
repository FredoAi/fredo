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
import { useWindowStyle } from '../../../shared/contexts/WindowStyleContext';
import { useCompanion } from '../../../shared/contexts/CompanionContext';
import { QUERY_TOOL_NAMES } from '../../../shared/constants';
import type { FredoFeatureClass } from '../../../shared/classes/FredoFeatureClass';
import type { SubscriptionDelivery } from '../../../shared/classes/EventSubscription';

// Features self-register via allFeatures.ts — no manual list needed.
const ALL_FEATURES = getFeatures();
const SHOWABLE_FEATURES = ALL_FEATURES.filter((feature) => feature.showable);

// ── Tool-name sets for auto-open detection (backward compat until contracts define these) ──
const WORKITEM_TOOLS: readonly string[] = [
  'azdo_start_workitem',
  'jira_get_my_issues',
  'jira_get_issue_details',
  'ado-wit_get_work_item',
  'ado-wit_update_work_item',
  'ado-wit_add_comment',
  'ado-wit_link_work_items',
  'ado-search_workitem',
  'ado-work_get_iterations',
  'ado-work_get_team_capacity',
  'ado-core_get_projects',
  'ado-core_get_teams',
];

const CREATE_TOOLS: readonly string[] = [
  'azdo_create_workitem', 'jira_create_issue', 'ado-wit_create_work_item',
];

const OPTIMIZELY_TOOLS: readonly string[] = [
  'optimizely_get_flags', 'optimizely_update_flag',
];

const GITHUB_TOOLS: readonly string[] = [
  'pull_request_read', 'get_pull_request', 'get_pull_request_files',
  'get_pull_request_diff', 'get_pull_request_review_comments',
  'search_code', 'get_file_contents', 'list_issues',
];

const BROWSER_TOOLS: readonly string[] = [
  'playwright_navigate', 'playwright_screenshot', 'playwright_click',
  'playwright_fill', 'playwright_select', 'playwright_hover',
  'playwright_evaluate', 'playwright_get_visible_text', 'playwright_get_visible_html',
  'playwright_go_back', 'playwright_go_forward',
  'take_screenshot', 'take_snapshot', 'navigate_page',
  'list_network_requests', 'get_network_request', 'list_console_messages', 'list_pages',
];

const DOCS_TOOLS: readonly string[] = [
  'search_documentation', 'microsoft_learn_search', 'microsoft_learn_get',
];

/**
 * Helper: extract a toolName from a SubscriptionDelivery's fields.
 * During the ECE transition, delivery fields may contain a 'toolName'
 * entry for backward compatibility with legacy auto-open logic.
 */
function getDeliveryToolName(delivery: SubscriptionDelivery): string | undefined {
  if (delivery.fields && typeof delivery.fields === 'object') {
    const v = (delivery.fields as Record<string, unknown>).toolName;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * Helper: extract a query from a delivery with lifecycle End (response).
 */
function getDeliveryQuery(delivery: SubscriptionDelivery): string {
  try {
    if (delivery.fields && typeof delivery.fields.query === 'string') {
      return delivery.fields.query;
    }
  } catch {
    // ignore
  }
  return 'Query not available';
}

/**
 * Helper: extract rows from a delivery with lifecycle End (response).
 */
function getDeliveryRows(delivery: SubscriptionDelivery): unknown[] {
  try {
    if (delivery.fields && Array.isArray(delivery.fields.rows)) {
      return delivery.fields.rows;
    }
  } catch {
    // ignore
  }
  return [];
}

/**
 * Helper: extract execution time from a delivery.
 */
function getDeliveryExecutionTime(delivery: SubscriptionDelivery): number | undefined {
  try {
    if (delivery.fields && typeof delivery.fields.executionTimeMs === 'number') {
      return delivery.fields.executionTimeMs;
    }
  } catch {
    // ignore
  }
  return undefined;
}

// ── Inner desktop component — must live inside <WindowSystemProvider> ─────────

const HomeDesktop: React.FC = () => {
  const { openWindow, closeWindow, updateWindow } = useWindowActions();
  const { deliveries } = useStream();
  const { showMessage } = useCompanion();

  const handleKonamiCode = useCallback(() => {
    openFeatureWindowRef.current(devModeFeature.id, devModeFeature);
    showMessage('Dev Mode Enabled 🐛', 4000);
  }, [showMessage]);

  // Track processed correlation keys to prevent duplicate auto-opens
  const processedKeysRef = useRef<Set<string>>(new Set());

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

  // Track open features so we can call lifecycle hooks
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

  // ── Auto-open Mission Monitor on first delivery ────────────────────────────
  useEffect(() => {
    if (deliveries.length === 0) return;
    if (openFeaturesRef.current.has(missionMonitorFeature.id)) return;
    openFeatureWindow(missionMonitorFeature.id, missionMonitorFeature);
  }, [deliveries, openFeatureWindow]);

  // ── React to Init deliveries — auto-open features ───────────────────────────
  useEffect(() => {
    const newInitDeliveries = deliveries.filter(
      (d) => d.lifecycle === 'Init' && d.correlationKey && !processedKeysRef.current.has(d.correlationKey)
    );
    if (newInitDeliveries.length === 0) return;

    newInitDeliveries.forEach((delivery) => {
      if (!delivery.correlationKey) return;
      processedKeysRef.current.add(delivery.correlationKey);
      const toolName = getDeliveryToolName(delivery);

      // ── Query events ──────────────────────────────────────────────────────
      if (toolName && (QUERY_TOOL_NAMES as readonly string[]).includes(toolName)) {
        // Query lifecycle is handled by contracts; auto-open is deferred
        // until we see a matching End delivery.
        return;
      }

      // ── Diagram (kubectl) ──────────────────────────────────────────────────
      if (toolName && toolName.startsWith('kubectl_')) {
        openFeatureWindow(diagramFeature.id, diagramFeature);
        return;
      }

      // ── My Work Items ──────────────────────────────────────────────────────
      if (toolName && (WORKITEM_TOOLS as readonly string[]).includes(toolName)) {
        // NOTE: feature.processEvent() still exists on the feature classes
        // but is no longer called from Home. Feature-local event processing
        // will be handled by eventContracts in a future capsule.
        openFeatureWindow(myWorkItemsFeature.id, myWorkItemsFeature);
        return;
      }

      // ── Create Work Item ────────────────────────────────────────────────────
      if (toolName && (CREATE_TOOLS as readonly string[]).includes(toolName)) {
        openFeatureWindow(createWorkItemFeature.id, createWorkItemFeature);
        return;
      }

      // ── Optimizely ──────────────────────────────────────────────────────────
      if (toolName && (OPTIMIZELY_TOOLS as readonly string[]).includes(toolName)) {
        openFeatureWindow(optimizelyFeature.id, optimizelyFeature);
        return;
      }

      // ── GitHub Viewer ────────────────────────────────────────────────────────
      if (toolName && (GITHUB_TOOLS as readonly string[]).includes(toolName)) {
        if (!openFeaturesRef.current.has(githubViewerFeature.id)) {
          openFeatureWindow(githubViewerFeature.id, githubViewerFeature);
        }
        return;
      }

      // ── Browser Preview ──────────────────────────────────────────────────────
      if (toolName && (BROWSER_TOOLS as readonly string[]).includes(toolName)) {
        if (!openFeaturesRef.current.has(browserPreviewFeature.id)) {
          openFeatureWindow(browserPreviewFeature.id, browserPreviewFeature);
        }
        return;
      }

      // ── Docs Viewer ──────────────────────────────────────────────────────────
      if (toolName && (DOCS_TOOLS as readonly string[]).includes(toolName)) {
        if (!openFeaturesRef.current.has(docsViewerFeature.id)) {
          openFeatureWindow(docsViewerFeature.id, docsViewerFeature);
        }
        return;
      }
    });
  }, [deliveries, openFeatureWindow]);

  // ── Handle query End deliveries — create query viewer windows ──────────────
  useEffect(() => {
    deliveries.forEach((delivery) => {
      if (delivery.lifecycle !== 'End') return;
      if (!delivery.correlationKey) return;
      if (processedKeysRef.current.has(`query-${delivery.correlationKey}`)) return;

      const toolName = getDeliveryToolName(delivery);
      if (!toolName || !(QUERY_TOOL_NAMES as readonly string[]).includes(toolName)) return;

      processedKeysRef.current.add(`query-${delivery.correlationKey}`);

      const queryResult: QueryResult = {
        id: delivery.correlationKey,
        toolName: toolName.replace('_', ' ').toUpperCase(),
        query: getDeliveryQuery(delivery),
        results: getDeliveryRows(delivery) as any[],
        executionTime: getDeliveryExecutionTime(delivery),
        timestamp: delivery.timestamp,
      };

      const queryFeature = createQueryViewerFeature(queryResult);
      openFeatureWindow(queryFeature.id, queryFeature);
    });
  }, [deliveries, openFeatureWindow]);

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
