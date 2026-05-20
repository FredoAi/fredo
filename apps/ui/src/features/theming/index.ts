export { ThemingFeature } from './ThemingFeature';

import { ThemingFeature } from './ThemingFeature';
import { registerFeature } from '../featureRegistry';
export const themingFeature = new ThemingFeature();
registerFeature(themingFeature);
