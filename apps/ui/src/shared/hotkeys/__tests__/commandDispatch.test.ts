/**
 * Spec #3097 ST-3 — the PURE dispatch decision with an application command scope.
 *
 * Pins the insertion points of the three new states (bounded prompt → text-entry →
 * mode chain → native-consumer → element fallback → kept globals) and, just as
 * importantly, that with NO `commandScope` every pre-existing outcome is unchanged
 * (terminal, modal Escape, text-entry, native consumer, pending, fresh/arm).
 *
 * `sequence.test.ts` / `engine.test.ts` stay byte-unmodified; this file is the
 * additive coverage for the new branches (the exact reason strings are part of the
 * binding contract).
 */

import { describe, expect, it } from 'vitest';

import type { ApplicationCommandSurface } from '../commandSurface';
import { parseSequence } from '../keys';
import { decideDispatch, type CommandDispatchScope, type DispatchInput } from '../sequence';
import type {
  HotkeyActionId,
  HotkeyTier,
  KeyStroke,
  RegisteredHotkeyAction,
  ResolvedBinding,
} from '../types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SURFACE: ApplicationCommandSurface = {
  modes: [
    {
      id: 'browse',
      label: 'Browse',
      parent: null,
      keymap: { t: 'open-tool', x: 'root-x', q: 'root-only' },
    },
    { id: 'tool', label: 'Tool', parent: 'browse', keymap: { c: 'capture', x: 'tool-x' } },
    { id: 'deep', label: 'Deep', parent: 'tool', keymap: {} },
  ],
  commands: [
    { id: 'open-tool', title: 'Open tool', run: () => {} },
    { id: 'root-x', title: 'Root X', run: () => {} },
    { id: 'tool-x', title: 'Tool X', run: () => {} },
    { id: 'root-only', title: 'Root only', run: () => {} },
    { id: 'capture', title: 'Capture', prompt: { label: 'Capture value' }, run: () => {} },
  ],
};

function action(actionId: HotkeyActionId, tier: HotkeyTier = 'feature'): RegisteredHotkeyAction {
  return { actionId, tier, title: actionId, defaultSequence: null, run: () => {} };
}

function binding(
  actionId: HotkeyActionId,
  serialized: string,
  tier: HotkeyTier = 'fredo',
): ResolvedBinding {
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

function scope(overrides: Partial<CommandDispatchScope> = {}): CommandDispatchScope {
  return {
    appId: 'surface-app',
    surface: SURFACE,
    modePath: ['browse'],
    promptOpen: false,
    promptInput: false,
    promptCommandId: null,
    ...overrides,
  };
}

function input(overrides: Partial<DispatchInput> & { stroke: KeyStroke }): DispatchInput {
  return {
    context: 'default',
    pending: null,
    bindings: [],
    nativeConsumes: false,
    platform: 'win32',
    ...overrides,
  };
}

// ── No scope ⇒ today's decision, byte for byte ───────────────────────────────

describe('decideDispatch — no commandScope keeps every existing outcome', () => {
  const toggle = binding('fredo.launcher.toggle', 'primary+space');

  it('terminal passthrough', () => {
    const decision = decideDispatch(input({ stroke: stroke({ key: 'a' }), context: 'terminal' }));
    expect(decision).toMatchObject({
      outcome: 'passthrough',
      consumed: false,
      reason: 'terminal-passthrough',
    });
  });

  it('modal owns Escape and suspends bare keys', () => {
    const escape = decideDispatch(
      input({ stroke: stroke({ key: 'escape' }), context: 'modal' }),
    );
    expect(escape).toMatchObject({ outcome: 'passthrough', reason: 'modal-escape' });

    const bare = decideDispatch(
      input({ stroke: stroke({ key: 'g' }), context: 'modal', bindings: [binding('fredo.a', 'g')] }),
    );
    expect(bare).toMatchObject({ outcome: 'passthrough', reason: 'modal-suspend' });
  });

  it('text-entry passes typed characters and keeps modifier chords global', () => {
    const typed = decideDispatch(
      input({ stroke: stroke({ key: 'g' }), context: 'text-entry', bindings: [binding('fredo.a', 'g')] }),
    );
    expect(typed).toMatchObject({ outcome: 'passthrough', reason: 'text-entry-passthrough' });

    const chord = decideDispatch(
      input({ stroke: stroke({ key: 'space', primary: true }), context: 'text-entry', bindings: [toggle] }),
    );
    expect(chord.outcome).toBe('match');
  });

  it('a native consumer wins a bare key and never arms', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: ' ' }),
        nativeConsumes: true,
        bindings: [binding('fredo.a', 'space space')],
      }),
    );
    expect(decision).toMatchObject({ outcome: 'passthrough', reason: 'native-consumes' });
  });

  it('pending sequences still resolve, extend and invalidate', () => {
    const exact = decideDispatch(
      input({
        stroke: stroke({ key: 'b' }),
        pending: parseSequence('a'),
        bindings: [binding('fredo.ab', 'a b')],
      }),
    );
    expect(exact.outcome).toBe('match');
    expect(exact.action?.actionId).toBe('fredo.ab');

    const pendingMore = decideDispatch(
      input({
        stroke: stroke({ key: 'b' }),
        pending: parseSequence('a'),
        bindings: [binding('fredo.abc', 'a b c')],
      }),
    );
    expect(pendingMore.outcome).toBe('pending');

    const invalid = decideDispatch(
      input({ stroke: stroke({ key: 'x' }), pending: parseSequence('a') }),
    );
    expect(invalid).toMatchObject({ outcome: 'suppress', reason: 'sequence-invalid' });
  });

  it('fresh keys still arm sequences, match single chords and pass unbound keys', () => {
    const arm = decideDispatch(
      input({ stroke: stroke({ key: 'a' }), bindings: [binding('fredo.ab', 'a b')] }),
    );
    expect(arm).toMatchObject({ outcome: 'arm-sequence', reason: 'sequence-armed' });

    const match = decideDispatch(
      input({ stroke: stroke({ key: 'space', primary: true }), bindings: [toggle] }),
    );
    expect(match).toMatchObject({ outcome: 'match', consumed: true });

    const unbound = decideDispatch(input({ stroke: stroke({ key: 'z' }) }));
    expect(unbound).toMatchObject({ outcome: 'passthrough', consumed: false, reason: 'unbound' });
  });

  it('an explicit null scope is identical to an absent one', () => {
    const withoutScope = decideDispatch(
      input({
        stroke: stroke({ key: 't' }),
        bindings: [binding('fredo.element.t#0', 't')],
        context: 'default',
      }),
    );
    const withNullScope = decideDispatch(
      input({
        stroke: stroke({ key: 't' }),
        bindings: [binding('fredo.element.t#0', 't')],
        context: 'default',
        commandScope: null,
      }),
    );
    expect(withNullScope.outcome).toBe(withoutScope.outcome);
    expect(withNullScope.reason).toBe(withoutScope.reason);
    expect(withNullScope.consumed).toBe(withoutScope.consumed);
    expect(withNullScope.action?.actionId).toBe(withoutScope.action?.actionId);
  });
});

