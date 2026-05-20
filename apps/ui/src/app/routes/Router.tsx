import React from 'react';
import { useExtension } from '../providers/ExtensionProvider';
import { Home } from '../../features/home';
import { ArchitectureDiagram } from '../../features/diagram/components/ArchitectureDiagram';
import { DevMode } from '../../features/dev-mode';
import { Settings } from '../../features/settings';
import { RunCliTerminalWindow } from '../../features/run-cli';

export const Router: React.FC = () => {
  // Terminal window route — opened as a separate Tauri webview
  if (new URLSearchParams(window.location.search).get('view') === 'terminal') {
    return <RunCliTerminalWindow />;
  }

  const { currentPage, showDiagram } = useExtension();

  if (currentPage === 'settings') {
    return <Settings />;
  }

  if (currentPage === 'dev-mode') {
    return <DevMode />;
  }

  if (showDiagram) {
    return <ArchitectureDiagram />;
  }

  return <Home />;
};
