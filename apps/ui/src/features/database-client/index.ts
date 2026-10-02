/**
 * database-client — built-in PostgreSQL client feature registration
 * (Spec #2950, ST-7).
 *
 * The singleton `databaseClientFeature` is registered here; `allFeatures.ts`
 * auto-discovers this module via its eager `import.meta.glob` over every
 * feature folder's `index.ts`, so no central shell/list edit is required (the
 * settings section is discovered the same way through
 * `FredoFeatureClass.hasSettings`).
 */

export {
  DatabaseClientFeature,
  DatabaseClientFeatureView,
  databaseClientFeature,
} from './DatabaseClientFeature';
export { AccessModeBadge } from './components/AccessModeBadge';
export { ConnectionForm, validateConnectionFields } from './components/ConnectionForm';
export { ConnectionsPanel } from './components/ConnectionsPanel';
export { DatabaseClientSettings, clampPref } from './components/DatabaseClientSettings';
export { ExportMenu } from './components/ExportMenu';
export { HistoryPanel } from './components/HistoryPanel';
export { QueryTabs } from './components/QueryTabs';
export { SavedQueriesPanel } from './components/SavedQueriesPanel';
export { SchemaInspector } from './components/SchemaInspector';
export { SchemaTree } from './components/SchemaTree';
export { SqlEditor } from './components/SqlEditor';

import { databaseClientFeature } from './DatabaseClientFeature';
import { registerFeature } from '../featureRegistry';

registerFeature(databaseClientFeature);
