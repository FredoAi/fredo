/**
 * Contract hydration helper — Spec #2768 (ST-4).
 *
 * Pull-based hydration for ANY feature: fetches the persisted
 * `SubscriptionDelivery` rows for the given contract names from the backend
 * `ContractEventStore` and injects them into StreamContext in emission (seq)
 * order under their ORIGINAL delivery ids.
 *
 * Design invariants (R8/R9, AGENTS.md):
 * - PULL-ONLY: rows are fetched via the `contract_events_hydrate` command
 *   return value — they are NEVER re-emitted on the "fredo-stream-event"
 *   channel and are NOT re-processed by the ECE. StreamContext append-only
 *   semantics are untouched.
 * - NO DUPLICATES: rows replay under their original delivery ids, so
 *   StreamContext id-dedupe (`StreamContext.tsx` ADD_DELIVERY) makes
 *   re-adding a delivery the feature already received live a no-op.
 * - NO cross-feature imports: this helper lives in `shared/` and knows
 *   nothing about any feature.
 *
 * Usage (inside a React component/effect that has `useStream()` access):
 *
 * ```ts
 * const { addDelivery } = useStream();
 * const injected = await hydrateContractEvents(
 *   ['chat-node', 'tool-use-lifecycle', 'subagent-tool-activity'],
 *   addDelivery,
 *   { sessionId },
 * );
 * ```
 *
 * Features should hydrate BEFORE consuming streaming updates for the same
 * keys (mount effect ordering) so the full lifecycle chains replay in order.
 */

import type { ContractDelivery } from '../classes/EventSubscription';

/** Options for {@link hydrateContractEvents}. */
export interface HydrateContractEventsOptions {
  /** Optional session scope — omit to hydrate rows across ALL sessions. */
  sessionId?: string;
}

/**
 * Fetch persisted contract deliveries and inject them via
 * `StreamContext.addDelivery` in seq (emission) order.
 *
 * @param contractNames Contract names to hydrate (must match the feature's
 *   registered contracts). An empty list is a no-op returning 0.
 * @param addDelivery The StreamContext delivery injector (pass
 *   `useStream().addDelivery`). Rows are injected in the backend's seq ASC
 *   order — the original emission order.
 * @param options Optional hydration scope ({@link HydrateContractEventsOptions}).
 * @returns The number of rows fetched and injected. Rows already present in
 *   StreamContext are no-ops there (id-dedupe), so this count is the
 *   hydrated-row total offered to the stream, not the net-new count.
 */
export async function hydrateContractEvents(
  contractNames: string[],
  addDelivery: (delivery: ContractDelivery) => void,
  options?: HydrateContractEventsOptions,
): Promise<number> {
  if (contractNames.length === 0) {
    return 0;
  }

  const { adapterBridge } = await import('../utils/adapterBridge');
  const rows = await adapterBridge.invoke<ContractDelivery[]>(
    'contract_events_hydrate',
    {
      contractNames,
      sessionId: options?.sessionId ?? null,
    },
  );

  if (!rows || rows.length === 0) {
    return 0;
  }

  // Rows arrive ordered by seq ASC from the backend (original emission order,
  // original delivery ids) — inject them in order so Init → Update → End
  // chains replay faithfully. StreamContext dedupes by id, so re-hydrating
  // deliveries the feature already has is a no-op.
  for (const delivery of rows) {
    addDelivery(delivery);
  }

  return rows.length;
}
