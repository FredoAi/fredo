/**
 * The generic application-side intent hook (Spec #3099, ST-6; navigation-only since
 * Spec #3122 P8 ST-2).
 *
 * Pins:
 *  - listener FIRST, then the take-on-mount drain (an intent queued before the
 *    mount still executes);
 *  - exactly-once per `requestId` across a remount (module-scoped ledger, never
 *    a React ref);
 *  - intents addressed to another `appId` are ignored (no cross-app drain);
 *  - the navigation-funnel outcome mapping (`performed`/`noop`/`rejected`/`failed` ->
 *    `Performed`/`Noop`/`Invalid`/`Failed`) and the `performed` list rule;
 *  - EVERY intent is answered with `app_command_intent_result` (never a silent
 *    drop), including a thrown `run`;
 *  - an intent addressed to an app with NO navigation host reports `Invalid`
 *    (the legacy `executeCommand` fallback is retired).
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('../../utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: invokeMock,
    listen: listenMock,
  },
}));

import type { DispatchResult, Intent, Surface } from '@/shared/navigation';
import {
  registerNavigationHost,
  type NavigationHost,
} from '@/shared/navigation/ui/hostRegistry';
import {
  APP_COMMAND_INTENT_EVENT,
  APP_COMMAND_INTENT_RESULT_COMMAND,
  APP_COMMAND_INTENT_TAKE_COMMAND,
  drainAppCommandIntents,
  handleAppCommandIntent,
  resetAppCommandIntentLedgerForTests,
  useAppCommandIntent,
  type AppCommandIntentPayload,
} from '../useAppCommandIntent';

type Handler = (payload: unknown) => void;

const APP_ID = 'demo';

const EMPTY_SURFACE: Surface = {
  tree: { appId: APP_ID, root: 'root', places: [], directAliases: {} },
  verbs: [],
  companion: null,
};

const PERFORMED = (verbId: string): DispatchResult => ({
  status: 'performed',
  entry: { verbId } as never,
});

/** Every registered host disposer for this test. */
let hostDisposers: Array<() => void> = [];

/**
 * Register a stub navigation host for the demo app (the ONLY execution path now).
 * Its `runIntent` models the declared verbs the tests drive.
 */
function registerDemo(overrides: {
  add?: () => void | boolean | Promise<void | boolean>;
  needs?: () => void | boolean | Promise<void | boolean>;
} = {}): { add: ReturnType<typeof vi.fn> } {
  const add = vi.fn(overrides.add ?? (() => true));
  const needs = vi.fn(overrides.needs ?? (() => true));

  const runIntent = vi.fn(async (next: Intent): Promise<DispatchResult> => {
    if (next.verbId === 'demo.add') {
      try {
        const result = await add();
        return result === false
          ? { status: 'noop', code: 'did-nothing', message: null }
          : PERFORMED(next.verbId);
      } catch {
        return { status: 'failed', code: 'failed-run' };
      }
    }
    if (next.verbId === 'demo.needs') {
      const keys = Object.keys(next.args);
      const name = next.args.name;
      if (keys.some((key) => key !== 'name') || typeof name !== 'string' || name.trim() === '') {
        return { status: 'rejected', code: 'invalid-args' };
      }
      try {
        const result = await needs();
        return result === false
          ? { status: 'noop', code: 'did-nothing', message: null }
          : PERFORMED(next.verbId);
      } catch {
        return { status: 'failed', code: 'failed-run' };
      }
    }
    return { status: 'rejected', code: 'unknown-verb' };
  });

  const unregister = registerNavigationHost({
    appId: APP_ID,
    surface: EMPTY_SURFACE,
    host: { runIntent } as unknown as NavigationHost,
  });
  hostDisposers.push(unregister);
  return { add };
}

function intent(overrides: Partial<AppCommandIntentPayload> = {}): AppCommandIntentPayload {
  return {
    requestId: 'req-1',
    appId: APP_ID,
    action: 'demo.add',
    arguments: {},
    ...overrides,
  };
}

function resultCalls(): Array<[string, Record<string, unknown>]> {
  return invokeMock.mock.calls.filter(
    ([command]) => command === APP_COMMAND_INTENT_RESULT_COMMAND,
  ) as Array<[string, Record<string, unknown>]>;
}

function takeCalls(): number {
  return invokeMock.mock.calls.filter(
    ([command]) => command === APP_COMMAND_INTENT_TAKE_COMMAND,
  ).length;
}

