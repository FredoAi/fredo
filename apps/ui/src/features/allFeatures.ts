// allFeatures — auto-discovers and registers every feature.
// Vite eagerly imports every features/[name]/index.ts, triggering each
// feature's registerFeature() side-effect. To add a new feature, just create
// a folder under features/ with an index.ts that calls registerFeature().
import.meta.glob('./*/index.ts', { eager: true });