// ── The bounded prompt branch ────────────────────────────────────────────────

describe('decideDispatch — bounded prompt branch', () => {
  it('Escape cancels the open prompt and is consumed', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'escape' }),
        context: 'text-entry',
        commandScope: scope({ promptOpen: true, promptInput: true, promptCommandId: 'capture' }),
      }),
    );
    expect(decision.outcome).toBe('prompt-cancel');
    expect(decision.consumed).toBe(true);
    expect(decision.reason).toBe('prompt-cancel:escape');
    expect(decision.command).toBeUndefined();
  });

  it('Enter commits the prompt command exactly once (never a plain command run)', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'enter' }),
        context: 'text-entry',
        commandScope: scope({ promptOpen: true, promptInput: true, promptCommandId: 'capture' }),
      }),
    );
    expect(decision.outcome).toBe('command');
    expect(decision.consumed).toBe(true);
    expect(decision.reason).toBe('command:prompt-commit');
    expect(decision.command).toEqual({
      appId: 'surface-app',
      commandId: 'capture',
      promptAction: 'commit',
    });
  });

  it('Enter without a prompt command id falls through to the text-entry branch', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'enter' }),
        context: 'text-entry',
        commandScope: scope({ promptOpen: true, promptInput: true, promptCommandId: null }),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'passthrough', reason: 'text-entry-passthrough' });
    expect(decision.command).toBeUndefined();
  });

  it('any other key while the prompt input is focused is typed (text-entry)', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'c' }),
        context: 'text-entry',
        bindings: [binding('fredo.element.c#0', 'c')],
        commandScope: scope({ promptOpen: true, promptInput: true, promptCommandId: 'capture' }),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'passthrough', reason: 'text-entry-passthrough' });
    expect(decision.command).toBeUndefined();
  });

  it('modifier chords still resolve the kept globals while the prompt is focused', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'space', primary: true }),
        context: 'text-entry',
        bindings: [binding('fredo.launcher.toggle', 'primary+space')],
        commandScope: scope({ promptOpen: true, promptInput: true, promptCommandId: 'capture' }),
      }),
    );
    expect(decision.outcome).toBe('match');
    expect(decision.action?.actionId).toBe('fredo.launcher.toggle');
  });

  it('the prompt branch is BOUNDED: a plain in-app text control is not a prompt', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'escape' }),
        context: 'text-entry',
        commandScope: scope({ promptOpen: false, promptInput: false }),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'passthrough', reason: 'text-entry-passthrough' });
  });
});

// ── The mode chain + the Escape stack rule ───────────────────────────────────

