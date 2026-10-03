export { DoomWindow } from './DoomWindow';
export { DoomFeature } from './DoomFeature';
export { DoomEntry } from './DoomEntry';

import { DoomFeature } from './DoomFeature';
import { registerFeature } from '../featureRegistry';
export const doomFeature = new DoomFeature();
registerFeature(doomFeature);
