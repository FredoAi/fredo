import React from 'react';
import { FredoFeatureClass } from '../../shared/classes';
import { LuGamepad2 } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { DoomEntry } from './DoomEntry';

/**
 * DoomFeature — the main-window entry host for Doom Mode (Spec #2968 CU-4/ST-7).
 *
 * A `FredoFeatureClass` singleton (`isMultiWindow = false`) registered through
 * `registerFeature` so it is discoverable in the pre-feature main window. Its
 * entry renders `doom-entry-button`, which invokes `open_doom_window` only; the
 * `doom` window's own mount starts the runtime.
 */
export class DoomFeature extends FredoFeatureClass {
  readonly id = 'doom';
  readonly name = 'Doom';
  readonly icon: IconType = LuGamepad2;
  readonly isMultiWindow = false;
  readonly showable = true;

  render() {
    return <DoomEntry />;
  }
}

export default DoomFeature;
