/**
 * Stepper Probe Feature — Spec #2768 ST-6 (AC6 generic-store proof), migrated
 * to the RTDB row store in Spec #2788 P4.3; the v1 contract deleted in P5.1.
 *
 * A minimal registered probe feature. Its READ path is the typed RTDB row
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
 *   fredo emit --event-type tool_use --tool-name Fredo_ui_stepper \
 *     --payload '{"steps":[{"title":"Step A","status":"Waiting"}]}'
 *
 * ── Auto-navigation (W5, P5.1) ───────────────────────────────────────────────
 * The v1 behavior "navigate to the stepper page on the first
 * `Fredo_ui_stepper` init delivery" (formerly AppProvider's ContractDelivery
 * leg) is re-implemented on RTDB rows: when the probe's stepper rows first
 * appear (empty → non-empty), the panel navigates to the steps page — unless
 * the user is already there or in Dev Mode (the exact guard semantics the v1
 * AppProvider leg enforced). Like the v1 leg, the trigger retrains until it
 * fires: a blocked navigation (user on dev-mode) retries on the next row
 * epoch advance. One-shot after it fires.
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

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, VStack } from '@chakra-ui/react';
import { LuListOrdered } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { FredoFeatureClass } from '../../shared/classes';
import { useEventRows } from '../../shared/hooks/useEventRows';
import { useExtension } from '../../app/providers/AppProvider';

/** Tool name of the probe's row source — `fredo emit --tool-name` classifies
 *  into ToolUseRow.toolName (ingest.rs), so the row query filters on it. */
const STEPPER_TOOL_NAME = 'Fredo_ui_stepper';

/**
 * The probe panel — subscribes the probe's ToolUse rows with replay (the
 * persisted snapshot restores as full-row inserts) and shows the replayed row
 * count alongside the row-store epoch. Carries the one-shot auto-navigation
 * onto RTDB rows (see the header note).
 */
const StepperProbePanel: React.FC = () => {
  const { rows, epoch, error, ready } = useEventRows(
    'ToolUse',
    { toolName: STEPPER_TOOL_NAME },
    { replay: true },
  );
  const { currentPage, setCurrentPage } = useExtension();
  const [navigated, setNavigated] = useState(false);

  // Client-side filter over the shared ToolUse partition (see the header
  // note) — epoch-keyed so the memo recomputes only on real row mutations
  // (the #523-cycle-1 no-loop rule).
  const stepperRows = useMemo(
    () => [...rows.values()].filter((r) => r.toolName === STEPPER_TOOL_NAME),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, epoch],
  );

  // W5 auto-navigation on RTDB rows — preserves the v1 AppProvider guard
  // semantics exactly: fire when stepper rows exist AND the current page is
  // neither `steps` nor `dev-mode`; a blocked navigation (dev-mode open)
  // stays armed and retriggers on the next row epoch advance. One-shot.
  useEffect(() => {
    if (navigated) return;
    if (stepperRows.length === 0) return;
    if (currentPage === 'steps' || currentPage === 'dev-mode') return;
    setCurrentPage('steps');
    setNavigated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, stepperRows.length, currentPage, navigated]);

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

  render() {
    return <StepperProbePanel />;
  }
}

/** Singleton registered via registerFeature() in index.ts. */
export const stepperProbeFeature = new StepperProbeFeature();
