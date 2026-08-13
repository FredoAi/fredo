import React, { useMemo, useEffect, useRef } from 'react';
import { Toolbar, useWindows } from '@maomaolabs/core';
import FredoLogoUrl from '../../../../assets/fredo-logo-icon.png';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';
import { useCompanion } from '../../../../shared/contexts/CompanionContext';

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

  // Every showable feature is a desktop item — Run CLI included. Its `render()`
  // (RunCliLauncher) fires `open_run_cli` on mount and closes the in-desktop
  // window immediately, so clicking the item opens the terminal window directly.
  const toolbarItems = useMemo(() => showableFeatures
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
    </>
  );
};
