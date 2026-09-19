/**
 * Feature-owned data declaration model (Spec #2896, contract (a)).
 *
 * A feature declares its data structure + canonical source mapping up front.
 * The backend persists and materializes it idempotently, then owns writes to the
 * declared tables. The wire shapes here MUST stay in sync with the Rust model
 * (`apps/tauri/src-tauri/src/infrastructure/feature_data/declaration.rs`).
 */

/** Canonical RTDB source a declaration reads rows from. */
export type ActivitySource = 'chat' | 'toolUse' | 'agentSession';

/** Declared (logical) column type. */
export type DeclaredColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN' | 'JSON';

/** A condition over canonical row fields (camelCase, `rows.rs` names). */
export type WhereExpr =
  | { all: WhereExpr[] }
  | { any: WhereExpr[] }
  | { not: WhereExpr }
  | { field: string; eq: unknown }
  | { field: string; isNull: boolean }
  | { field: string; in: unknown[] };

/** A column whose value is the named canonical field on the matched row. */
export interface RowProjection {
  kind: 'row';
  from: ActivitySource;
  where?: WhereExpr;
  select: Record<string /*declared column*/, { field: string } | { literal: unknown }>;
}

/**
 * The Mission-Monitor list rollup — a CLOSED, documented projection kind
 * (deliberately not a general SQL/expression DSL; adding a kind is how a new
 * aggregate is introduced). One output row per composited chat `sessionId`.
 * Produced columns (fixed): sessionId, startedAtNs, latestAt, chatRowCount,
 * nonSubagentChatRowCount, visibleTurnCount, userDispatchCount, derivedName,
 * agentName. Facts only — the QUALIFICATION RULE stays on the frontend.
 */
export interface SessionRollupProjection {
  kind: 'sessionRollup';
  /** Internal tool-execution agent names excluded from user-dispatch counting
   *  (single source for the rule; mirrors rowDerivation.ts:212). */
  excludeDispatchNames: string[];
  /** Row states whose chatRowStatus is terminal (rowDerivation.ts:174-188). */
  terminalStates: ['Response', 'Timeout'];
}

export interface FeatureDataTableDeclaration {
  /** Physical table: feature_<featureId>_<name>. */
  name: string;
  primaryKey: string[];
  columns: Array<{
    name: string;
    type: DeclaredColumnType;
    nullable?: boolean;
    /** 'backend' = projected from `source`; 'feature' = written via feature_data_write. */
    owner: 'backend' | 'feature';
  }>;
  /** Omit for a purely feature-written table. */
  source?: RowProjection | SessionRollupProjection;
  retention?: { maxRows?: number; ttlDays?: number };
}

export interface FeatureDataDeclaration {
  featureId: string;
  declarationRevision: string; // content hash of the declarations below
  tables: FeatureDataTableDeclaration[];
}
