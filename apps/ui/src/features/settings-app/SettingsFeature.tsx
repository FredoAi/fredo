import React from 'react';
import type { ReactElement } from 'react';
import type { IconType } from 'react-icons';
import { LuSettings } from 'react-icons/lu';
import { FredoFeatureClass } from '../../shared/classes';
import { SettingsSurface } from './components/SettingsSurface';

/**
 * SettingsFeature — Settings as a first-class Fredo app (Spec #2868 ST-1).
 *
 * Settings used to be a modal mounted by the floating gear
 * (`ProfileSettingsModal` + `FloatingSettingsButton`). It is now registered like
 * every other app — a `showable` singleton opened in Fredo's own window kernel
 * exactly like Mission Monitor. The shell (sidebar nav + static/auto-discovered
 * sections + unified Save footer) lives in feature-owned `SettingsSurface`.
 *
 * The stable `id = 'settings'` doubles as the window key, so `windowStore`'s
 * open/focus dedup raises the existing window instead of spawning a duplicate.
 */
export class SettingsFeature extends FredoFeatureClass {
  readonly id = 'settings';
  readonly name = 'Settings';
  readonly icon: IconType = LuSettings;
  readonly showable = true;
  readonly isMultiWindow = false;

  render(): ReactElement {
    return <SettingsSurface />;
  }
}

export const settingsFeature = new SettingsFeature();
