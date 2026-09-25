import { describe, it, expect } from 'vitest';

import { parseSequence } from '../keys';
import { decideDispatch, matchSequence, sequenceResetDecision, type DispatchInput } from '../sequence';
import type { HotkeyActionId, HotkeyTier, KeyStroke, RegisteredHotkeyAction, ResolvedBinding } from '../types';

function action(actionId: HotkeyActionId, tier: HotkeyTier): RegisteredHotkeyAction {
  return {
    actionId,
    tier,
    title: actionId,
    defaultSequence: null,
    run: () => {},
  };
}

function binding(actionId: HotkeyActionId, serialized: string, tier: HotkeyTier = 'fredo'): ResolvedBinding {
  return {
    actionId,
    tier,
    sequence: parseSequence(serialized),
    serialized,
    action: action(actionId, tier),
  };
}

function stroke(partial: Partial<KeyStroke> & { key: string }): KeyStroke {
  return { primary: false, ctrl: false, alt: false, shift: false, meta: false, ...partial };
}

function input(overrides: Partial<DispatchInput> & { stroke: KeyStroke }): DispatchInput {
  return {
    context: 'default',
    pending: null,
    bindings: [],
    leader: null,
    macroRecording: false,
    nativeConsumes: false,
    platform: 'win32',
    ...overrides,
  };
}

describe('matchSequence', () => {
  const bindings = [
    binding('fredo.a', 'g'),
    binding('fredo.b', 'g g'),
    binding('fredo.c', 'g g g'),
  ];

  it('returns exact for a complete candidate', () => {
    const result = matchSequence(parseSequence('g'), bindings, 'win32');
    expect(result.kind).toBe('exact');
  });

  it('returns prefix for a partial candidate', () => {
    const result = matchSequence(parseSequence('g'), [binding('fredo.c', 'g g g')], 'win32');
    expect(result.kind).toBe('prefix');
  });

  it('returns none for an unmatched candidate and an empty list', () => {
    expect(matchSequence(parseSequence('x'), bindings, 'win32').kind).toBe('none');
    expect(matchSequence([], bindings, 'win32').kind).toBe('none');
  });
});

describe('decideDispatch — single + sequence outcomes', () => {
  it('matches an exact single chord', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'space', primary: true }),
        bindings: [binding('fredo.launcher.toggle', 'primary+space')],
      }),
    );
    expect(decision.outcome).toBe('match');
    expect(decision.consumed).toBe(true);
    expect(decision.action?.actionId).toBe('fredo.launcher.toggle');
  });

  it('arms a sequence from its first stroke', () => {
    const decision = decideDispatch(
      input({ stroke: stroke({ key: 'g' }), bindings: [binding('fredo.a', 'g g')] }),
    );
    expect(decision.outcome).toBe('arm-sequence');
    expect(decision.consumed).toBe(true);
  });

  it('matches the completing stroke of a pending sequence', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'g' }),
        pending: parseSequence('g'),
        bindings: [binding('fredo.a', 'g g')],
      }),
    );
    expect(decision.outcome).toBe('match');
    expect(decision.action?.actionId).toBe('fredo.a');
  });

  it('stays pending when the candidate is still a prefix', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'g' }),
        pending: parseSequence('g'),
        bindings: [binding('fredo.a', 'g g g')],
      }),
    );
    expect(decision.outcome).toBe('pending');
    expect(decision.consumed).toBe(true);
  });

  it('invalidates a dead-end continuation without re-dispatching the key', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'x' }),
        pending: parseSequence('g'),
        bindings: [binding('fredo.a', 'g g'), binding('fredo.x', 'x')],
      }),
    );
    expect(decision.outcome).toBe('suppress');
    expect(decision.consumed).toBe(true);
    expect(decision.reason).toBe('sequence-invalid');
  });

  it('consumes Escape to abandon a pending sequence', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'escape' }),
        pending: parseSequence('g'),
        bindings: [binding('fredo.a', 'g g')],
      }),
    );
    expect(decision.outcome).toBe('suppress');
    expect(decision.reason).toBe('sequence-escape');
  });

  it('produces a suppress decision for a timeout reset', () => {
    const decision = sequenceResetDecision('timeout');
    expect(decision.outcome).toBe('suppress');
    expect(decision.reason).toBe('sequence-timeout');
    expect(sequenceResetDecision('invalid').consumed).toBe(true);
  });

  it('leaves an unbound key native', () => {
    const decision = decideDispatch(input({ stroke: stroke({ key: 'z' }) }));
    expect(decision.outcome).toBe('passthrough');
    expect(decision.consumed).toBe(false);
  });
});

