export { ModelStorageFeature } from './ModelStorageFeature';

import { ModelStorageFeature } from './ModelStorageFeature';
import { registerFeature } from '../featureRegistry';
export const modelStorageFeature = new ModelStorageFeature();
registerFeature(modelStorageFeature);
