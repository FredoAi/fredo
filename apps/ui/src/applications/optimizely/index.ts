export { OptimizelyFeature, optimizelyFeature } from './OptimizelyFeature';
export type { OptimizelyFlag, FlagEnvironment, FlagStatus, GetFlagsResponse } from './types';

import { optimizelyFeature } from './OptimizelyFeature';
import { registerApplication } from '../applicationRegistry';
registerApplication(optimizelyFeature);
