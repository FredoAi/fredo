export { BrowserPreviewFeature, browserPreviewFeature } from './BrowserPreviewFeature';

import { browserPreviewFeature } from './BrowserPreviewFeature';
import { registerFeature } from '../featureRegistry';
registerFeature(browserPreviewFeature);
