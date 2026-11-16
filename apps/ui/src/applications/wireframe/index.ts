/**
 * Wireframe application barrel (Spec #3070, ST-1).
 *
 * The eager application-folder glob in `allApplications.ts` imports this module
 * for its `registerApplication` side-effect — no `Home.tsx`,
 * `allApplications.ts` or `SettingsSurface.tsx` edit is needed (the G-265 entry
 * path).
 */

export { WireframeFeature, wireframeFeature } from './WireframeFeature';
export { WireframeEditor } from './components/WireframeEditor';
export { LuPenTool as WireframeIcon } from 'react-icons/lu';

import { wireframeFeature } from './WireframeFeature';
import { registerApplication } from '../applicationRegistry';

registerApplication(wireframeFeature);