let handlers: Record<string, Handler[]>;
let callOrder: string[];
let addSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers = {};
  callOrder = [];
  hostDisposers = [];
  resetAppCommandIntentLedgerForTests();
  addSpy = registerDemo().add;
  invokeMock.mockReset();
  listenMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  listenMock.mockImplementation(async (event: string, handler: Handler) => {
    callOrder.push(`listen:${event}`);
    (handlers[event] ??= []).push(handler);
    return vi.fn();
  });
  invokeMock.mockImplementation(async (command: string) => {
    callOrder.push(`invoke:${command}`);
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  for (const dispose of hostDisposers.splice(0)) dispose();
  resetAppCommandIntentLedgerForTests();
});

async function mount(appId: string = APP_ID): Promise<void> {
  renderHook(() => useAppCommandIntent(appId));
  await waitFor(() =>
    expect((handlers[APP_COMMAND_INTENT_EVENT] ?? []).length).toBeGreaterThan(0),
  );
}

describe('mount ordering + drain (R-2a)', () => {
  it('registers the listener BEFORE taking the queue', async () => {
    await mount();
    await waitFor(() => expect(takeCalls()).toBe(1));

    expect(callOrder.indexOf(`listen:${APP_COMMAND_INTENT_EVENT}`)).toBeLessThan(
      callOrder.indexOf(`invoke:${APP_COMMAND_INTENT_TAKE_COMMAND}`),
    );
  });

  it('executes and answers an intent that was queued before the mount', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === APP_COMMAND_INTENT_TAKE_COMMAND) return [intent({ requestId: 'queued' })];
      return undefined;
    });

    await mount();

    await waitFor(() => expect(resultCalls()).toHaveLength(1));
    expect(resultCalls()[0][1]).toEqual({
      requestId: 'queued',
      appId: APP_ID,
      outcome: 'Performed',
      performed: ['demo.add'],
      detail: null,
    });
  });

  it('drains only intents addressed to this appId', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === APP_COMMAND_INTENT_TAKE_COMMAND) {
        return [intent({ requestId: 'foreign', appId: 'other' })];
      }
      return undefined;
    });

    await mount();
    await waitFor(() => expect(takeCalls()).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(resultCalls()).toHaveLength(0);
  });
});

