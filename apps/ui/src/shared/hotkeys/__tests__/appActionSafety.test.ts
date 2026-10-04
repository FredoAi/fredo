/**
 * Spec #2961 ST-4 — app action availability + typing safety contract pins
 * (EARS R-5.1 / R-5.2).
 *
 * The shipped availability mapper (`buildKeyboardBarModel`, `keyboardBarModel.ts`)
 * and the pure decision (`decideDispatch`, `sequence.ts`) must never surface a
 * dead entry as available:
 *  - an action declared with `enabled: () => false` is projected unavailable
 *    carrying its declared `unavailableReason` (never as a dispatch `match`);
 *  - a bare-key app action in a `text-entry` focus is unavailable while typing,
 *    via the shipped typing suppression in `sequence.ts`.
 *
 * TESTS ONLY — no production file (resolver / engine / bar / defaults) is touched.
 */

import { describe, expect, it } from 'vitest';

import { parseSequence } from '../keys';
import { decideDispatch } from '../sequence';
import { buildKeyboardBarModel, type KeyboardBarModelInput } from '../keyboardBarModel';
import type { FocusSnapshot } from '../engine';
import type {
  FocusContext,
  Platform,
  RegisteredHotkeyAction,
  ResolvedBinding,
} from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeBinding(
  actionId: string,
  serialized: string,
  overrides: Partial<RegisteredHotkeyAction> = {},
): ResolvedBinding {
  const action: RegisteredHotkeyAction = {
    actionId,
    tier: 'feature',
    title: `Title ${actionId}`,
    defaultSequence: serialized,
    run: () => {},
    ...overrides,
  };
  return {
    actionId,
    tier: 'feature',
    sequence: parseSequence(serialized),
    serialized,
    action,
  };
}

function focus(context: FocusContext, nativeConsumes = false): FocusSnapshot {
  return { context, nativeConsumes, textEntry: context === 'text-entry' };
}

function modelInput(
  bindings: readonly ResolvedBinding[],
  focusSnapshot: FocusSnapshot,
): KeyboardBarModelInput {
  return {
    bindings,
    contextId: 'app-x',
    contextTitle: 'App X',
    depth: 1,
    focus: focusSnapshot,
    macroRecording: false,
    platform: 'win32' as Platform,
  };
}

// ── Disabled action (R-5.1) ───────────────────────────────────────────────────

describe('disabled action is unavailable — a dead entry is impossible (R-5.1)', () => {
  it('projects unavailable with its declared reason and never as available', () => {
    const disabled = makeBinding('app-x.explain', 'ctrl+shift+f8', {
      enabled: () => false,
      unavailableReason: 'Needs an open document',
    });
    const model = buildKeyboardBarModel(modelInput([disabled], focus('default')));

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].availability).toBe('unavailable');
    expect(model.rows[0].unavailableReason).toBe('Needs an open document');
    // A disabled action is NEVER surfaced as available (no dispatch `match`).
    expect(model.rows.filter((row) => row.availability === 'available')).toHaveLength(0);

    // The key itself IS dispatchable: an enabled twin with the same key projects
    // available, so the disabled row's state can only come from the enabled()
    // gate short-circuiting the decision — never from a dispatch `match`.
    const enabledTwin = makeBinding('app-x.explainEnabled', 'ctrl+shift+f8', {
      enabled: () => true,
    });
    const twinModel = buildKeyboardBarModel(modelInput([enabledTwin], focus('default')));
    expect(twinModel.rows[0].availability).toBe('available');
  });

  it('falls back to the generic copy when disabled with no declared reason', () => {
    const disabled = makeBinding('app-x.explain', 'ctrl+shift+f8', { enabled: () => false });
    const model = buildKeyboardBarModel(modelInput([disabled], focus('default')));

    expect(model.rows[0].availability).toBe('unavailable');
    expect(model.rows[0].unavailableReason).toBe('Not available right now');
  });
});

// ── Bare-key typing safety (R-5.2) ────────────────────────────────────────────

describe('bare-key app action is unavailable while typing (R-5.2)', () => {
  it('suppresses the bare key at the decision layer (text-entry-passthrough)', () => {
    const binding = makeBinding('app-x.activate', 'x');
    const decision = decideDispatch({
      stroke: binding.sequence[0],
      context: 'text-entry',
      pending: null,
      bindings: [binding],
      leader: null,
      macroRecording: false,
      nativeConsumes: false,
    });

    expect(decision.outcome).toBe('passthrough');
    expect(decision.reason).toBe('text-entry-passthrough');
    expect(decision.consumed).toBe(false);
  });

  it('projects unavailable with the reason "Unavailable while typing"', () => {
    const binding = makeBinding('app-x.activate', 'x');
    const model = buildKeyboardBarModel(modelInput([binding], focus('text-entry')));

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].availability).toBe('unavailable');
    expect(model.rows[0].unavailableReason).toBe('Unavailable while typing');
  });

  it('keeps a modifier chord global while typing (contrast)', () => {
    const chord = makeBinding('app-x.explain', 'ctrl+shift+f8');
    const model = buildKeyboardBarModel(modelInput([chord], focus('text-entry')));

    expect(model.rows[0].availability).toBe('available');
  });
});
