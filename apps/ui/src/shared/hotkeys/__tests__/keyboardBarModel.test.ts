/**
 * Spec #2959 ST-2 — keyboard-bar availability model tests (EARS R-2.1, R-5.1,
 * R-5.2, R-5.5, R-5.6; supports R-3.2).
 *
 * Pins: available/unavailable projection, the exact reason copy, the
 * `enabled()`-derived additive `unavailableReason`, the R-5.6 hide rule for
 * unbound actions, the R-5.4 empty model, the bounded announcement digest, and
 * — crucially — DECISION-REUSE PARITY: the model's availability is exactly what
 * the engine's own `decideDispatch` returns for the same scenario (R-5.5).
 */

import { describe, expect, it } from 'vitest';

import { parseSequence } from '../keys';
import { decideDispatch } from '../sequence';
import type { FocusSnapshot } from '../engine';
import {
  KEYBOARD_BAR_MAX_ANNOUNCED,
  buildKeyboardBarModel,
  keyboardBarAnnouncement,
  unavailableReasonFor,
  type KeyboardBarModelInput,
} from '../keyboardBarModel';
import {
  TERMINAL_EXIT_ACTION_ID,
  type FocusContext,
  type HotkeyTier,
  type Platform,
  type RegisteredHotkeyAction,
  type ResolvedBinding,
} from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeBinding(
  actionId: string,
  serialized: string,
  overrides: Partial<RegisteredHotkeyAction> = {},
): ResolvedBinding {
  const tier: HotkeyTier = actionId.startsWith('fredo.') ? 'fredo' : 'feature';
  const action: RegisteredHotkeyAction = {
    actionId,
    tier,
    title: `Title ${actionId}`,
    defaultSequence: serialized,
    run: () => {},
    ...overrides,
  };
  return {
    actionId,
    tier,
    sequence: parseSequence(serialized),
    serialized,
    action,
  };
}

function focus(context: FocusContext, nativeConsumes = false): FocusSnapshot {
  return { context, nativeConsumes };
}

function modelInput(overrides: Partial<KeyboardBarModelInput> = {}): KeyboardBarModelInput {
  return {
    bindings: [],
    contextId: 'fredo.root',
    contextTitle: 'Fredo',
    depth: 1,
    focus: focus('default'),
    macroRecording: false,
    platform: 'win32',
    ...overrides,
  };
}

/** The engine's OWN decision for a binding, walked exactly as the keydown path does. */
function engineDecision(
  binding: ResolvedBinding,
  bindings: readonly ResolvedBinding[],
  focusSnapshot: FocusSnapshot,
  macroRecording: boolean,
  platform: Platform | undefined,
): { available: boolean; reason: string } {
  let pending = null as ReturnType<typeof parseSequence> | null;
  let reason = 'unbound';
  const steps = binding.sequence;
  for (let i = 0; i < steps.length; i += 1) {
    const decision = decideDispatch({
      stroke: steps[i],
      context: focusSnapshot.context,
      pending,
      bindings,
      leader: null,
      macroRecording,
      nativeConsumes: focusSnapshot.nativeConsumes,
      platform,
    });
    reason = decision.reason;
    if (decision.outcome === 'match') {
      return { available: decision.action?.actionId === binding.actionId, reason };
    }
    if (decision.outcome === 'arm-sequence') {
      pending = [steps[i]];
      continue;
    }
    if (decision.outcome === 'pending') {
      pending = [...(pending ?? []), steps[i]];
      continue;
    }
    return { available: false, reason };
  }
  return { available: false, reason };
}

// ── Availability projection ───────────────────────────────────────────────────

