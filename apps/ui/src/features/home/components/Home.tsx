import React, { useRef, useEffect, useCallback } from 'react';
import { Box } from '@chakra-ui/react';
import { WindowSystemProvider, WindowManager, useWindowActions } from '@maomaolabs/core';
import { AlertHandler } from './AlertHandler';
import { StreamStatus } from './StreamStatus';
import { SideStepper } from './SideStepper';
import { DesktopToolbar } from './settings/DesktopToolbar';
import { DesktopBackground } from './DesktopBackground';
import { FloatingSettingsButton } from './settings/FloatingSettingsButton';
import { myWorkItemsFeature } from '../../my-workitems';
import { createWorkItemFeature } from '../../my-workitems';
import { devModeFeature } from '../../dev-mode';
import { setupFeature } from '../../setup';
import '../../allFeatures';
import { getFeatures } from '../../featureRegistry';
import { settingsService } from '../../settings';
import { useStream } from '../../../shared/contexts/StreamContext';
import { useWindowStyle } from '../../../shared/contexts/WindowStyleContext';
import { useCompanion } from '../../../shared/contexts/CompanionContext';
import type { FredoFeatureClass } from '../../../shared/classes/FredoFeatureClass';
import { registerEventContracts } from '../../../shared/classes/EventSubscription';

// Features self-register via allFeatures.ts — no manual list needed.
const ALL_FEATURES = getFeatures();
const SHOWABLE_FEATURES = ALL_FEATURES.filter((feature) => feature.showable);

// ── Inner desktop component — must live inside <WindowSystemProvider> ─────────

const HomeDesktop: React.FC = () => {
  const { openWindow, closeWindow, updateWindow } = useWindowActions();
  const { deliveries } = useStream();
  const { showMessage } = useCompanion();

  // Register all feature eventContracts with the Rust ContractEngine on mount
  React.useEffect(() => {
    const allContracts = ALL_FEATURES.flatMap(f => f.eventContracts ?? []);
    if (allContracts.length > 0) {
      registerEventContracts(allContracts);
    }
  }, []);

  // Event delivery to features is now handled by the ECE contract pipeline
  // instead of manual eventFilters matching.

  const handleKonamiCode = useCallback(() => {
    openFeatureWindowRef.current(devModeFeature.id, devModeFeature);
    showMessage('Dev Mode Enabled 🐛', 4000);
  }, [showMessage]);

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

  const openFeatureWindow = useCallback((id: string, feature: FredoFeatureClass) => {
    openWindow({
      id,
      title: feature.name,
      icon: React.createElement(feature.icon as any, { size: 16 }) as React.ReactNode,
      component: feature.render() as React.ReactNode,
      canClose: feature.gridConfig.closable,
      canMaximize: feature.gridConfig.maximizable,
      canMinimize: true,
      isMaximized: true,
    });

    openFeaturesRef.current.set(id, feature);

    feature.registerCloseCallback(() => {
      feature.onUnmount?.();
      openFeaturesRef.current.delete(id);
      closeWindow(id);
    });

    feature.registerOpenCallback(() => {
      openFeatureWindowRef.current(feature.id, feature);
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
