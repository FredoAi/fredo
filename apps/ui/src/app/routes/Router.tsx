import React from 'react';
import { Home } from '../../applications/home';
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

  // Spec #3122 ST-4 — the retired page-router branches (`showDiagram`, the dead
  // `currentPage === 'dev-mode'` page) are gone with the deleted hidden apps.
  // Dev Mode stays reachable through the window kernel (Home's Konami Easter egg).
  return <Home />;
};