describe('decideDispatch — leader arming', () => {
  it('arms a @leader sequence when the leader stroke is pressed', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'space' }),
        leader: stroke({ key: 'space' }),
        bindings: [binding('fredo.help.cheatsheet', '@leader ?')],
      }),
    );
    expect(decision.outcome).toBe('arm-sequence');
    expect(decision.reason).toBe('leader-armed');
  });

  it('does not arm when no @leader binding exists', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'space' }),
        leader: stroke({ key: 'space' }),
        bindings: [binding('fredo.a', 'g g')],
      }),
    );
    expect(decision.outcome).toBe('passthrough');
  });
});

describe('decideDispatch — focus contexts', () => {
  const exitBinding = binding('fredo.terminal.exitPassthrough', 'ctrl+shift+f10');
  const toggleBinding = binding('fredo.launcher.toggle', 'primary+space');

  it('passes every terminal keystroke through except the exit chord', () => {
    const native = decideDispatch(
      input({ stroke: stroke({ key: 'a' }), context: 'terminal', bindings: [exitBinding] }),
    );
    expect(native.outcome).toBe('passthrough');
    expect(native.consumed).toBe(false);

    const exit = decideDispatch(
      input({
        stroke: stroke({ key: 'f10', primary: true, shift: true }),
        context: 'terminal',
        bindings: [exitBinding],
      }),
    );
    expect(exit.outcome).toBe('match');
    expect(exit.action?.actionId).toBe('fredo.terminal.exitPassthrough');
    expect(exit.consumed).toBe(true);
  });

  it('matches an explicit ctrl stroke against the exit chord on win32 (platform fold)', () => {
    const exit = decideDispatch(
      input({
        stroke: stroke({ key: 'f10', ctrl: true, shift: true }),
        context: 'terminal',
        bindings: [exitBinding],
      }),
    );
    expect(exit.outcome).toBe('match');
  });

  it('passes typed characters through in text-entry and keeps modifier chords global', () => {
    const typed = decideDispatch(
      input({
        stroke: stroke({ key: 'g' }),
        context: 'text-entry',
        bindings: [binding('fredo.a', 'g')],
      }),
    );
    expect(typed.outcome).toBe('passthrough');
    expect(typed.reason).toBe('text-entry-passthrough');

    const chord = decideDispatch(
      input({
        stroke: stroke({ key: 'space', primary: true }),
        context: 'text-entry',
        bindings: [toggleBinding],
      }),
    );
    expect(chord.outcome).toBe('match');
  });

  it('suspends bare keys in a modal but keeps Escape native and chords global', () => {
    const bare = decideDispatch(
      input({ stroke: stroke({ key: 'g' }), context: 'modal', bindings: [binding('fredo.a', 'g')] }),
    );
    expect(bare.outcome).toBe('passthrough');
    expect(bare.reason).toBe('modal-suspend');

    const escape = decideDispatch(input({ stroke: stroke({ key: 'escape' }), context: 'modal' }));
    expect(escape.outcome).toBe('passthrough');
    expect(escape.reason).toBe('modal-escape');

    const chord = decideDispatch(
      input({
        stroke: stroke({ key: 'space', primary: true }),
        context: 'modal',
        bindings: [toggleBinding],
      }),
    );
    expect(chord.outcome).toBe('match');
  });

  it('lets a native consumer win on a bare key and never arms', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: ' ' }),
        nativeConsumes: true,
        bindings: [binding('fredo.a', 'space space')],
      }),
    );
    expect(decision.outcome).toBe('passthrough');
    expect(decision.reason).toBe('native-consumes');
  });

  it('abandons a pending sequence when focus moves to text-entry', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'g' }),
        context: 'text-entry',
        pending: parseSequence('g'),
        bindings: [binding('fredo.a', 'g g')],
      }),
    );
    expect(decision.outcome).toBe('passthrough');
    expect(decision.reason).toBe('sequence-focus-change');
  });
});

describe('decideDispatch — raw macro recording gate', () => {
  it('suspends unbound keys while recording and keeps Escape as the cancel', () => {
    const suspended = decideDispatch(
      input({
        stroke: stroke({ key: 'g' }),
        macroRecording: true,
        bindings: [binding('fredo.a', 'g')],
      }),
    );
    expect(suspended.outcome).toBe('suppress');
    expect(suspended.reason).toBe('macro-recording');

    const escape = decideDispatch(
      input({ stroke: stroke({ key: 'escape' }), macroRecording: true }),
    );
    expect(escape.outcome).toBe('suppress');
    expect(escape.reason).toBe('macro-recording-escape');
  });

  it('lets the recording-stop binding through', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'r', primary: true, shift: true, alt: true }),
        macroRecording: true,
        bindings: [binding('fredo.macro.recordToggle', 'primary+shift+alt+r')],
      }),
    );
    expect(decision.outcome).toBe('match');
    expect(decision.action?.actionId).toBe('fredo.macro.recordToggle');
  });
});
