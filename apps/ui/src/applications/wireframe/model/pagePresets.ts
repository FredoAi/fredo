/**
 * Wireframe page presets (Spec #3070, ST-1, C1).
 *
 * Page presets are document data: the same dimensions reopen identically under
 * any theme. Editing width/height directly yields the `custom` preset.
 */

import type { WireframePage } from './document';

export type WireframeNamedPagePreset = 'desktop' | 'tablet' | 'phone';
export type WireframePagePreset = WireframeNamedPagePreset | 'custom';

export interface WireframePresetDimensions {
  width: number;
  height: number;
}

/** The three named page presets (C1). */
export const PAGE_PRESETS: Readonly<Record<WireframeNamedPagePreset, WireframePresetDimensions>> =
  {
    desktop: { width: 1280, height: 800 },
    tablet: { width: 768, height: 1024 },
    phone: { width: 390, height: 844 },
  };

export const DEFAULT_PAGE_PRESET: WireframeNamedPagePreset = 'desktop';

/** Dimensions for a named preset (a fresh object — callers may mutate safely). */
export function pagePresetDimensions(preset: WireframeNamedPagePreset): WireframePresetDimensions {
  const dimensions = PAGE_PRESETS[preset];
  return { width: dimensions.width, height: dimensions.height };
}

/** The named preset matching these exact dimensions, or `null` (Custom). */
export function matchPagePreset(width: number, height: number): WireframeNamedPagePreset | null {
  for (const preset of Object.keys(PAGE_PRESETS) as WireframeNamedPagePreset[]) {
    const dimensions = PAGE_PRESETS[preset];
    if (dimensions.width === width && dimensions.height === height) return preset;
  }
  return null;
}

/** Build a page document value for a named preset. */
export function createPage(preset: WireframeNamedPagePreset): WireframePage {
  const dimensions = pagePresetDimensions(preset);
  return { preset, width: dimensions.width, height: dimensions.height };
}
