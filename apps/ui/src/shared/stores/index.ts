/**
 * shared/stores — Feature-local state stores.
 *
 * Convention: each file in this directory is a lightweight module-scope store
 * for state that must survive across React tree unmounts or be shared between
 * a feature's class instance (FredoFeatureClass) and its components.
 *
 * SAD equivalent: the managed Tauri `State<T>` values registered in `lib.rs`.
 *
 * Guidelines:
 *   - Prefer `useState` / `useReducer` inside hooks for component-local state.
 *   - Use a store here only when state must outlive a component or be accessed
 *     from an FredoFeatureClass method (which has no hook access).
 *   - Name files after the feature: `diagramStore.ts`, `runCliStore.ts`, etc.
 *   - Export a plain object or a factory function — no global singletons that
 *     make testing hard.
 *
 * Example store shape:
 *
 *   let _state = { ... };
 *   const listeners = new Set<() => void>();
 *
 *   export const myStore = {
 *     getState: () => _state,
 *     setState: (next: typeof _state) => { _state = next; listeners.forEach(fn => fn()); },
 *     subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
 *   };
 */

// No stores yet. Add per-feature store files here as features mature.
export {};
