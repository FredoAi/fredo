import React from 'react';
import { useExtension } from '../providers/ExtensionProvider';
import { Home } from '../../applications/home';
import { ArchitectureDiagram } from '../../applications/diagram/components/ArchitectureDiagram';
import { DevMode } from '../../applications/dev-mode';
import { TerminalWindow } from '../../applications/terminal';
import { DoomWindow } from '../../applications/doom';
import { StandaloneAppWindow } from '../../applications/app-window';

// DEV-only navigation prototype (Spec #3118 ST-6). `import.meta.env.DEV` is replaced with
// `false` in a production build, so Rollup drops this block AND the dynamic import inside it.
// The component is created ONCE at module load, so a parent re-render cannot remount the
// preview. The two route literals are INLINED here — never a root-exported module (C2/G-419).
let NavigationPreviewLazy: React.LazyExoticComponent<React.FC> | null = null;
if (import.meta.env.DEV) {
  NavigationPreviewLazy = React.lazy(() => import('../dev/NavigationPreview'));
}

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

  // DEV-only prototype route (P4). Production builds compile this guard to `false`.
  if (
    import.meta.env.DEV &&
    NavigationPreviewLazy !== null &&
    new URLSearchParams(window.location.search).get('view') === 'navigation-preview'
  ) {
    const Preview = NavigationPreviewLazy;
    return (
      <React.Suspense fallback={null}>
        <Preview />
      </React.Suspense>
    );
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
