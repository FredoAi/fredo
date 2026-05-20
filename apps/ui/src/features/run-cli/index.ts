export { RunCliFeature } from './RunCliFeature';
export { RunCliTerminalWindow } from './components/RunCliTerminalWindow';

import { RunCliFeature } from './RunCliFeature';
import { registerFeature } from '../featureRegistry';
export const runCliFeature = new RunCliFeature();
registerFeature(runCliFeature);
