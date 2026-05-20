export { SetupFeature } from './SetupFeature';

import { SetupFeature } from './SetupFeature';
import { registerFeature } from '../featureRegistry';
export const setupFeature = new SetupFeature();
registerFeature(setupFeature);
