export { ThemingFeature } from './ThemingFeature';

// Public composition surface — the Appearance section rendered by the Settings
// shell (Spec #2868 ST-1). The shell imports the section, never feature internals.
export { ThemingSettings } from './components/ThemingSettings';

import { ThemingFeature } from './ThemingFeature';
import { registerApplication } from '../applicationRegistry';
export const themingFeature = new ThemingFeature();
registerApplication(themingFeature);