describe('buildKeyboardBarModel — availability (R-5.1/R-5.2/R-5.5)', () => {
  it('marks a matching modifier chord available with no reason', () => {
    const model = buildKeyboardBarModel(
      modelInput({ bindings: [makeBinding('fredo.keyboardMode.toggle', 'ctrl+shift+f8')] }),
    );
    expect(model.rows).toHaveLength(1);
    const row = model.rows[0];
    expect(row.availability).toBe('available');
    expect(row.sequence).toBe('ctrl+shift+f8');
    expect(row.tier).toBe('fredo');
    expect(row.contextId).toBe('fredo.root');
    expect('unavailableReason' in row).toBe(false);
  });

  it('marks a bare key unavailable while typing (text-entry)', () => {
    const model = buildKeyboardBarModel(
      modelInput({
        bindings: [makeBinding('demo-widget.focus', 'g')],
        contextId: 'demo-widget',
        contextTitle: 'Demo',
        focus: focus('text-entry'),
      }),
    );
    expect(model.rows[0].availability).toBe('unavailable');
    expect(model.rows[0].unavailableReason).toBe('Unavailable while typing');
  });

  it('marks a bare key unavailable while a dialog is open (modal)', () => {
    const model = buildKeyboardBarModel(
      modelInput({ bindings: [makeBinding('demo-widget.focus', 'g')], focus: focus('modal') }),
    );
    expect(model.rows[0].availability).toBe('unavailable');
    expect(model.rows[0].unavailableReason).toBe('Unavailable while a dialog is open');
  });

  it('marks a bare key unavailable when the focused control captures it', () => {
    const model = buildKeyboardBarModel(
      modelInput({ bindings: [makeBinding('demo-widget.focus', 'g')], focus: focus('default', true) }),
    );
    expect(model.rows[0].unavailableReason).toBe('The focused control captures this key');
  });

  it('marks non-recording bindings unavailable during macro recording', () => {
    const model = buildKeyboardBarModel(
      modelInput({
        bindings: [makeBinding('fredo.keyboardMode.toggle', 'ctrl+shift+f8')],
        macroRecording: true,
      }),
    );
    expect(model.rows[0].availability).toBe('unavailable');
    expect(model.rows[0].unavailableReason).toBe('Unavailable during macro recording');
  });

  it('marks non-exit bindings unavailable in terminal passthrough', () => {
    const model = buildKeyboardBarModel(
      modelInput({
        bindings: [makeBinding('fredo.launcher.toggle', 'primary+space')],
        focus: focus('terminal'),
      }),
    );
    expect(model.rows[0].unavailableReason).toBe('The terminal owns the keyboard');
  });

  it('keeps the terminal exit binding available in terminal passthrough', () => {
    const model = buildKeyboardBarModel(
      modelInput({
        bindings: [makeBinding(TERMINAL_EXIT_ACTION_ID, 'ctrl+shift+f10')],
        focus: focus('terminal'),
      }),
    );
    expect(model.rows[0].availability).toBe('available');
  });

  it('resolves a multi-stroke sequence through its prefix (g g)', () => {
    const model = buildKeyboardBarModel(
      modelInput({ bindings: [makeBinding('fredo.window.first', 'g g')] }),
    );
    expect(model.rows[0].availability).toBe('available');
    expect(model.rows[0].sequence).toBe('g g');
  });

  it('marks a multi-stroke sequence unavailable while typing', () => {
    const model = buildKeyboardBarModel(
      modelInput({ bindings: [makeBinding('fredo.window.first', 'g g')], focus: focus('text-entry') }),
    );
    expect(model.rows[0].availability).toBe('unavailable');
    expect(model.rows[0].unavailableReason).toBe('Unavailable while typing');
  });
});

// ── Additive enabled() reason (the S4 contract) ───────────────────────────────

