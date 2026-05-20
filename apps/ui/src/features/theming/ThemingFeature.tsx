import React from 'react';
import type { ReactElement } from 'react';
import { LuPalette } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes/FredoFeatureClass';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { ThemingSettings } from './components/ThemingSettings';

/**
 * ThemingFeature — non-showable settings-only feature.
 * Adds a "Theming" tab to the Settings modal with live color and font customization.
 */
export class ThemingFeature extends FredoFeatureClass {
  readonly id = 'theming';
  readonly name = 'Theming';
  readonly icon = LuPalette;
  readonly eventFilters = [];
  readonly showable = false;
  readonly hasSettings = false;

  // This feature never processes stream events or renders a window.
  processEvent(_event: StreamEvent): void {}

  render(): ReactElement {
    return React.createElement(React.Fragment, null);
  }

  renderSettings(): ReactElement {
    return React.createElement(ThemingSettings, null);
  }
}
