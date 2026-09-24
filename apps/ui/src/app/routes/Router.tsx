import React from 'react';
import { useExtension } from '../providers/ExtensionProvider';
import { Home } from '../../features/home';
import { ArchitectureDiagram } from '../../features/diagram/components/ArchitectureDiagram';
import { DevMode } from '../../features/dev-mode';
import { TerminalWindow } from '../../features/terminal';

export const Router: React.FC = () => {
  // Terminal window route — opened as a separate Tauri webview
  if (new URLSearchParams(window.location.search).get('view') === 'terminal') {
    return <TerminalWindow />;
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
