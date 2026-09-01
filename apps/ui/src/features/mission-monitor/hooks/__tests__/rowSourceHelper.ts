/**
 * rowSourceHelper.ts — P4.2 test adapter: v1 delivery fixtures → typed row
 * sources for `useDeliveryGraph({ rows })`.
 *
 * Converts through `rowsFromDeliveries` (the classifier-semantics converter)
 * and keys the row maps exactly like the module-scoped row store
 * (`sessionId` + NUL + `correlationId`).
 *
 * STABILITY CONTRACT (kills the #523-cycle-1 loop class in tests): a render
 * callback that calls `rowSource(...)` re-executes on every render. The hook
 * memoizes on the epoch primitives, so the adapter MUST return the SAME row
 * source (same epoch) for the same fixture content — otherwise every render
 * recomputes the builder state and re-emits nodes forever. Caching: by array
 * identity (WeakMap — the common `renderHook(() => hook({ rows: rowSource(d) }))
 * with a stable `d`) and, on a miss, by JSON content signature (bounded LRU —
 * inline fixture literals are recreated per render but are content-stable;
 * a rerender with NEW content gets a fresh epoch and recomputes, mirroring a
 * live patch batch).
 */
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import { rowsFromDeliveries } from './fixtures/rowsFromDeliveries';

let __rowSourceEpoch = 0;
const byIdentity = new WeakMap<ContractDelivery[], object>();
const byContent = new Map<string, object>();
const CONTENT_CACHE_MAX = 8;

function build(deliveries: ContractDelivery[]) {
  const { chatRows, toolRows } = rowsFromDeliveries(deliveries);
  const toMap = (rows: Array<{ sessionId: string; correlationId: string }>) =>
    new Map(rows.map((r) => [`${r.sessionId}\u0000${r.correlationId}`, r] as const));
  return {
    chat: { rows: toMap(chatRows), epoch: ++__rowSourceEpoch, error: null },
    toolUse: { rows: toMap(toolRows), epoch: ++__rowSourceEpoch, error: null },
  };
}

export function rowSource(deliveries: ContractDelivery[]): object {
  const identityHit = byIdentity.get(deliveries);
  if (identityHit) return identityHit;

  const contentKey = JSON.stringify(deliveries);
  const contentHit = byContent.get(contentKey);
  if (contentHit) return contentHit;

  const built = build(deliveries);
  byIdentity.set(deliveries, built);
  byContent.set(contentKey, built);
  if (byContent.size > CONTENT_CACHE_MAX) {
    const oldest = byContent.keys().next();
    if (!oldest.done) byContent.delete(oldest.value);
  }
  return built;
}
