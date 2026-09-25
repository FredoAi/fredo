/**
 * Spec #2946 ST-2 — persistence + TOTAL migration tests (R-4.5/R-4.6).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  acquireRecordingLatch,
  createDefaultKeymap,
  loadKeymap,
  MAX_SEQUENCE_TIMEOUT_MS,
  migrateKeymap,
  MIN_SEQUENCE_TIMEOUT_MS,
  DEFAULT_SEQUENCE_TIMEOUT_MS,
  readRecordingLatch,
  releaseRecordingLatch,
  saveKeymap,
} from '../persistence';
import { CURRENT_SCHEMA_VERSION, KEYMAP_STORAGE_KEY } from '../types';

beforeEach(() => {
  localStorage.clear();
});

describe('createDefaultKeymap', () => {
  it('ships the minimal bindings, current version and default timeout', () => {
    const keymap = createDefaultKeymap();
    expect(keymap.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(keymap.sequenceTimeoutMs).toBe(DEFAULT_SEQUENCE_TIMEOUT_MS);
    expect(keymap.leader).toBeNull();
    expect(keymap.vimPresetEnabled).toBe(false);
    expect(keymap.bindings['fredo.launcher.toggle']).toEqual(['primary+space']);
    expect(keymap.macros).toEqual([]);
    expect(keymap.rawMacros).toEqual([]);
  });
});

describe('migrateKeymap is total (R-4.6)', () => {
  const hostileInputs: unknown[] = [
    null,
    undefined,
    42,
    'not-a-keymap',
    [],
    {},
    { schemaVersion: 'one' },
    { schemaVersion: -1 },
    { schemaVersion: 99, bindings: { 'fredo.launcher.toggle': ['primary+shift+l'] } },
    { schemaVersion: 1, bindings: 'nope', macros: 'nope', rawMacros: 'nope' },
  ];

  it('never throws and always yields a well-formed current-version keymap', () => {
    for (const raw of hostileInputs) {
      const migrated = migrateKeymap(raw);
      expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrated.bindings['fredo.launcher.toggle']).toEqual(['primary+space']);
      expect(Array.isArray(migrated.macros)).toBe(true);
      expect(Array.isArray(migrated.rawMacros)).toBe(true);
    }
  });

  it('hard-falls back to defaults for a future schema version', () => {
    const migrated = migrateKeymap({
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      bindings: { 'fredo.launcher.toggle': ['g g'] },
    });
    expect(migrated.bindings['fredo.launcher.toggle']).toEqual(['primary+space']);
  });

  it('clamps sequenceTimeoutMs into the documented bounds', () => {
    expect(migrateKeymap({ schemaVersion: 1, sequenceTimeoutMs: 10 }).sequenceTimeoutMs).toBe(
      MIN_SEQUENCE_TIMEOUT_MS,
    );
    expect(migrateKeymap({ schemaVersion: 1, sequenceTimeoutMs: 99999 }).sequenceTimeoutMs).toBe(
      MAX_SEQUENCE_TIMEOUT_MS,
    );
    expect(migrateKeymap({ schemaVersion: 1, sequenceTimeoutMs: 'x' }).sequenceTimeoutMs).toBe(
      DEFAULT_SEQUENCE_TIMEOUT_MS,
    );
    expect(migrateKeymap({ schemaVersion: 1, sequenceTimeoutMs: 750 }).sequenceTimeoutMs).toBe(750);
  });

  it('migrates a legacy version-less document instead of discarding it', () => {
    const migrated = migrateKeymap({
      leader: 'space',
      bindings: { 'fredo.launcher.toggle': ['primary+shift+l'] },
      macros: [
        {
          id: 'm1',
          name: 'Macro one',
          steps: ['fredo.launcher.toggle'],
          trigger: 'primary+shift+m',
          onStepError: 'abort',
        },
      ],
    });

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.leader).toBe('space');
    expect(migrated.bindings['fredo.launcher.toggle']).toEqual(['primary+shift+l']);
    expect(migrated.macros).toHaveLength(1);
    expect(migrated.macros[0].id).toBe('m1');
    expect(migrated.macros[0].trigger).toBe('primary+shift+m');
  });
});

describe('load / save round-trip (R-4.5)', () => {
  it('persists and reloads the document under the single storage key', async () => {
    const custom = createDefaultKeymap();
    custom.leader = 'space';
    custom.vimPresetEnabled = true;
    custom.sequenceTimeoutMs = 750;
    custom.bindings['fredo.launcher.toggle'] = ['primary+shift+l'];
    custom.macros.push({
      id: 'm1',
      name: 'Macro one',
      steps: ['fredo.test.ctx'],
      trigger: null,
      onStepError: 'continue',
    });

    await saveKeymap(custom);
    expect(localStorage.getItem(KEYMAP_STORAGE_KEY)).not.toBeNull();

    const loaded = await loadKeymap();
    expect(loaded.leader).toBe('space');
    expect(loaded.vimPresetEnabled).toBe(true);
    expect(loaded.sequenceTimeoutMs).toBe(750);
    expect(loaded.bindings['fredo.launcher.toggle']).toEqual(['primary+shift+l']);
    expect(loaded.macros).toHaveLength(1);
    expect(loaded.macros[0].onStepError).toBe('continue');
  });

  it('degrades to safe defaults for a corrupt stored document without throwing', async () => {
    localStorage.setItem(KEYMAP_STORAGE_KEY, '{definitely-not-json');
    const loaded = await loadKeymap();
    expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(loaded.bindings['fredo.launcher.toggle']).toEqual(['primary+space']);
  });
});

describe('raw-recording KV latch (cross-webview, G-124)', () => {
  it('grants exactly one recording at a time', async () => {
    expect(await readRecordingLatch()).toBeNull();

    expect(await acquireRecordingLatch('macro-1', 123)).toBe(true);
    expect(await readRecordingLatch()).toEqual({ macroId: 'macro-1', startedAt: 123 });

    expect(await acquireRecordingLatch('macro-2', 456)).toBe(false);
    expect(await readRecordingLatch()).toEqual({ macroId: 'macro-1', startedAt: 123 });

    await releaseRecordingLatch();
    expect(await readRecordingLatch()).toBeNull();

    expect(await acquireRecordingLatch('macro-2', 456)).toBe(true);
  });
});
