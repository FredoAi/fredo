/**
 * Spec #3009 CU-1 (ST-2) — the PURE hotkey-bar model (plan API Contracts / QA
 * rows F-96/F-97/F-98). Pins document-order rows, the empty reach-back (G-265),
 * the disabled pair (text-entry / terminal), the pending prefix, and the
 * storage/display units (`key` = first step, `serialized` = full sequence).
 *
 * Spec #3071 ST-3: the duplicate channel now follows the RELAXED rule (full
 * sequence / strict prefix), so a repeated first step is not a duplicate.
 */

import type { ReactElement } from 'react';
import { LuAppWindow } from 'react-icons/lu';
import { afterEach, describe, expect, it } from 'vitest';

import { registerApplication } from '@/applications/applicationRegistry';
import { FredoApplicationClass } from '@/shared/classes';
import { buildHotkeyBarModel } from '../hotkeyBarModel';
import { parseDataHotkey } from '../hotkeyGrammar';
import type { ApplicationCommandSurface } from '../commandSurface';
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

// ── Spec #3098 ST-1 fixtures (A1 element scope + A2 keymap order) ────────────

/** A surface-owning application registered for the scope/order cases. */
const ORDER_APP_ID = 'bar-order-app';

const orderAppSurface: ApplicationCommandSurface = {
  modes: [
    {
      id: 'select',
      label: 'Select',
      parent: null,
      keymap: { r: 'rect', e: 'ellipse', c: 'fill', v: 'select-mode' },
      keymapOrder: ['v', 'c', 'e', 'r', 'z'],
    },
    {
      id: 'plain-mode',
      label: 'Plain',
      parent: 'select',
      keymap: { b: 'command-b', a: 'command-a' },
    },
  ],
  commands: [
    { id: 'rect', title: 'Rectangle', run: () => {} },
    { id: 'ellipse', title: 'Ellipse', run: () => {} },
    { id: 'fill', title: 'Fill', run: () => {} },
    { id: 'select-mode', title: 'Select', run: () => {} },
    { id: 'command-b', title: 'Command B', run: () => {} },
    { id: 'command-a', title: 'Command A', run: () => {} },
  ],
};

class BarStubApplication extends FredoApplicationClass {
  readonly id = ORDER_APP_ID;
  readonly name = 'Bar order app';
  readonly icon = LuAppWindow;
  readonly commandSurface = orderAppSurface;

  render(): ReactElement {
    return null as unknown as ReactElement;
  }
}

registerApplication(new BarStubApplication());

/** One element hotkey mounted inside an application root (`data-fredo-app-id`). */
function scopedEntry(appId: string, key: string, title: string): HotkeyElementEntry {
  const grammar = parseDataHotkey(key);
  if (grammar === null) throw new Error(`bad fixture key ${key}`);
  const root = document.createElement('div');
  root.setAttribute('data-fredo-app-id', appId);
  const button = document.createElement('button');
  root.appendChild(button);
  document.body.appendChild(root);
  return {
    element: button,
    actionId: `fredo.element.${key}#${appId}`,
    grammar,
    title,
    source: 'element',
  };
}

function modeView(modeId: string): {
  appId: string;
  modeId: string;
  label: string;
  path: readonly string[];
} {
  return { appId: ORDER_APP_ID, modeId, label: modeId, path: ['select', modeId] };
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

// ── Duplicate channel (ST-2R / R-3.4) ────────────────────────────────────────

describe('buildHotkeyBarModel — duplicate channel (R-3.4)', () => {
  it('flags the duplicate and names the shared key when two entries share a key', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('s', 'Find session'), entry('s', 'Find session again')],
      pending: null,
      focus: focus('default'),
    });
    expect(model.duplicate).toBe(true);
    expect(model.duplicateKey).toBe('s');
  });

  it('is not duplicate for disjoint keys', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('s', 'Find session'), entry('d', 'Diagram')],
      pending: null,
      focus: focus('default'),
    });
    expect(model.duplicate).toBe(false);
    expect(model.duplicateKey).toBeNull();
  });

  it('is not duplicate for a single entry (or none) and resolves the state from the passed listing', () => {
    const single = buildHotkeyBarModel({
      entries: [entry('a', 'Alpha')],
      pending: null,
      focus: focus('default'),
    });
    expect(single.duplicate).toBe(false);
    expect(single.duplicateKey).toBeNull();

    const none = buildHotkeyBarModel({ entries: [], pending: null, focus: focus('default') });
    expect(none.duplicate).toBe(false);
    expect(none.duplicateKey).toBeNull();
  });

  // ── Spec #3071 ST-3 — relaxed rule at the bar-model seam ────────────────────

  it('is NOT duplicate for a shared first step with distinct full serializations (the g namespace)', () => {
    const model = buildHotkeyBarModel({
      entries: [
        entry('g+g', 'Group'),
        entry('g+a', 'Align left'),
        entry('g+i', 'Zoom in'),
      ],
      pending: null,
      focus: focus('default'),
    });
    expect(model.duplicate).toBe(false);
    expect(model.duplicateKey).toBeNull();
    // The first-step `key` repeats across the namespace — that is legal now.
    expect(model.rows.map((row) => row.key)).toEqual(['g', 'g', 'g']);
    expect(model.rows.map((row) => row.serialized)).toEqual(['g g', 'g a', 'g i']);
  });

  it('flags a bare binding shadowing a sequence on the same first step', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('g', 'Zoom in'), entry('g+i', 'Zoom in alt')],
      pending: null,
      focus: focus('default'),
    });
    expect(model.duplicate).toBe(true);
    expect(model.duplicateKey).toBe('g');
  });

  it('flags two identical two-step serializations as duplicates', () => {
    const model = buildHotkeyBarModel({
      entries: [entry('g+a', 'Align left'), entry('g+a', 'Align left again')],
      pending: null,
      focus: focus('default'),
    });
    expect(model.duplicate).toBe(true);
    expect(model.duplicateKey).toBe('g a');
  });
});

