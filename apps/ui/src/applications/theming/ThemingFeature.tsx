import React from 'react';
import type { ReactElement } from 'react';
import { LuPalette } from 'react-icons/lu';
import { FredoApplicationClass } from '../../shared/classes/FredoApplicationClass';
import { ThemingSettings } from './components/ThemingSettings';

/**
 * ThemingFeature — non-showable settings-only feature.
 * Adds a "Theming" tab to the Settings modal with live color and font customization.
 */
export class ThemingFeature extends FredoApplicationClass {
  readonly id = 'theming';
  readonly name = 'Theming';
  readonly icon = LuPalette;
  readonly showable = false;
  readonly hasSettings = false;

  render(): ReactElement {
    return React.createElement(React.Fragment, null);
  }

  renderSettings(): ReactElement {
    return React.createElement(ThemingSettings, null);
  }
}
