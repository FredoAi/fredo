/**
 * Stepper Probe Feature — Spec #2768 ST-6 (AC6 generic-store proof), migrated
 * to the RTDB row store in Spec #2788 P4.3.
 *
 * A minimal registered probe feature. Its READ path is now the typed RTDB row
 * store: `useEventRows('ToolUse', { toolName: 'Fredo_ui_stepper' },
 * { replay: true })` — the persisted snapshot restores as full-row inserts
 * (replay replaces the v1 `hydrateContractEvents()` hydration, which this
 * feature no longer calls) and live patches continue on the same path.
 *
 * ── Real event shape (verified in-repo, ST-6) ────────────────────────────────
 * Stepper events enter the pipeline exclusively via the CLI emit path
 * (`fredo emit` → named-pipe `CliCommand::EmitEvent` → InternalAdapter enrich
 * → ingest classifier, `infrastructure/rtdb/ingest.rs`). The CLI always builds
 * `transport: hook` and defaults `provider: internal`; `event_type: tool_use`
 * with `toolName: "Fredo_ui_stepper"` classifies into a ToolUseRow whose
 * `toolName` column carries the tool name (ingest.rs maps
 * `event.tool_name` → `tool_name`), so the row query below isolates the probe's
 * rows by a typed-column equality arg (SQL pushdown on the snapshot leg).
 * A representative emission:
 *
 *   fredo emit --event-type tool_use --tool-name Fredo_ui_stepper --state Init \
 *     --payload '{"steps":[{"title":"Step A","status":"Waiting"}]}'
 *
 * ── Why the v1 ECE contract stays declared ──────────────────────────────────
 * The `Fredo_ui_stepper` contract below is KEPT until Phase 5: AppProvider
 * navigates to the stepper page on any `Fredo_ui_stepper` INIT delivery
 * (AppProvider.tsx:112) — a live v1 behavior this spec does not change. The
 * keying on `payload.steps` (a field ONLY stepper events carry) keeps that
 * path isolated from unrelated CLI tool_use events. The contract's delivery
 * stream is no longer the probe's read path — it feeds only the v1 ECE
 * consumers (AppProvider navigation) during coexistence.
 *
 * ── Row-store note (P4.3) ────────────────────────────────────────────────────
 * The module-scoped row store is keyed per EVENT TYPE, not per query — the
 * probe's ToolUse partition is shared with every other ToolUse subscription.
 * The backend filters this subscription's envelopes by the query args, but
 * `useEventRows().rows` exposes the whole partition, so the probe filters its
 * own rows client-side (epoch-keyed memo) — the documented consumer-side
 * extraction pattern for arg-scoped subscriptions.
 *
 * UI surface: a small dev/test-harness readout showing the replayed row count
 * and the row-store epoch (the QA-sanctioned probe shape) — nothing more.
 */

import React, { useMemo } from 'react';
import { Box, Text, VStack } from '@chakra-ui/react';
import { LuListOrdered } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { FredoFeatureClass } from '../../shared/classes';
import type { EventFilter } from '../../shared/classes';
import type { FredoEvent } from '../../shared/contexts/StreamContext';
import type { ContractDelivery } from '../../shared/classes/EventSubscription';
import { useEventRows } from '../../shared/hooks/useEventRows';

/** Contract name — the v1 ECE contract kept for AppProvider navigation (see header). */
const STEPPER_CONTRACT = 'Fredo_ui_stepper';

/** Tool name of the probe's row source — `fredo emit --tool-name` classifies
 *  into ToolUseRow.toolName (ingest.rs), so the row query filters on it. */
const STEPPER_TOOL_NAME = 'Fredo_ui_stepper';

/**
 * The probe panel — subscribes the probe's ToolUse rows with replay (the
 * persisted snapshot restores as full-row inserts) and shows the replayed row
 * count alongside the row-store epoch.
 */
const StepperProbePanel: React.FC = () => {
  const { rows, epoch, error, ready } = useEventRows(
    'ToolUse',
    { toolName: STEPPER_TOOL_NAME },
    { replay: true },
  );

  // Client-side filter over the shared ToolUse partition (see the header
  // note) — epoch-keyed so the memo recomputes only on real row mutations
  // (the #523-cycle-1 no-loop rule).
  const stepperRows = useMemo(
    () => [...rows.values()].filter((r) => r.toolName === STEPPER_TOOL_NAME),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, epoch],
  );

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
          RTDB rows for <Text as="code">{STEPPER_TOOL_NAME}</Text> — replay + live
        </Text>
        <Box
          border="1px solid var(--border-color)"
          borderRadius="md"
          padding={3}
          width="100%"
        >
          <Text fontSize="sm" color="var(--text-secondary)">
            Replayed rows
          </Text>
          <Text fontSize="2xl" fontWeight="700" color="var(--accent-primary)">
            {error !== null ? '—' : (ready ? String(stepperRows.length) : '…')}
          </Text>
          {error !== null && (
            <Text fontSize="xs" color="var(--status-error)">
              Subscribe failed: {error}
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
            Row-store epoch
          </Text>
          <Text fontSize="2xl" fontWeight="700" color="var(--text-primary)">
            {String(epoch)}
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
  // verify replay against real persisted rows (AC6 test consumer).
  readonly showable = true;
  // @deprecated — kept for base class compatibility
  readonly eventFilters: EventFilter[] = [];

  /**
   * The ST-6 probe contract (AC6) — KEPT for the v1 ECE consumers during
   * coexistence (AppProvider navigates on its init deliveries; the delivery
   * layer persists it while the probe is closed). The probe's READ path is
   * the RTDB row subscription above; this contract no longer feeds the panel.
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
      // ST-6 (AC6): persisted by the delivery layer while the probe is closed.
      persistent: true,
    },
  ];

  // @deprecated — kept for base class compatibility; the probe reads its rows
  // via the useEventRows() subscription, not handleDelivery.
  processEvent(_event: FredoEvent): void {}

  handleDelivery(_delivery: ContractDelivery): void {
    // Read path is the useEventRows() RTDB subscription — replay inserts and
    // live patches share one path. This no-op remains because the contract is
    // still registered (AppProvider consumes its init deliveries).
  }

  render() {
    return <StepperProbePanel />;
  }
}

/** Singleton registered via registerFeature() in index.ts. */
export const stepperProbeFeature = new StepperProbeFeature();
