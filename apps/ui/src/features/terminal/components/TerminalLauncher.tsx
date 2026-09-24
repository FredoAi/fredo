import React, { useLayoutEffect, useState } from 'react';
import { Box, Text } from '@chakra-ui/react';
import { LuTriangleAlert } from 'react-icons/lu';
import { useWindowActions } from '../../../shared/window-system/useWindowActions';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { settingsService } from '../../settings';
import { ensureTerminalSettingsMigrated, WORK_DIR_KEY } from '../settings';

// Module-level in-flight guard: survives React StrictMode double-mount (mount →
// cleanup → remount would otherwise fire `open_terminal_window` twice) and
// blocks re-invocation while a launch is settling. Deliberately NOT a useRef —
// refs reset on every mount, so a ref guard would let the second mount re-fire.
let _launchInFlight = false;

/**
 * Launcher entry for the Terminal toolbar desktop item.
 *
 * The maomaolabs Toolbar opens an in-desktop window on item click; this
 * component is that window's content. On mount (a layout effect — runs before
 * paint, so the transient in-desktop window is not perceivable as a panel) it
 * migrates the pre-rename working directory (`ensureTerminalSettingsMigrated`),
 * reads the saved work dir (`terminal_work_dir`, the same key written by
 * TerminalSettings) and fires `open_terminal_window`. The backend opens the
 * `terminal` Tauri window directly — window-first, reusing an existing window
 * (one-window guarantee) — and captures every launch failure in TerminalState
 * (surfaced in the terminal window by TerminalSessionView). On resolve the
 * launcher closes the in-desktop window via `closeWindow('terminal')` so the
 * user only ever sees the single terminal window. On reject (the backend's only
 * hard-failure path — native window creation failed, so there is no terminal
 * window to surface the error in) the in-desktop window stays open and renders
 * an inline clear error; it keeps its native close control.
 *
 * The launcher never touches the `terminal` window itself — the backend owns
 * the terminal window, PTY, session lifecycle, and error surfacing.
 */
export const TerminalLauncher: React.FC = () => {
  const { closeWindow } = useWindowActions();
  const [launchError, setLaunchError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (_launchInFlight) return;
    _launchInFlight = true;

    (async () => {
      try {
        await ensureTerminalSettingsMigrated();
        const savedWorkDir = await settingsService.get<string>(WORK_DIR_KEY, '');
        await adapterBridge.invoke('open_terminal_window', { workDir: savedWorkDir || undefined });
        closeWindow('terminal');
      } catch (err) {
        setLaunchError(String(err));
      } finally {
        _launchInFlight = false;
      }
    })();
  }, [closeWindow]);

  if (launchError) {
    return (
      <Box
        role="alert"
        background="var(--card-bg)"
        border="1px solid var(--status-error)"
        px={4}
        py={3}
        m={4}
        borderRadius="md"
      >
        <Box display="flex" gap={2} alignItems="flex-start">
          <Box color="var(--status-error)" flexShrink={0} mt="1px">
            <LuTriangleAlert size={16} />
          </Box>
          <Box>
            <Text fontSize="sm" fontWeight="semibold" color="var(--status-error)">
              Could not open Terminal
            </Text>
            <Text fontSize="xs" color="var(--text-secondary)" mt={1} lineHeight="1.4">
              {launchError}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return null;
};
