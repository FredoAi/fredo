export { StepperProbeFeature, stepperProbeFeature } from './StepperProbeFeature';

import { stepperProbeFeature } from './StepperProbeFeature';
import { registerApplication } from '../applicationRegistry';

// Auto-registration: allApplications.ts eager-globs every applications/*/index.ts —
// no Home.tsx edit needed.
registerApplication(stepperProbeFeature);