describe('enabled() gate + additive unavailableReason (R-5.5)', () => {
  it('uses the declared unavailableReason when enabled() is false', () => {
    const model = buildKeyboardBarModel(
      modelInput({
        bindings: [
          makeBinding('demo-widget.explain', 'ctrl+shift+f8', {
            enabled: () => false,
            unavailableReason: 'Needs an open document',
          }),
        ],
      }),
    );
    expect(model.rows[0].availability).toBe('unavailable');
    expect(model.rows[0].unavailableReason).toBe('Needs an open document');
  });

  it('falls back to the generic copy when enabled() is false with no declared reason', () => {
    const model = buildKeyboardBarModel(
      modelInput({
        bindings: [makeBinding('demo-widget.explain', 'ctrl+shift+f8', { enabled: () => false })],
      }),
    );
    expect(model.rows[0].unavailableReason).toBe('Not available right now');
  });

  it('does not consult enabled() when it returns true', () => {
    const model = buildKeyboardBarModel(
      modelInput({
        bindings: [
          makeBinding('demo-widget.explain', 'ctrl+shift+f8', {
            enabled: () => true,
            unavailableReason: 'should not surface',
          }),
        ],
      }),
    );
    expect(model.rows[0].availability).toBe('available');
    expect('unavailableReason' in model.rows[0]).toBe(false);
  });
});

// ── Unbound hidden + empty model ──────────────────────────────────────────────

describe('unbound hidden + empty model (R-5.6/R-5.4)', () => {
  it('hides a binding with no effective sequence', () => {
    const unbound: ResolvedBinding = {
      ...makeBinding('demo-widget.unbound', 'ctrl+shift+f8'),
      sequence: [],
      serialized: '',
    };
    const model = buildKeyboardBarModel(
      modelInput({ bindings: [makeBinding('demo-widget.focus', 'ctrl+shift+f8'), unbound] }),
    );
    expect(model.rows.map((row) => row.actionId)).toEqual(['demo-widget.focus']);
  });

  it('produces an empty model (empty=true) when there are no rows', () => {
    const model = buildKeyboardBarModel(modelInput({ bindings: [] }));
    expect(model.rows).toHaveLength(0);
    expect(model.empty).toBe(true);
    expect(model.contextId).toBe('fredo.root');
    expect(model.depth).toBe(1);
  });

  it('reports empty=true when every binding was hidden as unbound', () => {
    const unbound: ResolvedBinding = {
      ...makeBinding('demo-widget.unbound', 'ctrl+shift+f8'),
      sequence: [],
      serialized: '',
    };
    const model = buildKeyboardBarModel(modelInput({ bindings: [unbound] }));
    expect(model.empty).toBe(true);
  });
});

// ── Reason copy mapper ────────────────────────────────────────────────────────

describe('unavailableReasonFor', () => {
  it.each([
    ['text-entry-passthrough', 'Unavailable while typing'],
    ['text-entry-chord-unbound', 'Unavailable while typing'],
    ['modal-suspend', 'Unavailable while a dialog is open'],
    ['modal-chord-unbound', 'Unavailable while a dialog is open'],
    ['native-consumes', 'The focused control captures this key'],
    ['macro-recording', 'Unavailable during macro recording'],
    ['terminal-passthrough', 'The terminal owns the keyboard'],
    ['unbound', 'Not available right now'],
    ['sequence-armed', 'Not available right now'],
  ])('maps %s → %s', (reason, expected) => {
    expect(unavailableReasonFor(reason)).toBe(expected);
  });
});

// ── Announcement copy ─────────────────────────────────────────────────────────

