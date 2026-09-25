/**
 * Spec #2946 ST-2 — keymap document persistence + TOTAL migration (contract
 * block 5).
 *
 * The keymap is ONE per-user JSON document stored under a single
 * `settingsService` key (`fredo.hotkeys.keymap`) — i.e. the backend `AppStore`
 * SQLite KV via `get_setting`/`save_setting`, with the shipped localStorage dev
 * mirror. NO new Rust command or table.
 *
 * `migrateKeymap()` is TOTAL: null / corrupt / string / array / unknown-shaped /
 * future-version input always yields a well-formed `PersistedKeymap`, never a
 * throw. A `schemaVersion` bump with no registered migration is a hard fallback
 * to the shipped defaults, not a crash.
 *
 * The `fredo.hotkeys.recording` KV latch helpers live here too — they are pure
 * KV I/O exercised by ST-8's macro recorder so "exactly one recording at a time"
 * holds ACROSS webviews (G-124).
 */

import { settingsService } from '../../features/settings';
import { MINIMAL_DEFAULT_BINDINGS } from './defaults';
import {
  CURRENT_SCHEMA_VERSION,
  KEYMAP_STORAGE_KEY,
  RECORDING_LATCH_KEY,
  type HotkeyActionId,
  type PersistedKeymap,
  type PersistedMacro,
  type PersistedRawMacro,
} from './types';

/** Default sequence timeout (contract block 5): 1000 ms, clamped to 200..5000. */
export const DEFAULT_SEQUENCE_TIMEOUT_MS = 1000;
export const MIN_SEQUENCE_TIMEOUT_MS = 200;
export const MAX_SEQUENCE_TIMEOUT_MS = 5000;

/** A deep copy of the shipped minimal bindings (`[]`-safe mutation). */
function createDefaultBindings(): Record<HotkeyActionId, string[]> {
  const bindings: Record<HotkeyActionId, string[]> = {};
  for (const [actionId, sequences] of Object.entries(MINIMAL_DEFAULT_BINDINGS)) {
    bindings[actionId] = [...sequences];
  }
  return bindings;
}

/** A fresh, mutable default keymap. Never share the returned object across stores. */
export function createDefaultKeymap(): PersistedKeymap {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    leader: null,
    vimPresetEnabled: false,
    sequenceTimeoutMs: DEFAULT_SEQUENCE_TIMEOUT_MS,
    bindings: createDefaultBindings(),
    macros: [],
    rawMacros: [],
  };
}

/** The frozen shipped default document (used as the `settingsService.get` default). */
export const DEFAULT_KEYMAP: PersistedKeymap = Object.freeze(createDefaultKeymap());

/** The shipped default sequences for one action (empty when the action ships unbound). */
export function getDefaultBinding(actionId: HotkeyActionId): readonly string[] {
  const sequences = MINIMAL_DEFAULT_BINDINGS[actionId];
  return sequences ? [...sequences] : [];
}

/** A deep copy of the shipped minimal bindings (exported for reset-all). */
export function createDefaultBindingMap(): Record<HotkeyActionId, string[]> {
  return createDefaultBindings();
}

// ── Migration ─────────────────────────────────────────────────────────────────

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as RawRecord;
}

function clampTimeout(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  if (Number.isNaN(numeric)) return DEFAULT_SEQUENCE_TIMEOUT_MS;
  return Math.min(MAX_SEQUENCE_TIMEOUT_MS, Math.max(MIN_SEQUENCE_TIMEOUT_MS, numeric));
}

function looksLikeKeymap(doc: RawRecord): boolean {
  return 'bindings' in doc || 'macros' in doc || 'rawMacros' in doc || 'leader' in doc;
}

/**
 * Read the document's version. A positive integer is taken verbatim; a document
 * that looks like a legacy keymap but carries no version is treated as v0 so the
 * registered migration chain can lift it.
 */
function readVersion(doc: RawRecord): number | null {
  const version = doc.schemaVersion;
  if (typeof version === 'number' && Number.isInteger(version) && version >= 0) return version;
  return looksLikeKeymap(doc) ? 0 : null;
}

/**
 * Versioned migrations, keyed by the version they upgrade FROM. Each returns the
 * next-version document shape; field-level sanitization happens afterwards.
 */
const MIGRATIONS: Readonly<Record<number, (doc: RawRecord) => RawRecord>> = {
  0: (doc) => ({ ...doc, schemaVersion: 1 }),
};

function normalizeMacro(raw: unknown): PersistedMacro | null {
  const doc = asRecord(raw);
  if (!doc || typeof doc.id !== 'string' || doc.id.length === 0) return null;
  const steps = Array.isArray(doc.steps)
    ? doc.steps.filter((step): step is string => typeof step === 'string')
    : [];
  return {
    id: doc.id,
    name: typeof doc.name === 'string' ? doc.name : doc.id,
    steps,
    trigger: typeof doc.trigger === 'string' && doc.trigger.length > 0 ? doc.trigger : null,
    onStepError: doc.onStepError === 'continue' ? 'continue' : 'abort',
  };
}

