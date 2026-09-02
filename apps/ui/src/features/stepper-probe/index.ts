export { StepperProbeFeature, stepperProbeFeature } from './StepperProbeFeature';

import { stepperProbeFeature } from './StepperProbeFeature';
import { registerFeature } from '../featureRegistry';

// Auto-registration: allFeatures.ts eager-globs every features/*/index.ts —
// no Home.tsx edit needed.
registerFeature(stepperProbeFeature);
