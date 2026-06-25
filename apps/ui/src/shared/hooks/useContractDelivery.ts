/**
 * useContractDelivery — Hook for non-feature components that need contract events.
 *
 * The ECE delivers ContractDelivery objects via StreamContext's delivery queue.
 * This hook filters deliveries by contract name, making it easy for components
 * like SideStepper or StreamStatus to receive contract events without extending
 * FredoFeatureClass.
 *
 * Usage:
 * ```typescript
 * const stepperDeliveries = useContractDelivery('Fredo_ui_stepper');
 * // Returns ContractDelivery[] filtered to the "Fredo_ui_stepper" contract
 * ```
 */

import { useMemo } from 'react';
import { useStream } from '../contexts/StreamContext';
import type { ContractDelivery } from '../classes/EventSubscription';

/**
 * Subscribe to contract deliveries for a specific contract name.
 *
 * @param contractName - The contract name to filter deliveries by.
 * @returns Array of ContractDelivery objects matching the contract name.
 */
export function useContractDelivery(contractName: string): ContractDelivery[] {
  const { deliveries } = useStream();

  return useMemo(
    () => deliveries.filter((d) => d.contractName === contractName),
    [deliveries, contractName]
  );
}

/**
 * Get the latest delivery for a specific contract name.
 *
 * @param contractName - The contract name to filter by.
 * @returns The latest ContractDelivery, or undefined if none exist.
 */
export function useLatestContractDelivery(contractName: string): ContractDelivery | undefined {
  const { deliveries } = useStream();

  return useMemo(() => {
    const matching = deliveries.filter((d) => d.contractName === contractName);
    return matching[matching.length - 1] as ContractDelivery | undefined;
  }, [deliveries, contractName]);
}
