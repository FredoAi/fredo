export { SetupFeature } from './SetupFeature';

// Public composition surface — the Fredo Setup section rendered by the Settings
// shell (Spec #2868 ST-1). The shell imports the section, never feature internals.
export { SetupWizard } from './components/SetupWizard';

import { SetupFeature } from './SetupFeature';
import { registerFeature } from '../featureRegistry';
export const setupFeature = new SetupFeature();
registerFeature(setupFeature);