describe('exactly once (module-scoped ledger)', () => {
  it('does not re-execute the same requestId after a remount', async () => {
    await mount();

    await act(async () => {
      (handlers[APP_COMMAND_INTENT_EVENT] ?? []).forEach((handler) =>
        handler(intent({ requestId: 'once' })),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(resultCalls()).toHaveLength(1));
    expect(addSpy).toHaveBeenCalledTimes(1);

    cleanup();
    // The unmounted hook's listeners are gone; only the remount's remain.
    handlers = {};
    invokeMock.mockClear();

    // The host queue still holds the request (the handler ran from the event).
    invokeMock.mockImplementation(async (command: string) => {
      if (command === APP_COMMAND_INTENT_TAKE_COMMAND) return [intent({ requestId: 'once' })];
      return undefined;
    });
    await mount();
    await waitFor(() => expect(takeCalls()).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // One execution, one report — the ledger carried across the remount.
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(resultCalls()).toHaveLength(0);
  });

  it('ignores an event addressed to another appId', async () => {
    await mount();

    await act(async () => {
      (handlers[APP_COMMAND_INTENT_EVENT] ?? []).forEach((handler) =>
        handler(intent({ requestId: 'foreign', appId: 'other' })),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(resultCalls()).toHaveLength(0);
  });

  it('ignores a malformed intent (blank requestId) without reporting', async () => {
    await handleAppCommandIntent(intent({ requestId: '   ' }));
    expect(resultCalls()).toHaveLength(0);

    await handleAppCommandIntent(null);
    await handleAppCommandIntent(undefined);
    expect(resultCalls()).toHaveLength(0);
  });
});

describe('outcome mapping (the ONE navigation funnel)', () => {
  it('performed -> Performed with the executed id', async () => {
    await handleAppCommandIntent(intent({ requestId: 'p' }));
    expect(resultCalls()[0][1]).toMatchObject({
      outcome: 'Performed',
      performed: ['demo.add'],
    });
  });

  it('run returning false -> Noop with an empty performed list', async () => {
    registerDemo({ add: () => false });

    await handleAppCommandIntent(intent({ requestId: 'n' }));
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Noop', performed: [] });
  });

  it('a thrown run -> Failed (never a silent drop)', async () => {
    registerDemo({
      add: () => {
        throw new Error('boom');
      },
    });

    await handleAppCommandIntent(intent({ requestId: 'f' }));
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Failed', performed: [] });
  });

  it('an unknown command id -> Invalid', async () => {
    await handleAppCommandIntent(intent({ requestId: 'i', action: 'demo.missing' }));
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Invalid', performed: [] });
  });

  it('a contract-failing argument is rejected BEFORE the verb runs', async () => {
    await handleAppCommandIntent(
      intent({ requestId: 'args', action: 'demo.needs', arguments: { bogus: 'x' } }),
    );
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Invalid', performed: [] });
  });

  it('a missing arguments value is the no-argument shape, never a prompt', async () => {
    await handleAppCommandIntent(intent({ requestId: 'bare', arguments: undefined }));
    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Performed', performed: ['demo.add'] });
  });

  it('an app with no navigation host reports Invalid (legacy fallback retired)', async () => {
    await handleAppCommandIntent(intent({ requestId: 'no-host', appId: 'unregistered' }));
    expect(resultCalls()[0][1]).toMatchObject({
      outcome: 'Invalid',
      performed: [],
      detail: 'unknown-app',
    });
  });
});

describe('drain helper', () => {
  it('is a no-op for a blank appId', async () => {
    await drainAppCommandIntents('   ');
    expect(takeCalls()).toBe(0);
  });
});

/* ───────────────────── navigation-host relay (Spec #3120, ST-4) ───────────────────── */

/** Register a stub NavigationHost for this app; the disposer unregisters it. */
function registerHost(
  runIntent: (intent: Intent) => Promise<DispatchResult>,
): { runIntent: ReturnType<typeof vi.fn>; unregister: () => void } {
  const spy = vi.fn(runIntent);
  const unregister = registerNavigationHost({
    appId: APP_ID,
    surface: EMPTY_SURFACE,
    host: { runIntent: spy } as unknown as NavigationHost,
  });
  hostDisposers.push(unregister);
  return { runIntent: spy, unregister };
}

describe('navigation-host relay (R-4.1 / R-4.2)', () => {
  it('executes through host.runIntent with channel agent and actor companion', async () => {
    const { runIntent } = registerHost(async () => PERFORMED('wireframe.element.delete'));

    await handleAppCommandIntent(intent({ requestId: 'relay', action: 'wireframe.element.delete' }));

    expect(runIntent).toHaveBeenCalledTimes(1);
    expect(runIntent).toHaveBeenCalledWith({
      verbId: 'wireframe.element.delete',
      args: {},
      channel: 'agent',
      actor: 'companion',
    });
    expect(resultCalls()[0][1]).toEqual({
      requestId: 'relay',
      appId: APP_ID,
      outcome: 'Performed',
      performed: ['wireframe.element.delete'],
      detail: null,
    });
  });

  it('passes a present non-object argument through (the funnel types the rejection)', async () => {
    const { runIntent } = registerHost(
      async () => ({ status: 'rejected', code: 'invalid-args' }) as DispatchResult,
    );

    await handleAppCommandIntent(intent({ requestId: 'bad-args', arguments: 'not-an-object' }));

    expect(runIntent).toHaveBeenCalledWith({
      verbId: 'demo.add',
      args: 'not-an-object',
      channel: 'agent',
      actor: 'companion',
    });
    expect(resultCalls()[0][1]).toMatchObject({
      outcome: 'Invalid',
      performed: [],
      detail: 'invalid-args',
    });
  });

  it('maps noop to Noop with an empty performed list', async () => {
    registerHost(
      async () => ({ status: 'noop', code: 'did-nothing', message: null }) as DispatchResult,
    );

    await handleAppCommandIntent(intent({ requestId: 'noop' }));

    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Noop', performed: [], detail: null });
  });

  it('maps a typed rejection to Invalid with the code as detail (R-4.2)', async () => {
    registerHost(async () => ({ status: 'rejected', code: 'unavailable' }) as DispatchResult);

    await handleAppCommandIntent(intent({ requestId: 'rejected' }));

    expect(resultCalls()[0][1]).toMatchObject({
      outcome: 'Invalid',
      performed: [],
      detail: 'unavailable',
    });
  });

  it('maps failed to Failed (never a silent drop)', async () => {
    registerHost(async () => ({ status: 'failed', code: 'failed-run' }) as DispatchResult);

    await handleAppCommandIntent(intent({ requestId: 'failed' }));

    expect(resultCalls()[0][1]).toMatchObject({ outcome: 'Failed', performed: [] });
  });
});
