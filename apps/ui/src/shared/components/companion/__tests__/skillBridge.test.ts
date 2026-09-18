/**
 * Spec #2893 ST-6 — pins the module-scoped reply-push bridge.
 *
 * The bridge is the ONE route from the Home app-open hook to the mounted
 * companion entity (mirrors `askActiveCompanion`); it must always no-op safely
 * when no companion is registered, and a stale unregister must never clear a
 * newer pusher.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { pushAppOpenReply, registerAppOpenReplyPusher } from '../skillBridge';
import type { AppOpenReply } from '../appOpenReply';

const REPLY: AppOpenReply = { kind: 'success', text: 'Opening Mission Monitor' };

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('skillBridge', () => {
  it('no-ops safely when no pusher is registered', () => {
    const temporary = registerAppOpenReplyPusher(() => {});
    temporary();

    expect(() => pushAppOpenReply(REPLY)).not.toThrow();
    expect(pushAppOpenReply(REPLY)).toBe(false);
  });

  it('delivers the composed reply to the registered pusher and reports delivery', () => {
    const pusher = vi.fn();
    unregister = registerAppOpenReplyPusher(pusher);

    expect(pushAppOpenReply(REPLY)).toBe(true);
    expect(pusher).toHaveBeenCalledTimes(1);
    expect(pusher).toHaveBeenCalledWith(REPLY);
  });

  it('stops delivering after unregister', () => {
    const pusher = vi.fn();
    const off = registerAppOpenReplyPusher(pusher);
    off();

    expect(pushAppOpenReply(REPLY)).toBe(false);
    expect(pusher).not.toHaveBeenCalled();
  });

  it('a stale unregister never clears a newer pusher', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerAppOpenReplyPusher(first);
    unregister = registerAppOpenReplyPusher(second);

    offFirst();

    expect(pushAppOpenReply(REPLY)).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