describe('keyboardBarAnnouncement', () => {
  it('announces entry with the bounded digest', () => {
    const model = buildKeyboardBarModel(
      modelInput({ bindings: [makeBinding('fredo.keyboardMode.toggle', 'ctrl+shift+f8')] }),
    );
    expect(keyboardBarAnnouncement(model, 'enter')).toBe(
      'Keyboard mode on. Fredo. 1 actions: Ctrl + Shift + F8 (Title fredo.keyboardMode.toggle)',
    );
  });

  it('announces an empty entry', () => {
    const model = buildKeyboardBarModel(modelInput({ bindings: [] }));
    expect(keyboardBarAnnouncement(model, 'enter')).toBe(
      'Keyboard mode on. Fredo. No actions in this context.',
    );
  });

  it('announces a context change with the level', () => {
    const model = buildKeyboardBarModel(
      modelInput({
        bindings: [makeBinding('fredo.window.first', 'g g')],
        contextId: 'fredo.root.reference',
        contextTitle: 'Reference',
        depth: 2,
      }),
    );
    expect(keyboardBarAnnouncement(model, 'context')).toBe(
      'Reference. Level 2. 1 actions: G then G (Title fredo.window.first)',
    );
  });

  it('announces an empty context change', () => {
    const model = buildKeyboardBarModel(
      modelInput({ contextTitle: 'Reference', depth: 3 }),
    );
    expect(keyboardBarAnnouncement(model, 'context')).toBe(
      'Reference. Level 3. No actions in this context.',
    );
  });

  it(`caps the digest at the first ${KEYBOARD_BAR_MAX_ANNOUNCED} actions`, () => {
    const bindings = Array.from({ length: 10 }, (_, i) =>
      makeBinding(`demo-widget.act${i}`, `ctrl+shift+f${i + 1}`),
    );
    const model = buildKeyboardBarModel(modelInput({ bindings }));
    expect(KEYBOARD_BAR_MAX_ANNOUNCED).toBe(8);
    const announcement = keyboardBarAnnouncement(model, 'enter');
    expect(announcement.startsWith('Keyboard mode on. Fredo. 10 actions: ')).toBe(true);
    expect(announcement.endsWith(', and 2 more')).toBe(true);
    expect(announcement).toContain('Title demo-widget.act7');
    expect(announcement).not.toContain('Title demo-widget.act8');
  });
});

// ── Decision-reuse parity (R-5.5) ─────────────────────────────────────────────

describe('decision-reuse parity with the engine (R-5.5)', () => {
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly binding: ResolvedBinding;
    readonly focus: FocusSnapshot;
    readonly macroRecording: boolean;
  }> = [
    {
      name: 'matching chord, default focus',
      binding: makeBinding('fredo.keyboardMode.toggle', 'ctrl+shift+f8'),
      focus: focus('default'),
      macroRecording: false,
    },
    {
      name: 'bare key in text-entry',
      binding: makeBinding('demo-widget.focus', 'g'),
      focus: focus('text-entry'),
      macroRecording: false,
    },
    {
      name: 'bare key in modal',
      binding: makeBinding('demo-widget.focus', 'g'),
      focus: focus('modal'),
      macroRecording: false,
    },
    {
      name: 'bare key on a native consumer',
      binding: makeBinding('demo-widget.focus', 'g'),
      focus: focus('default', true),
      macroRecording: false,
    },
    {
      name: 'chord during macro recording',
      binding: makeBinding('fredo.keyboardMode.toggle', 'ctrl+shift+f8'),
      focus: focus('default'),
      macroRecording: true,
    },
    {
      name: 'launcher chord in terminal',
      binding: makeBinding('fredo.launcher.toggle', 'primary+space'),
      focus: focus('terminal'),
      macroRecording: false,
    },
    {
      name: 'multi-stroke sequence in default focus',
      binding: makeBinding('fredo.window.first', 'g g'),
      focus: focus('default'),
      macroRecording: false,
    },
    {
      name: 'multi-stroke sequence in text-entry',
      binding: makeBinding('fredo.window.first', 'g g'),
      focus: focus('text-entry'),
      macroRecording: false,
    },
  ];

  it.each(scenarios)('$name', ({ binding, focus: focusSnapshot, macroRecording }) => {
    const bindings = [binding];
    const model = buildKeyboardBarModel(
      modelInput({ bindings, focus: focusSnapshot, macroRecording, platform: 'win32' }),
    );
    const expected = engineDecision(binding, bindings, focusSnapshot, macroRecording, 'win32');

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].availability).toBe(expected.available ? 'available' : 'unavailable');
    if (expected.available) {
      expect('unavailableReason' in model.rows[0]).toBe(false);
    } else {
      expect(model.rows[0].unavailableReason).toBe(unavailableReasonFor(expected.reason));
    }
  });
});
