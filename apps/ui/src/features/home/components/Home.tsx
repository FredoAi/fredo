import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { Box } from '@chakra-ui/react';
import { WindowSystemProvider } from '../../../shared/window-system/WindowSystemProvider';
import { WindowManager } from '../../../shared/window-system/WindowManager';
import { hydrateZoneLayout, reopenZonedWindows } from '../../../shared/window-system/zoneLayoutStore';
import { updateWindow } from '../../../shared/window-system/windowStore';
import { useWindowActions } from '../../../shared/window-system/useWindowActions';
import { createAppOpener } from '../../../shared/window-system/appWindows';
import { hydrateAppPresentation } from '../../../shared/window-system/appPresentationStore';
import { LauncherShell } from './launcher/LauncherShell';
import { DesktopBackdrop } from './background/DesktopBackdrop';
import { myWorkItemsFeature } from '../../my-workitems';
import { createWorkItemFeature } from '../../my-workitems';
import { devModeFeature } from '../../dev-mode';
import { setupFeature } from '../../setup';
import '../../allFeatures';
import { declareAllRegisteredFeatureData } from '../../../shared/feature-data/registry';
import { getFeatures, dedupeByFeatureId } from '../../featureRegistry';
import { settingsService } from '../../settings';
import { useCompanion } from '../../../shared/contexts/CompanionContext';
import { useKonamiCode } from '../../../shared/hooks/useKonamiCode';
import { useSecretCode } from '../../../shared/hooks/useSecretCode';
import { DOOM_SECRET_CODE, useDoomMode, useDoomModeSkill } from '../../../shared/doom-mode';
import { useAppOpenRequests } from '../hooks/useAppOpenRequests';
import type { FredoFeatureClass } from '../../../shared/classes/FredoFeatureClass';

// Features self-register via allFeatures.ts — no manual list needed.
const ALL_FEATURES = getFeatures();
// #2826: de-dup by feature `id` before the launcher consumes showables. The app
// grid and its keyboard-nav indices are index-aligned BY CONSTRUCTION — one tile
// per distinct id (no ghost tiles, no nav-sequence gaps), robust to double
// registration. ALL_FEATURES stays un-deduped for the open-callback registration
// loop below.
const SHOWABLE_FEATURES = dedupeByFeatureId(ALL_FEATURES.filter((feature) => feature.showable));

// ── Inner desktop component — must live inside <WindowSystemProvider> ─────────

interface HomeDesktopProps {
  registerOpenFeature: (fn: (id: string, feature: FredoFeatureClass) => void) => void;
}

