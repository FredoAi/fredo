/**
 * Curated wireframe icon set (Spec #3070, ST-1, C2).
 *
 * Icons are document data: each entry carries SVG path data drawn by the canvas
 * (ST-2) as a theme-coloured Konva `Path`, so the glyph survives PNG export.
 * The set is fixed at 12 curated ids; `WireframeIconId` is the closed enum.
 */

import type { WireframeIconId } from './elements';

export interface WireframeIconDefinition {
  id: WireframeIconId;
  label: string;
  /** SVG path data in a 24x24 viewBox. */
  path: string;
}

export const WIREFRAME_ICONS: readonly WireframeIconDefinition[] = [
  {
    id: 'user',
    label: 'User',
    path: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 8a8 8 0 0 1 16 0H4z',
  },
  {
    id: 'chart',
    label: 'Chart',
    path: 'M4 20V10h4v10H4zm6 0V4h4v16h-4zm6 0v-6h4v6h-4z',
  },
  {
    id: 'settings',
    label: 'Settings',
    path: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 5v-2l-2.1-.6a7 7 0 0 0-.7-1.8l1.1-1.9-1.4-1.4-1.9 1.1a7 7 0 0 0-1.8-.7L13.5 3h-3l-.6 2.1a7 7 0 0 0-1.8.7L6.2 4.7 4.8 6.1l1.1 1.9a7 7 0 0 0-.7 1.8L3 10.5v3l2.1.6a7 7 0 0 0 .7 1.8l-1.1 1.9 1.4 1.4 1.9-1.1a7 7 0 0 0 1.8.7l.7 2.2h3l.6-2.1a7 7 0 0 0 1.8-.7l1.9 1.1 1.4-1.4-1.1-1.9a7 7 0 0 0 .7-1.8L21 13z',
  },
  {
    id: 'search',
    label: 'Search',
    path: 'M10 4a6 6 0 1 0 3.5 10.9l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  },
  {
    id: 'home',
    label: 'Home',
    path: 'M12 3 2 12h3v9h6v-6h2v6h6v-9h3L12 3z',
  },
  {
    id: 'bell',
    label: 'Bell',
    path: 'M12 2a6 6 0 0 0-6 6v4l-2 3v1h16v-1l-2-3V8a6 6 0 0 0-6-6zm0 18a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2z',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    path: 'M7 2v2H4v18h16V4h-3V2h-2v2H9V2H7zm-1 6h12v12H6V8z',
  },
  {
    id: 'folder',
    label: 'Folder',
    path: 'M3 5h7l2 2h9v12H3V5z',
  },
  {
    id: 'mail',
    label: 'Mail',
    path: 'M3 5h18v14H3V5zm2 2v.6l7 5 7-5V7H5z',
  },
  {
    id: 'star',
    label: 'Star',
    path: 'm12 2 3 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.9 21l1.2-6.8-5-4.9 6.9-1L12 2z',
  },
  {
    id: 'check',
    label: 'Check',
    path: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z',
  },
  {
    id: 'arrowRight',
    label: 'Arrow right',
    path: 'M4 11h12.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H4v-2z',
  },
] as const;

/** Look up a curated icon by id. */
export function findWireframeIcon(id: WireframeIconId): WireframeIconDefinition {
  return WIREFRAME_ICONS.find((icon) => icon.id === id) ?? WIREFRAME_ICONS[0];
}
