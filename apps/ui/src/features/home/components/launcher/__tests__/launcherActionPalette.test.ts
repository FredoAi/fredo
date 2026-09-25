/**
 * Spec #2946 ST-9 — the command-palette switch + projection (pure).
 *
 * Pins:
 *   1. The `>` prefix switches to palette mode; a query without it stays
 *      inactive with an empty term (the byte-identical non-prefix guarantee).
 *   2. The projection keeps registry order, skips invalid/disabled actions, and
 *      projects the EFFECTIVE bindings (configured key wins — even `[]` — else
 *      the declared default) + the first binding's human display.
 *   3. The matcher reuses the settings-search semantics: title / description /
 *      feature id / displayed key text / stored serialized token, case-insensitive,
 *      hide-never-reorder.
 */

import { describe, it, expect } from 'vitest';

import {
  ACTION_PALETTE_PREFIX,
  ACTION_PALETTE_OPEN_ACTION_ID,
  buildLauncherActionEntries,
  isPaletteQuery,
  launcherActionEntryId,
  matchesPaletteQuery,
  parsePaletteQuery,
  type PaletteActionSource,
} from '../launcherActionPalette';

const action = (over: Partial<PaletteActionSource> = {}): PaletteActionSource => ({
  actionId: 'fredo.launcher.toggle',
  tier: 'fredo',
  title: 'Toggle launcher',
  description: 'Show or focus the launcher command bar',
  defaultSequence: 'primary+space',
  ...over,
});

const configured =
  (map: Record<string, readonly string[]>) =>
  (id: string): readonly string[] | undefined =>
    map[id];

describe('parsePaletteQuery — the `>` switch', () => {
  it('is active with an empty term for a bare prefix', () => {
    expect(parsePaletteQuery(ACTION_PALETTE_PREFIX)).toEqual({ active: true, term: '' });
  });

  it('is active with the trimmed remainder after the prefix', () => {
    expect(parsePaletteQuery('>open settings')).toEqual({ active: true, term: 'open settings' });
    expect(parsePaletteQuery('>  spaced  ')).toEqual({ active: true, term: 'spaced' });
  });

  it('tolerates leading whitespace before the prefix', () => {
    expect(parsePaletteQuery('   >x')).toEqual({ active: true, term: 'x' });
  });

  it('is INACTIVE for a query without the prefix (byte-identical app path)', () => {
    for (const query of ['', 'settings', 'f>oo', 'Mission Monitor', '  ']) {
      expect(parsePaletteQuery(query)).toEqual({ active: false, term: '' });
      expect(isPaletteQuery(query)).toBe(false);
    }
  });

  it('the prefix constant is the single `>` glyph', () => {
    expect(ACTION_PALETTE_PREFIX).toBe('>');
    expect(isPaletteQuery('>x')).toBe(true);
  });
});

describe('buildLauncherActionEntries — projection', () => {
  it('falls back to the declared default when the user has not overridden it', () => {
    const [entry] = buildLauncherActionEntries({
      actions: [action()],
      term: '',
      configuredBindingsFor: configured({}),
    });
    expect(entry.kind).toBe('action');
    expect(entry.actionId).toBe('fredo.launcher.toggle');
    expect(entry.tier).toBe('fredo');
    expect(entry.bindings).toEqual(['primary+space']);
    expect(entry.bindingDisplay).toMatch(/Space/);
  });

  it('a configured binding wins over the declared default', () => {
    const [entry] = buildLauncherActionEntries({
      actions: [action()],
      term: '',
      configuredBindingsFor: configured({ 'fredo.launcher.toggle': ['primary+q'] }),
    });
    expect(entry.bindings).toEqual(['primary+q']);
    expect(entry.bindingDisplay).toMatch(/Q/);
  });

  it('an explicitly-unbound configured action stays unbound (configured `[]` wins)', () => {
    const [entry] = buildLauncherActionEntries({
      actions: [action()],
      term: '',
      configuredBindingsFor: configured({ 'fredo.launcher.toggle': [] }),
    });
    expect(entry.bindings).toEqual([]);
    expect(entry.bindingDisplay).toBeNull();
  });

  it('reports an action with no default and no override as unbound', () => {
    const [entry] = buildLauncherActionEntries({
      actions: [action({ actionId: 'fredo.focus.left', title: 'Focus left', defaultSequence: null })],
      term: '',
      configuredBindingsFor: configured({}),
    });
    expect(entry.bindings).toEqual([]);
    expect(entry.bindingDisplay).toBeNull();
  });

  it('keeps registry order (never re-sorts) and skips invalid actions', () => {
    const entries = buildLauncherActionEntries({
      actions: [
        action({ actionId: 'fredo.a', title: 'A', defaultSequence: null }),
        action({ actionId: 'fredo.b', title: 'B', invalid: 'Malformed action id "fredo.b"' }),
        action({ actionId: 'fredo.c', title: 'C', defaultSequence: null }),
      ],
      term: '',
      configuredBindingsFor: configured({}),
    });
    expect(entries.map((e) => e.actionId)).toEqual(['fredo.a', 'fredo.c']);
  });

  it('skips a definitively-disabled action (never offers a dead row)', () => {
    const entries = buildLauncherActionEntries({
      actions: [
        action({ actionId: 'fredo.a', title: 'A', defaultSequence: null, enabled: () => false }),
        action({ actionId: 'fredo.b', title: 'B', defaultSequence: null }),
      ],
      term: '',
      configuredBindingsFor: configured({}),
    });
    expect(entries.map((e) => e.actionId)).toEqual(['fredo.b']);
  });

  it('an empty term lists every offered action', () => {
    const entries = buildLauncherActionEntries({
      actions: [
        action({ actionId: 'fredo.a', title: 'A', defaultSequence: null }),
        action({ actionId: 'fredo.b', title: 'B', defaultSequence: null }),
      ],
      term: '',
      configuredBindingsFor: configured({}),
    });
    expect(entries).toHaveLength(2);
  });
});

describe('matchesPaletteQuery — the settings matcher semantics (R-4.2)', () => {
  const entry = {
    title: 'Toggle launcher',
    description: 'Show or focus the launcher command bar',
    featureId: 'fredo',
    bindings: ['primary+space'],
  };

  it('matches the title case-insensitively', () => {
    expect(matchesPaletteQuery(entry, 'TOGGLE')).toBe(true);
  });

  it('matches the description', () => {
    expect(matchesPaletteQuery(entry, 'command bar')).toBe(true);
  });

  it('matches the STORED serialized token', () => {
    expect(matchesPaletteQuery(entry, 'primary+space')).toBe(true);
  });

  it('matches the DISPLAYED key text', () => {
    expect(matchesPaletteQuery(entry, 'space')).toBe(true);
  });

  it('does not match an unrelated needle', () => {
    expect(matchesPaletteQuery(entry, 'diagram')).toBe(false);
  });

  it('an empty needle matches everything (hide-never-reorder baseline)', () => {
    expect(matchesPaletteQuery(entry, '')).toBe(true);
  });
});

describe('launcherActionEntryId — the roving aria target', () => {
  it('is stable and index-keyed', () => {
    expect(launcherActionEntryId(0)).toBe('fredo-launcher-action-0');
    expect(launcherActionEntryId(3)).toBe('fredo-launcher-action-3');
  });

  it('names the palette-open action id', () => {
    expect(ACTION_PALETTE_OPEN_ACTION_ID).toBe('fredo.palette.openActions');
  });
});
