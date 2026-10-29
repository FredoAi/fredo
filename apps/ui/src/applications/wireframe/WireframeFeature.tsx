/**
 * Wireframe application class (Spec #3070, ST-1, C9).
 *
 * Identity is binding: id `wireframe`, name `Wireframe`, icon `LuPenTool`,
 * showable, singleton, no settings pane. Registration happens in `index.ts`;
 * the eager `allApplications.ts` glob discovers it with no central-list edit.
 */

import type { ReactElement } from 'react';
import { LuPenTool } from 'react-icons/lu';

import { FredoApplicationClass } from '../../shared/classes';
import { WIREFRAME_APP_ID } from './model/document';
import { wireframeCommandSurface } from './wireframeCommandSurface';
import { WireframeEditor } from './components/WireframeEditor';

export class WireframeFeature extends FredoApplicationClass {
  readonly id = WIREFRAME_APP_ID;
  readonly name = 'Wireframe';
  readonly icon = LuPenTool;
  readonly showable = true;
  readonly isMultiWindow = false;
  readonly hasSettings = false;
  /**
   * Spec #3098 ST-3 — Wireframe is the first application to opt into the
   * declarative command surface (modes + commands). Declaring it never changes
   * another application's scope.
   */
  readonly commandSurface = wireframeCommandSurface;

  render(): ReactElement {
    return <WireframeEditor />;
  }
}

export const wireframeFeature = new WireframeFeature();