const HomeDesktop: React.FC<HomeDesktopProps> = ({ registerOpenFeature }) => {
  const { openWindow, closeWindow, updateWindow } = useWindowActions();
  const { showMessage } = useCompanion();

  // Pre-register each feature's open callback at mount (#2758 round-22 C2):
  // previously registerOpenCallback() ran only inside openFeatureWindow(), so
  // `openSelf()` was null-noop for any feature never manually opened this
  // session. Registering eagerly is idempotent: openFeatureWindow()
  // re-registers on every open, replacing this callback with an equivalent.
  //
  // Spec #2955 ST-4: `openSelf()` is a USER-initiated open, so it routes through
  // the presentation-aware `openApp` (not the raw in-window opener) — the
  // per-app choice is honored here too. Internal transition callbacks stay on
  // the raw `openFeatureWindowRef`.
  React.useEffect(() => {
    ALL_FEATURES.forEach((feature) => {
      feature.registerOpenCallback(() => {
        openAppRef.current(feature.id, feature);
      });
    });
    // Spec #2896 ST-5 — bootstrap: materialize EVERY registered feature-data
    // declaration with ONE idempotent `feature_data_declare` (A-17). Runs at
    // runtime (after feature modules registered their declarations and after
    // main.tsx registered the adapter), never at module-evaluation time.
    void declareAllRegisteredFeatureData();
  }, []);

  const handleKonamiCode = useCallback(() => {
    openFeatureWindowRef.current(devModeFeature.id, devModeFeature);
    showMessage('Dev Mode Enabled 🐛', 4000);
  }, [showMessage]);

  // Re-home the konami → dev-mode easter egg. The hook attaches a document-level
  // keydown listener (position-independent), so it keeps working after the
  // decorative full-screen animated background was removed (#2817).
  useKonamiCode(handleKonamiCode);

  // Spec #2970 ST-6 — the typed secret trigger. `useSecretCode` mirrors the
  // document-level Konami host directly above: completing `iddqd` (five keys, no
  // modifier, outside an editable control) enters Doom Mode with origin `code`.
  // The hook renders NOTHING — the opened `doom` window is the sole feedback, so
  // the secret leaves no discoverable trace before activation (AC3/R-5).
  const { enter: enterDoomMode } = useDoomMode();
  const handleDoomCode = useCallback(() => {
    void enterDoomMode('code');
  }, [enterDoomMode]);
  useSecretCode(DOOM_SECRET_CODE, handleDoomCode);

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

  // Boot-time hydration of the persisted ZONE configuration (Spec #2980 ST-6,
  // R-4.2 / AC4): HomeDesktop is an always-mounted consumer at app boot, so its
  // first mount triggers the module-scoped zone store's idempotent, once-only
  // `hydrateZoneLayout()`. Without this the zone model stays empty until some
  // other consumer happens to mount, so a saved active layout would not restore
  // on a restart. The store is `hydrationStarted`-once + dirty-guarded, so a
  // later consumer's call is a harmless no-op and a late read never clobbers an
  // in-flight user write.
  //
  // After hydration resolves, REOPEN the active layout's zoned windows through
  // the raw in-window `openFeatureWindow` and immediately un-maximize them
  // (`updateWindow(id, { isMaximized: false })`) so they land directly in their
  // zones instead of rendering as degraded "App not available" placeholders.
  // The reopen is BOOT-HYDRATION ONLY, skips unregistered ids (the degraded path
  // renders them — R-4.4), and is a no-op while layout management is disabled or
  // no layout is active. Mount-only ([] deps) — `openFeatureWindowRef` is read at
  // call time and the module functions are stable, so no re-render loop (#523).
  useEffect(() => {
    void hydrateZoneLayout().then(() => {
      reopenZonedWindows({
        features: ALL_FEATURES,
        open: (id, feature) => openFeatureWindowRef.current(id, feature),
        update: (id, patch) => updateWindow(id, patch),
      });
    });
  }, []);

  // Spec #2955 ST-4 — boot-time hydration of the per-app presentation map, so
  // the ONE `openApp` resolves the user's choice on the very first open without
  // a flash. Idempotent + once-only at module scope; NO state write here (the
  // store notifies its own subscribers), so this is a mount-only effect with no
  // re-render loop (#523). `openApp` also awaits hydration, so this is purely
  // eager readiness.
  useEffect(() => {
    void hydrateAppPresentation();
  }, []);

  // Track open features so we can route deliveries and call lifecycle hooks
  const openFeaturesRef = useRef<Map<string, FredoFeatureClass>>(new Map());

  // Stable ref to allow recursive calls inside transition callbacks without circular deps
  const openFeatureWindowRef = useRef<(id: string, feature: FredoFeatureClass) => void>(() => {});

  // Spec #2955 ST-4 — the presentation-aware opener ref. USER-initiated entry
  // points (openSelf registration, launcher grid, Open-apps row, app-open CLI /
  // companion skill) read THIS; internal transition callbacks keep using the
  // raw `openFeatureWindowRef` so a workitem transition never re-routes through
  // the per-app choice.
  const openAppRef = useRef<(id: string, feature: FredoFeatureClass) => void>(() => {});

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

    // openSelf() is user-initiated — route it through the presentation-aware
    // opener (Spec #2955 ST-4). Internal transition callbacks below stay raw.
    feature.registerOpenCallback(() => {
      openAppRef.current(feature.id, feature);
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

  // Spec #2955 ST-4 — THE ONE presentation-aware opener. Every USER-initiated
  // open flows through it: the launcher grid + Open-apps row (via the
  // registered opener), the `fredo open-app` / companion `open_app` round trip
  // (`useAppOpenRequests`), and `openSelf`. `createAppOpener` awaits the per-app
  // presentation hydration, then branches `new-window` → the Rust singleton
  // native host (AC3) or `same-window` → the raw in-window `openFeatureWindow`.
  //
  // Internal transition callbacks and the #2980 `reopenZonedWindows` restore do
  // NOT route through here — they call `openFeatureWindowRef.current` directly,
  // so a workitem transition / zoned-workspace restore always stays in-window.
  // The bound in-window opener reads the ref at call time, so it always sees the
  // latest `openFeatureWindow`; the factory itself is created once.
  const openApp = useMemo(
    () => createAppOpener((id, feature) => openFeatureWindowRef.current(id, feature)),
    [],
  );

  // #2893 ST-6 — the ONE app-open request/confirm loop: the CLI `open-app`
  // round trip (`app-open-request`) and the companion skill selection
  // (`llm-skill-call`) both resolve through `resolveAppIdentity` and open
  // through the ONE presentation-aware `openApp` (never a raw `openWindow`).
  // The backend addresses the `main` window only, so the terminal route never
  // receives these events.
  useAppOpenRequests({ openFeatureWindow: openApp, features: SHOWABLE_FEATURES });

  // Spec #2970 ST-6 — the companion `doom_mode` dispatcher: it validates the
  // model-selected action, invokes enter/exit, and ALWAYS pushes one
  // deterministic reply (the 15 s watchdog can never fire). It filters only
  // `doom_mode`, so it coexists with `useAppOpenRequests` on the same
  // `llm-skill-call` channel without cross-talk.
  useDoomModeSkill();

  // Keep the refs in sync so transition callbacks always call the latest version,
  // and register the presentation-aware opener with the Home-level ref so the
  // sibling LauncherShell (which renders outside HomeDesktop, inside the
  // provider) routes launcher grid + Open-apps clicks through it. `openApp` and
  // `openFeatureWindow` are stable useCallbacks and `registerOpenFeature` is a
  // stable useCallback, so this runs once.
  useEffect(() => {
    openFeatureWindowRef.current = openFeatureWindow;
    openAppRef.current = openApp;
    registerOpenFeature(openApp);
  }, [openFeatureWindow, openApp, registerOpenFeature]);

  // The decorative full-screen animated background (#2817) is gone — the clean
  // shell chrome (FREDO notch, avatar, search bar, side ticks, clock) is rendered
  // by the sibling LauncherShell. HomeDesktop keeps only its orchestration hooks
  // (feature registration + konami), so it renders nothing.
  return null;
};

// ── Top-level Home component ──────────────────────────────────────────────────

export const Home: React.FC = () => {
  // Stable ref to the own-kernel openFeatureWindow so the sibling LauncherShell (which
  // renders outside HomeDesktop, inside the provider) can route a launcher click through
  // the own kernel's full-lifecycle opener. The initial no-op default means any click
  // before HomeDesktop's registration effect runs is a harmless no-op.
  const openFeatureRef = useRef<(id: string, feature: FredoFeatureClass) => void>(() => {});

  // Stable registration callback: HomeDesktop hands its openFeatureWindow up to this ref.
  const registerOpenFeature = useCallback((fn: (id: string, feature: FredoFeatureClass) => void) => {
    openFeatureRef.current = fn;
  }, []);

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
      {/* Row: Desktop (full width). The v1 SideStepper sidebar was deleted with
          the v1 event pipeline (Spec #2788 P5.1). */}
      <Box flex="1" display="flex" flexDirection="row" overflow="hidden" minHeight="0">
        {/* Desktop: transform scopes position:fixed windows to this box */}
        <Box flex="1" position="relative" overflow="hidden" style={{ transform: 'translateZ(0)' }}>
          <WindowSystemProvider>
            <Box display="flex" flexDirection="column" height="100%">
              <Box flex="1" position="relative" overflow="hidden">
                {/* #2899 ST-3 — the desktop background layer. FIRST child at
                    zIndex 0, strictly below WindowManager's z=1 container, so it
                    never paints above a window. Renders null for `none`. */}
                <DesktopBackdrop />
                <WindowManager />
                <HomeDesktop registerOpenFeature={registerOpenFeature} />
              </Box>
              <LauncherShell
                showableFeatures={SHOWABLE_FEATURES}
                onOpenFeature={(id, feature) => openFeatureRef.current(id, feature)}
              />
            </Box>
          </WindowSystemProvider>
        </Box>
      </Box>
    </Box>
  );
};
