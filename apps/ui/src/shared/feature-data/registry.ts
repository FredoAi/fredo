/**
 * Feature-data declaration registry + bootstrap (Spec #2896, ST-5).
 *
 * A feature registers its `FeatureDataDeclaration` at module load (its
 * `index.ts` side effect, e.g. Mission Monitor's `MISSION_MONITOR_DATA`).
 * `declareAllRegisteredFeatureData()` then issues ONE idempotent
 * `feature_data_declare` containing every registered declaration — wired from
 * `Home.tsx` after the feature modules have registered (A-17: the declaration
 * is materialized before a feature can open).
 *
 * The registry is also the frontend's source for a feature table's primary key
 * (`featureRecordKey`), which the store's snapshot seeding needs to key rows
 * consistently with notification keys. Canonical refs use the bound
 * `[correlationId, sessionId]` key (ST-4 `canonical_key_of`).
 */

import { featureDataDeclare } from './client';
import type { DataTableRef, FeatureDataDeclareResult } from './client';
import type { FeatureDataDeclaration } from './declaration';

const registeredDeclarations: FeatureDataDeclaration[] = [];

/**
 * Register (or replace, keyed by `featureId`) a feature's data declaration.
 * Idempotent — a feature module may be evaluated more than once under HMR.
 */
export function registerFeatureData(declaration: FeatureDataDeclaration): void {
  const index = registeredDeclarations.findIndex((d) => d.featureId === declaration.featureId);
  if (index >= 0) {
    registeredDeclarations[index] = declaration;
  } else {
    registeredDeclarations.push(declaration);
  }
}

/** Snapshot of the registered declarations (registration order). */
export function getRegisteredFeatureDataDeclarations(): readonly FeatureDataDeclaration[] {
  return registeredDeclarations;
}

/** The declared primary key for one feature table, or `null` when undeclared here. */
export function registeredPrimaryKey(featureId: string, table: string): string[] | null {
  const declaration = registeredDeclarations.find((d) => d.featureId === featureId);
  const tableDeclaration = declaration?.tables.find((t) => t.name === table);
  return tableDeclaration ? [...tableDeclaration.primaryKey] : null;
}

/**
 * The primary-key values for one snapshot/read row, in the exact order the
 * backend uses for notification keys:
 * - canonical: `[correlationId, sessionId]` (ST-4 `canonical_key_of`);
 * - declared: the registered declaration's `primaryKey` columns.
 *
 * Returns `null` when the key cannot be derived (an unregistered declared
 * table), so the caller skips the row rather than inventing a key.
 */
export function featureRecordKey(
  ref: DataTableRef,
  row: Record<string, unknown>,
): unknown[] | null {
  if (ref.source === 'canonical') {
    return [row.correlationId ?? null, row.sessionId ?? null];
  }
  const primaryKey = registeredPrimaryKey(ref.featureId, ref.table);
  if (primaryKey === null) return null;
  return primaryKey.map((column) => row[column] ?? null);
}

let declarePromise: Promise<FeatureDataDeclareResult | null> | null = null;

/**
 * Bootstrap: `feature_data_declare` every registered declaration exactly once.
 *
 * Idempotent — the first call issues the command and every later call returns
 * the same in-flight/settled promise. With no registered declarations it
 * resolves `null` without touching IPC. A failure is logged loudly and the
 * promise is reset so a later bootstrap can retry (never a silent no-op).
 */
export function declareAllRegisteredFeatureData(): Promise<FeatureDataDeclareResult | null> {
  if (declarePromise) {
    return declarePromise;
  }
  const declarations = [...registeredDeclarations];
  if (declarations.length === 0) {
    declarePromise = Promise.resolve(null);
    return declarePromise;
  }
  declarePromise = featureDataDeclare({ declarations })
    .then((result) => result)
    .catch((err) => {
      console.error('[feature-data] feature_data_declare failed:', err);
      declarePromise = null;
      return null;
    });
  return declarePromise;
}

/** Test-only: clear registered declarations and the bootstrap latch. */
export function resetFeatureDataRegistryForTests(): void {
  registeredDeclarations.length = 0;
  declarePromise = null;
}