// ── Spec #3098 ST-1 (A1) — per-scope element rows ────────────────────────────

describe('buildHotkeyBarModel — per-scope element rows (Spec #3098 A1)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('drops a carrier element whose surface-owning app is not displayed', () => {
    const carrier = scopedEntry(ORDER_APP_ID, 'g+i', 'Zoom in');

    const model = buildHotkeyBarModel({
      entries: [carrier],
      pending: null,
      focus: focus('default'),
      scopeAppId: 'another-app',
    });

    expect(model.rows).toHaveLength(0);
    expect(model.empty).toBe(true);
  });

  it('lists the same element when its app IS displayed', () => {
    const carrier = scopedEntry(ORDER_APP_ID, 'g+i', 'Zoom in');

    const model = buildHotkeyBarModel({
      entries: [carrier],
      pending: null,
      focus: focus('default'),
      scopeAppId: ORDER_APP_ID,
    });

    expect(model.rows.map((row) => row.key)).toEqual(['g']);
    expect(model.rows.map((row) => row.serialized)).toEqual(['g i']);
    expect(model.rows.map((row) => row.title)).toEqual(['Zoom in']);
  });

  it('lists a null-scoped element in both states (today’s behaviour)', () => {
    const global = entry('y', 'Global binding');

    for (const scopeAppId of [ORDER_APP_ID, 'another-app', null]) {
      document.body.innerHTML = '';
      const model = buildHotkeyBarModel({
        entries: [global],
        pending: null,
        focus: focus('default'),
        scopeAppId,
      });
      expect(model.rows.map((row) => row.serialized)).toEqual(['y']);
    }
  });

  it('defaults the scope to the focused application (no caller can forget it)', () => {
    const carrier = scopedEntry(ORDER_APP_ID, 'g+i', 'Zoom in');
    const other = scopedEntry('other-app', 'g+o', 'Zoom out');
    other.element.focus();

    const model = buildHotkeyBarModel({
      entries: [carrier, other],
      pending: null,
      focus: focus('default'),
    });

    // Focus is inside `other-app`: the surface-owned carrier is dropped even
    // though no `scopeAppId` was supplied (the single default did the filter).
    expect(model.rows.map((row) => row.serialized)).toEqual(['g o']);
  });
});

// ── Spec #3098 ST-1 (A2) — keymapOrder ───────────────────────────────────────

describe('buildHotkeyBarModel — keymapOrder (Spec #3098 A2)', () => {
  it('renders mode rows in the declared order and skips undeclared keys', () => {
    const model = buildHotkeyBarModel({
      entries: [],
      pending: null,
      focus: focus('default'),
      activeMode: modeView('select'),
    });

    expect(model.rows.map((row) => row.key)).toEqual(['v', 'c', 'e', 'r']);
    expect(model.rows.map((row) => row.title)).toEqual([
      'Select',
      'Fill',
      'Ellipse',
      'Rectangle',
    ]);
    expect(model.rows.every((row) => row.kind === 'mode')).toBe(true);
  });

  it('falls back to Object.entries (declaration) order when absent', () => {
    const model = buildHotkeyBarModel({
      entries: [],
      pending: null,
      focus: focus('default'),
      activeMode: modeView('plain-mode'),
    });

    expect(model.rows.map((row) => row.key)).toEqual(['b', 'a']);
    expect(model.rows.map((row) => row.title)).toEqual(['Command B', 'Command A']);
  });
});
