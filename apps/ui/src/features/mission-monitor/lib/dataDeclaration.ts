/**
 * Mission Monitor's feature-owned data declaration (Spec #2896, contract (a)).
 *
 * Mission Monitor is the acceptance-driving FIRST consumer of the realtime
 * feature-owned data layer (ST-6). Instead of re-deriving its session list from
 * a full Chat-row replay drain on every mount, it declares one backend-owned
 * table — `sessions` — whose rows are the CLOSED `sessionRollup` projection of
 * the canonical chat/tool-use rows (composited child copies ride the parent
 * `sessionId`). The backend materializes + projects it unconditionally on every
 * launch (ST-2/ST-3), so the list opens on the declared table's FIRST read
 * round-trip with no full-history scan.
 *
 * ── Facts, not the rule (Architect A-11) ─────────────────────────────────────
 * The produced columns are FACTS only. The list QUALIFICATION predicate
 * (`visibleTurnCount > 0 || (nonSubagentChatRowCount > 0 && userDispatchCount > 0)`)
 * lives in ONE place on the frontend (`hooks/useSessionHistory.ts`), mirroring
 * `lib/rowDerivation.ts`'s `deriveRenderableSessions`. The backend computes the
 * facts from the parameters declared here (`excludeDispatchNames` /
 * `terminalStates`), so the rule is never duplicated.
 *
 * ── Feature-owned column ─────────────────────────────────────────────────────
 * `customName` is owned by the feature (`owner: 'feature'`) — written through
 * `feature_data_write` on rename. Every other column is backend-owned and must
 * never be named by a feature write (the backend rejects it).
 *
 * ── Retention ────────────────────────────────────────────────────────────────
 * `maxRows: 500`, no TTL (Architect A-7). At 500 the cap is invisible for real
 * usage (today's effective cap was 50), so no caption ships this run; the knob
 * stays PO-overridable via the declaration.
 *
 * The wire shape MUST stay in sync with the Rust model
 * (`apps/tauri/src-tauri/src/infrastructure/feature_data/declaration.rs`).
 */

import type { FeatureDataDeclaration } from '../../../shared/feature-data/declaration';

export const MISSION_MONITOR_FEATURE_ID = 'mission-monitor';

/** The declared `sessions` rollup table. */
export const MISSION_MONITOR_DATA: FeatureDataDeclaration = {
  featureId: MISSION_MONITOR_FEATURE_ID,
  declarationRevision: 'mm.sessions.v2',
  tables: [
    {
      name: 'sessions',
      primaryKey: ['sessionId'],
      columns: [
        { name: 'sessionId', type: 'TEXT', owner: 'backend' },
        { name: 'provider', type: 'TEXT', owner: 'backend', nullable: true },
        { name: 'startedAtNs', type: 'INTEGER', owner: 'backend', nullable: true },
        { name: 'latestAt', type: 'TEXT', owner: 'backend' },
        { name: 'chatRowCount', type: 'INTEGER', owner: 'backend' },
        { name: 'nonSubagentChatRowCount', type: 'INTEGER', owner: 'backend' },
        { name: 'visibleTurnCount', type: 'INTEGER', owner: 'backend' },
        { name: 'userDispatchCount', type: 'INTEGER', owner: 'backend' },
        { name: 'derivedName', type: 'TEXT', owner: 'backend', nullable: true },
        { name: 'agentName', type: 'TEXT', owner: 'backend', nullable: true },
        { name: 'customName', type: 'TEXT', owner: 'feature', nullable: true },
      ],
      source: {
        kind: 'sessionRollup',
        excludeDispatchNames: ['build', 'plan'], // rowDerivation.ts:212
        terminalStates: ['Response', 'Timeout'], // rowDerivation.ts:174-188
      },
      retention: { maxRows: 500 },
    },
  ],
};
