// Backward-compatibility shim.
// Feature components import from '../../app/providers/ExtensionProvider' —
// this re-export makes those paths resolve without touching every feature file.
export { AppProvider as ExtensionProvider, useExtension } from './AppProvider';
export type { Step } from './AppProvider';
