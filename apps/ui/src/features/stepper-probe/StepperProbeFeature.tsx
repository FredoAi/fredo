/**
 * Stepper Probe Feature — Spec #2768 ST-6 (AC6 generic-store proof).
 *
 * A minimal registered probe feature that proves the per-contract event store
 * is a GENERIC mechanism (AC6): it declares a second, non-Mission-Monitor
 * contract (`Fredo_ui_stepper`) with `persistent: true`, hydrates its persisted
 * deliveries on mount via the shared `hydrateContractEvents()` helper, and
 * reads hydrated rows through the existing `useStepperEvents()` hook.
 *
 * ── Real event shape (verified in-repo, ST-6) ────────────────────────────────
 * Stepper events enter the pipeline exclusively via the CLI emit path
 * (`fredo emit` → named-pipe `CliCommand::EmitEvent` → `InternalAdapter::enrich`
 * → ECE, `infrastructure/ipc.rs:140-160`). The CLI (`emit.rs:109-119`) always
 * builds `transport: hook` and defaults `provider: internal`; the stepper tool
 * is a Fredo UI-control tool invocation, so `event_type: tool_use` with
 * `toolName: "Fredo_ui_stepper"` and `payload: { steps: [...] }`
 * (`SideStepper.tsx:70` requires exactly that shape). A representative emission:
 *
 *   fredo emit --event-type tool_use --tool-name Fredo_ui_stepper --state Init \
 *     --payload '{"steps":[{"title":"Step A","status":"Waiting"}]}'
 *
 * OTLP (the opencode plugin's only transport, transport `otlp_grpc`, provider
 * `open_code`) never carries stepper events — the providers/transports/
 * eventTypes filters below therefore isolate the contract to the real source.
 *
 * ── Why the composite key includes `payload.steps` ───────────────────────────
 * The ECE has no toolName filter field (`ContractDeclaration`, types.rs) —
 * `excludePayload` can only EXCLUDE (an absent path never matches), so a key of
 * `['sessionId', 'toolName']` would buffer EVERY CLI tool_use event and fire
 * `init` deliveries under this contract name for unrelated tools (AppProvider
 * navigates to the stepper page on any `Fredo_ui_stepper` init delivery,
 * `AppProvider.tsx:102-106` — a live-behavior regression). Keying on
 * `payload.steps` — a field ONLY stepper events carry — makes the composite-key
 * extraction double as the inclusion filter (REQ-10: a missing key field skips
 * the contract for that event, `engine.rs:303-311`), so non-stepper events
 * never buffer and never deliver. The key stays scoped per session, and the
 * store's `session_id` column (projected from `key.sessionId`,
 * `store.rs:128-132`) supports session-scoped hydration.
 *
 * ── Regression invariants ────────────────────────────────────────────────────
 * - `SideStepper.tsx` is untouched; the deliveries this contract produces are
 *   keyed `"state"` / `"payload.steps"` in the delivery payload, so the legacy
 *   raw-event consumer's `'steps' in event.payload` check (`SideStepper.tsx:70`)
 *   keeps evaluating exactly as before (no contract-derived event satisfies it).
 * - Mission Monitor is untouched; the store knows nothing about any feature.
 * - No `Home.tsx` edit — registration flows through `registerFeature()` +
 *   `allFeatures.ts` auto-glob + the existing `Home.tsx:60-63` contract flatMap.
 *
 * UI surface: a small dev/test-harness readout showing the hydrated-delivery
 * count (the QA-sanctioned probe shape) — nothing more.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, VStack } from '@chakra-ui/react';
import { LuListOrdered } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import { useStream, useStepperEvents } from '../../shared/contexts/StreamContext';
import type { ContractDelivery } from '../../shared/classes/EventSubscription';
import { hydrateContractEvents } from '../../shared/lib/contractHydration';

/** Contract name — matches the legacy `useStepperEvents()` filter (StreamContext.tsx:381). */
const STEPPER_CONTRACT = 'Fredo_ui_stepper';

/**
 * The probe panel — hydrates persisted `Fredo_ui_stepper` deliveries on mount
 * and shows the hydrated-delivery count alongside the live stepper-delivery
 * count from the existing `useStepperEvents()` hook.
 */
