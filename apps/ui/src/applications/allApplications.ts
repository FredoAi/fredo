// allApplications — auto-discovers and registers every feature.
// Vite eagerly imports every applications/[name]/index.ts, triggering each
// feature's registerApplication() side-effect. To add a new feature, just create
// a folder under applications/ with an index.ts that calls registerApplication().
import.meta.glob('./*/index.ts', { eager: true });
