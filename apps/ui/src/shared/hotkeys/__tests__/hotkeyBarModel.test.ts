/**
 * Spec #3009 CU-1 (ST-2) — the PURE hotkey-bar model (plan API Contracts / QA
 * rows F-96/F-97/F-98). Pins document-order rows, the empty reach-back (G-265),
 * the disabled pair (text-entry / terminal), the pending prefix, and the
 * storage/display units (`key` = first step, `serialized` = full sequence).
 */

import { describe, expect, it } from 'vitest';

import { buildHotkeyBarModel } from '../hotkeyBarModel';
import { parseDataHotkey } from '../hotkeyGrammar';
import type { HotkeyElementEntry } from '../hotkeyElements';
import type { FocusSnapshot } from '../engine';
import type { FocusContext } from '../types';

function entry(key: string, title: string): HotkeyElementEntry {
  const grammar = parseDataHotkey(key);
  if (grammar === null) throw new Error(`bad fixture key ${key}`);
  return {
    element: document.createElement('button'),
    actionId: `fredo.element.${key}#fixture`,
    grammar,
    title,
    source: 'element',
  };
}

function focus(context: FocusContext, textEntry = false): FocusSnapshot {
  return { context, nativeConsumes: false, textEntry };
}

describe('buildHotkeyBarModel — rows', () => {
  it('projects the listing in document order, element-only', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('s', 'Find session'), entry('n', 'Next'), entry('p', 'Previous')],
      pending: null,
      focus: focus('default'),
    });

    expect(model.empty).toBe(false);
    expect(model.disabled).toBe(false);
    expect(model.pendingPrefix).toBeNull();
    expect(model.rows.map((row) => row.key)).toEqual(['s', 'n', 'p']);
    expect(model.rows.map((row) => row.title)).toEqual(['Find session', 'Next', 'Previous']);
    expect(model.rows.every((row) => row.availability === 'available')).toBe(true);
    expect(model.rows.map((row) => row.actionId)).toEqual([
      'fredo.element.s#fixture',
      'fredo.element.n#fixture',
      'fredo.element.p#fixture',
    ]);
  });

  it('carries the storage (key) and display (serialized) units separately', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('a+b', 'Two step')],
      pending: null,
      focus: focus('default'),
    });
    expect(model.rows[0].key).toBe('a');
    expect(model.rows[0].serialized).toBe('a b');
    expect(model.rows[0].title).toBe('Two step');
  });

  it('is empty (reach-back) at zero entries', () => {
    const model = buildHotkeyBarModel({ entries: [], pending: null, focus: focus('default') });
    expect(model.empty).toBe(true);
    expect(model.rows).toHaveLength(0);
  });
});

describe('buildHotkeyBarModel — disabled + pending', () => {
  it('disables every row while focus is in a text-entry control', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('a', 'Alpha'), entry('b', 'Beta')],
      pending: null,
      focus: focus('text-entry', true),
    });
    expect(model.disabled).toBe(true);
    expect(model.rows.every((row) => row.availability === 'disabled')).toBe(true);
  });

  it('disables every row while focus is in a terminal session', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('a', 'Alpha')],
      pending: null,
      focus: focus('terminal'),
    });
    expect(model.disabled).toBe(true);
    expect(model.rows[0].availability).toBe('disabled');
  });

  it('stays available on a default / interactive focus', () => {
    for (const context of ['default', 'interactive'] as const) {
      const model = buildHotkeyBarModel({
        entries: [entry('a', 'Alpha')],
        pending: null,
        focus: focus(context),
      });
      expect(model.disabled).toBe(false);
      expect(model.rows[0].availability).toBe('available');
    }
  });

  it('echoes the pending prefix', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('a+b', 'Two step')],
      pending: 'a',
      focus: focus('default'),
    });
    expect(model.pendingPrefix).toBe('a');
  });
});
