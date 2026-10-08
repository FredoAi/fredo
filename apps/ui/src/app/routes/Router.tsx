import React from 'react';
import { useExtension } from '../providers/ExtensionProvider';
import { Home } from '../../applications/home';
import { ArchitectureDiagram } from '../../applications/diagram/components/ArchitectureDiagram';
import { DevMode } from '../../applications/dev-mode';
import { TerminalWindow } from '../../applications/terminal';
import { DoomWindow } from '../../applications/doom';
import { StandaloneAppWindow } from '../../applications/app-window';

export const Router: React.FC = () => {
  // Terminal window route — opened as a separate Tauri webview
  if (new URLSearchParams(window.location.search).get('view') === 'terminal') {
    return <TerminalWindow />;
  }

  // Doom window route — the dedicated `doom` webview (Spec #2968 CU-4/ST-6)
  if (new URLSearchParams(window.location.search).get('view') === 'doom') {
    return <DoomWindow />;
  }

  // Generic standalone app-window route (Spec #2955 ST-5) — the native window
  // built by `open_app_window` for any non-bespoke app loads this.
  if (new URLSearchParams(window.location.search).get('view') === 'app') {
    return <StandaloneAppWindow />;
  }

  const { currentPage, showDiagram } = useExtension();

  if (currentPage === 'dev-mode') {
    return <DevMode />;
  }

  if (showDiagram) {
    return <ArchitectureDiagram />;
  }

  return <Home />;
};
