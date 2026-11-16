/**
 * Spec #3120 (rework) ST-2-R4 — the composer open bridge's request retention.
 *
 * The bridge is a module-scoped bus with ONE retained request. `peek` lets a
 * late-mounting overlay resolve the target; `consume` is the read-AND-CLEAR the
 * overlay uses once it has APPLIED the request, so retention is a one-shot
 * hand-off rather than a forever-live value; `reset...` clears both state and
 * subscribers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeCompanionComposerRequest,
  peekCompanionComposerRequest,
  requestCompanionComposerOpen,
  resetCompanionComposerBridgeForTests,
  subscribeCompanionComposerOpen,
} from '../composerBridge';

afterEach(() => {
  resetCompanionComposerBridgeForTests();
});

describe('composerBridge — retained request (R-1.8 / R-3.1)', () => {
  it('peeks the retained request before consumption, and consume clears it', () => {
    expect(peekCompanionComposerRequest()).toBeNull();

    requestCompanionComposerOpen({ source: 'command-bar-ask', appId: 'wireframe', focus: true });

    expect(peekCompanionComposerRequest()).toEqual({
      source: 'command-bar-ask',
      appId: 'wireframe',
      focus: true,
    });
    // Peek is non-destructive — a second peek still sees it.
    expect(peekCompanionComposerRequest()).not.toBeNull();

    expect(consumeCompanionComposerRequest()).toEqual({
      source: 'command-bar-ask',
      appId: 'wireframe',
      focus: true,
    });
    expect(peekCompanionComposerRequest()).toBeNull();
    // Idempotent: a second consume has nothing left to hand over.
    expect(consumeCompanionComposerRequest()).toBeNull();
  });

  it('normalises an unknown appId to an ABSENT key (never an explicit null)', () => {
    requestCompanionComposerOpen({ source: 'keyboard', focus: true });

    const retained = consumeCompanionComposerRequest();
    expect(retained).toEqual({ source: 'keyboard', focus: true });
    expect(retained !== null && 'appId' in retained).toBe(false);
  });

  it('reset clears the retained request AND the subscribers', () => {
    const listener = vi.fn();
    subscribeCompanionComposerOpen(listener);
    requestCompanionComposerOpen({ source: 'keyboard', appId: 'wireframe', focus: true });
    expect(listener).toHaveBeenCalledTimes(1);

    resetCompanionComposerBridgeForTests();

    expect(peekCompanionComposerRequest()).toBeNull();
    expect(consumeCompanionComposerRequest()).toBeNull();

    // The subscriber was dropped with the reset — a later publish reaches no one.
    requestCompanionComposerOpen({ source: 'keyboard', appId: 'wireframe', focus: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(peekCompanionComposerRequest()).not.toBeNull();
  });
});
