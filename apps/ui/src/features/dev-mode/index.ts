export { DevMode } from './components/DevMode';
export { useDevModeStream } from './hooks/useDevModeStream';
export { DevModeFeature, devModeFeature } from './DevModeFeature';

import { devModeFeature } from './DevModeFeature';
import { registerFeature } from '../featureRegistry';
registerFeature(devModeFeature);
