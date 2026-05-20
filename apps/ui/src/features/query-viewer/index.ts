export { QueryViewer } from './components/QueryViewer';
export { QueryViewerFeature, createQueryViewerFeature, queryViewerFeature, type QueryResult } from './QueryViewerFeature';

import { queryViewerFeature } from './QueryViewerFeature';
import { registerFeature } from '../featureRegistry';
registerFeature(queryViewerFeature);