const StepperProbePanel: React.FC = () => {
  const { addDelivery } = useStream();
  const stepperDeliveries = useStepperEvents();

  /** Rows fetched + injected by the hydration helper (null until the call resolves). */
  const [hydratedCount, setHydratedCount] = useState<number | null>(null);
  const [hydrationError, setHydrationError] = useState<string | null>(null);

  // Mount-time hydration — runs ONCE (addDelivery is a stable useCallback in
  // StreamContext). No `deliveries.length` dependency (re-render-loop rule):
  // the live count is read in render via the memoized useStepperEvents() hook.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const count = await hydrateContractEvents([STEPPER_CONTRACT], addDelivery);
        if (!cancelled) setHydratedCount(count);
      } catch (e) {
        if (!cancelled) setHydrationError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addDelivery]);

  return (
    <Box
      bg="var(--card-bg)"
      color="var(--text-primary)"
      height="100%"
      width="100%"
      overflow="auto"
      padding={4}
    >
      <VStack align="start" gap={3}>
        <Text fontSize="md" fontWeight="600" color="var(--text-primary)">
          Stepper Probe
        </Text>
        <Text fontSize="sm" color="var(--text-secondary)">
          Persistent contract <Text as="code">{STEPPER_CONTRACT}</Text> — Spec #2768 AC6
          generic-store proof
        </Text>
        <Box
          border="1px solid var(--border-color)"
          borderRadius="md"
          padding={3}
          width="100%"
        >
          <Text fontSize="sm" color="var(--text-secondary)">
            Hydrated deliveries
          </Text>
          <Text fontSize="2xl" fontWeight="700" color="var(--accent-primary)">
            {hydrationError !== null ? '—' : (hydratedCount ?? '…')}
          </Text>
          {hydrationError !== null && (
            <Text fontSize="xs" color="var(--status-error)">
              Hydration failed: {hydrationError}
            </Text>
          )}
        </Box>
        <Box
          border="1px solid var(--border-color)"
          borderRadius="md"
          padding={3}
          width="100%"
        >
          <Text fontSize="sm" color="var(--text-secondary)">
            Stepper deliveries in stream
          </Text>
          <Text fontSize="2xl" fontWeight="700" color="var(--text-primary)">
            {stepperDeliveries.length}
          </Text>
        </Box>
      </VStack>
    </Box>
  );
};

export class StepperProbeFeature extends FredoFeatureClass {
  readonly id = 'stepper-probe';
  readonly name = 'Stepper Probe';
  readonly icon: IconType = LuListOrdered;
  readonly isMultiWindow = false;
  // Dev/test harness panel — must stay openable from the launcher so QA can
  // verify hydration against real persisted rows (AC6 test consumer).
  readonly showable = true;
  // @deprecated — kept for base class compatibility
  readonly eventFilters: EventFilter[] = [];

  /**
   * The ST-6 probe contract (AC6): a second, non-Mission-Monitor persistent
   * contract. Registration is automatic — Home.tsx flatMaps every feature's
   * `eventContracts` into `registerEventContracts()` on mount (Home.tsx:60-63).
   */
  readonly eventContracts = [
    {
      contractName: STEPPER_CONTRACT,
      // 2-level paths only. The delivery payload keys are the literal field
      // paths ("state", "payload.steps") — `payload.steps` enables the
      // `exists payload.steps` completeWhen (the accumulated payload carries
      // the literal key) and keeps the delivery payload slim.
      streamFields: ['state', 'payload.steps'],
      deferredFields: [],
      // `payload.steps` exists ONLY on stepper events — a missing key field
      // skips the contract for the event (REQ-10), which isolates the contract
      // from unrelated CLI tool_use events without a toolName filter.
      // `sessionId` scopes the buffer per session and projects into the
      // store's session_id column (session-scoped hydration).
      key: ['sessionId', 'payload.steps'],
      // Stepper events always carry `steps` — the first (Init) event completes
      // immediately, emitting init + end deliveries that both get persisted.
      completeWhen: 'exists payload.steps',
      timeout: 300000,
      providers: ['internal'],
      transports: ['hook'],
      eventTypes: ['tool_use'],
      // ST-6 (AC6): persisted by the delivery layer while the probe is closed;
      // hydrated on mount via hydrateContractEvents().
      persistent: true,
    },
  ];

  // @deprecated — kept for base class compatibility; the probe reads its
  // deliveries via the useStepperEvents() hook, not handleDelivery.
  processEvent(_event: FredoEvent): void {}

  handleDelivery(_delivery: ContractDelivery): void {
    // Read path is the useStepperEvents() hook (StreamContext deliveries) —
    // hydration + live deliveries flow through the same queue.
  }

  render() {
    return <StepperProbePanel />;
  }
}

/** Singleton registered via registerFeature() in index.ts. */
export const stepperProbeFeature = new StepperProbeFeature();
