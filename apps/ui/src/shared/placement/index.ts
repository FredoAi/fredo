/**
 * Spec #3243 ST-1 — the placement lifecycle's public surface.
 *
 * Consumers import `readPlacement` at turn time (the per-turn receipt) and
 * `subscribePlacement` from a React binding; nothing here is re-exported through
 * the `shared/order` barrel (that barrel belongs to the order surface, and this
 * module has no predecessor there).
 */

export {
  clearPlacement,
  placeFredo,
  readPlacement,
  rescopePlacement,
  resetPlacementForTests,
  subscribePlacement,
  type Placement,
} from './placementStore';
