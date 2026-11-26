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
import { WireframeEditor } from './components/WireframeEditor';

export class WireframeFeature extends FredoApplicationClass {
  readonly id = WIREFRAME_APP_ID;
  readonly name = 'Wireframe';
  readonly description = 'Draw and edit UI wireframes on a canvas.';
  readonly icon = LuPenTool;
  readonly showable = true;
  readonly isMultiWindow = false;
  readonly hasSettings = false;
  /**
   * Spec #3151 ST-5 — the navigation engine is gone: no declarative surface, no
   * key adapter, no command bar. The editor is the pointer product (canvas +
   * insert menu + control strip + property panel + file commands), and the
   * companion reaches the application through its application-level grounding
   * registration.
   */

  render(): ReactElement {
    return <WireframeEditor />;
  }
}

export const wireframeFeature = new WireframeFeature();
