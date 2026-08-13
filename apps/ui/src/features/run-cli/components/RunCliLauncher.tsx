import React, { useEffect } from 'react';
import { useWindowActions } from '@maomaolabs/core';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { settingsService } from '../../../features/settings';

// Module-level in-flight guard: survives React StrictMode remounts and prevents
// rapid double-clicks from spawning duplicate terminal windows.
let _launchInFlight = false;

/**
 * Launcher entry for the Run CLI toolbar desktop item.
 *
 * The maomaolabs Toolbar opens an in-desktop window on item click; this component
 * is that window's content. On mount it fires `open_run_cli` (the backend opens
 * the `run-cli-terminal` Tauri window directly — no intermediate panel) and then
 * immediately closes the in-desktop window, so the user only ever sees the
 * terminal window. Errors are surfaced in-window by RunCliLaunchStatus via
 * `get_run_cli_status` (the backend records launch failures in RunCliState).
 */
export const RunCliLauncher: React.FC = () => {
  const { closeWindow } = useWindowActions();

  useEffect(() => {
    if (_launchInFlight) return;
    _launchInFlight = true;
    (async () => {
      try {
        const savedWorkDir = await settingsService.get<string>('run_cli_work_dir', '');
        await adapterBridge.invoke('open_run_cli', { workDir: savedWorkDir || undefined });
      } catch {
        // Launch failures land in RunCliState.launch_error; the terminal window's
        // RunCliLaunchStatus surfaces them (AC5). Nothing to render here.
      } finally {
        closeWindow('run-cli');
        _launchInFlight = false;
      }
    })();
  }, [closeWindow]);

  return null;
};