describe('decideDispatch — active mode chain', () => {
  it('a root-mode keymap stroke dispatches its command', () => {
    const decision = decideDispatch(
      input({ stroke: stroke({ key: 't' }), commandScope: scope() }),
    );
    expect(decision.outcome).toBe('command');
    expect(decision.consumed).toBe(true);
    expect(decision.reason).toBe('command:mode');
    expect(decision.command).toEqual({
      appId: 'surface-app',
      commandId: 'open-tool',
      promptAction: 'none',
    });
  });

  it('the TOP mode wins over its parent when both bind the same key', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'x' }),
        commandScope: scope({ modePath: ['browse', 'tool'] }),
      }),
    );
    expect(decision.command).toEqual({
      appId: 'surface-app',
      commandId: 'tool-x',
      promptAction: 'none',
    });
  });

  it('walks top → parent → root so a parent keymap stays reachable', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'c' }),
        commandScope: scope({ modePath: ['browse', 'tool', 'deep'] }),
      }),
    );
    expect(decision.command?.commandId).toBe('capture');

    const rootKey = decideDispatch(
      input({
        stroke: stroke({ key: 'q' }),
        commandScope: scope({ modePath: ['browse', 'tool', 'deep'] }),
      }),
    );
    expect(rootKey.command?.commandId).toBe('root-only');
  });

  it('a modifier chord never matches a mode key', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'c', primary: true }),
        commandScope: scope({ modePath: ['browse', 'tool'] }),
      }),
    );
    expect(decision.outcome).toBe('passthrough');
    expect(decision.command).toBeUndefined();
  });

  it('mode keys never enter the pending-sequence machine', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 't' }),
        bindings: [binding('fredo.element.t#0', 't t')],
        commandScope: scope(),
      }),
    );
    expect(decision.outcome).toBe('command');
    expect(decision.reason).toBe('command:mode');
  });

  it('does NOT dispatch a mode key from an in-app text control (text-entry precedence)', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 't' }),
        context: 'text-entry',
        commandScope: scope({ modePath: ['browse', 'tool'] }),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'passthrough', reason: 'text-entry-passthrough' });
    expect(decision.command).toBeUndefined();
  });

  it('does not dispatch a mode key while a prompt is open', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 't' }),
        bindings: [binding('fredo.element.t#0', 't')],
        commandScope: scope({ promptOpen: true, promptInput: false, promptCommandId: 'capture' }),
      }),
    );
    expect(decision.command).toBeUndefined();
  });

  it('non-root Escape pops exactly one mode layer', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'escape' }),
        commandScope: scope({ modePath: ['browse', 'tool'] }),
      }),
    );
    expect(decision.outcome).toBe('mode-pop');
    expect(decision.consumed).toBe(true);
    expect(decision.reason).toBe('mode-pop:escape');
  });

  it('root Escape changes nothing and is still consumed', () => {
    const decision = decideDispatch(
      input({ stroke: stroke({ key: 'escape' }), commandScope: scope() }),
    );
    expect(decision.outcome).toBe('suppress');
    expect(decision.consumed).toBe(true);
    expect(decision.reason).toBe('mode-escape:root');
  });

  it('the modal branch still wins over the scoped Escape', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'escape' }),
        context: 'modal',
        commandScope: scope({ modePath: ['browse', 'tool'] }),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'passthrough', reason: 'modal-escape' });
  });
});

// ── Fall-through: scoped element bindings, kept globals, pending ─────────────

describe('decideDispatch — fall-through after the mode chain', () => {
  it('an unmatched key still fires the scoped element binding (fresh key)', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'y' }),
        bindings: [binding('fredo.element.y#0', 'y', 'feature')],
        commandScope: scope(),
      }),
    );
    expect(decision.outcome).toBe('match');
    expect(decision.action?.actionId).toBe('fredo.element.y#0');
  });

  it('an unmatched fresh key still arms a sequence', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'y' }),
        bindings: [binding('fredo.element.y#0', 'y y', 'feature')],
        commandScope: scope(),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'arm-sequence', reason: 'sequence-armed' });
  });

  it('the kept globals still match with a scope present', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'space', primary: true }),
        bindings: [binding('fredo.launcher.toggle', 'primary+space')],
        commandScope: scope(),
      }),
    );
    expect(decision.outcome).toBe('match');
  });

  it('an in-flight element sequence completes unchanged with a scope present', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'b' }),
        pending: parseSequence('a'),
        bindings: [binding('fredo.element.a#0', 'a b', 'feature')],
        commandScope: scope(),
      }),
    );
    expect(decision.outcome).toBe('match');
    expect(decision.action?.actionId).toBe('fredo.element.a#0');
  });

  it('a native consumer still wins when no mode key matches', () => {
    const decision = decideDispatch(
      input({
        stroke: stroke({ key: 'y' }),
        nativeConsumes: true,
        bindings: [binding('fredo.element.y#0', 'y y', 'feature')],
        commandScope: scope(),
      }),
    );
    expect(decision).toMatchObject({ outcome: 'passthrough', reason: 'native-consumes' });
  });

  it('an unbound key with a scope is still native', () => {
    const decision = decideDispatch(
      input({ stroke: stroke({ key: 'z' }), commandScope: scope() }),
    );
    expect(decision).toMatchObject({ outcome: 'passthrough', consumed: false, reason: 'unbound' });
  });
});
