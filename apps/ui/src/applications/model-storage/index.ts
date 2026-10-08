export { ModelStorageFeature } from './ModelStorageFeature';

import { ModelStorageFeature } from './ModelStorageFeature';
import { registerApplication } from '../applicationRegistry';
export const modelStorageFeature = new ModelStorageFeature();
registerApplication(modelStorageFeature);
