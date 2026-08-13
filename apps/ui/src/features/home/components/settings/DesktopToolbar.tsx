import React, { useMemo, useEffect, useRef, useState, useCallback } from 'react';
import { Toolbar, useWindows } from '@maomaolabs/core';
import { Box, Button, HStack, Text } from '@chakra-ui/react';
import { LuTerminal, LuTriangleAlert } from 'react-icons/lu';
import FredoLogoUrl from '../../../../assets/fredo-logo-icon.png';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';
import { useCompanion } from '../../../../shared/contexts/CompanionContext';
import { settingsService } from '../../../../features/settings';
import { adapterBridge } from '../../../../shared/utils/adapterBridge';

// Run CLI launches directly into its own Tauri window (run-cli-terminal) via the
// `open_run_cli` IPC command — it must NEVER be offered as an in-desktop window
// item here (that would open the intermediate launch panel / an empty window).
const RUN_CLI_FEATURE_ID = 'run-cli';

// Module-level in-flight guard: survives React StrictMode remounts and prevents
// rapid double-clicks from spawning duplicate terminal windows.
let _launchInFlight = false;

// Auto-dismiss window for the transient launch-error message.
const LAUNCH_ERROR_MS = 6000;

// MdOutlineEventSeat SVG — shown when Fredo is out in the world
const SEAT_SVG_DATA = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="rgba(255,255,255,0.75)"><path d="M4 18v3h3v-3h10v3h3v-6H4v3zm15-8h3v3h-3zM2 10h3v3H2zm15 3H7V5c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2v8z"/></svg>')}`;

const OVERLAY_ID = 'Fredo-launcher-overlay';

function upsertOverlay(button: HTMLElement, src: string, cover: boolean) {
  let img = button.querySelector<HTMLImageElement>(`#${OVERLAY_ID}`);
  if (!img) {
    img = document.createElement('img');
    img.id = OVERLAY_ID;
    img.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'pointer-events:none',
      'z-index:10',
    ].join(';');
    button.appendChild(img);
  }
  img.src = src;
  img.style.objectFit = cover ? 'cover' : 'contain';
  img.style.padding = cover ? '0' : '18%';
}

function findLauncherButton(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Desktop Toolbar"] button[aria-label="Open Menu"]') ??
    document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Desktop Toolbar"] button[aria-label="Close Menu"]') ??
    document.querySelector<HTMLElement>('button[class*="_pawButton_"]')
  );
}

export type ShowableFeatureEntry = FredoFeatureClass;

interface DesktopToolbarProps {
  showableFeatures: ShowableFeatureEntry[];
}

export const DesktopToolbar: React.FC<DesktopToolbarProps> = ({ showableFeatures }) => {
  const currentWindows = useWindows();
  const { state: companionState } = useCompanion();
  const observerRef = useRef<MutationObserver | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);

  // Direct single-window launch: read the saved work dir and invoke `open_run_cli`
  // (the backend opens the `run-cli-terminal` Tauri window — no intermediate panel).
  const handleLaunchRunCli = useCallback(async () => {
    if (_launchInFlight) return;
    _launchInFlight = true;
    setIsLaunching(true);
    setLaunchError(null);
    try {
      const savedWorkDir = await settingsService.get<string>('run_cli_work_dir', '');
      await adapterBridge.invoke('open_run_cli', { workDir: savedWorkDir || undefined });
    } catch (err) {
      setLaunchError(String(err));
      if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = window.setTimeout(() => setLaunchError(null), LAUNCH_ERROR_MS);
    } finally {
      _launchInFlight = false;
      setIsLaunching(false);
    }
  }, []);

  // Clear the transient error timer on unmount.
  useEffect(() => () => {
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
  }, []);

  // Inject the overlay image into the maomaolabs launcher button
  useEffect(() => {
    const src = companionState.isVisible ? SEAT_SVG_DATA : FredoLogoUrl;
    const cover = !companionState.isVisible;

    const apply = () => {
      const btn = findLauncherButton();
      if (btn) upsertOverlay(btn, src, cover);
    };

    apply();

    // Watch for the button to appear (first render) or be replaced
    observerRef.current?.disconnect();
    observerRef.current = new MutationObserver(apply);
    observerRef.current.observe(document.body, { childList: true, subtree: true });

    return () => observerRef.current?.disconnect();
  }, [companionState.isVisible]);

  const toolbarItems = useMemo(() => showableFeatures
    .filter((feature) => feature.id !== RUN_CLI_FEATURE_ID)
    .map((feature) => {
      const Icon = feature.icon;
      const id = feature.isMultiWindow
        ? `${feature.id}-${currentWindows.filter(w => w.id.startsWith(`${feature.id}-`)).length}`
        : feature.id;
      return {
        id,
        title: feature.name,
        icon: <Icon size={16} />,
        component: feature.render(),
        canClose: feature.gridConfig.closable,
        canMaximize: feature.gridConfig.maximizable,
        canMinimize: true,
        isMaximized: true,
      };
    }), [showableFeatures, currentWindows]);

  return (
    <>
      <style>{`
        [role="toolbar"][aria-label="Desktop Toolbar"] button[aria-label="Open Menu"],
        [role="toolbar"][aria-label="Desktop Toolbar"] button[aria-label="Close Menu"],
        button[class*="_pawButton_"] {
          position: relative !important;
          width: 52px !important;
          height: 52px !important;
        }
        [role="toolbar"][aria-label="Desktop Toolbar"] button[aria-label="Open Menu"] > *:not(#${OVERLAY_ID}),
        [role="toolbar"][aria-label="Desktop Toolbar"] button[aria-label="Close Menu"] > *:not(#${OVERLAY_ID}),
        button[class*="_pawButton_"] > *:not(#${OVERLAY_ID}) {
          opacity: 0 !important;
          font-size: 0 !important;
        }
      `}</style>
      <Toolbar toolbarItems={toolbarItems as any} showLogo={true} />
      <Box
        position="fixed"
        bottom="12px"
        right="16px"
        zIndex={100000}
        display="flex"
        flexDirection="column"
        alignItems="flex-end"
        gap={2}
      >
        {launchError && (
          <Box
            role="alert"
            background="var(--card-bg)"
            border="1px solid var(--status-error)"
            px={3}
            py={2}
            borderRadius="md"
            boxShadow="0 4px 12px rgba(0, 0, 0, 0.2)"
            maxW="300px"
          >
            <HStack gap={2} alignItems="flex-start">
              <Box color="var(--status-error)" flexShrink={0} mt="1px">
                <LuTriangleAlert size={14} />
              </Box>
              <Text fontSize="xs" color="var(--status-error)" lineHeight="1.4">
                Could not launch Run CLI: {launchError}
              </Text>
            </HStack>
          </Box>
        )}
        <Button
          size="sm"
          aria-label="Run CLI"
          borderRadius="full"
          background="var(--accent-primary)"
          color="white"
          boxShadow="0 4px 12px rgba(0, 0, 0, 0.25)"
          _hover={{ opacity: 0.9, transform: 'scale(1.04)' }}
          _active={{ transform: 'scale(0.98)' }}
          onClick={handleLaunchRunCli}
          disabled={isLaunching}
        >
          <HStack gap={1.5}>
            <LuTerminal size={14} />
            <Text fontSize="sm" fontWeight="semibold">Run CLI</Text>
          </HStack>
        </Button>
      </Box>
    </>
  );
};