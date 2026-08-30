export { StepperProbeFeature, stepperProbeFeature } from './StepperProbeFeature';

import { stepperProbeFeature } from './StepperProbeFeature';
import { registerFeature } from '../featureRegistry';

// Auto-registration: allFeatures.ts eager-globs every features/*/index.ts,
// and Home.tsx flatMaps ALL_FEATURES' eventContracts into
// registerEventContracts() at mount — no Home.tsx edit needed.
registerFeature(stepperProbeFeature);