function normalizeRawMacro(raw: unknown): PersistedRawMacro | null {
  const doc = asRecord(raw);
  if (!doc || typeof doc.id !== 'string' || doc.id.length === 0) return null;
  const strokes = Array.isArray(doc.strokes)
    ? doc.strokes.filter((stroke): stroke is string => typeof stroke === 'string')
    : [];
  return {
    id: doc.id,
    name: typeof doc.name === 'string' ? doc.name : doc.id,
    strokes,
    trigger: typeof doc.trigger === 'string' && doc.trigger.length > 0 ? doc.trigger : null,
  };
}

/** Field-level sanitization: known fields only, every one with a safe fallback. */
function sanitizeKeymap(doc: RawRecord): PersistedKeymap {
  const bindings = createDefaultBindings();
  const rawBindings = asRecord(doc.bindings);
  if (rawBindings) {
    for (const [actionId, value] of Object.entries(rawBindings)) {
      if (!Array.isArray(value)) continue;
      bindings[actionId] = value.filter((seq): seq is string => typeof seq === 'string');
    }
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    leader: typeof doc.leader === 'string' && doc.leader.length > 0 ? doc.leader : null,
    vimPresetEnabled: doc.vimPresetEnabled === true,
    sequenceTimeoutMs: clampTimeout(doc.sequenceTimeoutMs),
    bindings,
    macros: Array.isArray(doc.macros)
      ? doc.macros
          .map(normalizeMacro)
          .filter((macro): macro is PersistedMacro => macro !== null)
      : [],
    rawMacros: Array.isArray(doc.rawMacros)
      ? doc.rawMacros
          .map(normalizeRawMacro)
          .filter((macro): macro is PersistedRawMacro => macro !== null)
      : [],
  };
}

/**
 * TOTAL migration entry point (contract block 5 / R-4.6). Never throws.
 *
 * - unknown / corrupt / unreadable → shipped defaults
 * - older version with a registered migration → migrated, then sanitized
 * - older version with NO registered migration → shipped defaults
 * - version newer than CURRENT → shipped defaults (hard fallback)
 */
export function migrateKeymap(raw: unknown): PersistedKeymap {
  const doc = asRecord(raw);
  if (!doc) return createDefaultKeymap();

  const version = readVersion(doc);
  if (version === null) return createDefaultKeymap();
  if (version > CURRENT_SCHEMA_VERSION) return createDefaultKeymap();

  let working: RawRecord = doc;
  let current = version;
  while (current < CURRENT_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[current];
    if (!migrate) return createDefaultKeymap();
    working = migrate(working);
    current += 1;
  }
  return sanitizeKeymap(working);
}

// ── Load / save ───────────────────────────────────────────────────────────────

/** Read + migrate the persisted keymap. Never rejects; unreadable → defaults. */
export async function loadKeymap(): Promise<PersistedKeymap> {
  try {
    const stored = await settingsService.get<unknown>(KEYMAP_STORAGE_KEY, DEFAULT_KEYMAP);
    return migrateKeymap(stored);
  } catch {
    return createDefaultKeymap();
  }
}

/** Persist the keymap document as JSON under the single storage key. */
export async function saveKeymap(next: PersistedKeymap): Promise<void> {
  await settingsService.set(KEYMAP_STORAGE_KEY, JSON.stringify(next));
}

// ── Raw-recording KV latch (cross-webview, G-124) ─────────────────────────────

export interface RecordingLatch {
  readonly macroId: string;
  readonly startedAt: number;
}

function normalizeLatch(raw: unknown): RecordingLatch | null {
  const doc = asRecord(raw);
  if (!doc || typeof doc.macroId !== 'string' || doc.macroId.length === 0) return null;
  const startedAt = typeof doc.startedAt === 'number' && Number.isFinite(doc.startedAt) ? doc.startedAt : 0;
  return { macroId: doc.macroId, startedAt };
}

/** Read the cross-webview recording latch (`null` = no recording in progress). */
export async function readRecordingLatch(): Promise<RecordingLatch | null> {
  try {
    const stored = await settingsService.get<unknown>(RECORDING_LATCH_KEY, null);
    return normalizeLatch(stored);
  } catch {
    return null;
  }
}

/**
 * Claim the recording latch for `macroId`. Returns `false` when another recording
 * already holds it, so a second webview can never start a concurrent recording.
 */
export async function acquireRecordingLatch(
  macroId: string,
  startedAt: number = Date.now(),
): Promise<boolean> {
  const existing = await readRecordingLatch();
  if (existing) return false;
  try {
    await settingsService.set(RECORDING_LATCH_KEY, JSON.stringify({ macroId, startedAt }));
    return true;
  } catch {
    return false;
  }
}

/** Release the recording latch (idempotent; best-effort). */
export async function releaseRecordingLatch(): Promise<void> {
  try {
    await settingsService.remove(RECORDING_LATCH_KEY);
  } catch {
    // Best-effort — the latch is advisory; a failed clear must never throw.
  }
}
